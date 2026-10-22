@echo off
setlocal
cd /d "%~dp0"
echo LetterFerry Weixin one-shot: send reviewed reply, EXACTLY ONE
echo Foreground only. Confirm the test at the prompts. No automatic retry.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "scripts\web-weixin-one-shot.ps1" -Stage send
if errorlevel 1 echo Test stopped or requires manual review. Do not retry automatically.
pause
