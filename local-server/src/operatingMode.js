/**
 * Phase P2-A1: non-destructive safety checks for the existing TEST application.
 * REAL / PRODUCTION mode is intentionally NOT implemented or enabled here.
 *
 * This module is dependency-free so identity checks can run against a read-only
 * SQLite handle before migrations, seeding or application startup.
 */
export const TEST_MODE = "TEST";
export const DB_IDENTITY_KEY = "gtct.database.identity.v1";

function tableExists(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(table));
}

function verifyIdentityRow(db, config) {
  if (!tableExists(db, "meta")) return false;
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(DB_IDENTITY_KEY);
  if (!row) return false;
  let identity;
  try {
    identity = JSON.parse(row.value);
  } catch {
    throw new Error("Database identity is invalid; refusing TEST startup.");
  }
  if (
    identity?.version !== 1 ||
    identity?.operatingMode !== TEST_MODE ||
    identity?.testTenantId !== config.testTenantId
  ) {
    throw new Error("Database identity does not match this TEST server; refusing startup.");
  }
  return true;
}

/** Reject a non-test DB before running schema migrations or sample seeding. */
export function assertTestDatabaseIdentity(db, config) {
  if (config.operatingMode !== TEST_MODE) {
    throw new Error("Real restaurant mode is not implemented; refusing database access.");
  }

  const identified = verifyIdentityRow(db, config);
  if (!tableExists(db, "orders")) return { identified };

  const columns = db.prepare("PRAGMA table_info(orders)").all();
  if (!columns.some((column) => column.name === "is_test")) {
    throw new Error("Unknown orders schema; refusing TEST startup.");
  }
  const realCount = db.prepare(
    "SELECT COUNT(*) AS count FROM orders WHERE is_test IS NULL OR is_test <> 1"
  ).get().count;
  if (realCount > 0) {
    throw new Error("Non-test orders exist in this database; refusing TEST startup.");
  }
  return { identified };
}

/** Called only after migrations. Never rewrite an existing identity row. */
export function markTestDatabaseIdentity(db, config) {
  assertTestDatabaseIdentity(db, config);
  const value = JSON.stringify({
    version: 1,
    operatingMode: TEST_MODE,
    testTenantId: config.testTenantId,
  });
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
    .run(DB_IDENTITY_KEY, value);
  assertTestDatabaseIdentity(db, config);
}
