# Phase 1.6 — Editable Add-on Price Adjustments (Completion Report)

**Status:** Implemented and tested on MacBook only  
**Date:** 2026-10-19  
**Scope:** `local-server/` only — no commit, push, deploy, Windows transfer, or physical print

---

## 1. Existing code inspection findings

| Area | Location | Finding |
|------|----------|---------|
| Common add-on library | `services/addons.js`, Menu Setup UI | Integer `price_cents` minor units; Phase 1.5 had `CHECK (price_cents >= 0)` |
| Item-specific override | `menu_item_addons.price_override_cents` | `NULL` = library default; `0` = explicit free (already distinct) |
| Order-line pricing | `orders.js` + `resolveOrderAddons` | Server recalculates; client totals ignored |
| Money | `util/money.js`, `public/money.js` | Integer minor units; shop decimals; signed parse already supported |
| Auth | `auth.js`, session/bearer roles | Roles: `device`, `admin` only — no manager-override workflow |
| Audit | `services/audit.js` | Existing `audit_events` table reused |
| Tickets | `ticketFormat.js`, `printQueue.js` | Kitchen vs cashier already separated; MOCK only |
| Cart identity | `public/app.js` | Each add creates a distinct `lineId`; customization key now includes applied add-on prices |

**Limitation reviewed before migration:** non-negative CHECKs blocked signed library / order-line amounts. Migration `007_signed_addon_prices.js` removes those CHECKs non-destructively (FK-safe rebuild). Historical rows preserved; prior applied prices copied into `configured_unit_price_cents` with `price_adjusted = 0`.

---

## 2. Files modified / added

**Added**

- `local-server/src/db/migrations/007_signed_addon_prices.js`
- `local-server/src/scripts/acceptancePhase16.js`
- `docs/phase1.6-acceptance-report.md`

**Modified**

- `local-server/src/services/addons.js` — `canAdjustAddonPrices`, signed resolve/override
- `local-server/src/services/orders.js` — signed snapshots, negative line reject, audit on adjust
- `local-server/src/http/server.js` — `canAdjustAddonPrices` on config/session
- `local-server/src/print/ticketFormat.js` — signed kitchen/cashier add-on labels
- `local-server/public/app.js` — draft Customize UI, signed prices, Apply/Cancel, auth-gated edit
- `local-server/public/index.html` — sectioned Customize modal + sticky Apply
- `local-server/public/styles.css` — customize / add-on price / summary layout
- `local-server/public/menu.js` — signed library price display
- `local-server/package.json` — `accept:phase1.6`

---

## 3. Schema changes (non-destructive)

Migration `007_signed_addon_prices.js`:

- `addons.price_cents` — signed integers allowed (CHECK ≥ 0 removed)
- `menu_item_addons.price_override_cents` — signed; `NULL` still means “use library”
- `order_line_addons` gains:
  - `configured_unit_price_cents`
  - `price_adjusted`
  - `adjusted_by_role`
  - signed `unit_price_cents` / `line_price_cents` (non-negative CHECKs removed)

Existing menu items, add-ons, orders, photos, stations, and print jobs retained on the live Mac DB after migrate.

---

## 4. UI changes (Sales Customize Item)

Preserved GTCT Modern Light; sections:

- **A** Kitchen instructions — modifier + target auto-add (no Add button)
- **B** Selected instructions — chip list with ×
- **C** Add-ons & price adjustments — checkbox, name, kind (Charge/Free/Reduction), editable price (admin), currency label
- **D** Price summary — base, charges, reductions, net, unit, qty, line total
- **E** Optional order note
- Sticky footer: **Cancel** / **Apply Customization**

Draft edits are not committed until Apply; Cancel discards (and removes a brand-new pending line).

---

## 5. Monetary representation and calculation

- Storage and arithmetic: **integer minor units** (`price_cents`), scaled by shop `currency_decimals`
- No IEEE float arithmetic for money
- Effective unit = base + Σ(addon unit × qty)
- Line total = unit × item quantity
- Negative final unit/line totals **rejected** (not clamped)
- Formatters: `formatMoneyMinor` / `createMoneyFormatter` (BHD 3dp, QAR/INR 2dp, trailing zeros preserved)

Price resolution order (display + server):

