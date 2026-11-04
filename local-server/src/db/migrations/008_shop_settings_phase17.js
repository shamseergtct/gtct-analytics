/**
 * Phase 1.7 — Shop profile, tax, regional, receipt prefs + order billing snapshots.
 * Non-destructive ALTER / ensureColumn only.
 */

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function up(db) {
  // Business profile
  ensureColumn(db, "shop_settings", "legal_name", "legal_name TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "shop_settings", "address_text", "address_text TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "shop_settings", "city", "city TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "shop_settings", "country", "country TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "shop_settings", "phone", "phone TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "shop_settings", "phone_secondary", "phone_secondary TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "shop_settings", "whatsapp", "whatsapp TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "shop_settings", "email", "email TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    db,
    "shop_settings",
    "registration_number",
    "registration_number TEXT NOT NULL DEFAULT ''"
  );
  ensureColumn(db, "shop_settings", "logo_filename", "logo_filename TEXT");

  // Tax (disabled by default — safe)
  ensureColumn(
    db,
    "shop_settings",
    "tax_enabled",
    "tax_enabled INTEGER NOT NULL DEFAULT 0 CHECK (tax_enabled IN (0, 1))"
  );
  ensureColumn(db, "shop_settings", "tax_name", "tax_name TEXT NOT NULL DEFAULT 'VAT'");
  ensureColumn(
    db,
    "shop_settings",
    "tax_rate_bps",
    "tax_rate_bps INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(
    db,
    "shop_settings",
    "tax_mode",
    "tax_mode TEXT NOT NULL DEFAULT 'exclusive'"
  );
  ensureColumn(
    db,
    "shop_settings",
    "tax_registration_number",
    "tax_registration_number TEXT NOT NULL DEFAULT ''"
  );

  // Regional
  ensureColumn(db, "shop_settings", "timezone", "timezone TEXT NOT NULL DEFAULT 'UTC'");
  ensureColumn(
    db,
    "shop_settings",
    "date_format",
    "date_format TEXT NOT NULL DEFAULT 'YYYY-MM-DD'"
  );

  // Receipt display prefs (1 = show)
  ensureColumn(
    db,
    "shop_settings",
    "receipt_show_display_name",
    "receipt_show_display_name INTEGER NOT NULL DEFAULT 1"
  );
  ensureColumn(
    db,
    "shop_settings",
    "receipt_show_legal_name",
    "receipt_show_legal_name INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(
    db,
    "shop_settings",
    "receipt_show_address",
    "receipt_show_address INTEGER NOT NULL DEFAULT 1"
  );
  ensureColumn(
    db,
    "shop_settings",
    "receipt_show_phone",
    "receipt_show_phone INTEGER NOT NULL DEFAULT 1"
  );
  ensureColumn(
    db,
    "shop_settings",
    "receipt_show_tax_name",
    "receipt_show_tax_name INTEGER NOT NULL DEFAULT 1"
  );
  ensureColumn(
    db,
    "shop_settings",
    "receipt_show_tax_number",
    "receipt_show_tax_number INTEGER NOT NULL DEFAULT 1"
  );
  ensureColumn(
    db,
    "shop_settings",
    "receipt_show_registration",
    "receipt_show_registration INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(
    db,
    "shop_settings",
    "receipt_show_logo",
    "receipt_show_logo INTEGER NOT NULL DEFAULT 1"
  );
  ensureColumn(
    db,
    "shop_settings",
    "receipt_footer",
    "receipt_footer TEXT NOT NULL DEFAULT 'Thank you! Visit again.'"
  );

  // Order billing snapshots (legacy rows: tax 0 / empty mode = no tax at create time)
  ensureColumn(db, "orders", "goods_cents", "goods_cents INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "orders", "net_cents", "net_cents INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "orders", "tax_cents", "tax_cents INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "orders", "tax_enabled", "tax_enabled INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "orders", "tax_mode", "tax_mode TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "orders", "tax_rate_bps", "tax_rate_bps INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "orders", "tax_name", "tax_name TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    db,
    "orders",
    "tax_registration_number",
    "tax_registration_number TEXT NOT NULL DEFAULT ''"
  );
  ensureColumn(db, "orders", "currency_code", "currency_code TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "orders", "currency_label", "currency_label TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    db,
    "orders",
    "currency_decimals",
    "currency_decimals INTEGER NOT NULL DEFAULT 2"
  );
  ensureColumn(
    db,
    "orders",
    "shop_display_name",
    "shop_display_name TEXT NOT NULL DEFAULT ''"
  );
  ensureColumn(db, "orders", "shop_legal_name", "shop_legal_name TEXT NOT NULL DEFAULT ''");

  // Backfill goods/net from total for legacy rows that never had tax
  db.exec(`
    UPDATE orders
    SET goods_cents = CASE WHEN goods_cents = 0 THEN total_cents ELSE goods_cents END,
        net_cents = CASE WHEN net_cents = 0 THEN total_cents ELSE net_cents END
    WHERE total_cents IS NOT NULL
  `);
}
