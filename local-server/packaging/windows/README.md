# GTCT Restaurant Pilot — Plug & Play Windows Installer

Bundled **Node.js 24** + **NSIS** multi-architecture setup for the existing Local Server.
**Electron is not used.** Operating mode remains **TEST PILOT**. PRODUCTION startup stays blocked.

## Always-on host + LAN (0.1.13+)

After install (**one Setup EXE — no manual CMD**):

1. A **Scheduled Task** (`GTCT Restaurant Host`) starts `GTCTRestaurantPilot.exe --host` at **Windows logon**.
2. The host binds **LAN HTTPS** on this PC’s private Wi‑Fi/Ethernet IP (self-signed cert under `%LOCALAPPDATA%\GTCT\RestaurantPilot\tls\`).
3. The **desktop shortcut** only opens the browser. Closing the browser does **not** stop the server.
4. Install runs **Prepare LAN Access** automatically, and registers a **SYSTEM startup task** (`GTCT Restaurant LAN Prepare`) so LAN stays open after reboot:
   - Adds inbound allow rules for TCP **8787** + bundled `node.exe`
   - Sets the active network to **Private** when possible
   - If Group Policy blocks local firewall rules (common on locked POS images), **TEST pilot turns Windows Firewall OFF** and keeps it off across reboots
5. Tablets / phones on the same Wi‑Fi open:

   `https://<server-lan-ip>:8787/pair.html`

   Accept the certificate warning once (TEST). Then pair the terminal.

6. Logs: `%LOCALAPPDATA%\GTCT\RestaurantPilot\logs\host.log`  
   Current URL: `%LOCALAPPDATA%\GTCT\RestaurantPilot\current-url.txt`

If a phone cannot connect later: Start → **GTCT → Prepare LAN Access** (Run as administrator if prompted).

### Why Edge shows “Not secure”

The URL is still **HTTPS** (encrypted). Edge shows **Not secure** because the certificate is **self-signed for TEST** — it is not issued by a public CA. That is expected on a private LAN IP.

To make this Windows user trust the shop cert (lock icon / no red “Not secure”):

1. Start menu → **GTCT → Trust LAN Certificate**, or run:
   `powershell -ExecutionPolicy Bypass -File "C:\Program Files\GTCT\Restaurant Pilot\trust-lan-cert.ps1"`
2. Close all Edge windows and reopen `https://<lan-ip>:8787`.
3. Repeat on each tablet/PC that opens the restaurant URL.

A public Let’s Encrypt certificate needs a public domain name; it does not apply cleanly to a raw `192.168.x.x` LAN address.

### Forgot / reset password (0.1.14+)

On the restaurant PC: Start menu → **GTCT → Reset Staff Password**, or open **Forgot password?** on the login page for instructions.

Developer checkout: `npm run admin:reset-password`

Optional remote support form: set `GTCT_SUPPORT_MASTER_KEY` (24+ characters) on the host process, then use `/recovery.html`.

## Output

After `scripts/build-installer.sh`:

| Artifact | Path |
|---|---|
| Setup EXE (x64+ARM64 payload) | `packaging/windows/dist/GTCT-Restaurant-Pilot-Setup-*.exe` |
| Payload (debug) | `packaging/windows/dist/payload/` |
| Launchers | `packaging/windows/dist/launcher/*.exe` |

App branding icon source: `packaging/windows/icons/gtct-restaurant.ico` (also used for web favicons under `public/icons/`).

## Build (on macOS packager)

```bash
cd local-server
bash packaging/windows/scripts/build-installer.sh
```

Requirements: Node 24, npm, curl, unzip, rsync, Go, makensis (`brew install go makensis`).

## Install on Windows (restaurant PC)

1. Copy the Setup EXE to the PC (offline OK after copy).
2. Double-click `GTCT-Restaurant-Pilot-Setup-*.exe`.
3. Finish → optional **Open GTCT Restaurant in browser**.
4. Host starts automatically; other devices can connect without keeping a window open on the server PC.
5. First run may open **First-run setup** (`/setup.html`): shop, BHD, Admin, backup folder.
6. Configure printers in **Printer Settings**. Physical print stays **OFF** until authorized.

## Data locations

| Item | Path |
|---|---|
| Application | `C:\Program Files\GTCT\Restaurant Pilot\` |
| SQLite DB | `%LOCALAPPDATA%\GTCT\RestaurantPilot\` |
| TLS certs | `%LOCALAPPDATA%\GTCT\RestaurantPilot\tls\` |
| Backups | `%LOCALAPPDATA%\GTCT\RestaurantPilot-Backups\` (or path chosen at setup) |

Reinstall/upgrade replaces program files only. **Uninstall preserves the database and backups** and removes the Scheduled Task + firewall rule.

## Architecture

One installer embeds **both** `runtime/win-x64/node.exe` and `runtime/win-arm64/node.exe` plus matching launchers. At install time NSIS installs the launcher matching the PC (`IsNativeARM64` / `IsNativeAMD64`). The launcher then uses the matching Node folder.

**Verification status:** installer EXE and Windows PE launchers are **produced on macOS**. End-to-end execution on Windows x64 and Windows 11 ARM64 must be confirmed on those PCs.

## Rollback

Git tag: `windows-pilot-bat-rollback` (commit before this packaging architecture).
