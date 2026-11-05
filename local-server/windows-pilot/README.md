# Windows Pilot Package

Staff-facing launchers and install docs for a **controlled restaurant PC pilot**.

| File | Purpose |
|---|---|
| `INSTALL.md` | Full installation, admin, printers, backup |
| `PILOT-READINESS.md` | What is ready vs what needs approval / blockers |
| `Install-GTCT-Pilot.bat` | One-time Windows install |
| `Start-GTCT-Restaurant.bat` | Daily launcher (opens browser) |
| `Create-First-Admin.bat` | First admin account |
| `Backup-Database.bat` | SQLite-safe verified backup |
| `Verify-Backup.bat` / `Restore-Backup-NewFolder.bat` | Backup health / non-destructive restore |
| `Enable-PhysicalPrint-APPROVAL-REQUIRED.bat` | Opt-in physical print flag only |
| `env.pilot.example` | Safe defaults (TEST, print off) |
| `scripts/build-transfer-zip.sh` | Build transfer zip (no node_modules) |

Application source remains under the parent `local-server/` folder. Do not enable PRODUCTION mode or physical print without authorization.
