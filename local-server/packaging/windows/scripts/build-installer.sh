#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PKG="$ROOT/packaging/windows"
cd "$PKG"

bash scripts/build-launcher.sh
bash scripts/stage-payload.sh

# Ensure launchers are inside payload for NSIS File commands
cp -f dist/launcher/GTCTRestaurantPilot-x64.exe dist/payload/GTCTRestaurantPilot-x64.exe
cp -f dist/launcher/GTCTRestaurantPilot-arm64.exe dist/payload/GTCTRestaurantPilot-arm64.exe

echo "=== Compiling NSIS multi-arch setup EXE ==="
makensis -V2 nsis/gtct-restaurant-pilot.nsi

SETUP="$(ls -1t dist/GTCT-Restaurant-Pilot-Setup-*.exe | head -1)"
echo "Installer built: $SETUP"
ls -lh "$SETUP"
file "$SETUP" || true

# Essential non-Windows packaging checks (payload layout)
test -f dist/payload/runtime/win-x64/node.exe
test -f dist/payload/runtime/win-arm64/node.exe
test -f dist/payload/app/src/index.js
test -f dist/payload/app/node_modules/better-sqlite3/prebuilds/win32-x64.node
test -f dist/payload/app/node_modules/better-sqlite3/prebuilds/win32-arm64.node
test -f dist/payload/GTCTRestaurantPilot-x64.exe
test -f dist/payload/GTCTRestaurantPilot-arm64.exe
echo "PASS payload architecture layout checks"
echo "$SETUP"
