@echo off
setlocal EnableExtensions
title GTCT — Enable Physical Print (APPROVAL REQUIRED)
cd /d "%~dp0"

echo.
echo  ============================================================
echo   PHYSICAL PRINT ENABLEMENT — AUTHORIZATION REQUIRED
echo  ============================================================
echo.
echo  This does NOT print anything by itself.
echo  It only flips GTCT_ENABLE_PHYSICAL_PRINT=true in env.pilot.cmd
echo  AFTER you type the confirmation phrase.
echo.
echo  Prerequisites before enabling:
echo   1. Install and admin setup completed on this Windows PC
echo   2. Printers configured in Admin UI ^(NETWORK_TCP / MJ330_RASTER^)
echo   3. Manual test-print verified on Kitchen and Cashier printers
echo   4. physicalDispatchEnabled set per printer in Admin UI
echo   5. Explicit restaurant owner / GTCT authorization recorded
echo.
echo  Type exactly: ENABLE PHYSICAL PRINT
set /p "CONFIRM=> "
if /I not "%CONFIRM%"=="ENABLE PHYSICAL PRINT" (
  echo Cancelled. Physical print remains unchanged.
  pause
  exit /b 1
)

if not exist "%~dp0env.pilot.cmd" (
  copy /Y "%~dp0env.pilot.example" "%~dp0env.pilot.cmd" >nul
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='%~dp0env.pilot.cmd'; $c=Get-Content -Raw $p; if($c -notmatch 'GTCT_ENABLE_PHYSICAL_PRINT'){ throw 'env.pilot.cmd missing GTCT_ENABLE_PHYSICAL_PRINT' }; $c=[regex]::Replace($c,'(?im)^(\s*set\s+\"GTCT_ENABLE_PHYSICAL_PRINT=).*?(\")','${1}true${2}'); Set-Content -Path $p -Value $c -NoNewline; Write-Host 'Updated env.pilot.cmd: GTCT_ENABLE_PHYSICAL_PRINT=true'"

if errorlevel 1 (
  echo Failed to update env.pilot.cmd
  pause
  exit /b 1
)

echo.
echo  Physical print flag is now true for the NEXT server start.
echo  Restart Start-GTCT-Restaurant.bat to apply.
echo  Automatic dispatch can send real jobs — monitor Printer Settings carefully.
echo  Duplicate prevention still relies on print job status transitions; do not
echo  manually re-queue the same kitchen ticket without checking job history.
pause
exit /b 0
