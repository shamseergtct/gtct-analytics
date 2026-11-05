@echo off
setlocal EnableExtensions
title GTCT Restaurant — Pilot Install
cd /d "%~dp0"

echo.
echo  GTCT Restaurant Local Server — Windows Pilot Install
echo  =====================================================
echo  This installs dependencies on THIS PC only.
echo  Physical printing stays OFF. PRODUCTION mode is not enabled.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Install-GTCT-Pilot.ps1"
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" (
  echo Install finished with errors. See messages above.
  pause
  exit /b %ERR%
)
echo Install finished. Next: run Create-First-Admin.bat, then Start-GTCT-Restaurant.bat
pause
exit /b 0
