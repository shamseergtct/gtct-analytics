# Phase 1.7 — Shop Settings, Tax, Currency & Receipt (Completion Report)

**Status:** Implemented and tested on MacBook only  
**Date:** 2026-10-20  
**Scope:** `local-server/` only — no commit, push, deploy, Windows transfer, Firebase, or physical print

---

## 1. Files inspected

- `src/services/shopSettings.js`, `orders.js`, `addons.js`, `printQueue.js`, `menuMappings.js`
- `src/util/money.js`, `public/money.js`
- `src/print/ticketFormat.js`
- `src/http/server.js`, `src/config.js`, `src/db/migrations/*`
- `public/{index,menu,settings}.html`, acceptance Phase 1.4–1.6

## 2. Files created or modified

**Created**

- `src/db/migrations/008_shop_settings_phase17.js`
- `src/services/tax.js`
- `src/services/shopLogo.js`
- `public/shop-settings.html` / `.js` / `.css`
- `src/scripts/acceptancePhase17.js`
- `docs/phase1.7-acceptance-report.md`

**Modified**

- `src/services/shopSettings.js` — full profile/tax/receipt/regional + currency guards
- `src/services/orders.js` — Path B tax + billing snapshots at order create
- `src/services/printQueue.js` — shop display name + tax payload snapshots
- `src/print/ticketFormat.js` — tax lines + receipt preview renderer
- `src/http/server.js` — logo, receipt-preview, expanded settings/audit
- `src/config.js` — `shopAssetsDir`
- Nav links on Sales / Menu / Printers; `public/app.js` admin link
- `package.json`, `README.md`
- `acceptancePhase14|15|16.js` — currency-confirm / formatter-only where locked

## 3. SQLite migration

`008_shop_settings_phase17.js` — non-destructive `ensureColumn` only:

- Profile: legal name, address, city, country, phones, WhatsApp, email, CR, logo filename
- Tax: enabled (default **0**), name, rate bps, mode, registration number
- Regional: timezone, date format
- Receipt display flags + footer
- Orders: `goods/net/tax` cents + tax/currency/shop name snapshots

No resets; legacy orders backfilled with `goods/net = total`, `tax = 0`.

## 4. Shop Settings page

**Route:** `/shop-settings.html` (Printer Settings stays `/settings.html`)

Tabs: Business Profile · Tax & Billing · Currency & Regional · Receipt Settings  

Admin-only; unsaved-changes warning; sticky Save; receipt preview never prints.

## 5. Auth / permissions

| Action | device | admin |
|--------|--------|-------|
| GET shop settings / logo | ✓ | ✓ |
| PUT shop settings / logo / receipt preview | ✗ 403 | ✓ |

## 6. Configuration storage

Single local shop (`test-tenant-phase1`) via existing `shop_settings` row — extended, not duplicated.

## 7. Currency / decimals

- Reuses shared formatters (BHD 3dp / QAR·INR 2dp)
- **Confirm required** if menu/addons exist (`confirmCurrencyChange`)
- **Hard lock** if any orders exist (`CURRENCY_LOCKED_ORDERS`)
- No conversion / rescale of stored minors

## 8. Tax implementation status — **Path B complete & tested**

Tax engine **is operational** on new test orders (not configuration-only).

| Mode | Behavior |
|------|----------|
| Disabled | `tax=0`, total = goods |
| Exclusive | tax = half-up(goods × bps / 10000); total = goods + tax |
| Inclusive | net = half-up(goods × 10000 / (10000+bps)); tax = goods − net; total = goods |

Rate stored as **basis points** (10% = 1000). Independent of currency decimals.

## 9. Rounding approach

Documented half-up integer division via `BigInt` (`mulDivRoundHalfUp`).  
Goods base = sum of line totals (base + signed add-ons × qty).  
Single shop-wide rate; **no item-level tax exemption** (limitation).

## 10. Add-ons and tax

Positive / zero / negative add-ons included in goods before tax. Signs preserved. Free add-ons add 0. Negative line totals still rejected before tax.

## 11. Receipt preview

`POST /v1/shop-settings/receipt-preview` (admin) — draft form values, synthetic sample, modes active/disabled/exclusive/inclusive. `physicalPrintAttempted: false`.

## 12. Historical snapshots

New orders persist tax mode/rate/amounts, currency, and shop names. Later settings changes do not recalculate old orders. Legacy orders without tax snapshots are not fabricated from today’s settings.

## 13. Security / audit

Sensitive field diffs audited on `shop.settings.update`. Logo upload/clear audited. Tokens not logged.

## 14. Automated tests

```text
accept:phase1.7  → 14/14 PASS
accept:phase1.6  → 18/18 PASS
accept:phase1.5  → 12/12 PASS
accept:phase1.4  → PASS
```

Physical printing not attempted.

## 15. Manual browser verification

**Not performed** in this session (no interactive browser walkthrough claimed).

## 16. Regressions

Phase 1.5 currency flip after orders conflicted with the new lock — fixed by using formatter-only asserts for QAR/INR display.

## 17. Limitations / deferred

1. No item-level tax exemptions / multi-rate tax  
2. Logo not embedded in MOCK thermal text (filename/URL stored; receipt flag reserved)  
3. Timezone stored for future display use; ticket timestamps still use existing host/UTC helpers  
4. No manager dual-control for currency/tax changes beyond admin role  
5. Sales cart UI does not yet show a live tax breakdown before submit (server still authoritative)

## 18. Decisions for owner

1. Should Sales cart show estimated tax before send?  
2. Item-level taxability / exemptions?  
3. Allow admin force-unlock of currency after orders (lab only)?  
4. Embed logo on paper receipts when physical print is eventually enabled?

---

## Distilled status

| Area | Status |
|------|--------|
| Shop Settings UI + APIs | **Completed and tested** |
| Tax exclusive/inclusive on orders | **Completed and tested** |
| Currency guards | **Completed and tested** |
| Receipt preview (MOCK) | **Completed and tested** |
| Historical tax freeze | **Completed and tested** |
| Manual browser UX pass | **Not tested** |
| Item tax exemptions | **Deferred** |
| Physical print | **Out of scope / disabled** |
