/**
 * Phase 2.0 — Product Knowledge (informational / staff training).
 * Non-destructive. Optional 1:1 profile per menu item.
 * Does not alter prices, variants, tax, orders, or print jobs.
 */

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS menu_item_product_knowledge (
      item_id TEXT PRIMARY KEY REFERENCES menu_items(item_id) ON DELETE CASCADE,
      detailed_description TEXT NOT NULL DEFAULT '',
      ingredients_json TEXT NOT NULL DEFAULT '[]',
      brand TEXT NOT NULL DEFAULT '',
      ingredient_brand TEXT NOT NULL DEFAULT '',
      prep_time_min INTEGER,
      prep_time_max INTEGER,
      serving_style TEXT NOT NULL DEFAULT '',
      serving_accompaniments TEXT NOT NULL DEFAULT '',
      service_notes TEXT NOT NULL DEFAULT '',
      special_features TEXT NOT NULL DEFAULT '',
      allergen_notes TEXT NOT NULL DEFAULT '',
      allergen_verified INTEGER NOT NULL DEFAULT 0
        CHECK (allergen_verified IN (0, 1)),
      salesman_quick_answer TEXT NOT NULL DEFAULT '',
      staff_training_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        prep_time_min IS NULL
        OR (prep_time_min >= 0 AND prep_time_min <= 999)
      ),
      CHECK (
        prep_time_max IS NULL
        OR (prep_time_max >= 0 AND prep_time_max <= 999)
      ),
      CHECK (
        prep_time_min IS NULL
        OR prep_time_max IS NULL
        OR prep_time_max >= prep_time_min
      )
    );
  `);
}
