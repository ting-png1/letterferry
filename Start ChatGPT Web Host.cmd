@echo off
setlocal
cd /d "%~dp0"
echo.
echo LetterFerry ChatGPT Web Host - local manual mode
echo Does NOT start Weixin polling or send messages on its own.
echo The user must bind and arm one ChatGPT tab in Edge separately.
echo Close this console or press Ctrl+C to stop.
echo.
node scripts\start-web-host.mjs
if errorlevel 1 echo Web Host startup failed. Check port 8799 or configuration.
echo.
pause
