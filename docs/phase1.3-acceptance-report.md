# Phase 1.3 Acceptance Report

**Decision: Mac development COMPLETE — STOP for approval**  
No Windows transfer. No physical print jobs sent. No production Firebase/accounting changes.

## 1. Existing implementation audit

### Already present (reused)

- Sales Test UI (`public/index.html`, `app.js`) with cart, category chips, kitchen instruction modal, ticket preview
- SQLite `menu_items` + `item_stations` + `order_line_instructions`
- `PUT/GET /v1/menu-items`, `POST /v1/test-orders` (idempotent on order number)
- MOCK printers, Phase 1.2 Printer Settings, audit events, loopback session auth
- Ticket format already prints line instructions

### Gaps addressed in 1.3

- No admin Menu Setup page
- Menu rows lacked category/subcategory, price, description, photo, sold-out, sort order, item instruction options
- Categories were derived from station names
- Images not stored on server
- Sales UX lacked review step, image cards, cart display totals, subcategory filters, sold-out handling

### Intentionally not duplicated

- Extended `services/menuMappings.js` (no parallel menu module)
- Kept Printer Settings and MOCK dispatch untouched in behavior
- Did not modify `src/pages/RestaurantSales.jsx` or other production app modules for this phase

## 2. Changes made

**Created**

- `local-server/src/db/migrations/003_menu_setup.sql`
- `local-server/public/menu.html`, `menu.js`
- `local-server/src/scripts/acceptancePhase13.js`
- `docs/phase1.3-menu-sales-ux.md`, `docs/phase1.3-acceptance-report.md`

**Modified**

- `local-server/src/services/menuMappings.js` — full menu CRUD, images, instruction helpers
- `local-server/src/services/orders.js` — instruction dedupe on persist
- `local-server/src/http/server.js` — menu/category/image APIs, health phase 1.3
- `local-server/src/config.js` — `menuImagesDir`
- `local-server/src/seed/sampleData.js` — richer seed fields (same IDs)
- `local-server/public/index.html`, `app.js`, `styles.css`, `settings.html`
- `local-server/package.json`, `README.md`

## 3. Screens / pages improved

| Screen | Notes |
|---|---|
| Sales Test (`/`) | Images, search, category/subcategory, qty controls, display totals, instruction preview, order review, admin Menu Setup link |
| Menu Setup (`/menu.html`) | Admin CRUD, validation, photos, station map, sold-out/active, sort, instruction options |
| Printer Settings | Nav link to Menu Setup only; behavior unchanged |

## 4. Database migrations

`003_menu_setup.sql` — additive `ALTER TABLE` + indexes + seed backfill `UPDATE`s. No drops. Existing IDs preserved.

## 5. Test results

| Command / check | Result |
|---|---|
| `npm run accept:phase1.3` | **PASS 12/12** (`physicalPrintAttempted: false`) — includes optional SKU, availability, no-prep routing |
| `npm run accept:phase1.1` | **PASS 8/8** (regression) |
| `npm run accept:phase1.2` | **PASS 6/6** (regression) |
| Local DB migrate `003_menu_setup.sql` | Applied; seed IDs preserved with categories/prices |
| Live smoke on `127.0.0.1:8787` | health phase `1.3`; menu list; device menu PUT **403**; order + MOCK kitchen ticket includes `LESS SUGAR` / `NO ICE`; `/`, `/menu.html`, `/settings.html` **200** |
| Platform | darwin + Node v24.16.0 |
| Physical prints | **Not attempted** |

## 6. Remaining incomplete features

- Multi-station mapping UI still maps one primary kitchen station per item (schema supports many; Sales routing still expects unambiguous mapping)
- No bulk import/export of menu CSV
- No subcategory management as a first-class table (text fields only)
- LAN multi-device auth/TLS still NOT READY
- Physical printing still gated / not exercised
- Windows transfer / Windows acceptance NOT TESTED

## 7. Product decisions needed

1. Currency / locale for display prices (currently plain decimal from cents)?
2. Should sold-out items be hidden entirely from Sales, or shown disabled (current: shown disabled)?
3. Allow multiple kitchen stations per item in the Menu Setup UI, or keep single-station for Phase 1?
4. Confirm whether custom free-text notes should remain alongside structured modifier+target (currently yes)?
