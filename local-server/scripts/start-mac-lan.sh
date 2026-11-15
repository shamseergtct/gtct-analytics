#!/usr/bin/env bash
# Start the local server on this Mac's private LAN IP with HTTPS for tablets/PCs.
# Physical print stays enabled when GTCT_ENABLE_PHYSICAL_PRINT=true (default here).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST_NAME="${GTCT_LAN_HOSTNAME:-gtct-pos}"
TLS_DIR="${GTCT_TLS_DIR:-$HOME/Library/Application Support/GTCT/RestaurantLocalServer/tls}"
CERT="${GTCT_TLS_CERT_FILE:-$TLS_DIR/${HOST_NAME}.crt}"
KEY="${GTCT_TLS_KEY_FILE:-$TLS_DIR/${HOST_NAME}.key}"
PORT="${GTCT_LOCAL_PORT:-8787}"

# Prefer a private ethernet/Wi-Fi IPv4 address on this Mac.
LAN_IP="${GTCT_LAN_BIND_ADDRESS:-}"
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
fi
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}' | xargs -I{} ipconfig getifaddr {} 2>/dev/null || true)"
fi
if [[ -z "$LAN_IP" ]]; then
  echo "Could not detect a private LAN IP. Set GTCT_LAN_BIND_ADDRESS=192.168.x.x"
  exit 1
fi

export GTCT_LAN_BIND_ADDRESS="$LAN_IP"
# Always refresh cert so the current Wi-Fi IP is inside the certificate (needed for iPhone).
bash "$ROOT/scripts/generate-mac-lan-cert.sh"

if [[ ! -f "$CERT" || ! -f "$KEY" ]]; then
  echo "Missing TLS files after cert generation."
  exit 1
fi

export GTCT_OPERATING_MODE=TEST
export GTCT_LOCAL_HOST="$LAN_IP"
export GTCT_ALLOW_LAN_BIND=true
export GTCT_ENABLE_LAN_LISTENER=true
export GTCT_LAN_HOSTNAME="$HOST_NAME"
export GTCT_TLS_CERT_FILE="$CERT"
export GTCT_TLS_KEY_FILE="$KEY"
export GTCT_LOCAL_PORT="$PORT"
export GTCT_ENABLE_PHYSICAL_PRINT="${GTCT_ENABLE_PHYSICAL_PRINT:-true}"

# Cloud delivery bridge secret (same value as Firebase RESTAURANT_DELIVERY_BRIDGE_SECRET).
SECRET_FILE="${GTCT_CLOUD_BRIDGE_SECRET_FILE:-$HOME/Library/Application Support/GTCT/RestaurantLocalServer/cloud-bridge.secret}"
if [[ -z "${GTCT_CLOUD_BRIDGE_SECRET:-}" && -f "$SECRET_FILE" ]]; then
  export GTCT_CLOUD_BRIDGE_SECRET="$(tr -d '\r\n' < "$SECRET_FILE")"
fi

echo "Starting GTCT TEST LAN listener"
echo "  bind: ${LAN_IP}:${PORT}"
echo "  phone URL: https://${LAN_IP}:${PORT}/pair.html"
echo "  named URL: https://${HOST_NAME}:${PORT} (needs hosts entry)"
echo "  physical print: ${GTCT_ENABLE_PHYSICAL_PRINT}"
if [[ -n "${GTCT_CLOUD_BRIDGE_SECRET:-}" ]]; then
  echo "  cloud bridge secret: loaded"
else
  echo "  cloud bridge secret: missing (Shop orders will not sync)"
fi
echo

exec npm start
