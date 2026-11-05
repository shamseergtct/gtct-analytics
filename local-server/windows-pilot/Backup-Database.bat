@echo off
setlocal EnableExtensions
title GTCT Restaurant — Safe SQLite Backup
cd /d "%~dp0"

call "%~dp0scripts\load-env.cmd"
if errorlevel 1 (
  echo Failed to load pilot environment.
  pause
  exit /b 1
)

echo.
echo  Creating a SQLite-safe verified backup ^(Online Backup API^).
echo  Source data:  %GTCT_LOCAL_DATA_DIR%
echo  Backup folder: %GTCT_TEST_BACKUP_DIR%
echo.
echo  Do NOT copy gtct-local.sqlite by hand while the server is running.
echo.

cd /d "%GTCT_APP_ROOT%"
call npm run backup:test
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" goto fail

echo.
echo  Verifying newest backup health via backup:status ...
call npm run backup:status
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" goto fail

echo.
echo  Backup complete. Store a copy of the backup folder off this PC when practical.
pause
exit /b 0

:fail
echo.
echo  Backup refused or failed. The live database was not modified by this script.
pause
exit /b %ERR%
