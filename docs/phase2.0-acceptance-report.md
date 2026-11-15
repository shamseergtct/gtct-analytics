# Phase 2.0 — Product Knowledge & Salesman Training

**Status:** Implemented and acceptance-tested (Mac only)  
**Date:** 2026-10-20  
**Scope:** `local-server/` only — no Firebase, Windows transfer, physical printing, commit, push, or deploy

---

## 1. Existing implementation audit

| Area | Finding |
|------|---------|
| Menu schema | `menu_items` already has optional `description` (short text, Advanced/legacy). No product-knowledge table before this phase. |
| Menu Setup | Item editor with variants, add-ons, kitchen instructions, photo, tax, availability. |
| Sales cards | Single `<button class="menu-card">` added to cart / opened variants on full-card click. |
| Auth | Shared admin / device tokens; admin-only menu writes. |
| Images | Local `/v1/menu-images/...` serving. |
| Migrations | Ordered `*.sql` / `*.js` via `runMigrations`. |

**Compatibility:** New optional 1:1 table `menu_item_product_knowledge`. Existing items remain valid with empty profiles. `menu_items.description` reused as **Short description** (not overwritten by fabricated content). Knowledge is parent-item level (not per variant). No impact on prices, tax, cart, orders, or print jobs.

---

## 2. Files inspected

- `local-server/src/db/schema.sql`, migrations `003`–`012`
- `local-server/src/services/menuMappings.js`, `variants.js`, `auth`/`sessions`
- `local-server/src/http/server.js`
- `local-server/public/app.js`, `index.html`, `styles.css`
- `local-server/public/menu.js`, `menu.html`, `menu-setup.css`
- Prior acceptance scripts (`acceptancePhase16`–`19Customize`)

---

## 3. Files created or modified

**Created**

- `local-server/src/db/migrations/013_product_knowledge.js`
- `local-server/src/services/productKnowledge.js`
- `local-server/src/scripts/acceptancePhase20.js`
- `docs/phase2.0-acceptance-report.md`

**Modified**

- `local-server/src/services/menuMappings.js` — optional `productKnowledge` on upsert
- `local-server/src/http/server.js` — GET/PUT `/v1/menu-items/:id/product-knowledge`
- `local-server/public/menu.html` / `menu.js` / `menu-setup.css` — Product Information editor
- `local-server/public/index.html` / `app.js` / `styles.css` — Info button + PK modal
- `local-server/package.json` — `accept:phase2.0`

---

## 4. Database migrations

`013_product_knowledge.js` — creates `menu_item_product_knowledge` (PK = `item_id`, CASCADE delete).

Fields: detailed description, ingredients JSON, brand / ingredient brand, prep min/max, serving style / accompaniments / service notes, special features, allergen notes + verified flag, salesman quick answer, staff training notes, timestamps.

Applied to local data DB via `npm run migrate` (non-destructive).

---

## 5. Menu Setup — Product Information fields

Collapsible **Product information (optional · staff training)** section:

- Short description (reuses `menu_items.description`)
- Detailed description
- Salesman Quick Answer (“How to explain this item to customers”)
- Special features
- Main ingredients (chip entry)
- Verified allergen notes + verified checkbox
- Product brand / main ingredient brand
- Prep time from/to (minutes)
- Serving style / Served with / Additional service notes
- Staff training notes (admin-only; not returned to device)

Saved with existing **Save item** workflow (`productKnowledge` on `PUT /v1/menu-items`).

---

## 6. Sales Info button behavior

- Menu cards are `<article>` with separate **select** and **Info** controls (no nested buttons).
- Card body → add to cart / open variants (unchanged).
- Info → opens Product Knowledge dialog only (`stopPropagation`); never adds to cart or opens variants.
- Accessible name: `View information about {item name}`.
- Works for sold-out items (select disabled; Info still available).

---

## 7–8. Desktop modal / mobile information view

- `<dialog id="pk-dialog">` with GTCT colors, sticky header + Close, About / Ingredients / Service tabs.
- Mobile: near full-viewport sheet, large Info touch target, scrollable body.
- Escape / cancel closes; focus returns to the Info control.

---

## 9. Salesman Quick Answer

- Admin-editable; prominent green-accent panel at top of About when set.
- Plain-text rendering via `escapeHtml` (no HTML execution).
- Read-only for device role.

---

## 10. Auth and security

| Action | Admin | Device |
|--------|-------|--------|
| GET product knowledge | Yes (incl. training notes) | Yes (training notes stripped) |
| PUT product knowledge | Yes | 403 |
| Menu upsert with PK | Yes | N/A (admin route) |

Server-side length/type validation. No invented allergens or prep times.

---

## 11. Offline / local storage

All data from local SQLite + existing local images. No Firebase / cloud AI / external catalogs.

---

## 12. Automated test results

```text
npm run accept:phase2.0  →  15/15 passed
```

Covers: empty profiles, admin CRUD, device read-only, markup/isolation hooks, order + price stability, empty/partial states, XSS stored as text + escape helpers, Unicode, menu upsert path, MOCK dispatch with physical print off, migration 013, validation.

---

## 13. Manual browser checks actually performed

**Not performed in this session** (no interactive browser QA at 375/390/768/1366/1440). Owner UI/UX review recommended:

1. Restart local server, hard-refresh Sales + Menu Setup.
2. As admin: edit Product information → Save → reopen.
3. As device: Info opens modal; cart qty unchanged; variant cards still open size picker on body tap.
4. Confirm Quick Answer prominence and empty-state copy.
5. Spot-check mobile sheet + Escape / focus return.

---

## 14. Existing regression results

| Suite | Result |
|-------|--------|
| `accept:phase1.6` | Pass (18/18) |
| `accept:phase1.8` | Pass |
| `accept:phase1.9` | Pass |
| `accept:phase1.9c` | Pass (7/7) |
| `accept:phase2.0` | Pass (15/15) |

---

## 15. Known limitations

- Knowledge is item-level only (not per variant size).
- Staff training notes are admin API-only (not shown in Sales UI).
- Ingredients are informational chips — not inventory/BOM.
- Allergen UI never claims “allergen-free”; unverified shows confirm-with-restaurant copy.
- Visual/responsive QA deferred to owner review.
- Info fetch is on-demand per item (not embedded in full menu list).

---

## 16. Future enhancements requiring approval

- Per-variant knowledge profiles
- Malayalam / English / Arabic content fields (schema room exists conceptually; no auto-translate)
- Training quizzes, completion tracking, certificates
- AI-generated answers
- Deep-link from Sales empty state into Menu Setup editor for a specific item

---

## How to verify locally

```bash
cd local-server
npm run migrate
npm start
# Admin: Menu Setup → item → Product information → Save
# Sales: tap Info on a card (not the card body)
npm run accept:phase2.0
```

**Stop:** Waiting for owner UI/UX review before further development.
