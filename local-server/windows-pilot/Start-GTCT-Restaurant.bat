@echo off
setlocal EnableExtensions
title GTCT Restaurant Pilot
cd /d "%~dp0"

call "%~dp0scripts\load-env.cmd"
if errorlevel 1 (
  echo Failed to load pilot environment.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Run Install-GTCT-Pilot.bat first.
  pause
  exit /b 1
)

if /I not "%GTCT_OPERATING_MODE%"=="TEST" (
  echo ERROR: Only TEST mode is supported. Refusing to start.
  pause
  exit /b 1
)

if /I "%GTCT_ENABLE_PHYSICAL_PRINT%"=="true" (
  echo.
  echo WARNING: Physical printing is ENABLED in env.pilot.cmd
  echo Automatic kitchen/cashier dispatch may send jobs to LAN printers.
  echo Press Ctrl+C now to cancel, or
  pause
)

mkdir "%GTCT_LOCAL_DATA_DIR%" >nul 2>&1
mkdir "%GTCT_TEST_BACKUP_DIR%" >nul 2>&1

echo.
echo  Starting GTCT Restaurant Local Server ^(Pilot^)
echo  ----------------------------------------------
echo  URL:      http://%GTCT_LOCAL_HOST%:%GTCT_LOCAL_PORT%/
echo  Data:     %GTCT_LOCAL_DATA_DIR%
echo  Mode:     %GTCT_OPERATING_MODE%
echo  Print:    GTCT_ENABLE_PHYSICAL_PRINT=%GTCT_ENABLE_PHYSICAL_PRINT%
echo.
echo  Keep this window open while the restaurant is using the system.
echo  Close the window ^(or Ctrl+C^) to stop the server safely.
echo.

start "" "http://%GTCT_LOCAL_HOST%:%GTCT_LOCAL_PORT%/"

cd /d "%GTCT_APP_ROOT%"
node src\index.js
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" (
  echo Server exited with error code %ERR%.
) else (
  echo Server stopped.
)
pause
exit /b %ERR%
