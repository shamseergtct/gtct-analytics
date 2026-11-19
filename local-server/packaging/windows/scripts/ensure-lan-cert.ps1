# Optional manual TLS helper for GTCT Restaurant Pilot (TEST).
# The Windows host launcher normally generates certs itself in Go.
# Use this script only for ops troubleshooting.
#
# Usage (PowerShell as the restaurant Windows user):
#   powershell -ExecutionPolicy Bypass -File ensure-lan-cert.ps1 -LanIp 192.168.1.50

param(
  [Parameter(Mandatory = $true)][string]$LanIp,
  [string]$Hostname = "gtct-pos",
  [string]$OutDir = "$env:LOCALAPPDATA\GTCT\RestaurantPilot\tls"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$certPath = Join-Path $OutDir "$Hostname.crt"
$keyPath = Join-Path $OutDir "$Hostname.key"
$metaPath = Join-Path $OutDir "$Hostname.ip"

# Prefer openssl if present; otherwise ask the host launcher to regenerate on next start.
$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $openssl) {
  Write-Host "openssl not found. Delete $metaPath and restart GTCTRestaurantPilot.exe --host to regenerate."
  exit 1
}

$cfg = Join-Path $OutDir "$Hostname.cnf"
@"
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = $Hostname
O = GTCT Restaurant TEST
OU = Local Terminal LAN

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = $Hostname
IP.1 = $LanIp
"@ | Set-Content -Path $cfg -Encoding ASCII

& openssl req -x509 -nodes -newkey rsa:2048 -keyout $keyPath -out $certPath -days 825 -config $cfg
Set-Content -Path $metaPath -Value $LanIp -NoNewline
Write-Host "Certificate: $certPath"
Write-Host "Private key: $keyPath"
Write-Host "Open on tablets: https://${LanIp}:8787/pair.html"
