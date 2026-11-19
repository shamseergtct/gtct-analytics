#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PKG="$ROOT/packaging/windows"
LAUNCHER="$PKG/launcher"
OUT="$PKG/dist/launcher"
ICON="$PKG/icons/gtct-restaurant.ico"
TOOLS_BIN="$PKG/.tools/bin"
mkdir -p "$OUT" "$TOOLS_BIN"
cd "$LAUNCHER"

if [[ ! -f "$ICON" ]]; then
  echo "ERROR: missing app icon $ICON"
  exit 1
fi

# Embed Windows .ico into PE resources (picked up automatically by go build).
RSRC="$TOOLS_BIN/rsrc"
if [[ ! -x "$RSRC" ]]; then
  echo "Installing rsrc into $TOOLS_BIN ..."
  GOBIN="$TOOLS_BIN" GOSUMDB=off go install github.com/akavel/rsrc@latest
fi
rm -f rsrc_windows_amd64.syso rsrc_windows_arm64.syso
"$RSRC" -arch amd64 -ico "$ICON" -o rsrc_windows_amd64.syso
"$RSRC" -arch arm64 -ico "$ICON" -o rsrc_windows_arm64.syso

echo "Building Windows launchers (CGO disabled)..."
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w -H windowsgui" -o "$OUT/GTCTRestaurantPilot-x64.exe" .
GOOS=windows GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w -H windowsgui" -o "$OUT/GTCTRestaurantPilot-arm64.exe" .

ls -lh "$OUT"
file "$OUT/GTCTRestaurantPilot-x64.exe" "$OUT/GTCTRestaurantPilot-arm64.exe" || true
echo "Launcher build OK"
