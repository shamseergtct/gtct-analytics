/**
 * Phase 1.7 follow-up — optional WhatsApp line on receipts.
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
    "shop_settings",
    "receipt_show_whatsapp",
    "receipt_show_whatsapp INTEGER NOT NULL DEFAULT 1"
  );
}
