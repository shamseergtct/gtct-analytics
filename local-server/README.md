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
| `GTCT_CLOUD_BRIDGE_SECRET` | unset | Shared secret with Firebase `RESTAURANT_DELIVERY_BRIDGE_SECRET` (required to publish) |
| `GTCT_CLOUD_BRIDGE_ENABLED` | unset | Optional force-enable (`1`/`true`); Shop Settings checkbox also enables |
| `GTCT_CLOUD_CLIENT_ID` | unset | Optional default Analytics `clientId` if Shop Settings field is empty |
| `GTCT_CLOUD_BRIDGE_URL` | asia-south1 function URL | Override bridge HTTP endpoint |
| `GTCT_CLOUD_BRIDGE_INTERVAL_MS` | `8000` | Publish/claim sync interval |

### Online delivery bridge (TEST, cellular Delivery Boys)

Keeps the existing Delivery App **Bills** flow. Adds **Shop orders** for restaurant POS deliveries over mobile data.

1. Firebase project must be on **Blaze** (Cloud Functions / Cloud Build). Deploy Firestore rules + Cloud Functions (`acceptRestaurantDeliveryOrder`, `updateRestaurantDeliveryStatus`, `reportRestaurantDeliveryPayment`, `restaurantDeliveryBridge`). Put the shared key in `functions/.env` as `RESTAURANT_DELIVERY_BRIDGE_SECRET=...` (gitignored).
2. In Shop Settings → Currency panel → **Online delivery bridge**, set the Analytics **clientId** that your test Delivery Boys already belong to (`users.assignedShops` / `clientId`). Enable the bridge. Do **not** create a new Analytics shop yet — that is the next phase for reports.
3. Export the same value as `GTCT_CLOUD_BRIDGE_SECRET` for the local server and restart.
4. Ready local DELIVERY orders publish to `restaurant_delivery_orders`. Boys accept / mark delivered / payment in the Delivery App; the local POS applies claims and marks on the next sync tick.

## HTTPS on this computer

Leave the TLS variables unset for normal use. The server then stays on `http://127.0.0.1:8787`.

To try HTTPS locally, create a certificate whose name is `localhost` and `127.0.0.1`, using a certificate tool this computer already trusts. Point `GTCT_TLS_CERT_FILE` and `GTCT_TLS_KEY_FILE` at those files. Open `https://127.0.0.1:8787`. If the browser warns, the certificate is not trusted yet. Do not continue past that warning.

A self-signed certificate for a raw IP address is not trusted by other computers. This step does not install a certificate authority.

## Prepared LAN test (not opened)

The server still starts on `127.0.0.1` and does not listen on the restaurant network. A private-address listener is possible only when all of these are true: `GTCT_ALLOW_LAN_BIND=true`, `GTCT_ENABLE_LAN_LISTENER=true`, `GTCT_LOCAL_HOST` and `GTCT_LAN_BIND_ADDRESS` are the same private IPv4 address, HTTPS material loads, and the certificate includes `DNS:` plus `GTCT_LAN_HOSTNAME`. TLS 1.2 is the minimum. HTTP is not used as a fallback. A database on a network folder is refused. Physical printing may stay on when `GTCT_ENABLE_PHYSICAL_PRINT=true` (Mac LAN terminal testing).

The intended test name is `gtct-pos`. The browser URL is `https://gtct-pos:8787`. The certificate needs the Subject Alternative Name `DNS:gtct-pos`. Do not browse to the raw IP. Do not continue past a certificate warning.

### Mac LAN terminals (TEST)

1. `npm run cert:mac-lan` — creates a local `gtct-pos` certificate under Application Support.
2. Add `<mac-lan-ip> gtct-pos` to `/etc/hosts` on this Mac and each tablet/PC; trust the cert.
3. Admin → **Terminals** → add device → **Pair code**.
4. On the tablet open `https://gtct-pos:8787/pair.html`, enter the code, then staff sign-in.
5. Start LAN with `npm run start:mac-lan` (physical print defaults to on).

Staff sign-in stays a username and password. The cookie is HttpOnly, Secure, and SameSite=Strict. Bearer tokens stay rejected. Only that HTTPS origin is accepted. This document does not change the firewall, the virtual-machine network, or any trust store. Those steps wait for approval. Do not forward the server through the router.

## Status meanings

`DISPATCHED` means the adapter finished a send/write attempt.  
`CONFIRMED` requires authorized admin confirmation — never inferred from TCP/spooler success alone.

