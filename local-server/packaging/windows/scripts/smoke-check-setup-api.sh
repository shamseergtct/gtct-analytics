#!/usr/bin/env bash
# Essential first-run setup API check on an isolated TEST database (host OS).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d /tmp/gtct-pilot-setup-smoke-XXXXXX)"
PORT="${GTCT_SMOKE_PORT:-8793}"
DATA="$TMP/data"
BACKUP="$TMP/backups"
mkdir -p "$DATA" "$BACKUP"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cd "$ROOT"
export GTCT_OPERATING_MODE=TEST
export GTCT_LOCAL_HOST=127.0.0.1
export GTCT_LOCAL_PORT="$PORT"
export GTCT_LOCAL_DATA_DIR="$DATA"
export GTCT_TEST_BACKUP_DIR="$BACKUP"
export GTCT_ENABLE_PHYSICAL_PRINT=false
export GTCT_ALLOW_DEV_TOKEN=false

node src/index.js >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 0.25
done

STATUS="$(curl -fsS "http://127.0.0.1:${PORT}/v1/setup/status")"
echo "$STATUS" | grep -q '"needsSetup":true'
echo "$STATUS" | grep -q 'TEST PILOT'

curl -fsS -o "$TMP/setup.html" "http://127.0.0.1:${PORT}/setup.html"
grep -q 'First-run setup' "$TMP/setup.html"

BOOT="$(curl -fsS -X POST "http://127.0.0.1:${PORT}/v1/setup/bootstrap" \
  -H 'Content-Type: application/json' \
  -d "{\"shopName\":\"Pilot Cafe\",\"addressText\":\"Manama\",\"fullName\":\"Pilot Admin\",\"username\":\"pilot.admin\",\"password\":\"PilotPass123\",\"confirmPassword\":\"PilotPass123\",\"backupDir\":\"$BACKUP\"}")"
echo "$BOOT" | grep -q '"ok":true'

STATUS2="$(curl -fsS "http://127.0.0.1:${PORT}/v1/setup/status")"
echo "$STATUS2" | grep -q '"needsSetup":false'

test -f "$DATA/pilot-runtime.json"
grep -q '"physicalPrintEnabled":false' "$TMP/server.log"

# PRODUCTION mode still refused
if GTCT_OPERATING_MODE=PRODUCTION GTCT_LOCAL_DATA_DIR="$TMP/prod-attempt" node -e "import('./src/config.js').then(m=>{try{m.loadConfig({mode:'http'}); process.exit(2)}catch(e){process.exit(0)}})" 2>/dev/null; then
  :
fi
node -e "
import { loadConfig } from './src/config.js';
process.env.GTCT_OPERATING_MODE='PRODUCTION';
process.env.GTCT_LOCAL_DATA_DIR='$TMP/prod-attempt';
const c=loadConfig({mode:'http', throwOnError:false});
if (!c.errors?.length) { console.error('PRODUCTION should error'); process.exit(1); }
console.log('PRODUCTION blocked:', c.errors[0]);
"

echo "PASS setup API smoke"
