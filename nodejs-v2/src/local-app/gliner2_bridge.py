"""
GLiNER2 Bi-encoder Bridge — stdio JSON-line IPC sidecar.

Loaded by PII Shield local testing app (Node.js) via child_process.spawn().
Keeps model warm in memory; receives predict requests over stdin, responds on stdout.

Protocol (one JSON object per line):

  → {"cmd":"init","model":"knowledgator/gliner-bi-base-v2.0","cache_dir":"..."}
  ← {"status":"ok","model":"knowledgator/gliner-bi-base-v2.0"}

  → {"cmd":"predict","text":"...","labels":["person","organization"],"threshold":0.5}
  ← {"entities":[{"text":"John","label":"person","start":0,"end":4,"score":0.95}]}

  → {"cmd":"shutdown"}
  ← {"status":"ok"}

Requirements: pip install gliner
"""

import json
import sys
import os
import traceback

# Suppress noisy torch/transformers warnings on stderr
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

model = None
model_name = None


def log(msg: str) -> None:
    """Log to stderr (visible in Node's child_process stderr stream)."""
    print(f"[GLiNER2Bridge] {msg}", file=sys.stderr, flush=True)


def respond(obj: dict) -> None:
    """Write one JSON line to stdout."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _install_tokenize_patch(mdl) -> None:
    """
    Monkey-patch tokenize_inputs to bypass Rust encode_batch bug.

    The Rust tokenizer's encode_batch(is_pretokenized=True) crashes with
    TypeError on certain word lists. Fix: tokenize one sentence at a time
    via the single-input path, then pad+stack into a batch manually.
    """
    import types
    import torch

    processor = mdl.data_processor

    def _safe_tokenize_inputs(self, texts, entities=None):
        # Use the Rust tokenizer's encode() directly to bypass
        # HF's encode_batch which crashes on long pretokenized inputs.
        rust_tok = self.transformer_tokenizer._tokenizer
        max_len_cfg = getattr(self.transformer_tokenizer, "model_max_length", 512)

        all_ids = []
        all_masks = []
        all_word_ids = []

        for words in texts:
            if not words or not isinstance(words, list):
                words = ["[PAD]"]
            # Ensure every element is a non-empty string
            clean = []
            for w in words:
                if w is None:
                    continue
                s = str(w).strip()
                if s:
                    clean.append(s)
            words = clean if clean else ["[PAD]"]

            try:
                enc = rust_tok.encode(words, is_pretokenized=True, add_special_tokens=True)
            except (TypeError, Exception) as exc:
                # Fallback: tokenize word-by-word and concatenate
                log(f"encode(pretokenized) failed for {len(words)} words: {exc}")
                log(f"  types: {set(type(w).__name__ for w in words)}")
                log(f"  sample: {words[:5]}")
                all_tok_ids = [rust_tok.token_to_id("[CLS]")]
                word_id_map = [None]
                for wi, w in enumerate(words):
                    if not isinstance(w, str) or not w.strip():
                        continue
                    try:
                        sub = rust_tok.encode(w.strip(), add_special_tokens=False)
                    except Exception as sub_exc:
                        log(f"  word-by-word encode failed for word {wi} ({w!r}): {sub_exc}")
                        continue
                    for sid in sub.ids:
                        all_tok_ids.append(sid)
                        word_id_map.append(wi)
                all_tok_ids.append(rust_tok.token_to_id("[SEP]"))
                word_id_map.append(None)
                all_tok_ids = all_tok_ids[:max_len_cfg]
                word_id_map = word_id_map[:max_len_cfg]
                all_ids.append(all_tok_ids)
                all_masks.append([1] * len(all_tok_ids))
                all_word_ids.append(word_id_map)
                continue
            ids = enc.ids[:max_len_cfg]
            wids = enc.word_ids[:max_len_cfg]

            all_ids.append(ids)
            all_masks.append([1] * len(ids))
            all_word_ids.append(wids)

        # Pad to longest sequence in batch
        max_len = max(len(ids) for ids in all_ids)
        padded_ids = []
        padded_mask = []
        for ids, mask in zip(all_ids, all_masks):
            pad_len = max_len - len(ids)
            padded_ids.append(ids + [0] * pad_len)
            padded_mask.append(mask + [0] * pad_len)

        tokenized_inputs = {
            "input_ids": torch.tensor(padded_ids),
            "attention_mask": torch.tensor(padded_mask),
        }

        # Encode entity labels (same as original tokenize_inputs)
        if entities is not None:
            tokenized_labels = self.labels_tokenizer(
                entities, return_tensors="pt", truncation=True, padding="longest"
            )
            tokenized_inputs["labels_input_ids"] = tokenized_labels["input_ids"]
            tokenized_inputs["labels_attention_mask"] = tokenized_labels[
                "attention_mask"
            ]

        # Build word-level masks from word_ids
        words_masks = []
        for wids in all_word_ids:
            mask = []
            prev_wid = None
            seen = 0
            for wid in wids:
                if wid is None:
                    mask.append(0)
                elif wid != prev_wid:
                    seen += 1
                    mask.append(seen)
                else:
                    mask.append(0)
                prev_wid = wid
            mask += [0] * (max_len - len(mask))
            words_masks.append(mask)

        tokenized_inputs["words_mask"] = torch.tensor(words_masks)

        return tokenized_inputs

    processor.tokenize_inputs = types.MethodType(_safe_tokenize_inputs, processor)
    log("Installed tokenize_inputs patch (per-sentence encoding)")


def handle_init(req: dict) -> dict:
    global model, model_name
    try:
        from gliner import GLiNER
    except ImportError:
        return {
            "error": "gliner package not installed. Run: pip install gliner"
        }

    # Check transformers version — v5.0+ breaks GLiNER (GitHub #324)
    try:
        import transformers
        tv = tuple(int(x) for x in transformers.__version__.split(".")[:2])
        if tv >= (5, 0):
            log(
                f"WARNING: transformers {transformers.__version__} detected. "
                f"GLiNER requires transformers<5.0.0. "
                f"Run: pip install 'transformers>=4.51.3,<5.0.0'"
            )
            return {
                "error": (
                    f"transformers {transformers.__version__} is incompatible with GLiNER. "
                    f"Run: pip install 'transformers>=4.51.3,<5.0.0'"
                )
            }
    except Exception:
        pass

    name = req.get("model", "knowledgator/gliner-bi-base-v2.0")
    cache_dir = req.get("cache_dir")

    log(f"Loading model: {name} (cache_dir={cache_dir})")

    kwargs = {}
    if cache_dir:
        kwargs["cache_dir"] = cache_dir

    model = GLiNER.from_pretrained(name, **kwargs)
    model_name = name

    # Patch tokenize_inputs to work around Rust encode_batch bug
    _install_tokenize_patch(model)

    log(f"Model loaded: {name}")
    return {"status": "ok", "model": name}


def handle_predict(req: dict) -> dict:
    if model is None:
        return {"error": "Model not initialized. Send 'init' first."}

    text = req.get("text", "")
    labels = req.get("labels", [])
    threshold = req.get("threshold", 0.5)

    if not text or not labels:
        return {"entities": []}

    log(f"Predict: text={len(text)} chars, labels={len(labels)}, threshold={threshold}")

    clean_labels = [l.strip() for l in labels if l and isinstance(l, str) and l.strip()]
    if not clean_labels:
        return {"entities": []}

    try:
        entities = model.predict_entities(text, clean_labels, threshold=threshold)
    except TypeError as e:
        log(f"predict_entities TypeError: {e}")
        log(f"  text type={type(text).__name__}, len={len(text)}")
        log(f"  labels={clean_labels}")
        log(f"  text sample: {text[:200]!r}")
        # Try with smaller text to isolate the problem
        if len(text) > 500:
            log("  Retrying with first 500 chars...")
            try:
                entities = model.predict_entities(text[:500], clean_labels, threshold=threshold)
            except Exception as e2:
                log(f"  Retry also failed: {e2}")
                return {"entities": [], "warning": f"TypeError in predict_entities: {e}"}
        else:
            return {"entities": [], "warning": f"TypeError in predict_entities: {e}"}

    result = []
    for e in entities:
        result.append({
            "text": e.get("text", ""),
            "label": e.get("label", ""),
            "start": e.get("start", 0),
            "end": e.get("end", 0),
            "score": round(e.get("score", 0.0), 4),
        })

    log(f"Predict done: {len(result)} entities")
    return {"entities": result}


def main() -> None:
    log("Bridge started, waiting for commands on stdin...")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            respond({"error": f"Invalid JSON: {e}"})
            continue

        cmd = req.get("cmd")

        try:
            if cmd == "init":
                resp = handle_init(req)
            elif cmd == "predict":
                resp = handle_predict(req)
            elif cmd == "shutdown":
                respond({"status": "ok"})
                log("Shutdown requested, exiting.")
                break
            else:
                resp = {"error": f"Unknown command: {cmd}"}
        except Exception:
            tb = traceback.format_exc()
            log(f"Error handling '{cmd}': {tb}")
            resp = {"error": str(traceback.format_exc().splitlines()[-1])}

        respond(resp)

    log("Bridge exiting.")


if __name__ == "__main__":
    main()
