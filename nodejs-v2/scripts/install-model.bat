@echo off
rem PII Shield — double-click launcher for install-model.ps1 on Windows.
rem Bypasses the default .ps1 "open in Notepad" behaviour without changing
rem system ExecutionPolicy. `pause` keeps the window open so the user can
rem read the summary before closing.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-model.ps1"
echo.
pause
