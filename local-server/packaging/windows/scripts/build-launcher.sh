#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LAUNCHER="$ROOT/packaging/windows/launcher"
OUT="$ROOT/packaging/windows/dist/launcher"
mkdir -p "$OUT"
cd "$LAUNCHER"

echo "Building Windows launchers (CGO disabled)..."
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w -H windowsgui" -o "$OUT/GTCTRestaurantPilot-x64.exe" .
GOOS=windows GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w -H windowsgui" -o "$OUT/GTCTRestaurantPilot-arm64.exe" .

ls -lh "$OUT"
file "$OUT/GTCTRestaurantPilot-x64.exe" "$OUT/GTCTRestaurantPilot-arm64.exe" || true
echo "Launcher build OK"
