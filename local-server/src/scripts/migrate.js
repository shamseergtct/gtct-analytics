import { inspectExistingTestDatabase, stampMigratedTestDatabase } from "../db/testStartup.js";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger, log } from "../util/logger.js";

const config = loadConfig({ mode: "script" });
inspectExistingTestDatabase(config);
ensureDataDirs(config);
initLogger(config.logDir);
openDatabase(config.dbPath);
await runMigrations(getDb());
stampMigratedTestDatabase(getDb(), config);
log.info("Migrations applied", { dbPath: config.dbPath });
closeDatabase();
