import { loadConfig, ensureDataDirs } from "./config.js";
import { inspectExistingTestDatabase, stampMigratedTestDatabase } from "./db/testStartup.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "./db/db.js";
import { initLogger, log } from "./util/logger.js";
import { createServer } from "./http/server.js";
import { startDispatchLoop } from "./print/dispatcher.js";
import { seedIfEmpty } from "./seed/sampleData.js";
import { startTestAutoBackups } from "./backup/testBackup.js";
import { recordTestBackupAttempt } from "./backup/testBackupManagement.js";
import { startCloudDeliveryBridgeLoop } from "./services/cloudDeliveryBridge.js";

async function boot() {
  const config = loadConfig({ mode: "http" });
  inspectExistingTestDatabase(config);
  ensureDataDirs(config);
  initLogger(config.logDir);

  for (const warning of config.warnings) {
    log.warn(warning);
  }

  openDatabase(config.dbPath);
  await runMigrations(getDb());
  stampMigratedTestDatabase(getDb(), config);
  seedIfEmpty(config);
  // P2-C1: TEST-only; opt-in, checked hot SQLite backup BEFORE serving requests.
  const testBackups = await startTestAutoBackups({ logger: log, onAttempt: recordTestBackupAttempt });

  if (!config.loopback && config.lanAccessReady !== true) {
    throw new Error("Refusing to listen outside this computer.");
  }

  const server = createServer(config);
  const dispatcher = startDispatchLoop(config);
  const cloudBridge = startCloudDeliveryBridgeLoop(config);

  await new Promise((resolve, reject) => {
    server.listen(config.port, config.host, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // When serving the restaurant network, also serve THIS computer on loopback
  // (http://127.0.0.1) with the normal loopback-only rules, so the cashier PC keeps
  // working when Wi-Fi drops or the LAN address changes. Only this PC can reach it.
  let loopbackServer = null;
  if (!config.loopback && config.lanAccessReady === true) {
    const loopbackConfig = {
      ...config,
      host: "127.0.0.1",
      loopback: true,
      lanAccessReady: false,
      tlsReady: false,
      tls: null,
      lanHostname: "",
      lanPeer: { host: config.host, port: config.port, lanHostname: config.lanHostname || "" },
    };
    loopbackServer = createServer(loopbackConfig);
    await new Promise((resolve) => {
      loopbackServer.once("error", (err) => {
        log.warn("Loopback listener not started; this PC must use the LAN address", {
          error: err.message,
        });
        loopbackServer = null;
        resolve();
      });
      loopbackServer.listen(config.port, "127.0.0.1", () => {
        log.info("This computer can also use http://127.0.0.1", { port: config.port });
        resolve();
      });
    });
  }

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
    cloudBridge.stop();
    testBackups.stop();
    loopbackServer?.close();
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
