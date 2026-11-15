# Phase 1.2 — Printer Settings (Mac-first)

## Status

**Mac mock implementation complete.**  
**No physical print jobs were sent.**  
**Windows transfer / POS-80 live test: WAITING FOR APPROVAL.**

## What was added

- Admin **Printer Settings** UI at `http://127.0.0.1:8787/settings.html`
- Hardened printer validation (NETWORK_TCP host/port, spooler queue name)
- Per-printer `physicalDispatchEnabled` capability flag (still blocked without env master switch)
- Safe test modes: `preview`, `mock_file`, `tcp_probe` (probe default off), `physical` (blocked in 1.2)
- NETWORK_TCP adapter sends plain text only (no ESC/POS reset/cutter/drawer)
- Queue dispatch never auto-authorizes physical TCP writes
- `audit_events` table for admin printer/station actions

## Mac start

```bash
cd local-server
GTCT_ALLOW_DEV_TOKEN=true npm start
```

- Sales UI: http://127.0.0.1:8787/
- Printer Settings: http://127.0.0.1:8787/settings.html  
  Sign in with **admin** token (`phase1-admin-token` when dev tokens enabled).

## Mac acceptance

```bash
cd local-server
npm run accept:phase1.2
npm run accept:phase1.1
```

## Known POS-80 target (config only — not printed)

| Field | Value |
|---|---|
| Model family | POS-80 thermal |
| IP | `192.168.0.110` |
| Port | `9100` |
| Protocol | Not fully confirmed |

Settings UI can store this as NETWORK_TCP with physical flags **off**.

## Environment flags

| Variable | Default | Meaning |
|---|---|---|
| `GTCT_ENABLE_PHYSICAL_PRINT` | off | Master physical switch |
| `GTCT_ALLOW_TCP_PROBE` | off | Connect-only probe (no print payload) |

Physical NETWORK_TCP dispatch requires master env + per-printer flag + explicit authorized confirm (queue path keeps `allowPhysicalDispatch=false`).

## Windows transfer (after approval)

On Mac, copy **source only** (no `node_modules`, no Mac `data/` DB, no `.env`):

```bash
# Example: create a clean archive from repo
cd /path/to/gtct-analytics
tar --exclude='local-server/node_modules' \
    --exclude='local-server/data' \
    --exclude='**/node_modules' \
    --exclude='**/.env' \
    -czf gtct-local-server-phase12.tgz local-server docs/phase1*.md
```

On Windows UTM:

1. Extract/overwrite `local-server/` and docs — **do not overwrite** Windows `%LOCALAPPDATA%\GTCT\RestaurantLocalServer\*.sqlite*`.
2. `cd local-server`
3. `npm ci` (or `npm install`) with Node 24 LTS
4. `$env:GTCT_ALLOW_DEV_TOKEN="true"; npm start`
5. Verify Sales Test + MOCK printing
6. Open Printer Settings; confirm POS-80 config if desired
7. **Keep physical print env unset** until explicit approval

## Next step for one real POS-80 ticket (DO NOT RUN YET)

Only after written approval:

1. Confirm no other POS is mid-job on `192.168.0.110`
2. On Windows only: set `GTCT_ENABLE_PHYSICAL_PRINT=true`
3. In Printer Settings: enable per-printer physical flag for that device
4. Preview ticket text first
5. Authorized single test path (to be enabled in a later approved phase)
6. Treat TCP success as DISPATCHED/UNKNOWN — never CONFIRMED automatically
