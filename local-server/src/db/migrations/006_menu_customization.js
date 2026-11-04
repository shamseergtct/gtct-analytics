/**
 * Phase 1.5 — Kitchen instruction library + add-ons (non-destructive).
 * Seeds masters from existing shop/item JSON. Preserves all prior data.
 */

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function parseJsonArray(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed)
      ? parsed.map((v) => String(v).trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function up(db) {
  const ts = new Date().toISOString();

  db.exec(`
    CREATE TABLE IF NOT EXISTS kitchen_modifiers (
      modifier_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (shop_id, name_norm)
    );

    CREATE TABLE IF NOT EXISTS kitchen_targets (
      target_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (shop_id, name_norm)
    );

    CREATE TABLE IF NOT EXISTS kitchen_standalone (
      standalone_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (shop_id, name_norm)
    );

    CREATE TABLE IF NOT EXISTS menu_item_allowed_modifiers (
      item_id TEXT NOT NULL REFERENCES menu_items(item_id) ON DELETE CASCADE,
      modifier_id TEXT NOT NULL REFERENCES kitchen_modifiers(modifier_id),
      PRIMARY KEY (item_id, modifier_id)
    );

    CREATE TABLE IF NOT EXISTS menu_item_allowed_targets (
      item_id TEXT NOT NULL REFERENCES menu_items(item_id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES kitchen_targets(target_id),
      PRIMARY KEY (item_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS menu_item_allowed_standalone (
      item_id TEXT NOT NULL REFERENCES menu_items(item_id) ON DELETE CASCADE,
      standalone_id TEXT NOT NULL REFERENCES kitchen_standalone(standalone_id),
      PRIMARY KEY (item_id, standalone_id)
    );

    CREATE TABLE IF NOT EXISTS menu_item_blocked_pairs (
      item_id TEXT NOT NULL REFERENCES menu_items(item_id) ON DELETE CASCADE,
      modifier_id TEXT NOT NULL REFERENCES kitchen_modifiers(modifier_id),
      target_id TEXT NOT NULL REFERENCES kitchen_targets(target_id),
      PRIMARY KEY (item_id, modifier_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS addons (
      addon_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      max_quantity INTEGER NOT NULL DEFAULT 1 CHECK (max_quantity >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (shop_id, name_norm)
    );

    CREATE TABLE IF NOT EXISTS menu_item_addons (
      item_id TEXT NOT NULL REFERENCES menu_items(item_id) ON DELETE CASCADE,
      addon_id TEXT NOT NULL REFERENCES addons(addon_id),
      price_override_cents INTEGER CHECK (
        price_override_cents IS NULL OR price_override_cents >= 0
      ),
      PRIMARY KEY (item_id, addon_id)
    );

    CREATE TABLE IF NOT EXISTS order_line_addons (
      line_addon_id TEXT PRIMARY KEY,
      line_id TEXT NOT NULL REFERENCES order_lines(line_id) ON DELETE CASCADE,
      addon_id TEXT,
      addon_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      line_price_cents INTEGER NOT NULL CHECK (line_price_cents >= 0),
      sort_index INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_kitchen_modifiers_shop ON kitchen_modifiers(shop_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_kitchen_targets_shop ON kitchen_targets(shop_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_kitchen_standalone_shop ON kitchen_standalone(shop_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_addons_shop ON addons(shop_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_order_line_addons_line ON order_line_addons(line_id);
  `);

  ensureColumn(
    db,
    "menu_items",
    "instruction_customized",
    "instruction_customized INTEGER NOT NULL DEFAULT 0 CHECK (instruction_customized IN (0, 1))"
  );
  ensureColumn(
    db,
    "order_lines",
    "unit_base_price_cents",
    "unit_base_price_cents INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(
    db,
    "order_lines",
    "unit_addons_cents",
    "unit_addons_cents INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(
    db,
    "order_lines",
    "unit_total_cents",
    "unit_total_cents INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(
    db,
    "order_lines",
    "line_total_cents",
    "line_total_cents INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(db, "orders", "total_cents", "total_cents INTEGER NOT NULL DEFAULT 0");

  const shop =
    db.prepare(`SELECT * FROM shop_settings LIMIT 1`).get() || {
      shop_id: "test-tenant-phase1",
      instruction_modifiers_json: '["Less","More","No","Extra"]',
      instruction_targets_json:
        '["Sugar","Sauce","Onion","Salt","Ice","Cheese"]',
    };
  const shopId = shop.shop_id;

  const modCount = db
    .prepare(`SELECT COUNT(*) AS c FROM kitchen_modifiers WHERE shop_id = ?`)
    .get(shopId).c;
  if (modCount === 0) {
    const mods = parseJsonArray(shop.instruction_modifiers_json);
    const seedMods = mods.length ? mods : ["Less", "More", "No", "Extra", "Without"];
    const ins = db.prepare(
      `INSERT OR IGNORE INTO kitchen_modifiers (
         modifier_id, shop_id, name, name_norm, is_active, sort_order, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
    );
    seedMods.forEach((name, i) => {
      ins.run(`mod_${name_norm(name)}_${i}`, shopId, name, normalizeName(name), i, ts, ts);
    });
  }

  const tgtCount = db
    .prepare(`SELECT COUNT(*) AS c FROM kitchen_targets WHERE shop_id = ?`)
    .get(shopId).c;
  if (tgtCount === 0) {
    const tgts = parseJsonArray(shop.instruction_targets_json);
    const seedTgts = tgts.length
      ? tgts
      : ["Sugar", "Sauce", "Onion", "Cheese", "Salt", "Ice", "Oil", "Spicy"];
    const ins = db.prepare(
      `INSERT OR IGNORE INTO kitchen_targets (
         target_id, shop_id, name, name_norm, is_active, sort_order, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
    );
    seedTgts.forEach((name, i) => {
      ins.run(`tgt_${name_norm(name)}_${i}`, shopId, name, normalizeName(name), i, ts, ts);
    });
  }

  const standCount = db
    .prepare(`SELECT COUNT(*) AS c FROM kitchen_standalone WHERE shop_id = ?`)
    .get(shopId).c;
  if (standCount === 0) {
    db.prepare(
      `INSERT OR IGNORE INTO kitchen_standalone (
         standalone_id, shop_id, name, name_norm, is_active, sort_order, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, 0, ?, ?)`
    ).run("std_well_done", shopId, "Well Done", "well done", ts, ts);
  }

  // Link customized items that already had non-empty JSON lists.
  const items = db
    .prepare(
      `SELECT item_id, instruction_modifiers_json, instruction_targets_json, instruction_customized
       FROM menu_items`
    )
    .all();
  const findMod = db.prepare(
    `SELECT modifier_id FROM kitchen_modifiers WHERE shop_id = ? AND name_norm = ?`
  );
  const findTgt = db.prepare(
    `SELECT target_id FROM kitchen_targets WHERE shop_id = ? AND name_norm = ?`
  );
  const linkMod = db.prepare(
    `INSERT OR IGNORE INTO menu_item_allowed_modifiers (item_id, modifier_id) VALUES (?, ?)`
  );
  const linkTgt = db.prepare(
    `INSERT OR IGNORE INTO menu_item_allowed_targets (item_id, target_id) VALUES (?, ?)`
  );
  const markCustom = db.prepare(
    `UPDATE menu_items SET instruction_customized = 1 WHERE item_id = ?`
  );

  for (const item of items) {
    if (Number(item.instruction_customized) === 1) continue;
    const mods = parseJsonArray(item.instruction_modifiers_json);
    const tgts = parseJsonArray(item.instruction_targets_json);
    if (!mods.length && !tgts.length) continue;
    markCustom.run(item.item_id);
    for (const name of mods) {
      let row = findMod.get(shopId, normalizeName(name));
      if (!row) {
        const id = `mod_${normalizeName(name).replace(/\s/g, "_")}_${Date.now()}`;
        db.prepare(
          `INSERT INTO kitchen_modifiers (
             modifier_id, shop_id, name, name_norm, is_active, sort_order, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 1, 99, ?, ?)`
        ).run(id, shopId, name, normalizeName(name), ts, ts);
        row = { modifier_id: id };
      }
      linkMod.run(item.item_id, row.modifier_id);
    }
    for (const name of tgts) {
      let row = findTgt.get(shopId, normalizeName(name));
      if (!row) {
        const id = `tgt_${normalizeName(name).replace(/\s/g, "_")}_${Date.now()}`;
        db.prepare(
          `INSERT INTO kitchen_targets (
             target_id, shop_id, name, name_norm, is_active, sort_order, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 1, 99, ?, ?)`
        ).run(id, shopId, name, normalizeName(name), ts, ts);
        row = { target_id: id };
      }
      linkTgt.run(item.item_id, row.target_id);
    }
  }
}

function name_norm(name) {
  return normalizeName(name).replace(/\s+/g, "_").slice(0, 40);
}