## Docs

- `docs/phase1-local-server.md`
- `docs/phase1-sqlite-backup.md`
- `docs/phase1-acceptance.md`


## Phase P2-A1 — TEST / production isolation (not Real Mode)

The current server remains **TEST-ONLY**. No production order path has been added.
The default operating mode is `TEST` (including existing loopback and LAN pilot
configurations). `GTCT_OPERATING_MODE=REAL`, `PRODUCTION`, or any value other
than `TEST` **rejects startup**, including `npm run migrate` / `npm run seed`.

A future production data directory is reserved separately from the legacy test
data directory (`RestaurantProductionServer` beside `RestaurantLocalServer`
on Windows; `data-production` beside `data` in source development).
Optionally set `GTCT_PRODUCTION_DATA_DIR` to reserve a different absolute folder.
The TEST process refuses to use that folder (or a nested folder) for its SQLite
database. The reservation does **not** create a production DB or start Real Mode.

At HTTP boot, an existing SQLite DB is inspected through a **read-only handle
before migrations**. Any existing non-test orders, malformed identity marker,
or mismatched identity cause startup to stop. After migrations, the TEST DB gets
a `meta` identity marker (`gtct.database.identity.v1`) with its TEST tenant.
Legacy test databases with no marker and only test orders can continue as before.
Never point this server at live restaurant databases.

Run the dependency-free targeted tests:

```sh
npm run accept:production-guard
```

Before ever enabling real sales, a separate production initialization workflow,
production tenant identity, reporting/void/refund/close, backup validation,
Kitchen status integrity and physical printer strategy still require design,
implementation and independent Windows verification.

## Phase P2-A2 — SEALED production database placeholder (NO real sales)

This is an **offline, deliberately non-operational** production identity placeholder. It
is not a production release and cannot accept orders, money, customers, or printer
jobs. The normal server and all normal CLI commands remain TEST-only, even when
`GTCT_OPERATING_MODE=PRODUCTION` is requested. P2-A2 does not import TEST data,
run restaurant migrations on the sealed database, create an Admin, or expose a
production HTTP listener.

Run the **acceptance test first** on a Mac test copy:

```sh
npm run accept:production-vault
```

Future explicit initialization (`GTCT_PRODUCTION_DATA_DIR` must be a fresh,
**nonexistent local folder**, outside the source tree and TEST folder):

```sh
GTCT_PRODUCTION_DATA_DIR="$HOME/GTCT-Production-Vault" \
  npm run production:prepare-sealed -- --confirm-sealed-only
GTCT_PRODUCTION_DATA_DIR="$HOME/GTCT-Production-Vault" \
  npm run production:verify-sealed
```

The preparer creates exactly one SQLite file `gtct-production-sealed.sqlite`
containing a sealed PRODUCTION identity and **no operational tables**. A second
initialization refuses to overwrite the folder.

Make an optional **manual, SQLite-safe, verified** backup outside that folder:

```sh
GTCT_PRODUCTION_DATA_DIR="$HOME/GTCT-Production-Vault" \
GTCT_PRODUCTION_BACKUP_DIR="$HOME/GTCT-Production-Backups" \
  npm run production:backup-sealed
```

These commands are for an authorized **future controlled foundation step**, not
for immediate use on existing restaurant or Windows pilot data. This is not an
automatic backup service; no restore/production activation is provided. Backups
are unencrypted and must be protected with OS permissions, secure storage and
an eventual restore drill. Real mode, production migrations, printers, shifts,
financial corrections and live go-live remain blocked.


### P2-B2 Kitchen-only staff (TEST only)

- In **Users** (Admin login), create a **Kitchen Staff** account and check one or more active preparation stations.
- Kitchen staff sign in on `/prep.html` using their own username/password.
- The API returns only their assigned stations and refuses reads/writes for other stations (HTTP 403). Admin retains all stations; Cashier retains the P2-B1 preparation permission.
- Changing station assignments, role or active status revokes that staff member's existing sessions. They must sign in again.
- Kitchen staff have `prep.station.work` only; they cannot create sales, view the order register, manage staff or access Admin APIs.
- Migration `027_kitchen_staff_stations.js` is additive, creating `role_kitchen` and `staff_station_assignments`. It does **not** touch financial calculations, existing orders or production vault.
- Run `npm run accept:kitchen-roles` on the isolated Mac TEST copy. It creates disposable temporary SQLite data only. This is not approval to enable real sales or physical printing.
