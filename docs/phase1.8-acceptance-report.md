# Phase 1.8 Completion Report — Item & Add-on Tax Applicability

**Date:** 2026-10-20  
**Scope:** `local-server/` only (Mac development)  
**Status:** Implemented and automated-tested. Awaiting owner approval before further work.

---

## 1. Files inspected

- `local-server/src/services/shopSettings.js`
- `local-server/src/services/tax.js`
- `local-server/src/services/orders.js`
- `local-server/src/services/addons.js`
- `local-server/src/services/menuMappings.js`
- `local-server/src/util/money.js`
- `local-server/public/money.js`
- `local-server/src/print/ticketFormat.js`
- `local-server/src/services/printQueue.js`
- `local-server/src/http/server.js`
- `local-server/public/menu.html` / `menu.js` / `menu-setup.css`
- `local-server/public/index.html` / `app.js` / `styles.css`
- Migrations `001`–`010`, audit service, acceptance Phase 1.4–1.7

### Pre-implementation calculation (Phase 1.7)

- Shop tax enabled/disabled, exclusive/inclusive, rate in basis points
- Goods = sum of line selling prices (base + signed add-ons × qty)
- Tax rounded once on full goods total via BigInt half-up
- Order snapshots: goods/net/tax/total + shop tax/currency identity

### Risks documented before change

| Risk | Mitigation |
|------|------------|
| Historical orders recalculated | Snapshots include taxable/nontaxable + line/addon tax flags; never recomputed from current menu |
| Negative add-ons incorrectly offset | Separate taxable/nontaxable buckets; reject negative bucket totals |
| Float drift | Preserve integer minor units + BigInt half-up |
| Client ≠ server totals | Cart shows estimate; server is authoritative |
| Unauthorized tax edits | Admin-only APIs + dedicated audit events |

---

## 2. Files modified / added

**Added**

- `local-server/src/db/migrations/010_item_addon_tax.js`
- `local-server/src/scripts/acceptancePhase18.js`
- `docs/phase1.8-acceptance-report.md`

**Modified**

- `local-server/src/services/tax.js` — bucket engine
- `local-server/src/services/orders.js` — mixed tax + snapshots
- `local-server/src/services/addons.js` — `taxApplicable`
- `local-server/src/services/menuMappings.js` — item `taxApplicable`
- `local-server/src/http/server.js` — tax audit on upsert
- `local-server/src/print/ticketFormat.js` — cashier taxable/non-taxable lines
- `local-server/src/services/printQueue.js` — pass bucket fields
- `local-server/public/money.js` — shared estimate helpers
- `local-server/public/menu.html` / `menu.js` / `menu-setup.css`
- `local-server/public/index.html` / `app.js` / `styles.css`
- `local-server/package.json` — `accept:phase1.8`

---

## 3. SQLite migrations

`010_item_addon_tax.js` (idempotent `ALTER` + defaults):

| Table | Columns |
|-------|---------|
| `menu_items` | `tax_applicable` DEFAULT 1 |
| `addons` | `tax_applicable` DEFAULT 1 |
| `orders` | `taxable_goods_cents`, `nontaxable_goods_cents` |
| `order_lines` | `tax_applicable`, `taxable_cents`, `nontaxable_cents` |
| `order_line_addons` | `tax_applicable` |

Legacy orders: full goods treated as taxable (Phase 1.7 compatible). Non-destructive.

---

## 4. Menu-item tax control

- **Tax Applicable** checkbox in Menu Setup, near Availability (visually separate)
- List badge: **Taxable** / **No Tax**
- New items default ON; existing migrate to ON
- Admin PUT `/v1/menu-items` only; device denied (403)
- Audit: `menu.tax_applicable` with old/new flags

---

## 5. Add-on tax control

- Library list shows price kind (Free/Paid/Reduction), Taxable/No Tax, Active
- Editor: Tax Applicable checkbox (independent of Active and price)
- Shared library flag applies wherever assigned; no item-level tax override
- Price overrides do not change taxability
- Admin-only; audit `addon.tax_applicable`

---

## 6. Tax calculation architecture

Hierarchy:

1. Shop tax OFF → tax = 0 (flags preserved)
2. Shop tax ON → each item and each add-on uses its own `taxApplicable`
3. One shop rate + exclusive/inclusive mode (no multi-rate)

Functions:

