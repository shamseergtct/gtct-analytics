# Phase 1.1 Acceptance Report

**Decision: CONDITIONAL PASS**

Date: 2026-10-18  
Host tested: macOS (darwin) + Node.js v24.16.0  
Windows 10 / Windows 11: **NOT TESTED**

## A. Dependency compatibility

| Package | Version | Notes |
|---|---|---|
| Node.js | v24.16.0 (engines `>=24.0.0 <25`) | Preferred LTS target |
| better-sqlite3 | 13.0.3 | Upstream engines `>=22`; loads on this host |
| Other native print libs | none | Spooler not wired |

No engine warnings for `local-server` on Node 24 after the engines correction.

## B. Tests executed

| Command | Result |
|---|---|
| `npm install` (in `local-server/`) | PASS |
| SQLite in-memory open | PASS (`sqlite 3.53.4`) |
| `npm run accept:phase1.1` (8 checks) | PASS |
| `npm run demo:order` (idempotent re-run) | PASS (`created: false`) |
| HTTP start without tokens | PASS (refuses to start) |
| Windows PowerShell suite | **NOT RUN** |

## C. Windows 10 status

**NOT TESTED / BLOCKED** — no Windows 10 22H2 host in this review.  
See PowerShell steps in `docs/phase1-acceptance.md`.

## D. Windows 11 status

**NOT TESTED / BLOCKED** — no Windows 11 host in this review.

## E. Printer routing

TEST-001 MOCK destinations verified by acceptance harness:

| Destination | Content |
|---|---|
| JUICE | 2 × Orange Juice; Less sugar; No ice |
| SHAWARMA | 1 × Chicken Shawarma; No onion; Less sauce |
| GRILL | 1 × Chicken Burger; Extra cheese; No sauce |
| CASHIER | Full order; labeled TEST DATA |

## F. Queue reliability

| Check | Result |
|---|---|
| Sequential idempotency | PASS |
| Concurrent HTTP duplicates (8×) | PASS (1 create) |
| Restart PENDING recovery | PASS |
| UNKNOWN without blind reprint | PASS |
| Reprint audit (`is_reprint=1`, new key) | PASS |
| Missing printer → NEEDS_REVIEW | PASS |

`DISPATCHED` ≠ physically printed. `CONFIRMED` is admin-only.

## G. Security

| Control | Status |
|---|---|
| Default bind `127.0.0.1` | Yes |
| Dev tokens opt-in (`GTCT_ALLOW_DEV_TOKEN`) | Yes |
| Admin vs device roles | Yes |
| Unauthenticated → 401 | Yes |
| Device cannot register printers / reprint | Yes (403) |
| LAN bind + well-known tokens rejected | Yes |
| TLS | **Not implemented — LAN NOT READY** |
| Firebase secrets in package | None found |

## H. Unimplemented / mocked

| Item | State |
|---|---|
| MOCK adapter | Implemented |
| NETWORK_TCP | Implemented, physical gated; no ACK |
| WINDOWS_SPOOLER | Stub only |
| TLS / multi-device LAN | Unimplemented |
| Windows Service / installer | Unimplemented |
| Firebase sync / live POS | Unimplemented (by design) |

## I. Files changed (Phase 1.1 scope)

Under `local-server/` and `docs/` only (prototype hardening + docs).  
Notable: `package.json` engines → Node 24; `better-sqlite3` → 13.0.3; auth/config/HTTP role gates; `acceptancePhase11.js`; docs updates.

## J. Production safety

Phase 1.1 did **not** modify:

- `src/pages/Sales.jsx`
- `src/utils/posInvoiceSubmit.js`
- root `package.json`
- Firebase config

**Note:** The git working tree still contains **pre-existing** dirty files from earlier Restaurant Sales / menu work (`RestaurantSales.jsx`, `RestaurantMenuSetup.jsx`, `restaurantMenu.js`, `firestore.rules`, `menuImageStore.js`). Those are outside Phase 1.1 and were not edited for this hardening pass.

No commit, push, or deploy was performed.

## K. Readiness decision

**CONDITIONAL PASS** — source/mock acceptance passed; Windows/hardware verification remains.

## L. Next action

Run the PowerShell acceptance block in `docs/phase1-acceptance.md` on a Windows 10 22H2 x64 machine with Node.js 24 LTS, then repeat on Windows 11. Do not start Phase 2 or LAN exposure until that passes.
