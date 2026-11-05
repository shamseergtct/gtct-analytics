@echo off
setlocal EnableExtensions
title GTCT Restaurant — Non-destructive Restore
cd /d "%~dp0"

call "%~dp0scripts\load-env.cmd"
if errorlevel 1 (
  echo Failed to load pilot environment.
  pause
  exit /b 1
)

echo.
echo  NON-DESTRUCTIVE restore into a NEW folder only.
echo  The live pilot database will NOT be overwritten by this tool.
echo.
echo  Required:
echo    GTCT_TEST_BACKUP_FILE  = full path to verified backup .sqlite
echo    GTCT_TEST_RESTORE_DIR  = %GTCT_TEST_RESTORE_DIR%
echo.
echo  After restore, point GTCT_LOCAL_DATA_DIR at the restore folder ONLY after
echo  stopping the server and getting authorization to switch.
echo.

if not defined GTCT_TEST_BACKUP_FILE (
  echo ERROR: GTCT_TEST_BACKUP_FILE is not set.
  pause
  exit /b 1
)

cd /d "%GTCT_APP_ROOT%"
call npm run backup:test-restore-new
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" (
  echo Restore refused or failed. Live database unchanged.
) else (
  echo Restore wrote into the NEW restore directory only.
)
pause
exit /b %ERR%
