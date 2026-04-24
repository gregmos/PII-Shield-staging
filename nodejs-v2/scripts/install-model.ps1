# PII Shield v2 - GLiNER model installer (Windows PowerShell)
#
# Downloads the GLiNER PII model (~634 MB) from HuggingFace into
# $HOME\.pii_shield\models\gliner-pii-base-v1.0\ so the PII Shield .mcpb
# plugin can find it at runtime.
#
# One-liner usage (recommended - no file left on disk):
#   iwr https://raw.githubusercontent.com/gregmos/PII-Shield/main/nodejs-v2/scripts/install-model.ps1 | iex
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

# Custom downloader using System.Net.Http.HttpClient. Built-in
# Invoke-WebRequest in Windows PowerShell 5.1 redraws its progress bar by
# repainting the entire console window per chunk - on the 634 MB model file
# that means a 5x slowdown AND a flickery, uninformative "bytes ticking"
# UX. The HttpClient path lets us throttle the redraw to ~5x/sec and show
# percent + MB/total + MB/s + ETA in a single clean line.
Add-Type -AssemblyName System.Net.Http | Out-Null

function Download-WithProgress {
    param(
        [Parameter(Mandatory)] [string] $Uri,
        [Parameter(Mandatory)] [string] $OutFile,
        [Parameter(Mandatory)] [string] $DisplayName
    )

    $client = [System.Net.Http.HttpClient]::new()
    try {
        $client.Timeout = [TimeSpan]::FromMinutes(15)
        $response = $client.GetAsync(
            $Uri,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()
        $response.EnsureSuccessStatusCode() | Out-Null

        $totalBytes = $null
        if ($response.Content.Headers.ContentLength) {
            $totalBytes = [long]$response.Content.Headers.ContentLength
        }
        $totalMb = if ($totalBytes) { [math]::Round($totalBytes / 1MB, 1) } else { $null }

        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $fs = [System.IO.File]::Create($OutFile)
        $buffer = New-Object byte[] (1MB)
        [long]$totalRead = 0
        $startTime = Get-Date
        $lastPrintTime = $startTime

        try {
            while ($true) {
                $bytesRead = $stream.Read($buffer, 0, $buffer.Length)
                if ($bytesRead -le 0) { break }
                $fs.Write($buffer, 0, $bytesRead)
                $totalRead += $bytesRead

                $now = Get-Date
                $msSinceLast = ($now - $lastPrintTime).TotalMilliseconds
                if ($msSinceLast -lt 200) { continue }

                $elapsed = ($now - $startTime).TotalSeconds
                $mb = [math]::Round($totalRead / 1MB, 1)
                $speedMbs = if ($elapsed -gt 0) {
                    [math]::Round(($totalRead / 1MB) / $elapsed, 2)
                } else { 0 }

                if ($totalBytes) {
                    $pct = [int](($totalRead / $totalBytes) * 100)
                    $remainingMb = ($totalBytes - $totalRead) / 1MB
                    $etaStr = if ($speedMbs -gt 0) {
                        $sec = [int]($remainingMb / $speedMbs)
                        "{0:00}:{1:00}" -f ([int]($sec / 60)), ($sec % 60)
                    } else { "--:--" }
                    $line = "    {0}: {1,3}% ({2,7:N1} / {3,7:N1} MB) {4,5:N2} MB/s ETA {5}" -f `
                        $DisplayName, $pct, $mb, $totalMb, $speedMbs, $etaStr
                } else {
                    $line = "    {0}: {1,7:N1} MB ({2,5:N2} MB/s)" -f `
                        $DisplayName, $mb, $speedMbs
                }
                # \r returns to start of line; trailing spaces overwrite any
                # leftover characters from a previous (longer) line.
                Write-Host -NoNewline ("`r" + $line + "          ")
                $lastPrintTime = $now
            }

            # Final summary line - overwrite the in-place progress.
            $finalMb = [math]::Round($totalRead / 1MB, 1)
            $totalSec = ((Get-Date) - $startTime).TotalSeconds
            $avgSpeed = if ($totalSec -gt 0) {
                [math]::Round(($totalRead / 1MB) / $totalSec, 2)
            } else { 0 }
            $minutes = [int]($totalSec / 60)
            $seconds = $totalSec - ($minutes * 60)
            $timeStr = if ($minutes -gt 0) {
                "{0}m{1:N0}s" -f $minutes, $seconds
            } else {
                "{0:N1}s" -f $totalSec
            }
            Write-Host ("`r    {0}: done {1,7:N1} MB in {2} (avg {3:N2} MB/s)                              " -f `
                $DisplayName, $finalMb, $timeStr, $avgSpeed)
        }
        finally {
            $fs.Close()
            $stream.Close()
        }
    }
    finally {
        $client.Dispose()
    }
}

Write-Host ""
Write-Host "PII Shield - installing GLiNER model (~634 MB total)"
Write-Host "  Target: $TARGET"
Write-Host ""

New-Item -ItemType Directory -Force -Path $TARGET | Out-Null

$overallStart = Get-Date
foreach ($f in $FILES) {
    $dest = Join-Path $TARGET $f.name
    Download-WithProgress -Uri "$HF_BASE/$($f.url)" -OutFile $dest -DisplayName $f.name
}
$overallSec = ((Get-Date) - $overallStart).TotalSeconds

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
$overallMin = [int]($overallSec / 60)
$overallRemSec = $overallSec - ($overallMin * 60)
$overallTimeStr = if ($overallMin -gt 0) {
    "{0}m{1:N0}s" -f $overallMin, $overallRemSec
} else {
    "{0:N1}s" -f $overallSec
}

Write-Host ""
Write-Host "[OK] Model installed at $TARGET ($modelMb MB, total time $overallTimeStr)" -ForegroundColor Green
Write-Host ""
Write-Host "Next step: install pii-shield-v2.0.2-windows-linux.mcpb from"
Write-Host "  https://github.com/gregmos/PII-Shield/releases"
Write-Host "into Claude Desktop (Settings -> Extensions -> drag-drop)."
Write-Host ""
