@echo off
setlocal
set "PS1=%~dp0trust-lan-cert.ps1"
if not exist "%PS1%" (
  echo Missing: %PS1%
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "EC=%ERRORLEVEL%"
echo.
pause
exit /b %EC%
