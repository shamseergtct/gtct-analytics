#!/usr/bin/env bash
# Essential packaging + isolated TEST startup check (Mac/Linux packager host).
# Does not enable physical print. Does not touch reserved production paths.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/gtct-windows-pilot-smoke-XXXXXX)"
DATA="$TMP/data"
BACKUP="$TMP/backups"
PORT="${GTCT_SMOKE_PORT:-8791}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

mkdir -p "$DATA" "$BACKUP"
echo "Isolated data: $DATA"

# Port must be free
if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "ERROR: port $PORT already in use — refusing to disturb listeners."
    exit 1
  fi
fi

cd "$ROOT"
export GTCT_OPERATING_MODE=TEST
export GTCT_LOCAL_HOST=127.0.0.1
export GTCT_LOCAL_PORT="$PORT"
export GTCT_LOCAL_DATA_DIR="$DATA"
export GTCT_TEST_BACKUP_DIR="$BACKUP"
export GTCT_ENABLE_PHYSICAL_PRINT=false
export GTCT_ALLOW_DEV_TOKEN=false
unset GTCT_ALLOW_LAN_BIND GTCT_ENABLE_LAN_LISTENER GTCT_LAN_BIND_ADDRESS || true

node src/index.js >"$TMP/server.log" 2>&1 &
SERVER_PID=$!

ok=0
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: server exited early"
    cat "$TMP/server.log"
    exit 1
  fi
  sleep 0.25
done
[[ "$ok" == "1" ]] || { echo "ERROR: health timeout"; cat "$TMP/server.log"; exit 1; }

HEALTH="$(curl -fsS "http://127.0.0.1:${PORT}/health")"
echo "health: $HEALTH"
echo "$HEALTH" | grep -q '"ok":true'

CODE="$(curl -fsS -o "$TMP/index.html" -w '%{http_code}' "http://127.0.0.1:${PORT}/")"
[[ "$CODE" == "200" ]] || { echo "ERROR: index HTTP $CODE"; exit 1; }
grep -q 'GTCT Restaurant' "$TMP/index.html"

# Confirm DB only under disposable dir
DB="$DATA/gtct-local.sqlite"
[[ -f "$DB" ]] || { echo "ERROR: missing disposable DB"; exit 1; }
case "$DB" in
  /Users/shamseer/gtct-analytics/*|/Users/shamseer/Desktop/GTCT-P2A1-Test*)
    echo "ERROR: disposable DB path intersects project trees"; exit 1 ;;
esac

# Physical print must be false in boot log
grep -q '"physicalPrintEnabled":false' "$TMP/server.log"

# Safe backup create + status (server may stay up — Online Backup API)
npm run backup:test
npm run backup:status >/dev/null

echo "PASS packaging smoke: health + index + isolated DB + backup create"
echo "Server stopped by trap; disposable dir $TMP can be deleted."
