@echo off
setlocal
set "PS1=%~dp0prepare-lan-access.ps1"
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -InstallDir "%ROOT%"
set "EC=%ERRORLEVEL%"
echo.
if not "%EC%"=="0" (
  echo LAN prepare failed. Run this file as Administrator.
) else (
  echo Done. Open https://^<this-pc-ip^>:8787/pair.html on phones on the same Wi-Fi.
)
pause
exit /b %EC%
