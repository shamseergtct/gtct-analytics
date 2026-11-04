/**
 * Phase 1.2 Mac acceptance — isolated temp DB. Never touches physical printers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openRoleSessions } from "./testHttp.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger, log } from "../util/logger.js";
import { seedSampleData } from "../seed/sampleData.js";
import { createServer } from "../http/server.js";
import { createTestOrder } from "../services/orders.js";
import { processAllPending } from "../print/dispatcher.js";
import { listPrinters } from "../services/printers.js";
import { withSubmissionId } from "./orderRequest.js";

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function httpJson(port, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(withSubmissionId(body)) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          ...(token
            ? {
                Cookie: `gtct_ls_session=${encodeURIComponent(token)}`,
                Origin: `http://127.0.0.1:${port}`,
              }
            : {}),
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = { raw: data };
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const results = [];
  const pass = (name) => {
    results.push({ name, ok: true });
    log.info(`PASS ${name}`);
  };
  const fail = (name, err) => {
    results.push({ name, ok: false, error: String(err.message || err) });
    log.error(`FAIL ${name}`, { error: String(err.message || err) });
  };

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-phase12-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18788";
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;
  delete process.env.GTCT_ALLOW_TCP_PROBE;
  delete process.env.GTCT_ALLOW_LAN_BIND;

  const config = loadConfig({ mode: "http" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedSampleData(config);

  assert(config.physicalPrintEnabled === false, "physical print must be off");
  assert(config.allowTcpProbe === false, "tcp probe must be off");

  // Seed MOCK printers preserved
  try {
    const printers = listPrinters();
    assert(printers.length >= 4, "seed printers present");
    assert(
      printers.every((p) => p.connection_type === "MOCK"),
      "seed printers are MOCK"
    );
    pass("seed-mock-printers");
  } catch (err) {
    fail("seed-mock-printers", err);
  }

  // Invalid NETWORK_TCP rejected
  try {
    let rejected = false;
    try {
      const { upsertPrinter } = await import("../services/printers.js");
      upsertPrinter({
        displayName: "Bad",
        connectionType: "NETWORK_TCP",
        host: "not a host!!",
        port: 9100,
      });
    } catch {
      rejected = true;
    }
    assert(rejected, "invalid host must reject");
    pass("reject-bad-network-config");
  } catch (err) {
    fail("reject-bad-network-config", err);
  }

  // Persist valid NETWORK_TCP config without printing
  try {
    const { upsertPrinter } = await import("../services/printers.js");
    const { upsertStation } = await import("../services/stations.js");
    const prn = upsertPrinter({
      printerId: "prn_pos80_config_only",
      displayName: "POS-80 Config Only",
      connectionType: "NETWORK_TCP",
      host: "192.168.0.110",
      port: 9100,
      paperWidthMm: 80,
      capabilities: { physicalDispatchEnabled: false },
    });
    assert(prn.host === "192.168.0.110", "host persisted");
    assert(prn.port === 9100, "port persisted");
    upsertStation({
      stationId: "station_juice",
      name: "JUICE",
      description: "Juice",
      printerId: "prn_pos80_config_only",
    });
    // restore MOCK for later mock order
    upsertStation({
      stationId: "station_juice",
      name: "JUICE",
      description: "Juice and cold drinks prep",
      printerId: "prn_mock_juice",
    });
    pass("persist-network-tcp-config");
  } catch (err) {
    fail("persist-network-tcp-config", err);
  }

  // Restart recovery
  try {
    const before = getDb().prepare(`SELECT COUNT(*) AS c FROM printers`).get().c;
    const dbPath = config.dbPath;
    closeDatabase();
    openDatabase(dbPath);
    await runMigrations(getDb());
    const after = getDb().prepare(`SELECT COUNT(*) AS c FROM printers`).get().c;
    assert(after === before, "printers survive reopen/migrate");
    const pos = getDb()
      .prepare(`SELECT * FROM printers WHERE printer_id = ?`)
      .get("prn_pos80_config_only");
    assert(pos?.host === "192.168.0.110", "POS-80 config retained");
    pass("restart-recovery-settings");
  } catch (err) {
    fail("restart-recovery-settings", err);
  }

  // MOCK order still works
  try {
    const order = createTestOrder(
      {
        orderNumber: "TEST-P12-MOCK",
        submissionId: "sub-TEST-P12-MOCK",
        orderType: "TAKEAWAY",
        destination: "Counter 1",
        lines: [
          {
            itemId: "item_orange_juice",
            quantity: 1,
            instructions: ["No ice"],
          },
        ],
      },
      config
    );
    assert(order.created, "order created");
    const processed = await processAllPending(config);
    assert(processed.length >= 2, "kitchen + cashier dispatched");
    const again = createTestOrder(
      {
        orderNumber: "TEST-P12-MOCK",
        submissionId: "sub-TEST-P12-MOCK",
        orderType: "TAKEAWAY",
        destination: "Counter 1",
        lines: [
          {
            itemId: "item_orange_juice",
            quantity: 1,
            instructions: ["No ice"],
          },
        ],
      },
      config
    );
    assert(again.created === false, "idempotent");
    pass("mock-order-idempotent");
  } catch (err) {
    fail("mock-order-idempotent", err);
  }

  // HTTP auth + settings APIs + settings page + physical blocked
  let server;
  try {
    server = createServer(config);
    await new Promise((resolve, reject) => {
      server.listen(config.port, config.host, (err) =>
        err ? reject(err) : resolve()
      );
    });

    const sessions = await openRoleSessions(config.port, config.testTenantId);
    const admin = sessions.admin;
    const device = sessions.device;

    const page = await httpJson(config.port, "GET", "/settings.html");
    assert(page.status === 200, "settings page served");

    const devicePut = await httpJson(
      config.port,
      "PUT",
      "/v1/printers",
      device,
      {
        displayName: "Nope",
        connectionType: "MOCK",
      }
    );
    assert(devicePut.status === 403, "device cannot edit printers");

    const adminPut = await httpJson(
      config.port,
      "PUT",
      "/v1/printers",
      admin,
      {
        printerId: "prn_mock_extra",
        displayName: "Extra Mock",
        connectionType: "MOCK",
        paperWidthMm: 58,
      }
    );
    assert(adminPut.status === 200, "admin can add printer");

    const preview = await httpJson(
      config.port,
      "POST",
      "/v1/printers/prn_mock_extra/preview",
      admin,
      {}
    );
    assert(preview.status === 200 && preview.json.text, "preview works");
    assert(
      preview.json.physicalPrintEnabled === false,
      "preview reports physical off"
    );

    const physical = await httpJson(
      config.port,
      "POST",
      "/v1/printers/prn_pos80_config_only/test",
      admin,
      { mode: "physical" }
    );
    assert(physical.status === 400, "physical test blocked");
    assert(physical.json.physicalDataSent === false, "no physical data");

    const probe = await httpJson(
      config.port,
      "POST",
      "/v1/printers/prn_pos80_config_only/test",
      admin,
      { mode: "tcp_probe" }
    );
    assert(probe.status === 400, "tcp probe disabled by default");
    assert(probe.json.physicalDataSent === false, "probe sent no payload");

    const unauth = await httpJson(config.port, "GET", "/v1/printers");
    assert(unauth.status === 401, "unauth rejected");

    pass("http-settings-security");
  } catch (err) {
    fail("http-settings-security", err);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    closeDatabase();
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        tempRoot,
        results,
        passed: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        physicalPrintAttempted: false,
      },
      null,
      2
    )
  );
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
