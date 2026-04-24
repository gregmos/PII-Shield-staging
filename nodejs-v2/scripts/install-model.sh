#!/usr/bin/env bash
#
# PII Shield v2 — GLiNER model installer (macOS / Linux)
#
# Downloads the GLiNER PII model (~634 MB) from HuggingFace into
# $HOME/.pii_shield/models/gliner-pii-base-v1.0/ so the PII Shield .mcpb
# plugin can find it at runtime.
#
# One-liner usage (recommended — no file left on disk):
#   curl -fsSL https://raw.githubusercontent.com/gregmos/PII-Shield/main/nodejs-v2/scripts/install-model.sh | bash
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
echo "PII Shield — installing GLiNER model (~634 MB total)"
echo "  Target: $TARGET"
echo ""

mkdir -p "$TARGET"

# Wall-clock seconds since epoch (Linux: GNU date %s.%N nanoseconds; macOS:
# BSD date has no %N, fall back to second resolution).
now_s() {
  if date +%s.%N 2>/dev/null | grep -q -v N; then
    date +%s.%N
  else
    date +%s
  fi
}

# Format byte count as MB with one decimal.
fmt_mb() {
  awk -v b="$1" 'BEGIN { printf "%.1f", b / 1048576 }'
}

# Format elapsed-seconds float as "Xm YYs" or "Y.Ys".
fmt_time() {
  awk -v t="$1" 'BEGIN {
    if (t >= 60) { m = int(t / 60); s = t - m * 60; printf "%dm%.0fs", m, s }
    else         { printf "%.1fs", t }
  }'
}

download() {
  local url="$1" name="$2"
  local dest="$TARGET/$name"
  echo "  $name"
  local start; start=$(now_s)
  # No --progress-bar: default curl meter shows percent + bytes + speed +
  # ETA on a self-redrawing line — informative without --verbose noise.
  # -L follow redirects, --fail exit non-zero on HTTP errors,
  # -o write to file, -#  fallback would only print the # bar.
  curl -L --fail -o "$dest" "$HF_BASE/$url"
  local end; end=$(now_s)
  local elapsed; elapsed=$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.2f", b - a }')
  local size_b
  if stat -c%s "$dest" >/dev/null 2>&1; then
    size_b=$(stat -c%s "$dest")
  else
    size_b=$(stat -f%z "$dest")
  fi
  local size_mb; size_mb=$(fmt_mb "$size_b")
  local time_str; time_str=$(fmt_time "$elapsed")
  local speed_mbs
  if awk -v t="$elapsed" 'BEGIN { exit (t > 0) ? 0 : 1 }'; then
    speed_mbs=$(awk -v b="$size_b" -v t="$elapsed" 'BEGIN { printf "%.2f", (b/1048576)/t }')
    echo "    done ${size_mb} MB in ${time_str} (avg ${speed_mbs} MB/s)"
  else
    echo "    done ${size_mb} MB in ${time_str}"
  fi
}

overall_start=$(now_s)
download "onnx/model.onnx"         "model.onnx"
download "tokenizer.json"          "tokenizer.json"
download "tokenizer_config.json"   "tokenizer_config.json"
download "special_tokens_map.json" "special_tokens_map.json"
download "gliner_config.json"      "gliner_config.json"
overall_end=$(now_s)
overall_elapsed=$(awk -v a="$overall_start" -v b="$overall_end" 'BEGIN { printf "%.2f", b - a }')
overall_time_str=$(fmt_time "$overall_elapsed")

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
echo "[OK] Model installed at $TARGET (${model_mb} MB, total time ${overall_time_str})"
echo ""
echo "Next step: install the PII Shield .mcpb for your OS from"
echo "  https://github.com/gregmos/PII-Shield/releases"
echo "into Claude Desktop (Settings -> Extensions -> drag-drop)."
echo ""
