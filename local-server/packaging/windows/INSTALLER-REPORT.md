# Plug & Play Windows Installer — Report

## Rollback point
- Commit: `8d66b47` / tag `windows-pilot-bat-rollback`

## Approach
Bundled Node 24 + NSIS (not Electron). Existing Node backend, SQLite, browser UI unchanged in architecture. TEST guards preserved.

## Artifacts
See `dist/GTCT-Restaurant-Pilot-Setup-0.1.3.exe` after build.

## First-run
Launcher opens `/setup.html` when no Admin exists. Collects shop, BHD, Admin (no default password), backup folder. Printers via existing `/settings.html` after sign-in.

## Upgrade / uninstall
Program files replaced/removed. `%LOCALAPPDATA%\GTCT\RestaurantPilot` and backups **preserved**. Installer never resets an existing DB.

## Compatibility verification
| Item | Status |
|---|---|
| Setup EXE produced (PE) on macOS | Built by packager host |
| win-x64 + win-arm64 Node bundled | Staged in payload |
| better-sqlite3 `win32-x64` + `win32-arm64` prebuilds present | Staged |
| Launcher EXE x64 + arm64 cross-compiled | Built with Go |
| Run on Windows x64 hardware | **Not verified in this session** |
| Run on Windows 11 ARM64 (UTM) | **Not verified in this session** |

## Remaining pilot / production limits
- Still TEST-only; PRODUCTION HTTP server not implemented
- Physical print default OFF; auto-print requires authorization
- WINDOWS_SPOOLER not wired; use NETWORK_TCP / MJ330_RASTER
- Windows runtime verification pending on real/UTM Windows
- Not live-ready for unrestricted production billing
