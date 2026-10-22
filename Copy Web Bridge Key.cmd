@echo off
setlocal
cd /d "%~dp0"
echo.
echo LetterFerry local Web Bridge setup
if not exist "data\web-host.key" (
  echo The private key does not exist yet. Start ChatGPT Web Host once first.
  pause
  exit /b 1
)
powershell.exe -NoProfile -Command "Get-Content -LiteralPath 'data\web-host.key' -Raw | Set-Clipboard"
if errorlevel 1 (
 echo Clipboard copy failed.
) else (
 echo Local setup key copied to Windows clipboard. Paste only into the LetterFerry Edge extension popup.
)
pause
