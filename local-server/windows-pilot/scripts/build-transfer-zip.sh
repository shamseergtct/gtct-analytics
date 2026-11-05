#!/usr/bin/env bash
# Build a Windows transfer zip of local-server WITHOUT node_modules or local data.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${GTCT_PILOT_ZIP_OUT:-$ROOT/windows-pilot/dist}"
mkdir -p "$OUT_DIR"
ZIP="$OUT_DIR/gtct-restaurant-windows-pilot-${STAMP}.zip"

cd "$(dirname "$ROOT")"
# Zip contents as RestaurantLocalServer/... so Windows extract path is clear.
STAGE="$OUT_DIR/stage-$$"
rm -rf "$STAGE"
mkdir -p "$STAGE/RestaurantLocalServer"

rsync -a \
  --exclude node_modules \
  --exclude data \
  --exclude 'data-*' \
  --exclude '.git' \
  --exclude 'windows-pilot/dist' \
  --exclude '*.sqlite' \
  --exclude '*.sqlite-*' \
  --exclude .DS_Store \
  "$ROOT/" "$STAGE/RestaurantLocalServer/"

# Ensure pilot env example is present; do not ship a machine-specific env.pilot.cmd
rm -f "$STAGE/RestaurantLocalServer/windows-pilot/env.pilot.cmd"

(
  cd "$STAGE"
  zip -rq "$ZIP" RestaurantLocalServer
)

rm -rf "$STAGE"
echo "Created: $ZIP"
echo "Size: $(wc -c < "$ZIP") bytes"
ls -lh "$ZIP"
