# GTCT Restaurant Pilot (TEST) — LAN prepare for plug & play.
# Run elevated (installer / SYSTEM startup task). Safe to re-run.
#
# 1) Adds inbound allow rules for TCP 8787 + bundled node.exe (x64 + arm64)
# 2) Marks Wi‑Fi/Ethernet as Private when possible
# 3) If Group Policy blocks local firewall rules (or a prior pilot lock file exists),
#    turns Windows Firewall OFF permanently for this TEST pilot so phones keep working
#    across reboots even if someone turns Firewall back on.

param(
  [string]$InstallDir = "",
  [int]$Port = 8787
)

$ErrorActionPreference = "Continue"
$RulePort = "GTCT Restaurant Pilot HTTPS"
$RuleNodeX64 = "GTCT Restaurant Pilot Node x64"
$RuleNodeArm = "GTCT Restaurant Pilot Node ARM64"

# ProgramData works for both interactive Admin install and SYSTEM startup task.
$DataDir = Join-Path $env:ProgramData "GTCT\RestaurantPilot"
$Marker = Join-Path $DataDir "lan-access-prepared.txt"
$OverrideMarker = Join-Path $DataDir "firewall-disabled-by-pilot.txt"
$ForceOffMarker = Join-Path $DataDir "force-firewall-off.txt"
$LogFile = Join-Path $DataDir "lan-prepare.log"

function Write-Log([string]$msg) {
  $line = "$(Get-Date -Format o) $msg"
  Write-Host $msg
  try { Add-Content -LiteralPath $LogFile -Value $line -ErrorAction SilentlyContinue } catch {}
}

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-Dir([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
  }
}

function Remove-Rule([string]$name) {
  & netsh advfirewall firewall delete rule name="$name" | Out-Null
}

function Add-PortRule {
  Remove-Rule $RulePort
  & netsh advfirewall firewall add rule name="$RulePort" dir=in action=allow protocol=TCP localport=$Port profile=any enable=yes | Out-Null
  Write-Log "Firewall port rule: TCP $Port ($RulePort)"
}

function Add-ProgramRule([string]$name, [string]$exe) {
  if (-not (Test-Path -LiteralPath $exe)) { return }
  Remove-Rule $name
  & netsh advfirewall firewall add rule name="$name" dir=in action=allow program="$exe" enable=yes profile=any | Out-Null
  Write-Log "Firewall program rule: $name"
}

function Test-LocalFirewallRulesBlocked {
  $out = & netsh advfirewall show allprofiles | Out-String
  if ($out -match "LocalFirewallRules:\s*N/A \(GPO-store only\)") { return $true }
  if ($out -match "LocalFirewallRules:\s*Disable") { return $true }
  return $false
}

function Set-NetworksPrivate {
  try {
    Get-NetConnectionProfile -ErrorAction Stop | ForEach-Object {
      if ($_.NetworkCategory -ne "Private") {
        try {
          Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private -ErrorAction Stop
          Write-Log "Network '$($_.Name)' set to Private"
        } catch {
          Write-Log "Could not set '$($_.Name)' to Private: $($_.Exception.Message)"
        }
      }
    }
  } catch {
    Write-Log "Network category helper unavailable: $($_.Exception.Message)"
  }
}

function Disable-FirewallForPilot([string]$reason) {
  & netsh advfirewall set allprofiles state off | Out-Null
  @"
disabled=$(Get-Date -Format o)
reason=$reason
port=$Port
"@ | Set-Content -Path $OverrideMarker -Encoding ASCII
  @"
force=1
since=$(Get-Date -Format o)
reason=$reason
"@ | Set-Content -Path $ForceOffMarker -Encoding ASCII
  Write-Log "Windows Firewall OFF for TEST pilot ($reason)"
}

if (-not (Test-IsAdmin)) {
  Write-Log "ERROR: prepare-lan-access.ps1 must run as Administrator / SYSTEM."
  exit 1
}

Ensure-Dir $DataDir

if (-not $InstallDir) {
  $InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  if (-not (Test-Path (Join-Path $InstallDir "runtime"))) {
    $InstallDir = "C:\Program Files\GTCT\Restaurant Pilot"
  }
}

Write-Log "=== GTCT LAN prepare (TEST plug & play) ==="
Write-Log "InstallDir=$InstallDir  Port=$Port  User=$([Security.Principal.WindowsIdentity]::GetCurrent().Name)"

Add-PortRule
Add-ProgramRule $RuleNodeX64 (Join-Path $InstallDir "runtime\win-x64\node.exe")
Add-ProgramRule $RuleNodeArm (Join-Path $InstallDir "runtime\win-arm64\node.exe")
Set-NetworksPrivate

$gpoBlocksLocal = Test-LocalFirewallRulesBlocked
$forceOff = Test-Path -LiteralPath $ForceOffMarker

if ($gpoBlocksLocal -or $forceOff) {
  $reason = if ($gpoBlocksLocal) { "GPO blocks local firewall rules" } else { "force-firewall-off marker" }
  Write-Log "Applying permanent TEST LAN open: $reason"
  Disable-FirewallForPilot $reason
} else {
  Write-Log "Local firewall rules are allowed — Firewall stays ON with GTCT allow rules."
  if (Test-Path -LiteralPath $OverrideMarker) {
    Remove-Item -LiteralPath $OverrideMarker -Force -ErrorAction SilentlyContinue
  }
}

@"
prepared=$(Get-Date -Format o)
installDir=$InstallDir
port=$Port
gpoBlocksLocal=$gpoBlocksLocal
forceOff=$forceOff
pairHint=https://<this-pc-lan-ip>:${Port}/pair.html
"@ | Set-Content -Path $Marker -Encoding ASCII

Write-Log "LAN prepare complete. Phones/tablets: https://<lan-ip>:$Port/pair.html"
exit 0
