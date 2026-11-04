import { inspectExistingTestDatabase, stampMigratedTestDatabase } from "../db/testStartup.js";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger, log } from "../util/logger.js";
import { processAllPending } from "../print/dispatcher.js";

async function main() {
  const config = loadConfig({ mode: "script" });
  inspectExistingTestDatabase(config);
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  stampMigratedTestDatabase(getDb(), config);
  const processed = await processAllPending(config);
  log.info("Dispatcher run complete", { count: processed.length, processed });
  closeDatabase();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
