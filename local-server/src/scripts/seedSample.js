import { loadConfig, ensureDataDirs } from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger, log } from "../util/logger.js";
import { seedSampleData } from "../seed/sampleData.js";

const config = loadConfig({ mode: "script" });
ensureDataDirs(config);
initLogger(config.logDir);
openDatabase(config.dbPath);
await runMigrations(getDb());
const result = seedSampleData(config);
log.info("Seed complete", result);
closeDatabase();
