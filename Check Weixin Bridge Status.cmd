@echo off
setlocal
cd /d "%~dp0"
echo LetterFerry Weixin Bridge - read-only readiness check
echo No listening session or browser automation will start.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\check-bridge-readiness.ps1"
echo.
pause
