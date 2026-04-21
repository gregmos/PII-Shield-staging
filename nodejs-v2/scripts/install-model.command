#!/bin/bash
# PII Shield — double-click launcher for install-model.sh on macOS.
# Finder opens `.command` files in Terminal on double-click; a regular
# `.sh` with the same exec bit would require Right-click → "Open With".
# Falls back to ./install-model.sh next to this file.
set -e
cd "$(dirname "$0")"
bash ./install-model.sh
echo ""
echo "Press any key to close this window."
read -n 1 -s