- `splitUnitTaxBuckets(unitBase, itemTaxApplicable, addons)`
- `computeOrderTaxFromBuckets({ taxableCents, nontaxableCents }, shopTax)`
- `computeOrderTax(goods)` retained as all-taxable wrapper for Phase 1.7

---

## 7. Signed adjustment handling

- Signed add-on amounts keep sign in persistence and buckets
- Taxable negative reduces taxable bucket; non-taxable negative reduces non-taxable bucket
- Negative taxable or non-taxable order buckets → **400 reject** (no clamp/transfer/abs)
- Existing rule: line/order selling totals cannot be negative

---

## 8. Inclusive / exclusive rounding

- **Scope:** one half-up round on the **order-level taxable goods** total (not per-line)
- Exclusive: `tax = round(taxable * bps / 10000)`; `total = goods + tax`
- Inclusive: extract tax from taxable gross only; `total = goods` (customer price unchanged)
- Net + tax = taxable gross (inclusive on taxable portion + nontaxable)
- No floating-point arithmetic in the engine

---

## 9. Sales tax summary

Cart and Review show:

- Exclusive: Subtotal, Taxable (if mixed), Tax, Total
- Inclusive: Customer total, optional Taxable/Non-taxable, Included tax
- Disabled: Subtotal, Tax 0, Total

Labeled as **estimate** until server validates. Total uses estimate; server recomputes on submit.

---

## 10. Receipt and order snapshots

New orders store:

- Line: item tax flag + taxable/nontaxable cents
- Add-on lines: tax flag + signed prices
- Order: taxable/nontaxable goods + prior Phase 1.7 tax/currency snapshots

Cashier MOCK receipt: Subtotal, Taxable/Non-taxable when mixed, tax, total — from **order snapshot**.  
Kitchen tickets: preparation only (no tax breakdown).

---

## 11. Auth and audit

- Item/add-on/shop tax changes: admin token required
- Dedicated audits for tax flag flips (entity type/id, old/new, role, timestamp)
- No secrets logged

---

## 12. Mac automated test results

```
npm run accept:phase1.8  → 11/11 passed
```

Coverage includes: migration defaults, admin toggle + unauthorized deny, exclusive/inclusive mixed, signed add-ons, negative bucket reject, historical freeze, tax off, idempotency, MOCK cashier preview, restart persistence, rounding.

---

## 13. Manual UI results

**Not performed** in this session (no browser walkthrough claimed).

UI code paths added for Menu Setup tax control, Add-ons Library tax display/edit, and Sales cart tax breakdown.

---

## 14. Existing acceptance regressions

| Suite | Result |
|-------|--------|
| `accept:phase1.4` | Passed |
| `accept:phase1.5` | Passed |
| `accept:phase1.6` | Passed |
| `accept:phase1.7` | Passed |

---

## 15. Known limitations

- No item-specific override of add-on taxability (explicitly out of scope)
- Single shop tax rate/mode only
- Client cart tax is an estimate; authoritative totals are server-side
- Negative taxable/non-taxable buckets are rejected (no owner-approved clamp policy)
- Manual browser UI verification deferred

---

## 16. Remaining owner decisions

1. Policy if a line’s taxable or non-taxable bucket goes negative beyond reject-order (credit/refund workflow is out of phase)
2. Whether admin quick-toggle on item list cards is desired (API supports save; list shows badge only)
3. Optional: server `/v1/tax-preview` endpoint to eliminate any client estimate drift
4. When to transfer to Windows / physical printers / production (explicitly not this phase)

---

## Implemented / tested / deferred / unverified

| Area | State |
|------|--------|
| Migration + defaults | Implemented + tested |
| Item/add-on tax APIs + audit | Implemented + tested |
| Mixed exclusive/inclusive calc | Implemented + tested |
| Order snapshots | Implemented + tested |
| Sales tax summary UI | Implemented; **manual UI unverified** |
| Menu/Add-on tax UI | Implemented; **manual UI unverified** |
| Cashier receipt buckets | Implemented + tested (MOCK preview) |
| Kitchen routing / MOCK print | Implemented + regression tested |
| Phase 1.4–1.7 regressions | Tested pass |
| Windows / physical / Firebase / commit | Deferred (out of scope) |

---

**Stop:** Implementation, automated acceptance, and this report complete. Waiting for owner approval before further development.
