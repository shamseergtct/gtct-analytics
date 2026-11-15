# Phase 1.9 Completion Report — Sales Redesign & Item Variants

**Date:** 2026-10-20  
**Scope:** `local-server/` only (Mac)  
**Status:** Implemented and automated-tested. Awaiting owner UI/UX approval.

---

## Phase 1.8 dependency (verified)

Confirmed in the current repository before Phase 1.9 work:

- Migration `010_item_addon_tax.js`
- `taxApplicable` on menu items and add-ons
- `computeOrderTaxFromBuckets` / `splitUnitTaxBuckets`
- Order taxable/non-taxable snapshots
- `accept:phase1.8` → **11/11 passed** (re-run after 1.9)

Variants **inherit parent item tax applicability**. No parallel tax engine was added.

---

## 1. Files inspected

Sales UI (`index.html`, `app.js`, `styles.css`), Menu Setup, categories APIs, `orders.js`, `tax.js`, `addons.js`, `menuMappings.js`, `printQueue.js`, `ticketFormat.js`, migrations `001`–`010`, auth/audit, acceptance 1.4–1.8.

---

## 2. Files created / modified

**Created**

- `local-server/src/db/migrations/011_item_variants.js`
- `local-server/src/services/variants.js`
- `local-server/src/scripts/acceptancePhase19.js`
- `docs/phase1.9-acceptance-report.md`

**Modified**

- `menuMappings.js`, `orders.js`, `printQueue.js`, `ticketFormat.js`
- `public/index.html`, `app.js`, `styles.css`
- `public/menu.html`, `menu.js`, `menu-setup.css`
- `package.json` (`accept:phase1.9`)

---

## 3. SQLite migration

`011_item_variants.js` (idempotent):

| Change | Detail |
|--------|--------|
| `menu_item_variants` | variant_id, item_id, name, name_norm, price_cents, sku, code, sort_order, is_active, is_sold_out, is_default, timestamps; UNIQUE(item_id, name_norm) |
| `menu_items.has_variants` | DEFAULT 0 |
| `order_lines` | `variant_id`, `variant_name`, `variant_price_cents` |

Existing items remain non-variant. Variants are soft-deactivated, never hard-deleted.

---

## 4. Variant model and APIs

- Admin configures via `PUT /v1/menu-items` with `hasVariants` + `variants[]`
- Server resolves price via `resolveVariantForOrder`
- Client-supplied base price must match server price or order returns **409 PRICE_CHANGED**
- Duplicate normalized names → 409; invalid prices → 400
- Device cannot create/edit variants (403)
- Audit: `variant.create`, `variant.price_change`, `variant.deactivate`

---

## 5. Menu Setup variant editor

- **Variants & Sizes** section with Has Variants toggle
- Compact variant rows: name, price, sort, SKU, code, Active / Sold out / Default
- Add / Remove (soft-deactivate on save when omitted)
- Validation through existing save path

---

## 6. Category / subcategory behavior

Preserved and refined:

- Horizontal scroll chips (no heavy wrap)
- Category → subcategory → items
- Search across menu
- Inactive hidden in Sales; Sold Out disabled

---

## 7. Direct-add-to-cart workflow

| Item type | Behavior |
|-----------|----------|
| No variants | Tap card → add 1 to cart (+ toast) |
| Has variants | Tap card → compact selector → tap size → add immediately (no second Add button) |
| Customization | Via cart **Edit** only (no forced modal on every tap) |

Duplicate-tap guard (`addingLock`) prevents double add from one selection.

---

## 8. Cart line identity / merge

Merge only when identical:

- Same parent item + variant (or none)
- Same base price / tax flag
- Same instructions, note, add-ons (ids, qty, applied prices)

Different sizes or customizations stay separate lines.

---

## 9. Server-side pricing validation

Order create:

1. Auth
2. Item active / not sold out
3. Variant belongs to item when `has_variants`
4. Variant active / not sold out
5. Authoritative variant or parent price
6. Reject mismatched client `unitBasePriceCents`
7. Add-ons / instructions / signed adjust auth
8. Phase 1.8 tax buckets (variant price = taxable base when item taxable)
9. Idempotency + snapshots

---

## 10. Tax / currency integration

- Shop currency formatter unchanged (BHD/QAR/INR)
- Variant inherits parent `taxApplicable`
- Cart tax summary still uses shared estimate helpers; server remains authoritative
- Inclusive/exclusive + mixed taxable components preserved (Phase 1.8)

---

## 11. Tickets / printing

- Kitchen: `SIZE: LARGE` under item name
- Cashier: `Orange Juice — Large` + unit price from snapshot
- Station routing from parent; no-prep unchanged
- MOCK only; physical printing untouched

---

## 12. Desktop layout

- ~62% / 38% split (menu / cart)
- Sticky cart with footer actions always reachable
- Compact order meta
- Collapsible kitchen/printer panel (collapsed by default; expands after send)

Usable from ~1024px+ split; 1366×768 targeted.

---

## 13. Mobile / tablet layout

- Sticky bottom cart bar (count + total)
- Cart drawer overlay
- Horizontally scrolling category chips
- Touch-friendly variant options (≥44px)

---

## 14. Automated tests

```
npm run accept:phase1.9  → 10/10 passed
```

Covers: migration defaults, CRUD/auth, availability rules, server pricing/tax, historical freeze, ticket text, MOCK jobs, UI assets, idempotency, restart.

---

## 15. Manual browser tests

**Not performed** in this session (no screenshots / browser walkthrough).

---

## 16. Existing regressions

| Suite | Result |
|-------|--------|
| `accept:phase1.4` | Passed |
| `accept:phase1.5` | Passed |
| `accept:phase1.6` | Passed |
| `accept:phase1.7` | Passed |
| `accept:phase1.8` | Passed |

---

## 17. Known limitations

- No variant-specific tax/station/addon overrides (by design)
- Cart tax figures remain client estimates until submit
- Soft-deleted variants remain in DB (intentional)
- Manual responsive QA deferred

---

## 18. Intentionally not implemented

Hold/Recall orders, payments, settlement, table management, KDS, physical printing, Firebase, fake toolbar buttons without behavior.

---

## 19. Screenshots / preview links

None — automated tests only.

---

### Behavior change note (approved UX)

Routine item taps **no longer auto-open** the customization dialog. Staff use **Edit** on the cart line. This matches the Phase 1.9 minimal-click directive.

---

**Stop:** Implementation, automated acceptance, and this report complete. Waiting for owner UI/UX approval before further development.
