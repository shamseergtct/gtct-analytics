/**
 * Phase 1.1 acceptance harness — uses an isolated temp data directory.
 * Never deletes the developer's primary database.
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
import { createTestOrder } from "../services/orders.js";
import { processAllPending, updateJobStatus, requestReprint } from "../print/dispatcher.js";
import { listPrintJobs, getPrintJob } from "../services/printQueue.js";
import { createServer } from "../http/server.js";
import { upsertStation } from "../services/stations.js";
import { withSubmissionId } from "./orderRequest.js";

const SAMPLE_LINES = [
  {
    itemId: "item_orange_juice",
    quantity: 2,
    instructions: ["Less sugar", "No ice"],
  },
  {
    itemId: "item_chicken_shawarma",
    quantity: 1,
    instructions: ["No onion", "Less sauce"],
  },
  {
    itemId: "item_chicken_burger",
    quantity: 1,
    instructions: ["Extra cheese", "No sauce"],
  },
];

function assert(cond, message) {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

function readMockTickets(printOutputDir) {
  const dir = path.join(printOutputDir, "mock");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    return { name, text };
  });
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

  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gtct-phase11-accept-")
  );
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18787";
  delete process.env.GTCT_ALLOW_LAN_BIND;
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;

  let config = loadConfig({ mode: "http" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedSampleData(config);

  // --- Ticket routing ---
  try {
    const created = createTestOrder(
      {
        orderNumber: "TEST-001",
        submissionId: "sub-TEST-001",
        orderType: "TAKEAWAY",
        destination: "Counter 1",
        lines: SAMPLE_LINES,
      },
      config
    );
    assert(created.created === true, "TEST-001 should create once");
    assert(created.jobs.length === 4, "expected 4 print jobs");
    const processed = await processAllPending(config);
    assert(processed.length === 4, "expected 4 dispatches");

    const tickets = readMockTickets(config.printOutputDir);
    assert(tickets.length === 4, "expected 4 mock ticket files");

    const juice = tickets.find((t) => t.text.includes("STATION: JUICE"));
    const shawarma = tickets.find((t) => t.text.includes("STATION: SHAWARMA"));
    const grill = tickets.find((t) => t.text.includes("STATION: GRILL"));
    const cashier = tickets.find((t) => t.text.includes("CASHIER TEST RECEIPT"));

    assert(juice, "juice ticket missing");
    assert(shawarma, "shawarma ticket missing");
    assert(grill, "grill ticket missing");
    assert(cashier, "cashier ticket missing");

    assert(juice.text.includes("2 × ORANGE JUICE"), "juice qty/name");
    assert(juice.text.includes("LESS SUGAR"), "juice instr 1");
    assert(juice.text.includes("NO ICE"), "juice instr 2");
    assert(!juice.text.includes("SHAWARMA"), "juice must not include shawarma");
    assert(!juice.text.includes("BURGER"), "juice must not include burger");

    assert(shawarma.text.includes("1 × CHICKEN SHAWARMA"), "shawarma qty/name");
    assert(shawarma.text.includes("NO ONION"), "shawarma instr 1");
    assert(shawarma.text.includes("LESS SAUCE"), "shawarma instr 2");
    assert(!shawarma.text.includes("ORANGE"), "shawarma isolation");
    assert(!shawarma.text.includes("BURGER"), "shawarma isolation");

    assert(grill.text.includes("1 × CHICKEN BURGER"), "grill qty/name");
    assert(grill.text.includes("EXTRA CHEESE"), "grill instr 1");
    assert(grill.text.includes("NO SAUCE"), "grill instr 2");
    assert(!grill.text.includes("ORANGE"), "grill isolation");
    assert(!grill.text.includes("SHAWARMA"), "grill isolation");

    assert(cashier.text.includes("Orange Juice"), "cashier has OJ");
    assert(cashier.text.includes("Chicken Shawarma"), "cashier has shawarma");
    assert(cashier.text.includes("Chicken Burger"), "cashier has burger");
    assert(!/invoice\s*#/i.test(cashier.text), "no production invoice number");
    assert(
      cashier.text.includes("TEST DATA") &&
        cashier.text.includes("NOT A CUSTOMER BILL"),
      "cashier must be labeled test data"
    );

    pass("ticket-routing-TEST-001");
  } catch (err) {
    fail("ticket-routing-TEST-001", err);
  }

  // --- Sequential idempotency ---
  try {
    const again = createTestOrder(
      {
        orderNumber: "TEST-001",
        submissionId: "sub-TEST-001",
        orderType: "TAKEAWAY",
        destination: "Counter 1",
        lines: SAMPLE_LINES,
      },
      config
    );
    assert(again.created === false, "rerun must not recreate order");
    assert(again.jobs.length === 4, "same 4 jobs returned");
    const jobCount = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM print_jobs`)
      .get().c;
    assert(jobCount === 4, `job count should remain 4, got ${jobCount}`);
    pass("idempotency-sequential");
  } catch (err) {
    fail("idempotency-sequential", err);
  }

  // Create a second order and leave its jobs PENDING for restart/uncertain tests
  try {
    const pendingOrder = createTestOrder(
      {
        orderNumber: "TEST-PENDING",
        submissionId: "sub-TEST-PENDING",
        orderType: "TAKEAWAY",
        destination: "Counter 2",
        lines: SAMPLE_LINES,
      },
      config
    );
    assert(pendingOrder.created === true, "pending order created");
    assert(
      pendingOrder.jobs.every((j) => j.status === "PENDING"),
      "new jobs start PENDING"
    );
    pass("pending-jobs-created");
  } catch (err) {
    fail("pending-jobs-created", err);
  }

  // --- Restart recovery of PENDING jobs ---
  try {
    const pendingBefore = listPrintJobs({ status: "PENDING" }).length;
    assert(pendingBefore >= 4, "need pending jobs before restart simulation");
    const dbPath = config.dbPath;
    closeDatabase();
    openDatabase(dbPath);
    await runMigrations(getDb()); // must be non-destructive
    const pendingAfter = listPrintJobs({ status: "PENDING" }).length;
    assert(
      pendingAfter === pendingBefore,
      `pending count changed across reopen: ${pendingBefore} → ${pendingAfter}`
    );
    const stations = getDb().prepare(`SELECT COUNT(*) AS c FROM stations`).get()
      .c;
    assert(stations === 4, "migrations must not wipe stations");
    pass("restart-recovery-pending");
  } catch (err) {
    fail("restart-recovery-pending", err);
  }

  // --- Uncertain outcome + no blind reprint ---
  try {
    const pending = listPrintJobs({ status: "PENDING" })[0];
    assert(pending, "need a pending job");
    let job = getDb()
      .prepare(`SELECT * FROM print_jobs WHERE job_id = ?`)
      .get(pending.job_id);
    job = updateJobStatus(getDb(), job, "DISPATCHING", {
      attemptCount: job.attempt_count + 1,
      note: "Simulated claim",
    });
    job = updateJobStatus(getDb(), job, "UNKNOWN", {
      lastError: "Simulated uncertain dispatch after crash",
      note: "Acceptance: uncertain outcome",
    });
    assert(job.status === "UNKNOWN", "status UNKNOWN");
    const still = getPrintJob(pending.job_id);
    assert(still.status === "UNKNOWN", "no auto-transition from UNKNOWN");
    const reprint = requestReprint(pending.job_id);
    assert(reprint.is_reprint === 1, "reprint flagged");
    assert(reprint.status === "PENDING", "reprint enqueued as PENDING");
    assert(
      reprint.idempotency_key !== pending.idempotency_key,
      "reprint has distinct idempotency key"
    );
    assert(
      (still.events || []).length >= 1,
      "attempt history retained on original"
    );
    pass("uncertain-outcome-no-blind-reprint");
  } catch (err) {
    fail("uncertain-outcome-no-blind-reprint", err);
  }

  // --- Missing printer assignment → NEEDS_REVIEW ---
  try {
    getDb()
      .prepare(`DELETE FROM station_printers WHERE station_id = 'station_grill'`)
      .run();
    const r = createTestOrder(
      {
        orderNumber: "TEST-NOPRINTER",
        submissionId: "sub-TEST-NOPRINTER",
        orderType: "TAKEAWAY",
        destination: "Counter 3",
        lines: [
          {
            itemId: "item_chicken_burger",
            quantity: 1,
            instructions: ["No sauce"],
          },
        ],
      },
      config
    );
    const grillJob = r.jobs.find((j) => j.station_id === "station_grill");
    assert(grillJob, "grill job exists");
    assert(
      grillJob.status === "NEEDS_REVIEW",
      `expected NEEDS_REVIEW, got ${grillJob.status}`
    );
    upsertStation({
      stationId: "station_grill",
      name: "GRILL",
      description: "Grill / burger station",
      printerId: "prn_mock_grill",
    });
    pass("missing-printer-needs-review");
  } catch (err) {
    fail("missing-printer-needs-review", err);
  }

  // --- HTTP auth / admin / concurrent duplicate submissions ---
  let server;
  try {
    config = loadConfig({ mode: "http" });
    server = createServer(config);
    await new Promise((resolve, reject) => {
      server.listen(config.port, config.host, (err) =>
        err ? reject(err) : resolve()
      );
    });

    const sessions = await openRoleSessions(config.port, config.testTenantId);
    const admin = sessions.admin;
    const device = sessions.device;

    const unauth = await httpJson(config.port, "GET", "/v1/print-jobs");
    assert(unauth.status === 401, "unauthenticated rejected");

    const deviceOk = await httpJson(
      config.port,
      "GET",
      "/v1/print-jobs",
      device
    );
    assert(deviceOk.status === 200, "device token can read jobs");

    const devicePrinter = await httpJson(
      config.port,
      "PUT",
      "/v1/printers",
      device,
      {
        printerId: "prn_forbidden",
        displayName: "Nope",
        connectionType: "MOCK",
      }
    );
    assert(devicePrinter.status === 403, "device cannot register printers");

    const adminPrinter = await httpJson(
      config.port,
      "PUT",
      "/v1/printers",
      admin,
      {
        printerId: "prn_admin_ok",
        displayName: "Admin OK",
        connectionType: "MOCK",
      }
    );
    assert(adminPrinter.status === 200, "admin can register printers");

    const anyJob = listPrintJobs()[0];
    const deviceReprint = await httpJson(
      config.port,
      "POST",
      `/v1/print-jobs/${anyJob.job_id}/reprint`,
      device
    );
    assert(deviceReprint.status === 403, "device cannot reprint");

    const health = await httpJson(config.port, "GET", "/health");
    assert(health.status === 200 && health.json.ok === true, "health ok");
    assert(health.json.lanAccessReady === false, "LAN not ready");
    assert(health.json.tlsReady === false, "TLS not ready");

    process.env.GTCT_LOCAL_HOST = "0.0.0.0";
    process.env.GTCT_ALLOW_LAN_BIND = "true";
    process.env.GTCT_ALLOW_DEV_TOKEN = "true";
    delete process.env.GTCT_LOCAL_API_TOKEN;
    delete process.env.GTCT_LOCAL_ADMIN_TOKEN;
    let lanBlocked = false;
    try {
      loadConfig({ mode: "http" });
    } catch {
      lanBlocked = true;
    }
    assert(lanBlocked, "LAN + well-known dev tokens must be rejected");

    pass("http-auth-admin-lan-guards");

    // restore loopback env for concurrent HTTP test
    process.env.GTCT_LOCAL_HOST = "127.0.0.1";
    delete process.env.GTCT_ALLOW_LAN_BIND;
    process.env.GTCT_ALLOW_DEV_TOKEN = "true";
    config = loadConfig({ mode: "http" });

    const concurrentBody = {
      orderNumber: "TEST-CONCURRENT",
      orderType: "TAKEAWAY",
      destination: "Counter 9",
      lines: SAMPLE_LINES,
    };
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () =>
        httpJson(
          config.port,
          "POST",
          "/v1/test-orders",
          device,
          concurrentBody
        )
      )
    );
    assert(
      concurrent.every((r) => r.status === 200 || r.status === 201),
      "concurrent submissions succeed"
    );
    const createdFlags = concurrent.filter((r) => r.json?.created).length;
    assert(
      createdFlags === 1,
      `exactly one create expected among concurrent HTTP, got ${createdFlags}`
    );
    const orderIds = new Set(concurrent.map((r) => r.json.order.order_id));
    assert(orderIds.size === 1, "all concurrent HTTP calls share one order_id");
    const jobCount = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM print_jobs WHERE order_id = ?`)
      .get([...orderIds][0]).c;
    assert(jobCount === 4, `concurrent order job count 4, got ${jobCount}`);
    pass("idempotency-concurrent-http");
  } catch (err) {
    fail("http-security-or-concurrent", err);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
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
