import { loadConfig, ensureDataDirs } from "./config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "./db/db.js";
import { initLogger, log } from "./util/logger.js";
import { createServer } from "./http/server.js";
import { startDispatchLoop } from "./print/dispatcher.js";
import { seedIfEmpty } from "./seed/sampleData.js";

async function boot() {
  const config = loadConfig({ mode: "http" });
  ensureDataDirs(config);
  initLogger(config.logDir);

  for (const warning of config.warnings) {
    log.warn(warning);
  }

  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedIfEmpty(config);

  if (!config.loopback && config.lanAccessReady !== true) {
    throw new Error("Refusing to listen outside this computer.");
  }

  const server = createServer(config);
  const dispatcher = startDispatchLoop(config);

  await new Promise((resolve, reject) => {
    server.listen(config.port, config.host, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  log.info("GTCT local server listening", {
    host: config.host,
    port: config.port,
    dbPath: config.dbPath,
    physicalPrintEnabled: config.physicalPrintEnabled,
    lanAccessReady: config.lanAccessReady,
    tlsReady: config.tlsReady,
    node: process.version,
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutting down", { signal });
    dispatcher.stop();
    server.close(() => {
      closeDatabase();
      log.info("Shutdown complete");
      process.exit(0);
    });
    setTimeout(() => {
      closeDatabase();
      process.exit(1);
    }, 8000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

boot().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err.message || err);
  process.exit(1);
});
