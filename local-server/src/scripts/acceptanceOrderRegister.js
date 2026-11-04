/**
 * Read-only order register and delivery grouping.
 * Uses a temporary database only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger } from "../util/logger.js";
import { createServer } from "../http/server.js";
import { seedSampleData } from "../seed/sampleData.js";
import { httpJson, openRoleSessions } from "./testHttp.js";
import { renderKitchenTicket, renderCashierReceipt } from "../print/ticketFormat.js";

const PORT = 19002;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const results = [];

function pass(name) {
  results.push(name);
  console.log(`PASS ${name}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

function listen(server, config) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
}

function snapshot(orderId) {
  return getDb()
    .prepare(
      `SELECT order_number, status, total_cents, tax_cents, goods_cents,
              delivery_charge_cents, block_number, road_number, building_number,
              address_note, address_label, currency_code, updated_at
       FROM orders WHERE order_id = ?`
    )
    .get(orderId);
}

function counts(orderId) {
  const db = getDb();
  return {
    jobs: db.prepare(`SELECT COUNT(*) AS n FROM print_jobs WHERE order_id = ?`).get(orderId).n,
    settlements: db.prepare(`SELECT COUNT(*) AS n FROM order_settlements WHERE order_id = ?`).get(orderId).n,
  };
}

function cloneOrder(sourceId, patch) {
  const row = getDb().prepare(`SELECT * FROM orders WHERE order_id = ?`).get(sourceId);
  const next = { ...row, ...patch };
  const cols = Object.keys(next);
  getDb()
    .prepare(`INSERT INTO orders (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .run(...cols.map((col) => next[col]));
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-order-register-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = String(PORT);
  delete process.env.GTCT_TLS_CERT_FILE;
  delete process.env.GTCT_TLS_KEY_FILE;
  delete process.env.GTCT_ALLOW_LAN_BIND;
  delete process.env.GTCT_ENABLE_LAN_LISTENER;
  delete process.env.GTCT_LAN_BIND_ADDRESS;
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;

  const config = loadConfig({ mode: "http" });
  assert(config.host === "127.0.0.1" && config.physicalPrintEnabled === false, "safety flags");
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedSampleData(config);
  const server = createServer(config);
  await listen(server, config);

  try {
    const staffAuth = fs.readFileSync(path.join(root, "src/services/staffAuth.js"), "utf8");
    const staffUsers = fs.readFileSync(path.join(root, "src/services/staffUsers.js"), "utf8");
    const deviceBlock = staffAuth.slice(staffAuth.indexOf("DEVICE_PERMISSIONS"), staffAuth.indexOf("function"));
    assert(!deviceBlock.includes("sales.orders.view"), "device can view the order register");
    assert(!staffUsers.includes("sales.orders.view"), "cashiers can be granted order viewing as an extra");
    const ordersHtml = fs.readFileSync(path.join(root, "public/orders.html"), "utf8");
    const ordersCss = fs.readFileSync(path.join(root, "public/orders.css"), "utf8");
    const salesHtml = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
    const salesJs = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
    const ordersPage = fs.readFileSync(path.join(root, "public/orders.js"), "utf8");
    assert(salesHtml.includes('href="/orders.html"'), "sales navigation");
    assert(salesHtml.includes('id="payment-edit"'), "payment edit");
    assert(ordersPage.includes("data-edit"), "orders list edit");
    assert(salesJs.includes('permissions.includes("sales.orders.view")'), "sales link permission");
    assert(ordersHtml.includes("order-detail") && ordersCss.includes("max-width: 800px"), "orders layout");
    pass("ui-contract");

    const sessions = await openRoleSessions(PORT, config.testTenantId);
    const admin = sessions.admin;
    const cashier = sessions.device;
    const line = { itemId: "item_orange_juice", quantity: 1 };

    for (const blockNumber of ["2", "10"]) {
      const rate = await httpJson(PORT, "PUT", "/v1/block-delivery-rates", admin, {
        blockNumber,
        chargeCents: 250,
        taxApplicable: false,
        isActive: true,
      });
      assert(rate.status === 200, rate.json?.error || "block rate");
    }

    async function customer(name, phone, address) {
      const created = await httpJson(PORT, "POST", "/v1/customers", admin, {
        name,
        phone,
        label: address.label,
        buildingNumber: address.buildingNumber,
        roadNumber: address.roadNumber,
        blockNumber: address.blockNumber,
        addressNote: address.addressNote,
      });
      assert(created.status === 201, created.json?.error || name);
      return created.json.customer;
    }

    const home = await customer("Noor Ali", "55001001", {
      label: "Home",
      buildingNumber: "2",
      roadNumber: "2",
      blockNumber: "2",
      addressNote: "House 2",
    });
    const officeOwner = await customer("Latif Office", "55001002", {
      label: "Office",
      buildingNumber: "10",
      roadNumber: "2",
      blockNumber: "2",
      addressNote: "Office 10",
    });
    const far = await customer("Huda Far", "55001003", {
      label: "Home",
      buildingNumber: "4",
      roadNumber: "10",
      blockNumber: "10",
      addressNote: "Flat 4",
    });

    async function deliver(number, person, address) {
      const saved = (person.addresses || []).find((row) => row.label === address.label) || person.addresses[0];
      const created = await httpJson(PORT, "POST", "/v1/test-orders", admin, {
        orderNumber: number,
        orderType: "DELIVERY",
        fulfillment: {
          customerId: person.customerId,
          addressId: saved.addressId,
          blockNumber: address.blockNumber,
          roadNumber: address.roadNumber,
          buildingNumber: address.buildingNumber,
          addressNote: address.addressNote,
          deliveryChargeCents: 250,
          expectedBlockRateCents: 250,
        },
        lines: [line],
      });
      assert(created.status === 201, created.json?.error || number);
      return created.json.order;
    }

    const first = await deliver("REG-B2-R2-H2", home, {
      label: "Home",
      blockNumber: "2",
      roadNumber: "2",
      buildingNumber: "2",
      addressNote: "House 2",
    });
    const second = await deliver("REG-B2-R2-B10", officeOwner, {
      label: "Office",
      blockNumber: "2",
      roadNumber: "2",
      buildingNumber: "10",
      addressNote: "Office 10",
    });
    const third = await deliver("REG-B10-R10-F4", far, {
      label: "Home",
      blockNumber: "10",
      roadNumber: "10",
      buildingNumber: "4",
      addressNote: "Flat 4",
    });
    const takeaway = await httpJson(PORT, "POST", "/v1/test-orders", cashier, {
      orderNumber: "REG-TAKEAWAY",
      orderType: "TAKEAWAY",
      fulfillment: { customerName: "Walk up", customerPhone: "55001999" },
      lines: [line],
    });
    assert(takeaway.status === 201, takeaway.json?.error || "takeaway");
    const dine = await httpJson(PORT, "POST", "/v1/test-orders", cashier, {
      orderNumber: "REG-TABLE",
      orderType: "DINE_IN",
      fulfillment: { tableNumber: "4" },
      lines: [line],
    });
    assert(dine.status === 201, dine.json?.error || "dine in");

    cloneOrder(first.order_id, {
      order_id: "order_legacy_incomplete",
      order_number: "REG-LEGACY",
      submission_id: null,
      block_number: "",
      road_number: "",
      building_number: "",
      address_note: "old free-text address",
      address_label: null,
      destination: "old free-text address",
    });
    cloneOrder(first.order_id, {
      order_id: "order_other_shop",
      tenant_id: "other-shop",
      order_number: "REG-OTHER",
      submission_id: null,
    });

    const before = snapshot(first.order_id);
    const listed = await httpJson(PORT, "GET", "/v1/order-register?behavior=DELIVERY&pageSize=40", admin);
    assert(listed.status === 200, listed.json?.error || "delivery list");
    const numbers = listed.json.orders.map((order) => order.orderNumber);
    assert(numbers.indexOf("REG-B2-R2-H2") < numbers.indexOf("REG-B2-R2-B10"), "building 2 before 10");
    assert(numbers.indexOf("REG-B2-R2-B10") < numbers.indexOf("REG-B10-R10-F4"), "block 2 before 10");
    assert(numbers.at(-1) === "REG-LEGACY", "incomplete address stays visible last");
    const groups = listed.json.deliveryGroups;
    assert(groups.blocks[0].blockNumber === "2", "first block");
    assert(groups.blocks[0].roads[0].roadNumber === "2", "first road");
    assert(groups.blocks[0].roads[0].buildings[0].buildingNumber === "2", "first building");
    assert(groups.blocks[0].roads[0].buildings[1].buildingNumber === "10", "second building");
    assert(groups.blocks[1].blockNumber === "10", "second block");
    assert(groups.blocks[1].roads[0].roadNumber === "10", "road 10");
    assert(groups.incomplete.some((order) => order.orderNumber === "REG-LEGACY"), "legacy group");
    assert(groups.incomplete[0].addressNote === "old free-text address", "legacy text kept");
    assert(!listed.json.orders.some((order) => order.orderNumber === "REG-OTHER"), "other shop hidden");
    assert(JSON.stringify(snapshot(first.order_id)) === JSON.stringify(before), "snapshot unchanged");
    assert(snapshot(first.order_id).delivery_charge_cents === before.delivery_charge_cents, "delivery fee unchanged");
    pass("delivery-grouping");

    const office = await httpJson(PORT, "GET", "/v1/order-register?behavior=DELIVERY&addressLabel=Office", admin);
    assert(office.json.orders.length === 1 && office.json.orders[0].orderNumber === "REG-B2-R2-B10", "address type");
    assert(office.json.orders[0].addressNote === "Office 10", "office detail");
    const found = await httpJson(PORT, "GET", "/v1/order-register?q=55001001", admin);
    assert(found.json.orders.some((order) => order.orderNumber === "REG-B2-R2-H2"), "phone search");
    const takeaways = await httpJson(PORT, "GET", "/v1/order-register?behavior=TAKEAWAY", admin);
    assert(takeaways.json.orders.every((order) => order.fulfillmentBehavior === "TAKEAWAY"), "takeaway filter");
    assert(takeaways.json.orderTypes.some((type) => type.behavior === "CAR_HOP"), "configured types");
    const day = before.updated_at.slice(0, 10);
    const dated = await httpJson(PORT, "GET", `/v1/order-register?date=${day}`, admin);
    assert(dated.json.total >= 4, "date filter includes today");
    const emptyDay = await httpJson(PORT, "GET", "/v1/order-register?date=2001-01-01", admin);
    assert(emptyDay.json.total === 0, "old date is empty");
    const page = await httpJson(PORT, "GET", "/v1/order-register?page=1&pageSize=1", admin);
    const page2 = await httpJson(PORT, "GET", "/v1/order-register?page=2&pageSize=1", admin);
    assert(page.json.total > 1 && page.json.orders.length === 1, "page size");
    assert(page2.json.orders[0].orderId !== page.json.orders[0].orderId, "second page");
    pass("filters-and-pages");

    const cash = await httpJson(PORT, "POST", `/v1/orders/${first.order_id}/settlements`, admin, {
      submissionId: "reg-cash-pay-01",
      tender: "CASH",
      amountCents: before.total_cents,
      currencyCode: before.currency_code,
    });
    assert(cash.status === 201, cash.json?.error || cash.json?.code || "cash");
    const account = await httpJson(PORT, "POST", "/v1/bank-accounts", admin, {
      displayName: "Main operating",
      bankName: "Qatar National Bank",
      accountType: "OPERATIONAL",
      isActive: true,
      reference: "1234",
    });
    assert(account.status === 201, account.json?.error || "bank account");
    const bankTotal = snapshot(second.order_id).total_cents;
    const bank = await httpJson(PORT, "POST", `/v1/orders/${second.order_id}/settlements`, admin, {
      submissionId: "reg-bank-pay-01",
      tender: "BANK",
      amountCents: bankTotal,
      currencyCode: before.currency_code,
      bankAccountId: account.json.account.accountId,
    });
    assert(bank.status === 201, bank.json?.error || bank.json?.code || "bank");

    const paidCounts = counts(first.order_id);
    const detail = await httpJson(PORT, "GET", `/v1/order-register/${first.order_id}`, cashier);
    assert(detail.status === 200, detail.json?.error || "detail");
    assert(detail.json.order.paymentStatus === "PAID" && detail.json.order.paymentTender === "CASH", "cash status");
    assert(detail.json.order.lines[0].itemName && detail.json.order.lines[0].quantity === 1, "frozen line");
    assert(detail.json.order.totalCents === before.total_cents, "stored total");
    assert(detail.json.order.addressLabel === "Home" && detail.json.order.addressNote === "House 2", "home snapshot");
    assert(detail.json.order.createdByName === "Test Admin", "staff creator");
    const bankDetail = await httpJson(PORT, "GET", `/v1/order-register/${second.order_id}`, admin);
    assert(bankDetail.json.order.paymentTender === "BANK" && bankDetail.json.order.bankAccountLabel.includes("Main operating"), "bank status");
    const unpaid = await httpJson(PORT, "GET", `/v1/order-register/${third.order_id}`, admin);
    assert(unpaid.json.order.paymentStatus === "UNPAID", "unpaid stays unpaid");
    assert(JSON.stringify(counts(first.order_id)) === JSON.stringify(paidCounts), "view did not print or pay");
    const afterView = snapshot(first.order_id);
    assert(afterView.total_cents === before.total_cents && afterView.address_label === "Home", "historical fields kept");
    const hidden = await httpJson(PORT, "GET", "/v1/order-register/order_other_shop", admin);
    assert(hidden.status === 404, "other shop detail");
    pass("payment-and-detail");

    const beforeEdit = snapshot(third.order_id);
    const jobsBefore = counts(third.order_id).jobs;
    const draft = await httpJson(PORT, "GET", `/v1/orders/${third.order_id}/edit-draft`, admin);
    assert(draft.status === 200 && draft.json.orderNumber === "REG-B10-R10-F4", draft.json?.error || "edit draft");
    assert(draft.json.lines[0].itemId === "item_orange_juice" && draft.json.lines[0].quantity === 1, "draft line");
    assert(counts(third.order_id).jobs === jobsBefore, "opening an edit does not print");
    const paidDraft = await httpJson(PORT, "GET", `/v1/orders/${first.order_id}/edit-draft`, admin);
    assert(paidDraft.status === 409 && paidDraft.json.code === "ORDER_ALREADY_PAID", "paid order stays locked");
    const saved = await httpJson(PORT, "POST", "/v1/test-orders", admin, {
      orderId: third.order_id,
      orderNumber: "SHOULD-NOT-CHANGE",
      submissionId: "reg-edit-third-01",
      orderType: "DELIVERY",
      fulfillment: {
        customerId: far.customerId,
        addressId: far.addresses[0].addressId,
        blockNumber: "10",
        roadNumber: "10",
        buildingNumber: "4",
        addressNote: "Flat 4",
        deliveryChargeCents: 250,
        expectedBlockRateCents: 250,
      },
      lines: [{ itemId: "item_orange_juice", quantity: 2 }],
    });
    assert(saved.status === 200 && saved.json.edited === true, saved.json?.error || saved.json?.code || "edit save");
    assert(saved.json.order.order_id === third.order_id, "same order");
    assert(saved.json.order.order_number === "REG-B10-R10-F4", "order number kept");
    const editedJobs = saved.json.jobs || [];
    const kitchenJob = editedJobs.find((job) => job.job_type === "KITCHEN");
    const cashierJob = editedJobs.find((job) => job.job_type === "CASHIER");
    assert(kitchenJob && cashierJob, "edit sends the preparation station and the cashier");
    const kitchenText = renderKitchenTicket(JSON.parse(kitchenJob.payload_snapshot));
    const cashierText = renderCashierReceipt(JSON.parse(cashierJob.payload_snapshot));
    assert(kitchenText.includes("ORDER UPDATED") && /2 × ORANGE JUICE/i.test(kitchenText), "kitchen receives the edited items");
    assert(cashierText.includes("ORDER UPDATED") && /ORANGE JUICE/i.test(cashierText), "cashier receives the edited order");
    const afterEdit = snapshot(third.order_id);
    assert(afterEdit.total_cents > beforeEdit.total_cents, "edited total");
    assert(afterEdit.address_note === "Flat 4" && afterEdit.block_number === "10", "address kept");
    assert(counts(third.order_id).jobs > jobsBefore, "updated ticket");
    assert(counts(third.order_id).settlements === 0, "edit did not pay");
    const jobsAfter = counts(third.order_id).jobs;
    const replay = await httpJson(PORT, "POST", "/v1/test-orders", admin, {
      orderId: third.order_id,
      submissionId: "reg-edit-third-01",
      orderType: "DELIVERY",
      fulfillment: {
        customerId: far.customerId,
        addressId: far.addresses[0].addressId,
        blockNumber: "10",
        roadNumber: "10",
        buildingNumber: "4",
        addressNote: "Flat 4",
        deliveryChargeCents: 250,
        expectedBlockRateCents: 250,
      },
      lines: [{ itemId: "item_orange_juice", quantity: 2 }],
    });
    assert(replay.status === 200 && replay.json.order.order_id === third.order_id, "edit replay");
    assert(counts(third.order_id).jobs === jobsAfter, "replay did not print again");
    const paidSave = await httpJson(PORT, "POST", "/v1/test-orders", admin, {
      orderId: first.order_id,
      submissionId: "reg-edit-paid-01",
      lines: [line],
    });
    assert(paidSave.status === 409 && paidSave.json.code === "ORDER_ALREADY_PAID", "paid save blocked");
    assert(snapshot(first.order_id).total_cents === before.total_cents, "paid total unchanged");
    pass("edit-unpaid-order");

    getDb()
      .prepare(
        `UPDATE staff_role_permissions
         SET revoked_at = ?
         WHERE role_id = 'role_cashier' AND permission_code = 'sales.orders.view'`
      )
      .run(new Date().toISOString());
    const denied = await httpJson(PORT, "GET", "/v1/order-register", cashier);
    assert(denied.status === 403, "cashier permission");
    const stillAdmin = await httpJson(PORT, "GET", "/v1/order-register?pageSize=1", admin);
    assert(stillAdmin.status === 200, "admin keeps access");
    const anon = await httpJson(PORT, "GET", "/v1/order-register", null);
    assert(anon.status === 401, "anonymous rejected");
    const write = await httpJson(PORT, "POST", "/v1/order-register", admin, { orderId: first.order_id });
    assert(write.status !== 200 && write.status !== 201, "register is read only");
    pass("permissions");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`order register ${results.length}`);
  if (results.length !== 6) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
