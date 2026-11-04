import fs from "node:fs";
import Database from "better-sqlite3";
import { assertTestDatabaseIdentity, markTestDatabaseIdentity } from "../operatingMode.js";

/**
 * Inspect the existing SQLite database without creating or migrating it.
 * Use before EVERY normal server/CLI entry point that may write SQLite.
 */
export function inspectExistingTestDatabase(config) {
  if (config.operatingMode !== "TEST") {
    throw new Error("Real restaurant mode is not implemented; refusing database access.");
  }
  if (!fs.existsSync(config.dbPath)) return;
  const inspection = new Database(config.dbPath, { readonly: true, fileMustExist: true });
  try {
    assertTestDatabaseIdentity(inspection, config);
  } finally {
    inspection.close();
  }
}

/** Complete identification after existing migrations have created meta table. */
export function stampMigratedTestDatabase(db, config) {
  markTestDatabaseIdentity(db, config);
}
