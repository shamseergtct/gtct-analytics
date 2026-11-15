/**
 * Essential auto-print verification (isolated TEST DB). Never sends physical jobs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { stampMigratedTestDatabase } from "../db/testStartup.js";
import { seedSampleData } from "../seed/sampleData.js";
import { createTestOrder } from "../services/orders.js";
import { enqueuePrintJobsForOrder } from "../services/printQueue.js";
import { processAllPending } from "../print/dispatcher.js";
import { updatePrintSettings, getPrintSettings } from "../services/printSettings.js";
import { settleCashPayment } from "../services/settlements.js";
import { createFirstAdmin } from "../services/staffAuth.js";
import { getShopSettings } from "../services/shopSettings.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-autoprint-"));
process.env.GTCT_OPERATING_MODE = "TEST";
process.env.GTCT_LOCAL_DATA_DIR = dir;
delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;

const config = loadConfig({ mode: "http" });
openDatabase(config.dbPath);
await runMigrations(getDb());
stampMigratedTestDatabase(getDb(), config);
seedSampleData(config);
getShopSettings(config.testTenantId);
createFirstAdmin({
  shopId: config.testTenantId,
  fullName: "Print Admin",
  username: "print.admin",
  password: "PrintAdmin1",
});
const admin = getDb()
  .prepare(`SELECT user_id FROM staff_users WHERE username_normalized = ?`)
  .get("print.admin");

const created = createTestOrder(
  {
    submissionId: "autoprint-order-001",
    orderType: "TAKEAWAY",
    printKitchen: true,
    printCashier: true,
    lines: [
      { itemId: "item_orange_juice", quantity: 1 },
      { itemId: "item_chicken_shawarma", quantity: 1 },
    ],
  },
  config,
  { role: "cashier", userId: admin.user_id }
);

const jobs1 = getDb()
  .prepare(`SELECT job_id, job_type, status, station_id, idempotency_key FROM print_jobs WHERE order_id = ?`)
  .all(created.order.order_id);
assert(jobs1.some((j) => j.job_type === "KITCHEN"), "kitchen jobs missing");
assert(jobs1.some((j) => j.job_type === "CASHIER"), "cashier bill missing before payment");
const kitchenCount = jobs1.filter((j) => j.job_type === "KITCHEN").length;
const prePayCashier = jobs1.filter((j) => j.job_type === "CASHIER").length;
assert(prePayCashier === 1, "expected one unpaid cashier bill");

// Idempotent re-enqueue should not duplicate
enqueuePrintJobsForOrder(created.order.order_id, 1, config, { includeCashier: false });
const jobs2 = getDb()
  .prepare(`SELECT COUNT(*) AS n FROM print_jobs WHERE order_id = ? AND job_type = 'KITCHEN'`)
  .get(created.order.order_id).n;
assert(jobs2 === kitchenCount, "duplicate kitchen jobs created");

const processed = await processAllPending(config, 20);
assert(processed.length >= 1, "dispatcher processed nothing");
assert(
  processed.every((r) => ["DISPATCHED", "FAILED", "NEEDS_REVIEW", "UNKNOWN"].includes(r.status)),
  "unexpected dispatch outcome"
);
const afterDispatch = getDb()
  .prepare(
    `SELECT status, last_error FROM print_jobs WHERE order_id = ? AND job_type = 'KITCHEN'`
  )
  .all(created.order.order_id);
assert(
  afterDispatch.every((j) => j.status !== "PENDING"),
  "kitchen jobs still pending after dispatch"
);

// Payment should enqueue exactly one cashier receipt
// Simulate single-printer shop: remove CASHIER station assignment only.
getDb().prepare(`DELETE FROM station_printers WHERE station_id = 'station_cashier'`).run();

const pay = settleCashPayment(
  {
    orderId: created.order.order_id,
    submissionId: "pay-autoprint-001",
    tender: "CASH",
    amountCents: Number(created.order.total_cents),
    currencyCode: created.order.currency_code,
  },
  config,
  { role: "cashier", userId: admin.user_id }
);
assert(pay.created === true, "payment not created");
assert(pay.cashierPrint?.ok === true, `cashier paid receipt failed: ${pay.cashierPrint?.error}`);
const cashierJobs = getDb()
  .prepare(
    `SELECT job_id, status, printer_id, idempotency_key FROM print_jobs WHERE order_id = ? AND job_type = 'CASHIER'`
  )
  .all(created.order.order_id);
assert(cashierJobs.length === 2, `expected unpaid+paid cashier jobs, got ${cashierJobs.length}`);
assert(
  cashierJobs.some((j) => String(j.idempotency_key).includes("::paid::")),
  "paid cashier receipt missing"
);

const { clearPrintJobHistory } = await import("../services/printQueue.js");
const pendingBeforeClear = getDb()
  .prepare(
    `SELECT COUNT(*) AS n FROM print_jobs WHERE order_id = ? AND status = 'PENDING'`
  )
  .get(created.order.order_id).n;
const cleared = clearPrintJobHistory(config.testTenantId);
assert(cleared.cleared >= 1, "history clear removed no finished jobs");
const stillPending = getDb()
  .prepare(
    `SELECT COUNT(*) AS n FROM print_jobs WHERE order_id = ? AND status = 'PENDING'`
  )
  .get(created.order.order_id).n;
assert(stillPending === pendingBeforeClear, "clear history must keep PENDING jobs");

// Settings: enable auto physical and hold a fresh pre-enable pending job
const holdJobId = "job_hold_autoprint_test";
const holdCreatedAt = "2020-01-01T00:00:00.000Z";
getDb()
  .prepare(
    `INSERT INTO print_jobs (
       job_id, tenant_id, order_id, station_id, printer_id, ticket_revision, job_type,
       status, idempotency_key, payload_snapshot, attempt_count, is_reprint, created_at, updated_at
     ) VALUES (?, ?, ?, 'station_cashier', ?, 99, 'CASHIER', 'PENDING', ?, '{}', 0, 0, ?, ?)`
  )
  .run(
    holdJobId,
    config.testTenantId,
    created.order.order_id,
    cashierJobs[0].printer_id,
    `hold-test::${holdJobId}`,
    holdCreatedAt,
    holdCreatedAt
  );
const beforeEnable = getPrintSettings();
assert(beforeEnable.autoPhysicalPrintEnabled === false, "auto print should start off");
const updated = updatePrintSettings(
  { autoPhysicalPrintEnabled: true },
  { role: "admin", userId: admin.user_id }
);
assert(updated.autoPhysicalPrintEnabled === true, "auto print not enabled");
assert(updated.heldPendingJobs >= 1, "pre-enable PENDING jobs were not held");
const held = getDb()
  .prepare(`SELECT status, last_error FROM print_jobs WHERE job_id = ?`)
  .get(holdJobId);
assert(held?.status === "NEEDS_REVIEW", "held job status wrong");
assert(/before automatic physical printing/i.test(held.last_error || ""), "hold reason missing");

// Isolation: no production identity
const identity = getDb()
  .prepare(`SELECT value FROM meta WHERE key = 'gtct.database.identity.v1'`)
  .get();
assert(JSON.parse(identity.value).operatingMode === "TEST", "TEST identity broken");

closeDatabase();
fs.rmSync(dir, { recursive: true, force: true });
console.log(
  JSON.stringify({
    ok: true,
    kitchenJobs: kitchenCount,
    noDuplicateKitchen: true,
    cashierBillBeforePayment: true,
    cashierPaidReceiptAfterPayment: true,
    heldBeforeAutoEnable: updated.heldPendingJobs,
    dataDir: dir,
  })
);
