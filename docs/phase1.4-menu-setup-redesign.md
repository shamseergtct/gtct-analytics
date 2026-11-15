# Phase 1.4 — Menu Setup Modern Light Redesign + Shop Currency

**Decision: Mac implementation COMPLETE — STOP for owner review**  
No Sales redesign. No Windows transfer. No physical prints. No commit/push.

---

## 1. Files inspected

- `local-server/public/menu.html`, `menu.js`, prior menu CSS / `styles.css`
- `local-server/public/index.html`, `app.js`, `settings.html`, `settings.js`
- `local-server/src/http/server.js`, `auth.js`, `sessions.js`, `config.js`
- `local-server/src/services/menuMappings.js`, `categories.js`, `orders.js`, `printQueue.js`
- `local-server/src/db/migrations/001–004`, `schema.sql`
- Prior docs: phase 1.1–1.3 acceptance / ops notes
- Approved desktop + mobile Menu Setup mockups (owner-supplied)

## 2. Files modified / added

| Path | Role |
|---|---|
| `local-server/public/menu.html` | Redesigned Menu Setup shell (tabs, list, editor, categories, kitchen notes) |
| `local-server/public/menu.js` | Items / Categories / Kitchen Notes UX + currency-aware pricing |
| `local-server/public/menu-setup.css` | GTCT Modern Light tokens + responsive layouts |
| `local-server/public/money.js` | Browser money formatter / parser (mirrors server) |
| `local-server/public/styles.css` | Shared light tokens flattened for cohesion |
| `local-server/src/util/money.js` | Server money formatter / parser |
| `local-server/src/services/shopSettings.js` | Shop currency + kitchen-notes settings |
| `local-server/src/services/categories.js` | Category/subcategory management (phase ops) |
| `local-server/src/services/menuMappings.js` | Menu item APIs / availability |
| `local-server/src/http/server.js` | `/v1/shop-settings`, `/v1/kitchen-notes`, menu routes |
| `local-server/src/db/migrations/005_shop_settings.sql` | Additive `shop_settings` table |
| `local-server/src/scripts/acceptancePhase14.js` | Phase 1.4 acceptance suite |
| `docs/phase1.4-menu-setup-redesign.md` | This report |

## 3. Design changes completed

- **GTCT Modern Light**: Primary `#0B539E`, accent `#99AC3E` (sparingly), bg `#F5F7FA`, cards white, borders `#D7E0EA`
- System/native fonts; spacing scale 4–32; soft borders; minimal shadow
- Header with GTCT branding, Menu Setup title, role/currency badges, Sales / Printers / Sign out only
- Primary tabs: **Items | Categories | Kitchen Notes** (no page reload)
- Status badges: Active (green), Sold out (orange), Inactive (gray)
- Filter chips + search; compact item cards with thumbnail, name, price, category/station tags

## 4. Screens implemented

1. Admin sign-in (preserved token auth)
2. Items — list + filters + quick Sold out
3. Items — focused New/Edit editor (desktop side pane; mobile full-screen)
4. Categories — expandable cards, add/rename/activate on demand
5. Kitchen Notes — chip editors for modifiers & targets

URL: `http://127.0.0.1:8787/menu.html` (dev: `GTCT_ALLOW_DEV_TOKEN=true`, admin token `phase1-admin-token`)

## 5. Mobile responsiveness

| Width | Behavior verified |
|---|---|
| 375px | List-first, FAB **+ Add Item**, full-screen editor (`position: fixed; inset: 0`), sticky Save footer, safe-area padding |
| 768px | Tablet/editor stack; FAB; no horizontal overflow |
| 1024px+ | Desktop list + side editor; FAB hidden; **+ New menu item** in toolbar |
| 1440px | Same desktop pattern; list expands when editor closed |

`window.innerWidth` checked at 375 with `editor-open` + `matchMedia('(max-width: 1023px)') === true`.

## 6. Item entry behavior

- Required: name, price, category (where enforced)
- Optional: SKU, code, subcategory, photo, sort, description
- Kitchen station: **None — No Preparation** default; GRILL / JUICE / SHAWARMA from configured stations
- No-prep → empty `item_stations` (no prep ticket; still on cashier receipt)
- Availability segment maps to independent `is_active` + `is_sold_out` (not one DB field)
- Quick Sold out / Available from list without full editor
- Advanced details collapsible for SKU/code/sort/description/item-specific notes
- Photo upload/replace/remove via existing local-server storage
- Save: validation, disable double-submit, success toast; unsaved-change warn on abandon

## 7. Categories & Kitchen Notes

**Categories**

- Expandable cards: name, Active/Inactive, sub count, item count
- Display-mode default; edit/rename only on demand
- Add category / Add subcategory; activate/deactivate; IDs preserved
- Inactive categories filterable via “Show inactive”
- Legacy categories (e.g. Drinks, Grill) may remain until owner deactivates — no auto-delete/merge

