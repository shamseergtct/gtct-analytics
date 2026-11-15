# Phase 2.1 — Menu Setup popup item editor

**Date:** 2026-10-22  
**Scope:** `local-server/` Menu Setup UI only  
**Status:** Implemented. Desktop popup and 390px list checked in the browser. Waiting for owner UI/UX approval.

No Firebase, Windows transfer, physical printing, commit, push, or deploy.

---

## 1. Files inspected

`menu.html`, `menu.js`, `menu-setup.css`, `money.js`, `menuMappings.js`, `variants.js`, `productKnowledge.js`, `server.js` menu routes, Phase 2.0 acceptance.

## 2. Files created or modified

**Modified**

- `local-server/public/menu.html`
- `local-server/public/menu.js`
- `local-server/public/menu-setup.css`
- `local-server/package.json` (`accept:phase2.1`)
- `local-server/src/scripts/acceptancePhase20.js` (Quick Answer label assertion)

**Created**

- `local-server/src/scripts/acceptancePhase21.js`
- `docs/phase2.1-acceptance-report.md`

## 3. Existing code reused

Same field IDs, `collectForm()`, `PUT /v1/menu-items`, photo upload/delete endpoints, variant soft-deactivate, kitchen assignment, add-on overrides, and Product Knowledge payload. No second catalog and no new migration.

## 4. Popup editor

One `<dialog id="item-editor-dialog">` for create and edit.

- Header: Create Menu Item / Edit Menu Item, item name when editing, Close
- Item ID only under Technical details
- Tabs: Basic, Variants, Kitchen & Extras, Product Knowledge
- Body scrolls inside the dialog
- Sticky footer: Cancel and Save Item / Save Changes
- Escape and Close ask before discarding a dirty draft
- Focus returns to the button that opened the editor

## 5. Basic

Name, base price, category, subcategory, kitchen station (including None — No Preparation), photo, Active / Sold out / Inactive, Tax Applicable, optional SKU / code / sort.

Photo uses Choose / Upload / Remove. Upload and remove still hit the existing image API immediately for a saved item. Cancel does not roll a completed upload back.

## 6. Variants

Existing Has Variants control. Off hides the size list and explains direct-add behavior. Turning variants off when saved sizes exist asks for confirmation. Omitted sizes are still soft-deactivated by the existing server, not hard-deleted. Parent price does not rewrite size prices.

## 7. Kitchen & Extras

Shop defaults stay collapsed. Customize shows the existing modifier, target, and standalone chips plus a count summary. Add-on assignment and override fields are unchanged.

## 8. Product Knowledge

Same optional fields, grouped as About, Ingredients, and Service details. Quick Answer label: **What should the salesman tell the customer?** Values stay in the form when switching tabs and save with the same item request.

## 9. Items list

Compact row: thumbnail, name, category / SKU / station / status, price, Sold out, Edit.

Prices use Shop Settings currency and decimals. Variant items show the active size price, or `From {min}` when sizes differ. Orange Juice showed `From BD: 0.600`. The `BD:` text is the shop currency label already stored in Shop Settings (header pill is `BHD · 3 DP`). It is not hardcoded.

## 10–11. Save and cancel

One Save sends the existing menu upsert, including variants, kitchen options, add-ons, and product knowledge. That request is one server transaction for those fields. The photo API is separate and is not part of that transaction.

Cancel and Escape discard the draft after confirmation. Tab changes do not save. Validation errors mark the relevant tab and move to it. Entered values stay after a failed check.

## 12. Database / API

No schema change. Same admin-only `PUT /v1/menu-items`. Device writes remain rejected.

## 13. Security

Admin session is still required. Hidden fields are not treated as authorization.

## 14. Automated tests

| Suite | Result |
|-------|--------|
| `accept:phase2.1` | 2/2 — dialog/tabs present; save keeps the same item id; device cannot edit |
| `accept:phase2.0` | Passed after the Quick Answer label assertion was updated |

Phase 2.1 automation does not click the UI. It checks markup and the existing save API.

## 15–16. Browser checks actually performed

On the running local server (`http://127.0.0.1:8787/menu.html`), signed in as admin:

- Desktop: New menu item opens the popup on Basic. Typing a name, opening Variants, and returning to Basic kept “Draft Burger”. Cancel closed the dialog and focus returned to New menu item.
- Desktop list: FRESH BURGER BEEF `BD: 0.100`, Orange Juice `From BD: 0.600`, Shawarma `BD: 1.500`, Burger `BD: 1.800`.
- 390×844: prices fully visible, Edit not covered, New menu item stays in the toolbar. Long names truncate. The section tabs scroll horizontally; Add-ons starts off-screen until scrolled.

Not checked in the browser: 375, 430, 768, 1024, 1366, 1440, photo upload, a full save of a new item, or Sales Info after an edit.

## 17. Known issues

- Currency label `BD:` comes from Shop Settings, while the header pill shows `BHD`.
- Photo upload is immediate and is not undone by Cancel.
- Narrow screens truncate long item names.
- Menu section tabs need horizontal scroll below about 390px.

## 18. Deferred

Per-variant knowledge, translations, and any change to Sales cart, tax, or printing. Stopped for owner UI/UX review.
