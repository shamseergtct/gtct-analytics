# Phase 1 / 1.1 Acceptance

## Readiness decision (source + mock)

**CONDITIONAL PASS** — mock/source acceptance passed on the development host; Windows 10/11 hardware verification remains **NOT TESTED**.

This prototype is **not production-ready**. Multi-device LAN access is **NOT READY** (no TLS, no production device identity).

## Runtime

| Item | Requirement |
|---|---|
| Node.js | **24 LTS** (`>=24.0.0 <25`) |
| SQLite driver | `better-sqlite3` `^13.0.3` (`engines.node: >=22`) |
| OS primary | Windows 10 22H2 x64 |
| OS secondary | Windows 11 x64 |

Windows 10 mainstream support ended 2025-10-14 — use ESU or an otherwise maintained host.

## Automated acceptance (any OS)

Uses an isolated temp database (does not touch your normal data dir):

```bash
cd local-server
npm ci
npm run accept:phase1.1
```

## Local mock demo

```bash
cd local-server
npm ci
npm run demo:order
# inspect: data/print-output/mock/   (non-Windows dev path)
```

## Start server (loopback + opt-in dev tokens)

**macOS / Linux**
```bash
cd local-server
GTCT_ALLOW_DEV_TOKEN=true npm start
```

**Windows PowerShell**
```powershell
cd local-server
$env:GTCT_ALLOW_DEV_TOKEN = "true"
npm start
```

Without `GTCT_ALLOW_DEV_TOKEN=true` or explicit `GTCT_LOCAL_API_TOKEN` / `GTCT_LOCAL_ADMIN_TOKEN`, the HTTP server refuses to start.

Default bind remains `127.0.0.1`. LAN bind requires `GTCT_ALLOW_LAN_BIND=true` and strong tokens — still **NOT READY** for multi-device use (no TLS).

### Tokens (loopback development only)

| Role | Opt-in default (only with `GTCT_ALLOW_DEV_TOKEN=true` on loopback) |
|---|---|
| Device | `phase1-dev-token` |
| Admin | `phase1-admin-token` |

Admin required for: printer/station/menu mutation, reprint, confirm, dispatch, printer test.

## Windows PowerShell acceptance (NOT RUN in this review)

Run on a real Windows 10 22H2 or Windows 11 x64 machine with Node 24 LTS installed:

```powershell
# Prerequisites: Node.js 24 LTS, build tools for native modules if needed
# https://github.com/nodejs/node/blob/main/BUILDING.md#windows
node -v   # expect v24.x
cd path\to\gtct-analytics\local-server
npm ci
npm run accept:phase1.1
npm run demo:order

# Data dir on Windows:
# $env:LOCALAPPDATA\GTCT\RestaurantLocalServer

$env:GTCT_ALLOW_DEV_TOKEN = "true"
npm start
# other terminal:
Invoke-RestMethod http://127.0.0.1:8787/health
Invoke-RestMethod http://127.0.0.1:8787/v1/print-jobs -Headers @{ Authorization = "Bearer phase1-dev-token" }
```

Firewall: keep bind on `127.0.0.1` for Phase 1.1. Do not open inbound LAN ports until TLS + device auth exist.

Windows Defender: allow Node if it blocks the native `better-sqlite3` addon on first run.

Mark results:

| OS | Status |
|---|---|
| Windows 10 22H2 x64 | **NOT TESTED** |
| Windows 11 x64 | **NOT TESTED** |

## Checklist

### Safety
- [x] Prototype isolated under `local-server/`
- [x] Physical print default off
- [x] No Firebase secrets in local-server
- [ ] Production SPA files clean in git (see isolation note in Phase 1.1 report)

### Functional (mock)
- [x] TEST-001 four-way routing
- [x] Idempotent re-create
- [x] Concurrent HTTP duplicate submissions
- [x] Restart PENDING recovery
- [x] UNKNOWN without blind reprint
- [x] Missing printer → NEEDS_REVIEW
- [x] Unauthenticated API → 401
- [x] Device cannot register printers / reprint

### Windows / hardware
- [ ] Node 24 + `npm ci` on Win10
- [ ] Node 24 + `npm ci` on Win11
- [ ] `%LOCALAPPDATA%` persistence
- [ ] Physical NETWORK_TCP / WINDOWS_SPOOLER

## Production-readiness blockers

1. Windows 10/11 acceptance not executed
2. No TLS
3. LAN multi-device auth not ready
4. WINDOWS_SPOOLER not wired to a validated Win32 print API
5. NETWORK_TCP lacks reliable print confirmation
6. No Windows Service / installer
7. Not connected to live POS (by design for Phase 1)
