# Trust the GTCT Restaurant Pilot self-signed LAN certificate for this Windows user.
# After this, Edge/Chrome should stop showing "Not secure" for https://<lan-ip>:8787
# on THIS PC. Repeat on each tablet/PC that opens the restaurant URL.
#
# Run in PowerShell (current user is enough for browsers):
#   powershell -ExecutionPolicy Bypass -File trust-lan-cert.ps1

param(
  [string]$CertPath = "$env:LOCALAPPDATA\GTCT\RestaurantPilot\tls\gtct-pos.crt",
  [string]$StoreName = "Root",
  [string]$StoreLocation = "CurrentUser"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $CertPath)) {
  Write-Error "Certificate not found: $CertPath`nStart GTCT Restaurant Host once so it can create the LAN certificate."
}

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertPath)
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store($StoreName, $StoreLocation)
$store.Open("ReadWrite")
try {
  $existing = $store.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
  if ($existing) {
    Write-Host "Already trusted: $($cert.Subject) ($($cert.Thumbprint))"
  } else {
    $store.Add($cert)
    Write-Host "Trusted certificate: $($cert.Subject)"
    Write-Host "Thumbprint: $($cert.Thumbprint)"
  }
} finally {
  $store.Close()
}

Write-Host ""
Write-Host "Close all Edge/Chrome windows, then reopen https://<this-pc-lan-ip>:8787"
Write-Host "The address bar should no longer show Not secure for this TEST certificate."
Write-Host "Note: traffic was already encrypted with HTTPS; the warning was only about the untrusted self-signed cert."
