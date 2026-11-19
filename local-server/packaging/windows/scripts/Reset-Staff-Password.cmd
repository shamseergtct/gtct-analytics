@echo off
setlocal
REM Reset a staff password using the shop database on this PC.
REM Installed next to GTCTRestaurantPilot.exe under Program Files.

set "DATA=%LOCALAPPDATA%\GTCT\RestaurantPilot"
set "GTCT_LOCAL_DATA_DIR=%DATA%"
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

REM Developer fallback when this file still lives under packaging\windows\scripts
if not exist "%ROOT%\app\package.json" (
  if exist "%ProgramFiles%\GTCT\Restaurant Pilot\app\package.json" (
    set "ROOT=%ProgramFiles%\GTCT\Restaurant Pilot"
  )
)

set "APP=%ROOT%\app"
set "NODE=%ROOT%\runtime\win-x64\node.exe"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
  if exist "%ROOT%\runtime\win-arm64\node.exe" set "NODE=%ROOT%\runtime\win-arm64\node.exe"
)

if not exist "%NODE%" (
  echo Could not find bundled Node at:
  echo   %NODE%
  echo Install GTCT Restaurant Pilot, or from a developer checkout run:
  echo   cd local-server
  echo   npm run admin:reset-password
  pause
  exit /b 1
)

if not exist "%APP%\src\scripts\resetStaffPassword.js" (
  echo Could not find reset script under:
  echo   %APP%
  pause
  exit /b 1
)

echo GTCT Restaurant — reset staff password
echo Database folder: %DATA%
echo.
cd /d "%APP%"
"%NODE%" "src\scripts\resetStaffPassword.js" %*
set "EC=%ERRORLEVEL%"
echo.
if not "%EC%"=="0" (
  echo Reset did not complete.
) else (
  echo Done. Open the restaurant page and sign in with the new password.
)
pause
exit /b %EC%
