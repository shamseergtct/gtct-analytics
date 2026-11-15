# Phase 1.3 — Menu Setup, Item Entry & Restaurant Sales UI/UX

Isolated `local-server/` work only. No production GTCT Analytics Sales, Firebase, accounting, inventory, or invoice math changes. No physical printer dispatch.

## URLs (loopback)

| Page | Path | Access |
|---|---|---|
| Restaurant Sales Test | `http://127.0.0.1:8787/` | Device or admin session |
| Menu Setup | `http://127.0.0.1:8787/menu.html` | Admin only |
| Printer Settings | `http://127.0.0.1:8787/settings.html` | Admin only (Phase 1.2) |

## Menu data model (SQLite)

Migration `003_menu_setup.sql` adds non-destructive columns on `menu_items`:

- `category`, `subcategory`
- `description`, `price_cents` (display only)
- `code` (optional short code; `sku` remains the unique key)
- `image_filename` (file under `{dataDir}/menu-images/`)
- `is_sold_out`, `sort_order`
- `instruction_modifiers_json`, `instruction_targets_json` (item-specific; empty → restaurant defaults)

Existing `item_id` / `sku` rows are preserved. Seed IDs (`item_orange_juice`, etc.) are backfilled, not recreated.

## Images

- Uploaded via admin `POST /v1/menu-items/:id/image` (base64 JPEG/PNG/WebP)
- Stored on the local server disk (`menu-images/`), not IndexedDB or Firebase
- Served via authenticated `GET /v1/menu-images/:filename` (same-origin session cookie works for `<img>`)

## Kitchen instructions

Sales UI workflow: pick modifier → pick target → generate label (e.g. `Less Sauce`) → add to the **order line** (not the global menu item). Custom per-line notes remain separate. Duplicates on the same line are blocked (client + server). Labels persist in `order_line_instructions` and appear on kitchen ticket previews.

## Display totals

Cart “display total” uses `price_cents` for staff UX only. No payments, taxes, invoices, or production accounting.
