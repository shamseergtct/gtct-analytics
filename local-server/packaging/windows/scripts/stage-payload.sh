#!/usr/bin/env bash
# Stage an offline Windows payload: app sources + bundled Node x64/arm64 + deps.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PKG="$ROOT/packaging/windows"
CACHE="$PKG/cache"
STAGE="$PKG/dist/payload"
NODE_VERSION="${GTCT_NODE_VERSION:-v24.22.2}"
NODE_BASE="https://nodejs.org/dist/${NODE_VERSION}"

mkdir -p "$CACHE" "$STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/app" "$STAGE/runtime/win-x64" "$STAGE/runtime/win-arm64"

download_node() {
  local arch="$1"
  local zip="node-${NODE_VERSION}-${arch}.zip"
  local url="${NODE_BASE}/${zip}"
  local dest="$CACHE/$zip"
  if [[ ! -f "$dest" ]]; then
    echo "Downloading $url"
    curl -fsSL "$url" -o "$dest"
  else
    echo "Using cached $dest"
  fi
  local tmp="$CACHE/extract-${arch}"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  unzip -q "$dest" -d "$tmp"
  local folder
  folder="$(find "$tmp" -maxdepth 1 -type d -name "node-${NODE_VERSION}-${arch}" | head -1)"
  cp "$folder/node.exe" "$STAGE/runtime/${arch}/node.exe"
  # Optional: include LICENSE for redistribution clarity
  [[ -f "$folder/LICENSE" ]] && cp "$folder/LICENSE" "$STAGE/runtime/${arch}/NODE-LICENSE.txt"
  rm -rf "$tmp"
}

echo "=== Bundling Node ${NODE_VERSION} (win-x64 + win-arm64) ==="
download_node win-x64
download_node win-arm64

echo "=== Copying application (no Mac node_modules) ==="
rsync -a \
  --exclude node_modules \
  --exclude data \
  --exclude 'data-*' \
  --exclude packaging/windows/cache \
  --exclude packaging/windows/dist \
  --exclude windows-pilot/dist \
  --exclude '.git' \
  --exclude '*.sqlite' \
  --exclude '*.sqlite-*' \
  --exclude .DS_Store \
  "$ROOT/" "$STAGE/app/"

# Production node_modules for Windows: install on staging host is Darwin —
# install JS deps then ensure better-sqlite3 prebuilds for BOTH Windows arches
# remain present (package ships win32-x64 + win32-arm64 N-API binaries).
echo "=== Installing npm production dependencies into payload ==="
(
  cd "$STAGE/app"
  # Ignore install scripts: better-sqlite3 must not compile for Darwin here.
  # Windows win32-x64 / win32-arm64 N-API prebuilds ship in the package.
  npm ci --omit=dev --ignore-scripts
)

# Verify Windows native prebuilds exist (do not claim they were executed on Windows).
for arch in win32-x64 win32-arm64; do
  pre="$STAGE/app/node_modules/better-sqlite3/prebuilds/${arch}.node"
  if [[ ! -f "$pre" ]]; then
    echo "ERROR: missing better-sqlite3 prebuild: $pre"
    exit 1
  fi
  echo "Found better-sqlite3 prebuild: $arch"
done

# Place architecture-specific launchers if already built
LAUNCHER_DIR="$PKG/dist/launcher"
if [[ -f "$LAUNCHER_DIR/GTCTRestaurantPilot-x64.exe" ]]; then
  cp "$LAUNCHER_DIR/GTCTRestaurantPilot-x64.exe" "$STAGE/GTCTRestaurantPilot-x64.exe"
  cp "$LAUNCHER_DIR/GTCTRestaurantPilot-arm64.exe" "$STAGE/GTCTRestaurantPilot-arm64.exe"
fi

# Marker files for installer / support
cat > "$STAGE/APP-INFO.txt" <<EOF
GTCT Restaurant Local Server — TEST PILOT Windows package
Node runtime: ${NODE_VERSION}
better-sqlite3: $(node -p "require('$STAGE/app/node_modules/better-sqlite3/package.json').version")
Operating mode: TEST (PRODUCTION startup remains blocked by the application)
Physical print default: OFF
Data directory (runtime): %LOCALAPPDATA%\\GTCT\\RestaurantPilot
EOF

echo "Payload staged at $STAGE"
du -sh "$STAGE" "$STAGE/runtime/win-x64" "$STAGE/runtime/win-arm64" "$STAGE/app"
