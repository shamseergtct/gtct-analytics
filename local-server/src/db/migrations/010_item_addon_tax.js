/**
 * Phase 1.8 — Item and add-on tax applicability + order tax bucket snapshots.
 * Non-destructive. Existing rows default to taxable (1) for Phase 1.7 compatibility.
 */

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function up(db) {
  ensureColumn(
    db,
    "menu_items",
    "tax_applicable",
    "tax_applicable INTEGER NOT NULL DEFAULT 1 CHECK (tax_applicable IN (0, 1))"
  );
  ensureColumn(
    db,
    "addons",
    "tax_applicable",
    "tax_applicable INTEGER NOT NULL DEFAULT 1 CHECK (tax_applicable IN (0, 1))"
  );

  // Order-level buckets
  ensureColumn(
    db,
    "orders",
    "taxable_goods_cents",
    "taxable_goods_cents INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(
    db,
    "orders",
    "nontaxable_goods_cents",
    "nontaxable_goods_cents INTEGER NOT NULL DEFAULT 0"
  );

  // Line snapshots
  ensureColumn(
    db,
    "order_lines",
    "tax_applicable",
    "tax_applicable INTEGER NOT NULL DEFAULT 1"
  );
  ensureColumn(
    db,
    "order_lines",
    "taxable_cents",
    "taxable_cents INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(
    db,
    "order_lines",
    "nontaxable_cents",
    "nontaxable_cents INTEGER NOT NULL DEFAULT 0"
  );

  // Add-on line snapshots
  ensureColumn(
    db,
    "order_line_addons",
    "tax_applicable",
    "tax_applicable INTEGER NOT NULL DEFAULT 1"
  );

  // Legacy orders: treat full goods as taxable (matches prior Phase 1.7 behavior)
  db.exec(`
    UPDATE orders
    SET taxable_goods_cents = CASE
          WHEN taxable_goods_cents = 0 AND nontaxable_goods_cents = 0
            THEN COALESCE(goods_cents, total_cents, 0)
          ELSE taxable_goods_cents
        END
    WHERE taxable_goods_cents = 0 AND nontaxable_goods_cents = 0
  `);

  db.exec(`
    UPDATE order_lines
    SET taxable_cents = CASE
          WHEN taxable_cents = 0 AND nontaxable_cents = 0
            THEN COALESCE(line_total_cents, 0)
          ELSE taxable_cents
        END
    WHERE taxable_cents = 0 AND nontaxable_cents = 0
  `);
}
