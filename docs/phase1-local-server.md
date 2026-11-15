# Phase 1 — Local Server & Multi-Printer Kitchen System

## Scope status (Phase 1.1)

Isolated Node.js local server under `local-server/` with SQLite, stations, MOCK printers, durable print queue, and TEST-001 routing.

**Out of scope / not ready:** Firebase sync, live POS integration, Windows Service installer, Electron, TLS LAN, physical printer certification.

**Readiness:** CONDITIONAL PASS (mock/source). Windows hardware **NOT TESTED**.

## Runtime (Phase 1.1 correction)

| Item | Value |
|---|---|
| Preferred Node.js | **24 LTS** (`engines`: `>=24.0.0 <25`) |
| SQLite | `better-sqlite3` `^13.0.3` (upstream `engines.node: >=22`) |
| Default bind | `127.0.0.1:8787` |

Node.js 20 is EOL as of 2026 and is no longer the Phase 1 target.

## Operating systems

| Target | Role | Acceptance |
|---|---|---|
| Windows 10 22H2 x64 | Primary | **NOT TESTED** |
| Windows 11 x64 | Secondary | **NOT TESTED** |

Same codebase/schema/API for both. No Windows 11-only APIs are required.

Windows 10 mainstream support ended 2025-10-14 — use ESU or a maintained configuration.

### Unverified on Windows (source-reviewed only)

- Native `better-sqlite3` compile/load via `npm ci`
- `%LOCALAPPDATA%\GTCT\RestaurantLocalServer` permissions
- Windows Defender first-run blocks
- Firewall interaction if LAN bind is forced
- WINDOWS_SPOOLER real queue submission

Exact PowerShell steps: see `docs/phase1-acceptance.md`.

## Security limitations (Phase 1.1)

| Topic | Status |
|---|---|
| Default bind loopback | Implemented |
| Opt-in dev tokens (loopback only) | Implemented |
| Admin vs device roles | Implemented |
| Reject unauthenticated API | Implemented |
| LAN bind gate (`GTCT_ALLOW_LAN_BIND`) | Implemented |
| Block well-known tokens on LAN | Implemented |
| TLS | **Not implemented — LAN NOT READY** |
| Per-device hashed credentials at rest | Stub table only |
| Production Firebase secrets | None in this package |

## Architecture

```
Windows PC (local server)
  └── Node.js 24 process
        ├── HTTP API (default 127.0.0.1)
        ├── SQLite (WAL) in persistent app data dir
        ├── Print dispatch loop
        └── Adapters: MOCK (supported) | NETWORK_TCP (gated) | WINDOWS_SPOOLER (stub)
```

## Capability matrix

| Capability | State |
|---|---|
| Health endpoint | Implemented |
| SQLite + migrations | Implemented |
| Stations / printers / mappings | Implemented |
| TEST-001 sample order | Implemented |
| MOCK print files | Implemented |
| Durable print_jobs + events | Implemented |
| Idempotency keys | Implemented |
| Admin reprint / confirm | Implemented |
| NETWORK_TCP send | Implemented, physical gated; no ACK |
| WINDOWS_SPOOLER | Architecture stub only |
| TLS / mTLS LAN | Unimplemented |
| Windows Service installer | Unimplemented |
| Firebase sync | Unimplemented |

## Sales Test UI

Served at `GET /` (static files under `local-server/public/`).

Browser auth: `POST /v1/session/login` with `{ "token": "…" }` sets an HttpOnly cookie.  
Sessions work only when the server is loopback-bound **and** the client is loopback. Tokens are not embedded in static assets.

## API summary

| Method | Path | Auth |
|---|---|---|
| GET | `/` | Public static UI shell |
| GET | `/health` | None |
| POST | `/v1/session/login` | Loopback + valid token |
| POST | `/v1/session/logout` | Cookie clear |
| GET | `/v1/session/me` | Session or bearer |
| GET | `/v1/*` reads | Device or admin |
| GET | `/v1/print-jobs/:id/preview` | Device or admin |
| POST | `/v1/test-orders` | Device or admin |
| PUT | stations/printers/menu | **Admin** |
| POST | dispatch / confirm / reprint / printer test | **Admin** |

## Print job states

`PENDING → DISPATCHING → DISPATCHED | FAILED | UNKNOWN | NEEDS_REVIEW`  
`CONFIRMED` only via admin confirmation (or future reliable device ACK).

## Future installer (not built)

Prefer Windows Service + optional tray status app. Preserve SQLite across upgrades; never silently delete business data on uninstall.
