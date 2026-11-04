/**
 * Phase 1.6 — Allow signed add-on amounts (charge / free / reduction).
 * Non-destructive: rebuilds constrained tables; preserves all rows.
 * Disables FK checks during rebuild (same pattern as 004_menu_ops.js).
 */

function tableExists(db, name) {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name)
  );
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

export function up(db) {
  db.pragma("foreign_keys = OFF");

  try {
    // Library defaults may be negative (e.g. Remove Cheese -0.100).
    if (tableExists(db, "addons")) {
      const cols = columnNames(db, "addons");
      // Skip if already rebuilt without non-negative CHECK (idempotent re-run safe).
      const sql = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='addons'`)
        .get()?.sql || "";
      if (/price_cents\s+INTEGER[^,]*CHECK\s*\(\s*price_cents\s*>=\s*0/i.test(sql)) {
        db.exec(`
          CREATE TABLE addons_new (
            addon_id TEXT PRIMARY KEY,
            shop_id TEXT NOT NULL,
            name TEXT NOT NULL,
            name_norm TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            price_cents INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
            sort_order INTEGER NOT NULL DEFAULT 0,
            max_quantity INTEGER NOT NULL DEFAULT 1 CHECK (max_quantity >= 1),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (shop_id, name_norm)
          );
          INSERT INTO addons_new (
            addon_id, shop_id, name, name_norm, description, price_cents,
            is_active, sort_order, max_quantity, created_at, updated_at
          )
          SELECT
            addon_id, shop_id, name, name_norm, description, price_cents,
            is_active, sort_order, max_quantity, created_at, updated_at
          FROM addons;
          DROP TABLE addons;
          ALTER TABLE addons_new RENAME TO addons;
          CREATE INDEX IF NOT EXISTS idx_addons_shop ON addons(shop_id, is_active);
        `);
      }
      void cols;
    }

    // Item overrides may be signed; NULL still means "use library default".
    if (tableExists(db, "menu_item_addons")) {
      const sql = db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='menu_item_addons'`
        )
        .get()?.sql || "";
      if (/price_override_cents\s+INTEGER[^,]*CHECK/i.test(sql)) {
        db.exec(`
          CREATE TABLE menu_item_addons_new (
            item_id TEXT NOT NULL REFERENCES menu_items(item_id) ON DELETE CASCADE,
            addon_id TEXT NOT NULL REFERENCES addons(addon_id),
            price_override_cents INTEGER,
            PRIMARY KEY (item_id, addon_id)
          );
          INSERT INTO menu_item_addons_new SELECT * FROM menu_item_addons;
          DROP TABLE menu_item_addons;
          ALTER TABLE menu_item_addons_new RENAME TO menu_item_addons;
        `);
      }
    }

    // Order-line snapshots: signed applied unit + configured original + audit flags.
    if (tableExists(db, "order_line_addons")) {
      const cols = columnNames(db, "order_line_addons");
      if (!cols.includes("price_adjusted")) {
        db.exec(`
          CREATE TABLE order_line_addons_new (
            line_addon_id TEXT PRIMARY KEY,
            line_id TEXT NOT NULL REFERENCES order_lines(line_id) ON DELETE CASCADE,
            addon_id TEXT,
            addon_name TEXT NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
            configured_unit_price_cents INTEGER NOT NULL DEFAULT 0,
            unit_price_cents INTEGER NOT NULL,
            line_price_cents INTEGER NOT NULL,
            price_adjusted INTEGER NOT NULL DEFAULT 0 CHECK (price_adjusted IN (0, 1)),
            adjusted_by_role TEXT NOT NULL DEFAULT '',
            sort_index INTEGER NOT NULL DEFAULT 0
          );
          INSERT INTO order_line_addons_new (
            line_addon_id, line_id, addon_id, addon_name, quantity,
            configured_unit_price_cents, unit_price_cents, line_price_cents,
            price_adjusted, adjusted_by_role, sort_index
          )
          SELECT
            line_addon_id, line_id, addon_id, addon_name, quantity,
            unit_price_cents, unit_price_cents, line_price_cents,
            0, '', sort_index
          FROM order_line_addons;
          DROP TABLE order_line_addons;
          ALTER TABLE order_line_addons_new RENAME TO order_line_addons;
          CREATE INDEX IF NOT EXISTS idx_order_line_addons_line ON order_line_addons(line_id);
        `);
      }
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
