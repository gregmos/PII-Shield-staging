#!/usr/bin/env bash
#
# PII Shield v2 — GLiNER model installer (macOS / Linux)
#
# Downloads the GLiNER PII model (~634 MB) from HuggingFace into
# $HOME/.pii_shield/models/gliner-pii-base-v1.0/ so the PII Shield .mcpb
# plugin can find it at runtime.
#
# One-liner usage (recommended — no file left on disk):
#   curl -fsSL https://raw.githubusercontent.com/grigorii-moskalev/pii-shield/main/nodejs-v2/scripts/install-model.sh | bash
#
# Downloaded-file usage:
#   macOS:  xattr -d com.apple.quarantine install-model.sh && chmod +x install-model.sh && ./install-model.sh
#   Linux:  chmod +x install-model.sh && ./install-model.sh
#
# Idempotent: safe to re-run. Existing files are re-downloaded (atomic
# overwrite via `curl -o`) so partial failures heal on retry.

set -euo pipefail

MODEL_SLUG="gliner-pii-base-v1.0"
TARGET="$HOME/.pii_shield/models/$MODEL_SLUG"
HF_BASE="https://huggingface.co/knowledgator/$MODEL_SLUG/resolve/main"

echo ""
echo "PII Shield — installing GLiNER model"
echo "  Target: $TARGET"
echo ""

mkdir -p "$TARGET"

download() {
  local url="$1" name="$2"
  echo "  Downloading $name ..."
  # -L follow redirects, --progress-bar show progress (human-readable),
  # -o write to file, --fail exit non-zero on HTTP errors.
  curl -L --fail --progress-bar -o "$TARGET/$name" "$HF_BASE/$url"
}

download "onnx/model.onnx"         "model.onnx"
download "tokenizer.json"          "tokenizer.json"
download "tokenizer_config.json"   "tokenizer_config.json"
download "special_tokens_map.json" "special_tokens_map.json"
download "gliner_config.json"      "gliner_config.json"

# Size sanity — both Linux (stat -c) and macOS (stat -f) syntaxes.
if stat -c%s "$TARGET/model.onnx" >/dev/null 2>&1; then
  model_size=$(stat -c%s "$TARGET/model.onnx")
else
  model_size=$(stat -f%z "$TARGET/model.onnx")
fi

if [ "$model_size" -lt 629145600 ]; then
  mb=$((model_size / 1024 / 1024))
  echo ""
  echo "ERROR: model.onnx is only ${mb} MB, expected >= 600 MB." >&2
  echo "The download may have been truncated — re-run this script." >&2
  exit 1
fi

model_mb=$((model_size / 1024 / 1024))
echo ""
echo "[OK] Model installed at $TARGET (${model_mb} MB)"
echo ""
echo "Next step: install pii-shield-v2.0.0.mcpb from"
echo "  https://github.com/grigorii-moskalev/pii-shield/releases"
echo "into Claude Desktop (Settings -> Extensions -> drag-drop)."
echo ""
