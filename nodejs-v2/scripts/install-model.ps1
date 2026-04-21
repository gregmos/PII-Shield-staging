# PII Shield v2 - GLiNER model installer (Windows PowerShell)
#
# Downloads the GLiNER PII model (~634 MB) from HuggingFace into
# $HOME\.pii_shield\models\gliner-pii-base-v1.0\ so the PII Shield .mcpb
# plugin can find it at runtime.
#
# One-liner usage (recommended - no file left on disk):
#   iwr https://raw.githubusercontent.com/grigorii-moskalev/pii-shield/main/nodejs-v2/scripts/install-model.ps1 | iex
#
# Downloaded-file usage:
#   Double-click install-model.bat (wraps this .ps1 with -ExecutionPolicy Bypass)
#   OR: right-click install-model.ps1 -> Properties -> Unblock -> OK
#       then: powershell -ExecutionPolicy Bypass -File install-model.ps1
#
# Idempotent: safe to re-run. Existing files are re-downloaded (atomic
# overwrite) so partial failures heal on retry.
#
# IMPORTANT FOR MAINTAINERS: this file must stay pure ASCII (no em-dashes,
# no smart quotes). Windows PowerShell 5.1 reads .ps1 files via the system
# ANSI codepage when there is no UTF-8 BOM; non-ASCII bytes corrupt the
# token stream and surface as confusing "Unexpected token" errors on
# totally unrelated lines.

$ErrorActionPreference = "Stop"

$MODEL_SLUG = "gliner-pii-base-v1.0"
$TARGET = Join-Path $HOME ".pii_shield\models\$MODEL_SLUG"
$HF_BASE = "https://huggingface.co/knowledgator/$MODEL_SLUG/resolve/main"

# Array items must be comma-separated in Windows PowerShell 5.1 - without
# the commas the parser treats adjacent @{...} blocks as a single compound
# expression and the closing ')' below is mis-attributed.
$FILES = @(
    @{ url = "onnx/model.onnx";         name = "model.onnx" },
    @{ url = "tokenizer.json";          name = "tokenizer.json" },
    @{ url = "tokenizer_config.json";   name = "tokenizer_config.json" },
    @{ url = "special_tokens_map.json"; name = "special_tokens_map.json" },
    @{ url = "gliner_config.json";      name = "gliner_config.json" }
)

Write-Host ""
Write-Host "PII Shield - installing GLiNER model"
Write-Host "  Target: $TARGET"
Write-Host ""

New-Item -ItemType Directory -Force -Path $TARGET | Out-Null

foreach ($f in $FILES) {
    $dest = Join-Path $TARGET $f.name
    Write-Host "  Downloading $($f.name) ..."
    # Invoke-WebRequest writes via .NET WebClient with a built-in progress bar.
    # -UseBasicParsing skips IE engine DOM parsing (we only need raw bytes).
    Invoke-WebRequest -Uri "$HF_BASE/$($f.url)" -OutFile $dest -UseBasicParsing
}

$modelFile = Join-Path $TARGET "model.onnx"
$modelSize = (Get-Item $modelFile).Length
if ($modelSize -lt 600MB) {
    $mb = [math]::Round($modelSize / 1MB, 1)
    Write-Host ""
    Write-Host "ERROR: model.onnx is only $mb MB, expected >= 600 MB." -ForegroundColor Red
    Write-Host "The download may have been truncated - re-run this script." -ForegroundColor Red
    exit 1
}

$modelMb = [math]::Round($modelSize / 1MB, 1)
Write-Host ""
Write-Host "[OK] Model installed at $TARGET ($modelMb MB)" -ForegroundColor Green
Write-Host ""
Write-Host "Next step: install pii-shield-v2.0.0.mcpb from"
Write-Host "  https://github.com/grigorii-moskalev/pii-shield/releases"
Write-Host "into Claude Desktop (Settings -> Extensions -> drag-drop)."
Write-Host ""
