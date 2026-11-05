@echo off
REM Loads windows-pilot\env.pilot.cmd from the package, else falls back to example defaults.
set "GTCT_PILOT_ROOT=%~dp0.."
call :normalize "%GTCT_PILOT_ROOT%"
set "GTCT_PILOT_ROOT=%_NORM%"
set "GTCT_APP_ROOT=%GTCT_PILOT_ROOT%\.."
call :normalize "%GTCT_APP_ROOT%"
set "GTCT_APP_ROOT=%_NORM%"

if exist "%GTCT_PILOT_ROOT%\env.pilot.cmd" (
  call "%GTCT_PILOT_ROOT%\env.pilot.cmd"
) else if exist "%GTCT_PILOT_ROOT%\env.pilot.example" (
  echo WARNING: env.pilot.cmd missing — using env.pilot.example defaults.
  call "%GTCT_PILOT_ROOT%\env.pilot.example"
) else (
  echo ERROR: No env.pilot.cmd or env.pilot.example found.
  exit /b 1
)

if not defined GTCT_OPERATING_MODE set "GTCT_OPERATING_MODE=TEST"
if not defined GTCT_LOCAL_HOST set "GTCT_LOCAL_HOST=127.0.0.1"
if not defined GTCT_LOCAL_PORT set "GTCT_LOCAL_PORT=8787"
if not defined GTCT_LOCAL_DATA_DIR set "GTCT_LOCAL_DATA_DIR=%LOCALAPPDATA%\GTCT\RestaurantPilot"
if not defined GTCT_TEST_BACKUP_DIR set "GTCT_TEST_BACKUP_DIR=%LOCALAPPDATA%\GTCT\RestaurantPilot-Backups"
if not defined GTCT_ENABLE_PHYSICAL_PRINT set "GTCT_ENABLE_PHYSICAL_PRINT=false"

exit /b 0

:normalize
set "_NORM=%~f1"
exit /b 0