1. Order-line override (`unitPriceCents` when present and authorized)
2. Else item-specific override
3. Else library default

Explicit zero override remains distinct from missing override (`NULL`).

---

## 6. Authorization model

| Action | `device` | `admin` |
|--------|---------|---------|
| Select/remove add-ons at configured price | ✓ | ✓ |
| Kitchen instructions | ✓ | ✓ |
| Edit add-on amount / negative / override | ✗ (403) | ✓ |

`canAdjustAddonPrices(role)` → `role === "admin"` only.

**Limitation (by design):** no manager PIN / staff approval workflow. Admin-only until owner defines one. UI hides editing for non-admin; API enforces independently.

---

## 7. Price override rules

- Client may omit `unitPriceCents` → server uses configured effective price
- Client may send `unitPriceCents` equal to configured → accepted, not audited as adjust
- Client may send different `unitPriceCents` → requires admin; otherwise **403**
- Malformed / non-integer minor units → **400**
- Negative line/order totals → **400**
- No invented max-discount thresholds

---

## 8. Audit logging

On each actual override (`priceAdjusted === true`):

- Action: `order.addon.price_adjust`
- Records: configured, applied, delta, order/line/item/addon ids, actor role, deviceId
- Uses existing `audit_events` (no tokens in detail)

---

## 9. Server-side validation

`createTestOrder` → `resolveOrderAddons(…, { role })`:

1. Auth + shop tenant
2. Active menu item / sold-out checks
3. Add-on must be assigned & active for item
4. Quantity bounds
5. Resolve configured price on server
6. Permission check for override
7. Signed integer validation
8. Recalculate line/order totals
9. Reject negative totals
10. Persist snapshots transactionally
11. Idempotent on `(tenant_id, order_number)`

---

## 10. Cart and ticket changes

- Cart shows signed add-on labels (`+` / `−` / free)
- Customization key includes applied prices (lines with different amounts stay distinct)
- Kitchen MOCK: `+ DOUBLE CHEESE`, `- REMOVE CHEESE` (names, not money)
- Cashier MOCK: signed amounts + shop currency totals
- Physical print remains disabled

---

## 11. Automated test results

```text
npm run accept:phase1.6  → 18/18 PASS (darwin, Node v24.16.0)
npm run accept:phase1.5  → 12/12 PASS (regression)
```

Covered: positive/zero/negative amounts; BHD/QAR/INR precision; invalid precision; incomplete drafts; library/item unchanged after order-line edit; explicit zero; unauthorized vs authorized; audit; tamper 403; calc + qty; negative line reject; distinct lines; historical freeze; kitchen/cashier MOCK; idempotency; schema; UI assets.

Physical printing not attempted.

---

## 12. Manual browser test results

**Not performed in this session** (no interactive browser walkthrough claimed). UI assets are served and covered by static content assertions in acceptance 1.6. Recommend a short Mac browser pass with admin vs device tokens when convenient.

---

## 13. Known limitations

1. **Admin-only** price edits — no manager override / dual control
2. **No configurable adjustment caps** / negative-line policy beyond “reject negative totals”
3. **Currency/precision change while cart is open** — not auto-handled; cart minor units are not reinterpreted; operator should clear/rebuild cart after shop currency change (future explicit UX)
4. Windows UTM / real printers postponed
5. Production GTCT Analytics / Firebase / accounting untouched

---

## 14. Remaining business decisions

1. Should non-admin staff ever edit prices (manager PIN, thresholds)?
2. Maximum reduction % / amount before secondary approval?
3. Allow negative *order* totals for comps, or keep hard reject?
4. Should library defaults commonly be negative (e.g. “Remove Cheese”), or only order-line adjustments?
5. Currency-change-with-open-cart policy (block send vs force clear vs migrate)

---

## Implemented vs proposal

| Item | Status |
|------|--------|
| Signed order-line add-on prices | **Implemented** |
| Admin-only adjust permission | **Implemented** |
| Draft Apply/Cancel customize UI | **Implemented** |
| Server recalc + audit + snapshots | **Implemented** |
| MOCK kitchen/cashier signed display | **Implemented** |
| Manager approval workflow | **Not implemented** (needs owner decision) |
| Configurable adjustment limits | **Not implemented** (needs owner decision) |
| Physical print / Windows | **Out of scope** |
