# GTCT Restaurant — Windows pilot install (Node 24 + native better-sqlite3).
# Does not enable physical printing or PRODUCTION mode.
$ErrorActionPreference = 'Stop'

$PilotRoot = Split-Path -Parent $PSScriptRoot
$AppRoot = Split-Path -Parent $PilotRoot
Set-Location $AppRoot

Write-Host "Application root: $AppRoot"

function Assert-Node24 {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw @"
Node.js was not found.

1. Download Node.js 24 LTS (Windows x64 MSI) from https://nodejs.org/
2. Install for all users (or current user).
3. Close and reopen this window, then run Install-GTCT-Pilot.bat again.

Do not copy node_modules from a Mac. better-sqlite3 must compile on Windows.
"@
  }
  $ver = (& node -v).Trim()
  Write-Host "Detected Node: $ver"
  if ($ver -notmatch '^v24\.') {
    throw "Node.js 24.x is required (found $ver). Uninstall other majors or fix PATH."
  }
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npm) { throw 'npm was not found on PATH after Node install.' }
}

Assert-Node24

$EnvExample = Join-Path $PilotRoot 'env.pilot.example'
$EnvFile = Join-Path $PilotRoot 'env.pilot.cmd'
if (-not (Test-Path $EnvFile)) {
  Copy-Item -Path $EnvExample -Destination $EnvFile
  Write-Host "Created $EnvFile"
} else {
  Write-Host "Keeping existing $EnvFile"
}

# Parse data/backup dirs from env file for folder creation (simple SET lines).
$envText = Get-Content $EnvFile -Raw
function Read-EnvValue([string]$name, [string]$fallback) {
  if ($envText -match ("(?im)^\s*set\s+`"$([regex]::Escape($name))=(.+?)`"")) {
    $raw = $Matches[1]
    return [Environment]::ExpandEnvironmentVariables($raw.Trim())
  }
  return [Environment]::ExpandEnvironmentVariables($fallback)
}

$DataDir = Read-EnvValue 'GTCT_LOCAL_DATA_DIR' '%LOCALAPPDATA%\GTCT\RestaurantPilot'
$BackupDir = Read-EnvValue 'GTCT_TEST_BACKUP_DIR' '%LOCALAPPDATA%\GTCT\RestaurantPilot-Backups'
$RestoreDir = Read-EnvValue 'GTCT_TEST_RESTORE_DIR' '%LOCALAPPDATA%\GTCT\RestaurantPilot-Restore'

foreach ($dir in @($DataDir, $BackupDir, $RestoreDir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Write-Host "Ensured directory: $dir"
}

# Reserved production path must remain untouched / empty for this pilot.
$ReservedProd = Join-Path $env:LOCALAPPDATA 'GTCT\RestaurantProductionServer'
if (-not (Test-Path $ReservedProd)) {
  New-Item -ItemType Directory -Force -Path $ReservedProd | Out-Null
  Set-Content -Path (Join-Path $ReservedProd 'README-RESERVED.txt') -Value @(
    'RESERVED for a future sealed PRODUCTION vault.',
    'The pilot server must NOT use this folder.',
    'Do not place the pilot database here.'
  )
}

Write-Host ''
Write-Host 'Installing npm dependencies (compiles better-sqlite3 for Windows)...'
if (Test-Path (Join-Path $AppRoot 'package-lock.json')) {
  npm ci
} else {
  npm install
}

Write-Host ''
Write-Host 'Smoke-checking better-sqlite3 native binding...'
node -e "import('better-sqlite3').then((m)=>{const Database=m.default; const db=new Database(':memory:'); db.exec('select 1'); console.log('better-sqlite3 OK');})"

# Desktop shortcut to the staff launcher
$Launcher = Join-Path $PilotRoot 'Start-GTCT-Restaurant.bat'
$Desktop = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $Desktop 'GTCT Restaurant Pilot.lnk'
$Wsh = New-Object -ComObject WScript.Shell
$Sc = $Wsh.CreateShortcut($ShortcutPath)
$Sc.TargetPath = $Launcher
$Sc.WorkingDirectory = $PilotRoot
$Sc.Description = 'Start GTCT Restaurant Local Server (Pilot / TEST)'
$Sc.Save()
Write-Host "Desktop shortcut: $ShortcutPath"

Write-Host ''
Write-Host 'Install complete.'
Write-Host "  Data dir:   $DataDir"
Write-Host "  Backup dir: $BackupDir"
Write-Host '  Physical print: OFF (see env.pilot.cmd)'
Write-Host '  Mode: TEST only'
