@echo off
setlocal
cd /d "%~dp0"
echo ===================================================
echo LetterFerry Web Weixin - 30-minute live chat (20 max DMs)
echo ===================================================
echo This mode automatically sends Weixin replies after ONE explicit session approval.
echo It archives all older same-peer DMs from the activation batch without replying.
echo The START marker in Weixin is required before automatic chat can begin.
echo Do not start another Weixin session or one-shot at the same time.
echo Persistent capability flags stay OFF. No unattended startup.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "scripts\web-weixin-session.ps1"
if errorlevel 1 echo Session NOT completed normally. Review the safe error before any retry.
pause
