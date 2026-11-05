@echo off
setlocal EnableExtensions
title GTCT Restaurant — Verify Backup
cd /d "%~dp0"

call "%~dp0scripts\load-env.cmd"
if errorlevel 1 (
  echo Failed to load pilot environment.
  pause
  exit /b 1
)

echo.
echo  Set GTCT_TEST_BACKUP_FILE to the full path of a gtct-test-*.sqlite backup,
echo  then run this script. Example:
echo    set GTCT_TEST_BACKUP_FILE=%GTCT_TEST_BACKUP_DIR%\gtct-test-....sqlite
echo.

if not defined GTCT_TEST_BACKUP_FILE (
  echo ERROR: GTCT_TEST_BACKUP_FILE is not set.
  pause
  exit /b 1
)

cd /d "%GTCT_APP_ROOT%"
call npm run backup:test-verify
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" (
  echo Verification failed.
) else (
  echo Verification OK.
)
pause
exit /b %ERR%
