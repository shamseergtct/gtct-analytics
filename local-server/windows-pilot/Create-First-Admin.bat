@echo off
setlocal EnableExtensions
title GTCT Restaurant — Create First Admin
cd /d "%~dp0"

call "%~dp0scripts\load-env.cmd"
if errorlevel 1 (
  echo Failed to load pilot environment.
  pause
  exit /b 1
)

echo.
echo  Create the first administrator for THIS pilot database only.
echo  Data directory: %GTCT_LOCAL_DATA_DIR%
echo  There is no default password. Choose a strong password and store it safely.
echo  Leave the main server stopped ^(or create admin before first sales day^).
echo.

cd /d "%GTCT_APP_ROOT%"
call npm run admin:create
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" (
  echo Admin creation failed.
) else (
  echo Done. Sign in at http://%GTCT_LOCAL_HOST%:%GTCT_LOCAL_PORT%/
)
pause
exit /b %ERR%
