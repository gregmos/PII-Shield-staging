#!/usr/bin/env bash
#
# PII Shield v2 — GLiNER model installer (macOS / Linux)
#
# Downloads the GLiNER PII model (~634 MB) from the PII Shield GitHub release
# into $HOME/.pii_shield/models/gliner-pii-base-v1.0/ so the PII Shield .mcpb
# plugin can find it at runtime.
#
# One-liner usage (recommended — no file left on disk):
#   curl -fsSL https://raw.githubusercontent.com/gregmos/PII-Shield/main/nodejs-v2/scripts/install-model.sh | bash
#
# Downloaded-file usage:
#   macOS:  xattr -d com.apple.quarantine install-model.sh && chmod +x install-model.sh && ./install-model.sh
#   Linux:  chmod +x install-model.sh && ./install-model.sh
#
# Idempotent: safe to re-run. Existing files are overwritten by the unzip
# step (-o) so partial failures heal on retry.

set -euo pipefail

MODEL_SLUG="gliner-pii-base-v1.0"
MODEL_VERSION="v2.0.2"
TARGET="$HOME/.pii_shield/models/$MODEL_SLUG"
MODEL_ZIP_URL="https://github.com/gregmos/PII-Shield/releases/download/${MODEL_VERSION}/${MODEL_SLUG}.zip"

echo ""
echo "PII Shield — installing GLiNER model (~634 MB)"
echo "  Source: $MODEL_ZIP_URL"
echo "  Target: $TARGET"
echo ""

mkdir -p "$TARGET"

# Ensure unzip is available before we download a 634 MB file.
if ! command -v unzip >/dev/null 2>&1; then
  echo "ERROR: \`unzip\` is required but not found in PATH." >&2
  echo "Install it first:" >&2
  echo "  macOS:  (already included — reinstall Xcode CLT with 'xcode-select --install' if missing)" >&2
  echo "  Debian/Ubuntu:  sudo apt install unzip" >&2
  echo "  Fedora/RHEL:    sudo dnf install unzip" >&2
  echo "  Alpine:         apk add unzip" >&2
  exit 1
fi

# Wall-clock seconds since epoch (Linux: GNU date %s.%N; macOS: BSD date has
# no %N so fall back to second resolution).
now_s() {
  if date +%s.%N 2>/dev/null | grep -q -v N; then
    date +%s.%N
  else
    date +%s
  fi
}

fmt_time() {
  awk -v t="$1" 'BEGIN {
    if (t >= 60) { m = int(t / 60); s = t - m * 60; printf "%dm%.0fs", m, s }
    else         { printf "%.1fs", t }
  }'
}

TMP_ZIP=$(mktemp -t pii-shield-model.XXXXXX.zip)
# shellcheck disable=SC2064
trap "rm -f '$TMP_ZIP'" EXIT

start=$(now_s)
echo "1/2 Downloading ${MODEL_SLUG}.zip..."
# -L follow redirects, --fail exit non-zero on HTTP errors, default curl
# progress meter shows percent + bytes + speed + ETA on one self-redrawing
# line.
curl -L --fail -o "$TMP_ZIP" "$MODEL_ZIP_URL"
dl_end=$(now_s)
dl_elapsed=$(awk -v a="$start" -v b="$dl_end" 'BEGIN { printf "%.2f", b - a }')
echo "    done in $(fmt_time "$dl_elapsed")"

echo ""
echo "2/2 Unpacking into $TARGET..."
# -o overwrite without prompting, -q quiet (we already printed "Unpacking").
unzip -o -q "$TMP_ZIP" -d "$TARGET"
unzip_end=$(now_s)

overall_elapsed=$(awk -v a="$start" -v b="$unzip_end" 'BEGIN { printf "%.2f", b - a }')
overall_time_str=$(fmt_time "$overall_elapsed")

# Size sanity on model.onnx — both Linux (stat -c) and macOS (stat -f) syntaxes.
if [ ! -f "$TARGET/model.onnx" ]; then
  echo "" >&2
  echo "ERROR: model.onnx missing after unzip. The release zip might be corrupt." >&2
  exit 1
fi
if stat -c%s "$TARGET/model.onnx" >/dev/null 2>&1; then
  model_size=$(stat -c%s "$TARGET/model.onnx")
else
  model_size=$(stat -f%z "$TARGET/model.onnx")
fi

if [ "$model_size" -lt 629145600 ]; then
  mb=$((model_size / 1024 / 1024))
  echo "" >&2
  echo "ERROR: model.onnx is only ${mb} MB, expected >= 600 MB." >&2
  echo "The release asset may have been truncated — re-run this script." >&2
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
