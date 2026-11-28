/**
 * Extras (add-ons) were opt-in per item. New library extras are enabled on every
 * item by default until unchecked in that item's Menu editor. Backfill existing
 * active extras onto all items so current menus match that rule.
 *
 * Kitchen modifiers/targets/standalones for shop-default items already inherit
 * the active library. Newly created library options are auto-enabled in code.
 */
export function up(db) {
  const items = db.prepare(`SELECT item_id FROM menu_items`).all();
  const addons = db.prepare(`SELECT addon_id FROM addons WHERE is_active = 1`).all();
  if (!items.length || !addons.length) return;

  const linkAddon = db.prepare(
    `INSERT OR IGNORE INTO menu_item_addons (item_id, addon_id, price_override_cents)
     VALUES (?, ?, NULL)`
  );

  const tx = db.transaction(() => {
    for (const item of items) {
      for (const a of addons) linkAddon.run(item.item_id, a.addon_id);
    }
  });
  tx();
}
