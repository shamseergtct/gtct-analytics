# GTCT Restaurant — Windows PC Pilot Installation

**Baseline:** git `8640f9a` (local-server)  
**Status:** Controlled restaurant **PILOT** under `GTCT_OPERATING_MODE=TEST`.  
**Not live-ready.** Real `PRODUCTION` / `REAL` mode is intentionally blocked by the application.

Physical printing stays **off** until authorized on the Windows PC.

---

## 1. What you install

| Piece | Role |
|---|---|
| Node.js **24 LTS** (Windows x64) | Runtime |
| This `local-server` folder | Application (HTTP + SQLite + browser UI) |
| `windows-pilot\*.bat` | Staff-friendly launchers |
| `%LOCALAPPDATA%\GTCT\RestaurantPilot` | Persistent pilot database (new, empty) |
| `%LOCALAPPDATA%\GTCT\RestaurantPilot-Backups` | Verified SQLite backups |

Architecture is unchanged: Node + SQLite (`better-sqlite3`) + browser. There is no separate macOS `node_modules` copy — Windows must run `npm ci` locally so the native SQLite binding builds for Windows.

A fully silent self-contained `.exe` installer is **not** shipped in this package (native module + ongoing pilot risk). Use the documented MSI + scripts path below.

---

## 2. Transfer package to the Windows PC

On the build Mac (or CI), from `local-server/`:

```bash
bash windows-pilot/scripts/build-transfer-zip.sh
```

Copy the resulting zip to the restaurant PC. Extract to a permanent folder, for example:

`C:\GTCT\RestaurantLocalServer\`

Do **not** run from Downloads long-term. Do **not** place the database on a network share.

---

## 3. Install (one-time, IT or owner)

1. Install **Node.js 24 LTS** Windows x64 MSI from [nodejs.org](https://nodejs.org/).  
   Confirm in a new Command Prompt: `node -v` shows `v24.x.x`.
2. Open `windows-pilot\Install-GTCT-Pilot.bat` (double-click).  
   It creates `env.pilot.cmd`, data/backup folders, runs `npm ci`, checks `better-sqlite3`, and adds a Desktop shortcut.
3. Review `windows-pilot\env.pilot.cmd` (leave `GTCT_ENABLE_PHYSICAL_PRINT=false`).

---

## 4. First administrator

1. Prefer with the server **stopped**.
2. Run `windows-pilot\Create-First-Admin.bat`.
3. Enter display name, username, and password (no default exists).
4. Store the credentials offline. Recovery = this Admin account (no shared bearer secret).

---

## 5. Daily start / stop (staff)

1. Double-click **GTCT Restaurant Pilot** on the Desktop, or `Start-GTCT-Restaurant.bat`.
2. Browser opens `http://127.0.0.1:8787/`.
3. Sign in with staff username/password.
4. Leave the black window open during service.
5. To stop: focus that window and press `Ctrl+C`, or close it and confirm.

Do not start a second copy on the same port.

---

## 6. Restaurant pilot configuration (Admin UI)

After login as Admin, configure on **this PC only**:

| Task | URL |
|---|---|
| Shop name / address / BHD currency / tax / receipts | `/shop-settings.html` |
| Menu, prices, stations | `/menu.html` |
| Staff users & roles | `/users.html` |
| Cash / bank accounts | Sales + shop/settings flows already in app |
| Kitchen stations & printer routing | `/settings.html` |
| Delivery staff / commission (TEST features) | Delivery admin pages in app |
| Sales / shifts / register | `/` and order register / monitor pages |

First empty start may seed **MOCK** printers/stations and a small sample menu (no sample customer bills / no staff users). Replace with the restaurant’s real menu and printers before trial service.

---

## 7. Printer setup (LAN MJ330)

Reference verified earlier (lab): IP `192.168.0.110`, port `9100`, format `MJ330_RASTER`.  
**Each restaurant PC may use different IPs — configure in Admin UI; do not hard-code.**

1. Keep `GTCT_ENABLE_PHYSICAL_PRINT=false` until manual tests pass.
2. Open `/settings.html` as Admin.
3. Create/update printers:
   - Connection: `NETWORK_TCP`
   - Host / port: this shop’s printer IPs (Kitchen, Cashier, others)
   - Format capability: `MJ330_RASTER` where applicable
   - Assign stations (Kitchen vs Cashier routing)
   - Leave automatic physical dispatch off until authorized; use MOCK first if needed
4. Use the UI **manual test-print** after enabling physical print (see §8).
5. Confirm job history; `DISPATCHED` ≠ `CONFIRMED` (admin confirmation required).

**WINDOWS_SPOOLER** adapter is present but **not wired** to a validated Win32 print API yet — use `NETWORK_TCP` for MJ330 LAN printers.

Automatic printing must stay disabled until manual printing is verified on the new PC. Do not enable physical print during package preparation.

---

## 8. Enable physical print (authorization gate)

Only after owner approval **on the restaurant PC**:

1. Complete Admin printer config and connectivity checks.
2. Run `Enable-PhysicalPrint-APPROVAL-REQUIRED.bat` and type `ENABLE PHYSICAL PRINT`.
3. Restart `Start-GTCT-Restaurant.bat`.
4. Admin → manual test print for Kitchen and Cashier.
5. Only then allow normal order dispatch to create physical jobs.

Gates already in software:

- Process flag `GTCT_ENABLE_PHYSICAL_PRINT`
- Per-printer `physicalDispatchEnabled`
- No automatic retry after TCP timeout (operator review)
- Job status machine limits transitions; do not blindly re-queue

---

## 9. Backup and restore

### Backup (preferred)

With the app env loaded (scripts do this):

- Double-click `Backup-Database.bat`, **or**
- `npm run backup:test` from `local-server` with the same env vars

This uses the SQLite Online Backup API + integrity verification.  
**Do not** treat a casual Explorer copy of an open `gtct-local.sqlite` as a verified backup.

### Health check

- `Backup-Database.bat` also runs `npm run backup:status`
- Or Admin API `GET /v1/admin/backup-health` (signed-in Admin; paths not exposed)
- `Verify-Backup.bat` with `GTCT_TEST_BACKUP_FILE` set to a specific file

### Restore (non-destructive)

1. Stop the server.
2. Set `GTCT_TEST_BACKUP_FILE` to a verified backup.
3. Run `Restore-Backup-NewFolder.bat` → writes into `GTCT_TEST_RESTORE_DIR` only.
4. Live pilot DB is **not** overwritten by this tool.
5. Switching the live data directory to the restore folder requires explicit ops approval and `env.pilot.cmd` edit.

Optional: stop server, then copy a self-contained `.backup` snapshot into place only under change-control (see also `docs/phase1-sqlite-backup.md`).

---

## 10. Safety checklist

- [ ] Node 24 installed on Windows; `npm ci` run on Windows
- [ ] Data under `%LOCALAPPDATA%\GTCT\RestaurantPilot` (not Mac `data/`, not production vault)
- [ ] `GTCT_OPERATING_MODE=TEST`
- [ ] `GTCT_ENABLE_PHYSICAL_PRINT=false` until authorized
- [ ] First Admin created; no shared tokens
- [ ] LAN multi-PC HTTPS listener still off unless separately approved
- [ ] Daily backup proven once before busy service
