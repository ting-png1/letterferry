@echo off
setlocal
cd /d "%~dp0"
set "EdgeExe=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EdgeExe%" set "EdgeExe=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EdgeExe%" (
  echo [ERROR] Microsoft Edge was not found.
  pause
  exit /b 1
)
if not exist "%~dp0web-extension\manifest.json" (
  echo [ERROR] The LetterFerry extension folder is missing.
  pause
  exit /b 1
)
echo.
echo LetterFerry - Step 1 of 2: Open Edge extensions management.
echo The Edge internal page cannot reliably be opened via a command-line URL.
powershell.exe -NoProfile -Command "Set-Clipboard -Value 'edge://extensions/'"
if errorlevel 1 (
  echo [ERROR] Could not copy the Edge page address.
  pause
  exit /b 1
)
start "" "%EdgeExe%" "about:blank"
echo.
echo Address COPIED: edge://extensions/
echo In the new Edge tab, press Ctrl+L, then Ctrl+V, then Enter.
echo Confirm you can see the Edge extensions management page.
echo.
echo AFTER THE EXTENSIONS PAGE IS OPEN, come back to this window.
pause
echo.
echo LetterFerry - Step 2 of 2: Load the local extension folder.
powershell.exe -NoProfile -Command "Set-Clipboard -Value (Join-Path (Get-Location).Path 'web-extension')"
if errorlevel 1 (
  echo [ERROR] Could not copy the extension folder path.
  pause
  exit /b 1
)
echo.
echo Extension folder path COPIED to the clipboard.
echo Enable Developer mode in Edge extensions if needed.
echo Click Load unpacked, paste with Ctrl+V, then choose the folder.
echo The extension is NOT installed automatically; you choose whether to authorize it.
echo.
echo No Weixin listener, ChatGPT message, or local bridge has been started.
pause
