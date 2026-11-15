# GTCT Restaurant Pilot — Plug & Play Windows Installer

Bundled **Node.js 24** + **NSIS** multi-architecture setup for the existing Local Server.
**Electron is not used.** Operating mode remains **TEST PILOT**. PRODUCTION startup stays blocked.

## Output

After `scripts/build-installer.sh`:

| Artifact | Path |
|---|---|
| Setup EXE (x64+ARM64 payload) | `packaging/windows/dist/GTCT-Restaurant-Pilot-Setup-0.1.3.exe` |
| Payload (debug) | `packaging/windows/dist/payload/` |
| Launchers | `packaging/windows/dist/launcher/*.exe` |

## Build (on macOS packager)

```bash
cd local-server
bash packaging/windows/scripts/build-installer.sh
```

Requirements: Node 24, npm, curl, unzip, rsync, Go, makensis (`brew install go makensis`).

## Install on Windows (restaurant PC)

1. Copy the Setup EXE to the PC (offline OK after copy).
2. Double-click `GTCT-Restaurant-Pilot-Setup-*.exe`.
3. Finish → optional Launch.
4. First run opens **First-run setup** (`/setup.html`): shop, BHD, Admin, backup folder.
5. Then configure printers in **Printer Settings**. Physical print stays **OFF** until authorized.

## Data locations

| Item | Path |
|---|---|
| Application | `C:\Program Files\GTCT\Restaurant Pilot\` |
| SQLite DB | `%LOCALAPPDATA%\GTCT\RestaurantPilot\` |
| Backups | `%LOCALAPPDATA%\GTCT\RestaurantPilot-Backups\` (or path chosen at setup) |

Reinstall/upgrade replaces program files only. **Uninstall preserves the database and backups.**

## Architecture

One installer embeds **both** `runtime/win-x64/node.exe` and `runtime/win-arm64/node.exe` plus matching launchers. At install time NSIS installs the launcher matching the PC (`IsNativeARM64` / `IsNativeAMD64`). The launcher then uses the matching Node folder.

**Verification status:** installer EXE and Windows PE launchers are **produced on macOS**. End-to-end execution on Windows x64 and Windows 11 ARM64 (UTM) is **not claimed until run on those PCs**.

## Rollback

Git tag: `windows-pilot-bat-rollback` (commit before this packaging architecture).