**Kitchen Notes**

- Shop-wide modifiers (Less, More, No, Extra) and targets (Sugar, Sauce, …) as chips
- Stored in `shop_settings` JSON; `GET/PUT /v1/kitchen-notes`
- Item-specific overrides remain in Advanced details
- Order instruction payload / ticket dispatch unchanged

## 8. Currency settings source

Isolated local-server had **no shop currency** before 1.4.

| Setting | Storage |
|---|---|
| Shop identity | `shop_settings.shop_id` (= `testTenantId`) |
| Currency | `currency_code`, `currency_label`, `currency_decimals` |
| Prices | Existing `menu_items.price_cents` = **integer minor units** |

Defaults: **QAR / QR / 2** (matches prior seed interpretation).  
Presets: BHD (3 dp), QAR (QR, 2), INR (₹, 2).  
Optional env (display until admin save): `GTCT_SHOP_CURRENCY`, `GTCT_SHOP_CURRENCY_LABEL`, `GTCT_SHOP_CURRENCY_DECIMALS`.  
APIs: `GET/PUT /v1/shop-settings` (admin write).

**No multi-shop selector** invented — single shop identity already used by the isolated server.

## 9. Currency formatter

- Server: `local-server/src/util/money.js` — `formatMoneyMinor`, `parseMoneyInput`, `moneyInputStep`
- Client: `local-server/public/money.js` — same contract for Menu Setup UI
- Reads active shop label + decimals; preserves trailing zeros; thousands separators via `toLocaleString`
- **Changing decimals does not rescale stored `price_cents`**
- No float money math; excess entered precision rejected (400), never silently truncated
- Designed for later reuse on Sales / cart / tickets (not wired there in 1.4)

## 10. SQLite changes

`005_shop_settings.sql` — **additive only** (`shop_settings` table).  
No destructive migrations. No monetary column rewrites. Existing `price_cents` values unchanged after currency preset flips.

## 11. Automated test results

```
npm run accept:phase1.4  →  7/7 PASS
  currency-default-qar
  currency-presets-no-rescale   (BHD 1.500 / INR ₹ 150.00 / QAR QR 1.50; stored 800 unchanged)
  menu-setup-assets
  no-prep-and-availability
  kitchen-notes-api
  printer-settings-intact
  restart-persistence

npm run accept:phase1.3  →  regression PASS (incl. optional-sku, availability, no-prep, physical-print-disabled)
```

`physicalPrintAttempted: false` throughout.

## 12. Manual browser checks completed

Server: `127.0.0.1:8787` with `GTCT_ALLOW_DEV_TOKEN=true` (MacBook).

| Check | Result |
|---|---|
| Menu Setup loads + admin sign-in | Pass |
| Items list, search, filter chips, QR prices | Pass |
| Categories tab expandable cards | Pass |
| Kitchen Notes chip UI | Pass |
| Mobile 375 list + FAB + full-screen editor | Pass (CDP device metrics) |
| Tablet 768 editor stack | Pass |
| Currency badge `QAR · 2 DP` in header | Pass |
| Printer Settings page still served | Covered by acceptance + nav link |
| Physical print disabled | Acceptance + server meta |

Screenshots captured during session (Cursor browser): sign-in, Items, Categories, Kitchen Notes, mobile/editor.

## 13. Known limitations

1. **Sales / Printer Settings** not visually redesigned (by design).
2. **Currency admin UI** is API + header badge; no dedicated currency settings screen yet (presets via API/env).
3. **Legacy categories** from earlier seeds may coexist with Food/Beverages until manually deactivated.
4. **Browser-wide multi-shop selector** not present — shop = server `testTenantId` / `shop_settings.shop_id`.
5. Money formatter not yet applied on Restaurant Sales UI (ready for reuse).
6. Cursor browser panel chrome may differ from a physical phone; widths verified via CDP `Emulation.setDeviceMetricsOverride`.

## 14. Preview

- Local: http://127.0.0.1:8787/menu.html  
- Sign in with admin token when `GTCT_ALLOW_DEV_TOKEN=true`: `phase1-admin-token`

## 15. Remaining design questions for owner

1. Should inactive legacy categories (Drinks / Grill) be auto-hidden by default, or left visible until manually cleaned?
2. Prefer a small **Shop currency** panel on Menu Setup (admin-only) vs settings-only API for now?
3. When Sales is redesigned next: apply the same Modern Light tokens + shared `money.js` immediately?
4. Any shop-specific currency beyond BHD / QAR / INR presets needed before Windows transfer?

---

**STOP** — awaiting owner review before Restaurant Sales redesign or Windows work.
