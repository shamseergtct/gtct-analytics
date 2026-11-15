# Phase 1.5 — Kitchen Instructions Library, Add-ons & Item Customization

**Decision: Mac implementation COMPLETE — STOP for owner review**  
No Windows transfer. No physical prints. No commit/push. No Sales visual redesign beyond customization/cart/money wiring.

---

## 1. Existing implementation audit

| Area | Before 1.5 | Action |
|---|---|---|
| Kitchen notes | Shop + item JSON string arrays | Extended into normalized library; JSON kept in sync |
| Order instructions | `order_line_instructions.label` | Reused (free-text snapshot) |
| Add-ons | None | New catalog + assignments + order snapshots |
| Order pricing | None (display-only on client) | Server resolves integer minor units; snapshots on lines |
| Tickets | Instructions only | Kitchen + cashier show add-ons; cashier shows amounts |
| Currency | Shop settings + money util (1.4) | Reused everywhere for new prices |
| Auth | Admin vs device | Masters/pricing admin-only; sales selection for device |

## 2. Files created / modified

**Created**

- `src/db/migrations/006_menu_customization.js`
- `src/services/kitchenLibrary.js`
- `src/services/addons.js`
- `src/scripts/acceptancePhase15.js`
- `docs/phase1.5-menu-customization.md`

**Modified**

- `src/services/orders.js` — validate instructions, resolve add-ons, snapshot totals
- `src/services/menuMappings.js` — expose instructionConfig + addons; save assignments on upsert
- `src/services/printQueue.js` — payload includes addons + money meta
- `src/print/ticketFormat.js` — kitchen clarity + cashier charges/totals
- `src/http/server.js` — library / addons / item instruction & addon APIs
- `public/menu.html`, `menu.js`, `menu-setup.css` — Tabs: Items, Categories, Kitchen Instructions, Add-ons; checkbox assignment UI
- `public/index.html`, `app.js` — customize dialog, cart lines, shop money formatter
- `package.json` — `accept:phase1.5`

## 3. Database migrations

`006_menu_customization.js` — **additive / non-destructive**

- Masters: `kitchen_modifiers`, `kitchen_targets`, `kitchen_standalone`, `addons`
- Item links: `menu_item_allowed_*`, `menu_item_blocked_pairs`, `menu_item_addons` (nullable `price_override_cents`)
- Orders: `order_line_addons`; columns on `order_lines` / `orders` for price snapshots
- Seeds masters from existing shop JSON; marks customized items that already had non-empty JSON
- Does **not** reset DB, delete orders, or rescale `price_cents`

## 4. Common instruction library

- Shop-scoped modifiers / targets / standalone (“Well Done”)
- Admin add / rename / activate / deactivate; duplicate normalized names → 409 on rename clash
- Legacy `GET/PUT /v1/kitchen-notes` still works (upsert-by-name)
- New: `GET /v1/kitchen-library`, `PUT /v1/kitchen-modifiers|targets|standalone`

## 5. Add-ons library

- Fields: id, name, description, `price_cents` (minor units), active, sort, max_quantity (default 1)
- Free = effective price 0; Paid = > 0
- `GET/PUT /v1/addons`, assignments listing
- Device cannot create/change prices (403)

## 6. Item-level selection & overrides

- Item editor: Use shop defaults vs Customize checkboxes for modifiers/targets/standalone
- Add-ons: tick to enable; optional override input (blank = library default; `0` = explicit free)
- Persisted in SQLite; survives restart
- Library changes do **not** silently overwrite item checkbox selections

## 7. Sales customization

- Selecting an item opens Customize when options exist
- Instructions: modifier → target (+ standalone chips); multi; dedupe; removable
- Add-ons: checkboxes with effective prices (Free / + amount)
- Cart shows base, instructions, add-ons, line total
- Different customizations stay as separate lines (merge only identical sets)
- POST `/v1/test-orders` sends `addons: [{ addonId, quantity }]` — **no client prices trusted**

## 8. Exact price calculation

```
unit_base = menu_items.price_cents
unit_addons = Σ (resolved_effective_addon_price × addon_qty)
unit_total = unit_base + unit_addons
line_total = unit_total × line_qty   (whole-number qty only)
order.total_cents = Σ line_total
```

All integer minor units. Resolved from authorized shop/item config at order time. Snapshots stored on `order_lines` / `order_line_addons`. Later library price changes do not alter historical orders.

## 9. Shop currency

Reuses `shop_settings` + `formatMoneyMinor` / client `money.js`. BHD 3 dp / QAR 2 / INR 2 verified in acceptance. No currency conversion.

## 10. Cart & tickets

- Cart: name, qty, base, free instructions, free/paid add-ons, line total
- Kitchen MOCK: instructions + `+ ADDON` (no prices)
- Cashier MOCK: base, add-on charges, TOTAL with shop label; still “TEST DATA — NOT A CUSTOMER BILL”

## 11. Security & API validation

- Admin-only: library CRUD, addon prices, item assignments/overrides
- Device: read catalogs, select enabled options, place test orders
- Server rejects inactive addons, unknown assignments, non-integer qty, blocked instruction pairs
- Idempotent `(tenant_id, order_number)` preserved
- Physical print remains disabled

## 12. Automated test results

```
npm run accept:phase1.5  →  12/12 PASS
npm run accept:phase1.4  →  7/7 PASS (kitchen-notes compat restored)
npm run accept:phase1.3  →  PASS
```

`physicalPrintAttempted: false`

## 13. Manual browser tests

Not fully re-run in this pass after UI wiring. Automated API/UI asset checks passed. Owner should spot-check:

- Menu Setup → Kitchen Instructions / Add-ons tabs
- Item editor instruction checkboxes + add-on overrides
- Sales customize dialog + cart totals (BHD if configured)

Server: `http://127.0.0.1:8787` with `GTCT_ALLOW_DEV_TOKEN=true`

## 14. Screenshots

Not captured in this validation pass (API-first). Prior Phase 1.4 Menu Setup screenshots remain applicable for shell chrome.

## 15. Remaining limitations / decisions

1. **Add-on max quantity** defaults to 1; qty stepper beyond 1 is API-ready but Sales UI currently toggles qty=1 only.
2. **Blocked modifier×target pairs** are stored/API-ready; Menu Setup UI for editing denylist pairs is minimal (not a full matrix editor yet).
3. **Sales page chrome** not fully restyled to Modern Light (only customization + money + cart clarity).
4. **No multi-shop selector** — single `shop_settings.shop_id` / test tenant.
5. Pair-restriction admin UX and richer addon qty controls can be a follow-up after owner review.

---

**STOP** — awaiting owner approval before Windows transfer or further phases.
