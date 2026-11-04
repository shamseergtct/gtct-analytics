/**
 * Phase 1.3 ops: optional SKU, category/subcategory tables, category FKs.
 * Non-destructive — preserves menu item IDs, photos, stations, orders.
 */
import { newId } from "../../util/ids.js";
import { nowIso } from "../../util/time.js";

function normalizeLabel(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function ensureCategory(db, name, sortOrder, ts, cache) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const norm = normalizeLabel(trimmed);
  if (cache.byNorm.has(norm)) return cache.byNorm.get(norm);

  const existing = db
    .prepare(
      `SELECT category_id FROM menu_categories WHERE name_normalized = ?`
    )
    .get(norm);
  if (existing) {
    cache.byNorm.set(norm, existing.category_id);
    return existing.category_id;
  }

  const categoryId = newId("cat");
  db.prepare(
    `INSERT INTO menu_categories (
      category_id, name, name_normalized, is_active, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?)`
  ).run(categoryId, trimmed, norm, sortOrder, ts, ts);
  cache.byNorm.set(norm, categoryId);
  return categoryId;
}

function ensureSubcategory(db, categoryId, name, sortOrder, ts, cache) {
  const trimmed = String(name || "").trim();
  if (!categoryId || !trimmed) return null;
  const norm = normalizeLabel(trimmed);
  const key = `${categoryId}::${norm}`;
  if (cache.subByKey.has(key)) return cache.subByKey.get(key);

  const existing = db
    .prepare(
      `SELECT subcategory_id FROM menu_subcategories
       WHERE category_id = ? AND name_normalized = ?`
    )
    .get(categoryId, norm);
  if (existing) {
    cache.subByKey.set(key, existing.subcategory_id);
    return existing.subcategory_id;
  }

  const subcategoryId = newId("sub");
  db.prepare(
    `INSERT INTO menu_subcategories (
      subcategory_id, category_id, name, name_normalized,
      is_active, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(subcategoryId, categoryId, trimmed, norm, sortOrder, ts, ts);
  cache.subByKey.set(key, subcategoryId);
  return subcategoryId;
}

export function up(db) {
  const ts = nowIso();
  db.pragma("foreign_keys = OFF");

  db.exec(`
    CREATE TABLE IF NOT EXISTS menu_categories (
      category_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_normalized TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS menu_subcategories (
      subcategory_id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES menu_categories(category_id),
      name TEXT NOT NULL,
      name_normalized TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (category_id, name_normalized)
    );

    CREATE INDEX IF NOT EXISTS idx_menu_subcategories_category
      ON menu_subcategories(category_id);
  `);

  const cache = { byNorm: new Map(), subByKey: new Map() };

  // Seed practical defaults if empty (does not rename existing labels).
  const catCount = db.prepare(`SELECT COUNT(*) AS c FROM menu_categories`).get().c;
  if (catCount === 0) {
    const defaults = [
      {
        name: "Beverages",
        sort: 10,
        subs: [
          ["Soft Drinks", 10],
          ["Fresh Juice", 20],
          ["Tea & Coffee", 30],
        ],
      },
      {
        name: "Food",
        sort: 20,
        subs: [
          ["Burgers", 10],
          ["Shawarma", 20],
          ["Sandwiches", 30],
        ],
      },
      {
        name: "Desserts",
        sort: 30,
        subs: [
          ["Cakes", 10],
          ["Ice Cream", 20],
        ],
      },
    ];
    for (const cat of defaults) {
      const id = ensureCategory(db, cat.name, cat.sort, ts, cache);
      for (const [subName, subSort] of cat.subs) {
        ensureSubcategory(db, id, subName, subSort, ts, cache);
      }
    }
  }

  // Import legacy free-text categories from menu_items.
  const legacy = db
    .prepare(
      `SELECT DISTINCT TRIM(category) AS category, TRIM(subcategory) AS subcategory
       FROM menu_items
       WHERE TRIM(COALESCE(category, '')) != ''`
    )
    .all();
  let sort = 100;
  for (const row of legacy) {
    const categoryId = ensureCategory(db, row.category, sort, ts, cache);
    sort += 10;
    if (row.subcategory) {
      ensureSubcategory(db, categoryId, row.subcategory, 10, ts, cache);
    }
  }

  // Rebuild menu_items so SKU can be NULL (multiple blank SKUs allowed).
  db.exec(`
    CREATE TABLE menu_items_new (
      item_id TEXT PRIMARY KEY,
      sku TEXT,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      subcategory TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
      code TEXT,
      image_filename TEXT,
      is_sold_out INTEGER NOT NULL DEFAULT 0 CHECK (is_sold_out IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      instruction_modifiers_json TEXT NOT NULL DEFAULT '[]',
      instruction_targets_json TEXT NOT NULL DEFAULT '[]',
      category_id TEXT REFERENCES menu_categories(category_id),
      subcategory_id TEXT REFERENCES menu_subcategories(subcategory_id)
    );
  `);

  const oldCols = db
    .prepare(`PRAGMA table_info(menu_items)`)
    .all()
    .map((c) => c.name);
  const hasCatId = oldCols.includes("category_id");

  if (hasCatId) {
    db.exec(`
      INSERT INTO menu_items_new (
        item_id, sku, name, is_active, created_at, updated_at,
        category, subcategory, description, price_cents, code,
        image_filename, is_sold_out, sort_order,
        instruction_modifiers_json, instruction_targets_json,
        category_id, subcategory_id
      )
      SELECT
        item_id,
        CASE WHEN TRIM(COALESCE(sku, '')) = '' THEN NULL ELSE sku END,
        name, is_active, created_at, updated_at,
        category, subcategory, description, price_cents, code,
        image_filename, is_sold_out, sort_order,
        instruction_modifiers_json, instruction_targets_json,
        category_id, subcategory_id
      FROM menu_items;
    `);
  } else {
    db.exec(`
      INSERT INTO menu_items_new (
        item_id, sku, name, is_active, created_at, updated_at,
        category, subcategory, description, price_cents, code,
        image_filename, is_sold_out, sort_order,
        instruction_modifiers_json, instruction_targets_json,
        category_id, subcategory_id
      )
      SELECT
        item_id,
        CASE WHEN TRIM(COALESCE(sku, '')) = '' THEN NULL ELSE sku END,
        name, is_active, created_at, updated_at,
        category, subcategory, description, price_cents, code,
        image_filename, is_sold_out, sort_order,
        instruction_modifiers_json, instruction_targets_json,
        NULL, NULL
      FROM menu_items;
    `);
  }

  db.exec(`DROP TABLE menu_items;`);
  db.exec(`ALTER TABLE menu_items_new RENAME TO menu_items;`);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_items_sku_unique
      ON menu_items(sku)
      WHERE sku IS NOT NULL AND TRIM(sku) != '';
    CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category);
    CREATE INDEX IF NOT EXISTS idx_menu_items_sort ON menu_items(sort_order, name);
    CREATE INDEX IF NOT EXISTS idx_menu_items_category_id ON menu_items(category_id);
    CREATE INDEX IF NOT EXISTS idx_menu_items_subcategory_id ON menu_items(subcategory_id);
  `);

  // Link items to category/subcategory ids from legacy text (and keep text in sync).
  const items = db
    .prepare(
      `SELECT item_id, category, subcategory, category_id, subcategory_id FROM menu_items`
    )
    .all();
  const updateIds = db.prepare(
    `UPDATE menu_items
     SET category_id = ?, subcategory_id = ?, category = ?, subcategory = ?, updated_at = ?
     WHERE item_id = ?`
  );

  for (const item of items) {
    let categoryId = item.category_id;
    let subcategoryId = item.subcategory_id;
    let categoryName = item.category || "";
    let subcategoryName = item.subcategory || "";

    if (!categoryId && categoryName.trim()) {
      categoryId = ensureCategory(db, categoryName, 200, ts, cache);
    }
    if (categoryId) {
      const cat = db
        .prepare(`SELECT name FROM menu_categories WHERE category_id = ?`)
        .get(categoryId);
      if (cat) categoryName = cat.name;
    }
    if (categoryId && subcategoryName.trim()) {
      subcategoryId = ensureSubcategory(
        db,
        categoryId,
        subcategoryName,
        10,
        ts,
        cache
      );
    }
    if (subcategoryId) {
      const sub = db
        .prepare(
          `SELECT name, category_id FROM menu_subcategories WHERE subcategory_id = ?`
        )
        .get(subcategoryId);
      if (sub) {
        subcategoryName = sub.name;
        if (sub.category_id !== categoryId) {
          // Invalid combo — clear subcategory rather than orphan.
          subcategoryId = null;
          subcategoryName = "";
        }
      }
    } else {
      subcategoryName = "";
    }

    updateIds.run(
      categoryId,
      subcategoryId,
      categoryName,
      subcategoryName,
      ts,
      item.item_id
    );
  }

  // Friendly remaps for known seed labels onto default taxonomy (IDs preserved).
  const remap = [
    {
      itemId: "item_orange_juice",
      category: "Beverages",
      subcategory: "Fresh Juice",
    },
    {
      itemId: "item_chicken_shawarma",
      category: "Food",
      subcategory: "Shawarma",
    },
    {
      itemId: "item_chicken_burger",
      category: "Food",
      subcategory: "Burgers",
    },
  ];
  for (const row of remap) {
    const exists = db
      .prepare(`SELECT item_id FROM menu_items WHERE item_id = ?`)
      .get(row.itemId);
    if (!exists) continue;
    const categoryId = ensureCategory(db, row.category, 10, ts, cache);
    const subcategoryId = ensureSubcategory(
      db,
      categoryId,
      row.subcategory,
      10,
      ts,
      cache
    );
    db.prepare(
      `UPDATE menu_items
       SET category_id = ?, subcategory_id = ?, category = ?, subcategory = ?, updated_at = ?
       WHERE item_id = ?`
    ).run(
      categoryId,
      subcategoryId,
      row.category,
      row.subcategory,
      ts,
      row.itemId
    );
  }

  db.pragma("foreign_keys = ON");
}
