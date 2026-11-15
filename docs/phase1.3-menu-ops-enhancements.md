# Phase 1.3 Menu Ops Enhancements

Optional SKU, availability toggles, category/subcategory tables, and **None — No Preparation** kitchen routing.

## Validation rules (before → after)

| Field | Before | After |
|---|---|---|
| Name | Required | Required |
| SKU | Required, `NOT NULL UNIQUE` | Optional; blank stored as `NULL`; unique only when non-blank |
| Code | Optional short label | Unchanged (distinct from SKU) |
| Kitchen station | Required in UI | Optional; empty = no preparation (no fake NONE station) |
| Active | Checkbox | Active = on menu; Inactive = hidden from Sales; history kept |
| Sold out | Checkbox | Blocks **new** orders (server-enforced); list quick toggle |

## Categories

Tables `menu_categories` / `menu_subcategories` with normalized unique names. Items keep denormalized `category` / `subcategory` text plus `category_id` / `subcategory_id`. Deactivate only (no hard delete when referenced). Quick-create from item form.

## No-preparation routing

- Empty `item_stations` = intentional no prep.
- No JUICE/GRILL/SHAWARMA kitchen ticket for those lines.
- Not treated as UNMAPPED / NEEDS_REVIEW.
- Cashier receipt still lists them with station label **No Preparation**.
- Prep items continue to route to their assigned stations.

## Availability permissions

| Action | Admin | Device |
|---|---|---|
| Full menu CRUD | Yes | No |
| Category CRUD | Yes | No |
| Toggle Sold Out (`PATCH .../availability`) | Yes | Yes |
| Toggle Active/Inactive | Yes | No (403) |

## Migration

`004_menu_ops.js` — rebuilds `menu_items` for nullable SKU (FK off, IDs preserved), adds category tables, backfills links. Partial unique index `idx_menu_items_sku_unique`.

## Tests

`npm run accept:phase1.3` — includes optional SKU, availability enforcement, no-prep routing, physical print still off.
