/**
 * Sales "folder" cards: optional photo per subcategory, and the shop's choice of
 * how subcategories show on the Sales screen (cards in the grid, or pills).
 * Additive only: new nullable/defaulted columns, no data rewritten.
 */

export function up(db) {
  const subCols = new Set(
    db.prepare(`PRAGMA table_info(menu_subcategories)`).all().map((c) => c.name)
  );
  if (!subCols.has("image_filename")) {
    db.exec(`ALTER TABLE menu_subcategories ADD COLUMN image_filename TEXT`);
  }
  const shopCols = new Set(
    db.prepare(`PRAGMA table_info(shop_settings)`).all().map((c) => c.name)
  );
  if (!shopCols.has("subcategory_display")) {
    db.exec(
      `ALTER TABLE shop_settings ADD COLUMN subcategory_display TEXT NOT NULL DEFAULT 'cards'
       CHECK (subcategory_display IN ('cards', 'pills'))`
    );
  }
}
