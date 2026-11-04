# GTCT Restaurant Local Server (Phase 1 / 1.1–1.3)

Isolated Windows-oriented local server prototype for SQLite storage, menu setup, sales test UI, and multi-printer kitchen routing.

**Not connected to live restaurant sales, production Firebase, inventory, or accounting.**  
**Not production-ready. Multi-PC LAN access stays off until the firewall, certificate, and listener steps are approved.**

## Requirements

| Item | Target |
|---|---|
| OS (primary) | Windows 10 64-bit 22H2 (**acceptance NOT TESTED**) |
| OS (secondary) | Windows 11 64-bit (**acceptance NOT TESTED**) |
| Runtime | Node.js **24 LTS** (`>=24.0.0 <25`) |
| Database | SQLite via `better-sqlite3` `^13.0.3` |

Windows 10 mainstream security support ended **2025-10-14**. Prefer ESU or a maintained host.

A successful macOS/Linux run does **not** count as Windows verification.

## Install

```bash
cd local-server
npm ci
```

If `npm ci` fails (no lock sync), use `npm install` once, then commit the lockfile when asked.

## Acceptance harness

```bash
npm run accept:phase1.1
npm run accept:phase1.2
npm run accept:phase1.3
npm run accept:phase1.4
npm run accept:phase1.5
npm run accept:phase1.6
npm run accept:phase1.7
```

## Shop Settings UI (admin)

`http://127.0.0.1:8787/shop-settings.html`

Sign in with an administrator username and password. Configure business profile, tax (disabled / exclusive / inclusive), currency, regional options, receipt prefs, and a MOCK receipt preview. Printer Settings remains at `/settings.html`.

Uses a temporary data directory only.

## Demo order

```bash
npm run demo:order
```

Mock tickets: `data/print-output/mock/` (non-Windows) or `%LOCALAPPDATA%\GTCT\RestaurantLocalServer\print-output\mock\` (Windows).

## Sales Test UI

Open in a browser on the same machine:

`http://127.0.0.1:8787/`

## Menu Setup UI (admin)

`http://127.0.0.1:8787/menu.html`

Sign in with an administrator username and password. Manage categories/subcategories, items (optional SKU), prices (display only), photos, optional kitchen station (**None — No Preparation** for packaged items), sold-out/active flags with list quick toggles, sort order, and item-specific kitchen instruction options. Photos are stored under the local data directory (`menu-images/`), not browser IndexedDB or Firebase. A cashier with sold-out permission may toggle sold-out without full menu admin access.

## Printer Settings UI (admin)

`http://127.0.0.1:8787/settings.html`

Sign in with an administrator username and password. Configure MOCK / NETWORK_TCP / WINDOWS_SPOOLER, assign stations, preview tickets, and view job history. Physical printing stays off unless explicitly enabled later.

## Start server

```bash
npm start
```

Default bind: `127.0.0.1:8787` over HTTP on this computer. Sign in with a staff username and password. The session is an **HttpOnly**, **SameSite=Strict** cookie stored in SQLite. On HTTPS the cookie is also **Secure**. Shared Admin and Device bearer secrets are retired and are rejected. Recovery is the shop Admin account. Do not add a shared password or token.

Admin-only: register printers/stations/menu items (incl. photos), reprint, confirm, dispatch, printer test, and user management.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `GTCT_LOCAL_HOST` | `127.0.0.1` | Bind address. Stays on this computer unless every LAN setting below is present. |
| `GTCT_LOCAL_PORT` | `8787` | Listen port |
| `GTCT_LOCAL_DATA_DIR` | OS-specific | Persistent data root on this computer. A network folder is refused for LAN. |
| `GTCT_TLS_CERT_FILE` | unset | PEM certificate for HTTPS. Keep it outside the repository. |
| `GTCT_TLS_KEY_FILE` | unset | PEM private key for HTTPS. Keep it outside the repository. Never copy it to a client. |
| `GTCT_TLS_KEY_PASSPHRASE` | unset | Optional key passphrase. Never commit or log it. |
| `GTCT_ALLOW_LAN_BIND` | unset | First opt-in. Does not listen by itself. |
| `GTCT_ENABLE_LAN_LISTENER` | unset | Second opt-in. Required before a private-address listener is allowed. |
| `GTCT_LAN_BIND_ADDRESS` | unset | Must be the same private IPv4 address as `GTCT_LOCAL_HOST`. |
| `GTCT_LAN_HOSTNAME` | unset | Private name on the certificate, such as `gtct-pos`. Browsers use this name, not the raw IP. |
| `GTCT_ENABLE_PHYSICAL_PRINT` | unset/false | Enable TCP/spooler adapters |
| `GTCT_DISPATCH_INTERVAL_MS` | `1500` | Dispatch poll |

## HTTPS on this computer

Leave the TLS variables unset for normal use. The server then stays on `http://127.0.0.1:8787`.

To try HTTPS locally, create a certificate whose name is `localhost` and `127.0.0.1`, using a certificate tool this computer already trusts. Point `GTCT_TLS_CERT_FILE` and `GTCT_TLS_KEY_FILE` at those files. Open `https://127.0.0.1:8787`. If the browser warns, the certificate is not trusted yet. Do not continue past that warning.

A self-signed certificate for a raw IP address is not trusted by other computers. This step does not install a certificate authority.

## Prepared LAN test (not opened)

The server still starts on `127.0.0.1` and does not listen on the restaurant network. A private-address listener is possible only when all of these are true: `GTCT_ALLOW_LAN_BIND=true`, `GTCT_ENABLE_LAN_LISTENER=true`, `GTCT_LOCAL_HOST` and `GTCT_LAN_BIND_ADDRESS` are the same private IPv4 address, HTTPS material loads, and the certificate includes `DNS:` plus `GTCT_LAN_HOSTNAME`. TLS 1.2 is the minimum. HTTP is not used as a fallback. Physical printing and a database on a network folder are refused in that mode.

The intended test name is `gtct-pos`. The browser URL is `https://gtct-pos:8787`. The certificate needs the Subject Alternative Name `DNS:gtct-pos`. Do not browse to the raw IP. Do not continue past a certificate warning.

Staff sign-in stays a username and password. The cookie is HttpOnly, Secure, and SameSite=Strict. Bearer tokens stay rejected. Only that HTTPS origin is accepted. This document does not change the firewall, the virtual-machine network, or any trust store. Those steps wait for approval. Do not forward the server through the router.

## Status meanings

`DISPATCHED` means the adapter finished a send/write attempt.  
`CONFIRMED` requires authorized admin confirmation — never inferred from TCP/spooler success alone.

## Docs

- `docs/phase1-local-server.md`
- `docs/phase1-sqlite-backup.md`
- `docs/phase1-acceptance.md`
