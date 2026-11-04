import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dbInstance = null;

export function getDb() {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call openDatabase() first.");
  }
  return dbInstance;
}

export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  dbInstance = db;
  return db;
}

export function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Apply schema.sql then ordered migrations (*.sql and *.js with export function up(db)).
 */
export async function runMigrations(db) {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  db.exec(schemaSql);

  const applied = new Set(
    db
      .prepare("SELECT name FROM schema_migrations ORDER BY id")
      .all()
      .map((row) => row.name)
  );

  const migrationsDir = path.join(__dirname, "migrations");
  if (!fs.existsSync(migrationsDir)) return;

  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql") || name.endsWith(".js"))
    .sort();

  const insert = db.prepare(
    "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)"
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const fullPath = path.join(migrationsDir, file);

    if (file.endsWith(".sql")) {
      const sql = fs.readFileSync(fullPath, "utf8");
      const tx = db.transaction(() => {
        db.exec(sql);
        insert.run(file, new Date().toISOString());
      });
      tx();
      continue;
    }

    const mod = await import(pathToFileURL(fullPath).href);
    if (typeof mod.up !== "function") {
      throw new Error(`Migration ${file} must export function up(db)`);
    }
    mod.up(db);
    insert.run(file, new Date().toISOString());
  }
}
