# Windows Pilot — Ready vs Requires Approval

**Package location:** `local-server/windows-pilot/`  
**Git baseline inspected:** `8640f9a`  
**Prepared:** additive packaging/docs/launchers only — application runtime source not changed for production enablement.

---

## Ready for controlled Windows pilot (with approval)

| Area | Status |
|---|---|
| Node + SQLite + browser architecture | Ready — reuse as-is |
| Windows install scripts + Desktop launcher | Ready — `Install-GTCT-Pilot.bat`, `Start-GTCT-Restaurant.bat` |
| Persistent pilot DB outside source | Ready — `%LOCALAPPDATA%\GTCT\RestaurantPilot` via env |
| Fresh DB / migrations / TEST identity guards | Ready — existing startup path |
| First Admin setup | Ready — `Create-First-Admin.bat` → `npm run admin:create` |
| Shop / menu / staff / stations / bank UI | Ready — existing Admin pages |
| Printer Admin UI (IP/port per printer, stations) | Ready — `/settings.html` |
| MJ330_RASTER NETWORK_TCP path | Ready in code (lab-verified earlier); must re-verify on new PC |
| Physical print default | **Off** in package env |
| SQLite-safe backup / verify / restore-to-new | Ready — wrappers around existing TEST backup CLI |
| Transfer zip builder | Ready — `scripts/build-transfer-zip.sh` |

---

## Requires explicit approval before use on restaurant PC

1. **Physical printing** — flip only via `Enable-PhysicalPrint-APPROVAL-REQUIRED.bat` after manual test prints on that PC.  
2. **Automatic kitchen/cashier dispatch to real printers** — only after §1.  
3. **Trial bills that leave paper at the restaurant** — ops authorization.  
4. **LAN multi-terminal HTTPS** (`GTCT_ENABLE_LAN_LISTENER`, certificates, firewall) — separate approval; physical print is refused while that LAN test mode is on.  
5. **Any claim of “live production”** — blocked; see below.

---

## Production / live blockers (do not declare live-ready)

| Blocker | Detail |
|---|---|
| `GTCT_OPERATING_MODE` ≠ `TEST` | Startup **refuses**. REAL/PRODUCTION HTTP server is not implemented (`operatingMode.js` / `config.js`). |
| Sealed production vault (P2-A2) | Placeholder DB only — **no orders, money, printers, or HTTP**. |
| Windows acceptance | README: Windows 10/11 **acceptance NOT TESTED** on hardware for this baseline. |
| `WINDOWS_SPOOLER` | Adapter scaffold only — not wired to a validated Win32 print API. Use NETWORK_TCP for MJ330. |
| Sample seed on empty DB | Seeds MOCK printers/stations/sample menu (not staff, not real bills). Replace for real menu. |
| Delivery / commission / split tender | Large surface still labeled **TEST-only** in APIs. |
| Financial day-end / full production reporting | Not a completed production close suite. |
| Multi-PC concurrent writers | Single-PC loopback pilot is the supported shape until LAN+TLS approved. |
| Backup off-site / encryption | Backups are local/unencrypted; OS ACLs + external copy required. |
| Root GTCT Analytics / Firebase | Intentionally untouched; not part of this pilot. |

### Smallest safe path toward “real mode” (proposal only — not implemented)

1. Keep pilot on **TEST** + dedicated Windows data dir until Windows print + backup drills pass.  
2. Design a separate production tenant identity + migrations (do **not** promote the pilot DB by renaming folders).  
3. Implement explicit `PRODUCTION` boot that refuses TEST identity markers and sample seed.  
4. Independent Windows hardware certification for NETWORK_TCP (and spooler if needed).  
5. Production backup/restore drill with RPO/RTO owners.  
6. Legal/ops go-live checklist — then flip mode under change control.

**Do not** bypass TEST-only checks merely to start the server.

---

## Packaging checks run on Mac (isolated)

See `scripts/packaging-smoke-check.sh` results in the session report.  
These do **not** replace Windows `npm ci` / better-sqlite3 native build / physical printer tests.
