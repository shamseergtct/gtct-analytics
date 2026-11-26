#!/usr/bin/env bash
# Start the local server on this Mac's private LAN IP with HTTPS for tablets/PCs.
# Watches Wi-Fi/router changes: rebinds to the new IP (or falls back to
# http://127.0.0.1:8787 when there is no network), same idea as the Windows host.
# Physical print stays enabled when GTCT_ENABLE_PHYSICAL_PRINT=true (default here).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST_NAME="${GTCT_LAN_HOSTNAME:-gtct-pos}"
TLS_DIR="${GTCT_TLS_DIR:-$HOME/Library/Application Support/GTCT/RestaurantLocalServer/tls}"
CERT="${GTCT_TLS_CERT_FILE:-$TLS_DIR/${HOST_NAME}.crt}"
KEY="${GTCT_TLS_KEY_FILE:-$TLS_DIR/${HOST_NAME}.key}"
PORT="${GTCT_LOCAL_PORT:-8787}"
WATCH_SECS="${GTCT_LAN_WATCH_SECS:-15}"
# Capture any manual override once; do not treat the running bind as a permanent pin
# or Wi-Fi changes would never be detected.
FIXED_LAN_BIND="${GTCT_LAN_BIND_ADDRESS:-}"

detect_lan_ip() {
  local ip=""
  if [[ -n "$FIXED_LAN_BIND" ]]; then
    printf '%s' "$FIXED_LAN_BIND"
    return 0
  fi
  ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [[ -z "$ip" ]]; then
    ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  if [[ -z "$ip" ]]; then
    local iface
    iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}' || true)"
    if [[ -n "$iface" ]]; then
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    fi
  fi
  printf '%s' "$ip"
}

ip_still_on_mac() {
  local want="$1"
  [[ -n "$want" ]] || return 1
  ifconfig 2>/dev/null | grep -F "inet ${want} " >/dev/null 2>&1
}

# Cloud delivery bridge secret (same value as Firebase RESTAURANT_DELIVERY_BRIDGE_SECRET).
SECRET_FILE="${GTCT_CLOUD_BRIDGE_SECRET_FILE:-$HOME/Library/Application Support/GTCT/RestaurantLocalServer/cloud-bridge.secret}"
if [[ -z "${GTCT_CLOUD_BRIDGE_SECRET:-}" && -f "$SECRET_FILE" ]]; then
  export GTCT_CLOUD_BRIDGE_SECRET="$(tr -d '\r\n' < "$SECRET_FILE")"
fi

export GTCT_OPERATING_MODE=TEST
export GTCT_LOCAL_PORT="$PORT"
export GTCT_ENABLE_PHYSICAL_PRINT="${GTCT_ENABLE_PHYSICAL_PRINT:-true}"
export GTCT_LAN_HOSTNAME="$HOST_NAME"

SERVER_PID=""
CURRENT_MODE="" # lan | loopback
CURRENT_IP=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

start_loopback() {
  echo "No private Wi-Fi/LAN address — starting on this Mac only"
  echo "  open: http://127.0.0.1:${PORT}/"
  echo "  (phones/tablets need Wi-Fi; the app will switch to LAN when the network returns)"
  echo

  unset GTCT_LOCAL_HOST GTCT_LAN_BIND_ADDRESS GTCT_ALLOW_LAN_BIND GTCT_ENABLE_LAN_LISTENER \
    GTCT_TLS_CERT_FILE GTCT_TLS_KEY_FILE || true
  export GTCT_LOCAL_HOST=127.0.0.1
  export GTCT_ALLOW_LAN_BIND=false
  export GTCT_ENABLE_LAN_LISTENER=false

  npm start &
  SERVER_PID=$!
  CURRENT_MODE="loopback"
  CURRENT_IP=""
}

start_lan() {
  local lan_ip="$1"
  export GTCT_LAN_BIND_ADDRESS="$lan_ip"
  # Always refresh cert so the current Wi-Fi IP is inside the certificate (needed for iPhone).
  bash "$ROOT/scripts/generate-mac-lan-cert.sh"

  if [[ ! -f "$CERT" || ! -f "$KEY" ]]; then
    echo "Missing TLS files after cert generation — falling back to loopback."
    start_loopback
    return
  fi

  export GTCT_LOCAL_HOST="$lan_ip"
  export GTCT_ALLOW_LAN_BIND=true
  export GTCT_ENABLE_LAN_LISTENER=true
  export GTCT_TLS_CERT_FILE="$CERT"
  export GTCT_TLS_KEY_FILE="$KEY"

  echo "Starting GTCT TEST LAN listener"
  echo "  bind: ${lan_ip}:${PORT}"
  echo "  phone URL: https://${lan_ip}:${PORT}/pair.html"
  echo "  named URL: https://${HOST_NAME}:${PORT} (needs hosts entry)"
  echo "  this Mac also: http://127.0.0.1:${PORT}/"
  echo "  physical print: ${GTCT_ENABLE_PHYSICAL_PRINT}"
  if [[ -n "${GTCT_CLOUD_BRIDGE_SECRET:-}" ]]; then
    echo "  cloud bridge secret: loaded"
  else
    echo "  cloud bridge secret: missing (Shop orders will not sync)"
  fi
  echo "  network watch: every ${WATCH_SECS}s (auto-reconnect on router/Wi-Fi change)"
  echo

  npm start &
  SERVER_PID=$!
  CURRENT_MODE="lan"
  CURRENT_IP="$lan_ip"
}

stop_server() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Stopping server (pid ${SERVER_PID}) to rebind…"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
}

# First boot
FIRST_IP="$(detect_lan_ip)"
if [[ -n "$FIRST_IP" ]]; then
  start_lan "$FIRST_IP"
else
  start_loopback
fi

# Watch for router / Wi-Fi changes (same behaviour as Windows host launcher).
while true; do
  sleep "$WATCH_SECS"

  if [[ -n "$SERVER_PID" ]] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server exited — restarting…"
    SERVER_PID=""
    NEW_IP="$(detect_lan_ip)"
    if [[ -n "$NEW_IP" ]]; then
      start_lan "$NEW_IP"
    else
      start_loopback
    fi
    continue
  fi

  NEW_IP="$(detect_lan_ip)"

  if [[ "$CURRENT_MODE" == "lan" ]]; then
    if ! ip_still_on_mac "$CURRENT_IP"; then
      echo "LAN address ${CURRENT_IP} is gone (router/Wi-Fi changed)."
      stop_server
      if [[ -n "$NEW_IP" ]]; then
        echo "Rebinding to ${NEW_IP}"
        start_lan "$NEW_IP"
      else
        start_loopback
      fi
    elif [[ -n "$NEW_IP" && "$NEW_IP" != "$CURRENT_IP" ]] && ip_still_on_mac "$NEW_IP"; then
      # Prefer the default-route interface IP if it moved (e.g. switched networks).
      echo "Preferred LAN address changed ${CURRENT_IP} → ${NEW_IP}"
      stop_server
      start_lan "$NEW_IP"
    fi
  elif [[ "$CURRENT_MODE" == "loopback" && -n "$NEW_IP" ]]; then
    echo "Network is available again — switching to LAN ${NEW_IP}"
    stop_server
    start_lan "$NEW_IP"
  fi
done
