/**
 * Phase 2.3B — sales order types and order-specific delivery charges.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openRoleSessions } from "./testHttp.js";
import { openDatabase, closeDatabase, runMigrations, getDb } from "../db/db.js";
import { seedSampleData } from "../seed/sampleData.js";
import { createServer } from "../http/server.js";
import { initLogger, log } from "../util/logger.js";
import { getOrder } from "../services/orders.js";
import { mulDivRoundHalfUp } from "../services/tax.js";
import { withSubmissionId } from "./orderRequest.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function httpJson(port, method, pathName, token, body) {
  const payload = body == null ? null : JSON.stringify(withSubmissionId(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method,
        headers: {
          Accept: "application/json",
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
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { raw: text };
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
    results.push({ name, ok: false, error: String(err?.message || err) });
    log.error(`FAIL ${name}`, { error: String(err?.message || err) });
  };

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
    const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
    assert(!html.includes(">Dine in</option>"), "hardcoded dine-in option removed");
    assert(html.includes('id="fulfillment-fields"'), "conditional fields");
    assert(app.includes("deliveryFeeOverride"), "explicit override flag");
    assert(app.includes("Custom delivery charge"), "custom fee label");
    assert(app.includes("reset the delivery charge"), "block change confirms a manual fee");
    assert(!app.includes("canAdjustBasePrices") || app.includes("deliveryFeeOverride"), "fee edit is separate");
    const ordersSrc = fs.readFileSync(path.join(root, "src/services/orders.js"), "utf8");
    const feeAt = ordersSrc.indexOf("deliveryFeeOverride");
    const feeWindow = ordersSrc.slice(feeAt, feeAt + 700);
    assert(feeAt > 0 && !feeWindow.includes("canAdjustBasePrices"), "delivery fee does not use base-price permission");
    pass("sales-markup");
  } catch (err) {
    fail("sales-markup", err);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-phase23b-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18825";
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;
  delete process.env.GTCT_LOCAL_ADMIN_TOKEN;
  delete process.env.GTCT_LOCAL_API_TOKEN;

  const config = loadConfig({ mode: "http" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedSampleData(config);
  const server = createServer(config);
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const port = config.port;
  const sessions = await openRoleSessions(port, config.testTenantId);
  const admin = sessions.admin;
  const device = sessions.device;
  const cashierDeviceId = sessions.cashierDeviceId;

  let deliveryCustomerId = "";
  const order = (token, body) => {
    const next = body && typeof body === "object" ? { ...body } : body;
    if (next && next.orderType === "DELIVERY") {
      next.fulfillment = {
        customerId: deliveryCustomerId,
        ...(body.fulfillment || {}),
      };
    }
    return httpJson(port, "POST", "/v1/test-orders", token, next);
  };

  try {
    const menu = await httpJson(port, "GET", "/v1/menu-items?includeInactive=0", device);
    const item = (menu.json.menuItems || []).find((row) => row.is_active);
    assert(item?.item_id, "menu item");
    const line = { itemId: item.item_id, quantity: 1, instructions: ["No onion"] };
    const goods = Number(item.price_cents);
    const taxableGoods =
      item.taxApplicable === false || item.tax_applicable === 0 ? 0 : goods;
    const tax = mulDivRoundHalfUp(taxableGoods, 1000, 10000);
    let carBlank = null;
    let auto = null;
    let editedOrder = null;
    let autoOrder = null;
    let master = null;

    const currency = await httpJson(port, "PUT", "/v1/shop-settings", admin, {
      currencyCode: "BHD",
      currencyLabel: "BHD",
      currencyDecimals: 3,
      confirmCurrencyChange: true,
      taxEnabled: true,
      taxMode: "exclusive",
      taxRatePercent: "10",
      taxName: "VAT",
    });
    assert(currency.status === 200, currency.json?.error || "currency");

    try {
      const counter = await order(device, {
        orderNumber: "P23B-COUNTER",
        orderType: "COUNTER",
        destination: "Front",
        lines: [line],
      });
      assert(counter.status === 201, counter.json?.error || "counter");
      const counterOrder = getOrder(counter.json.order.order_id);
      assert(counterOrder.order_type === "COUNTER", "counter code");
      assert(counterOrder.fulfillment_behavior === "COUNTER", "counter behavior");
      assert(Number(counterOrder.delivery_charge_cents) === 0, "counter has no fee");

      const takeaway = await order(device, {
        orderNumber: "P23B-TAKEAWAY",
        orderType: "TAKEAWAY",
        fulfillment: { customerName: "Sara", customerPhone: "33001122" },
        lines: [line],
      });
      assert(takeaway.status === 201, takeaway.json?.error || "takeaway");
      const takeawayOrder = getOrder(takeaway.json.order.order_id);
      assert(takeawayOrder.customer_name === "Sara", "takeaway name");
      assert(takeawayOrder.destination.includes("Sara"), "takeaway destination");

      const missingTable = await order(device, {
        orderNumber: "P23B-TABLE-BAD",
        orderType: "DINE_IN",
        fulfillment: {},
        lines: [line],
      });
      assert(missingTable.status === 400, "table number required");
      const table = await order(device, {
        orderNumber: "P23B-TABLE",
        orderType: "DINE_IN",
        fulfillment: { tableNumber: "4" },
        lines: [line],
      });
      assert(table.status === 201, table.json?.error || "table");
      assert(getOrder(table.json.order.order_id).table_number === "4", "table saved");
      assert(getOrder(table.json.order.order_id).fulfillment_behavior === "TABLE", "dine-in is table");

      carBlank = await order(device, {
        orderNumber: "P23B-CAR-BLANK",
        orderType: "CAR_HOP",
        fulfillment: { vehicleNumber: "", parkingLocation: "" },
        lines: [line],
      });
      assert(carBlank.status === 201, carBlank.json?.error || "car hop blank");
      const blankCar = getOrder(carBlank.json.order.order_id);
      assert(!blankCar.vehicle_number, "vehicle optional");
      assert(!blankCar.destination, "no placeholder vehicle");
      const carSaved = await order(device, {
        orderNumber: "P23B-CAR-VEHICLE",
        orderType: "CAR_HOP",
        fulfillment: { vehicleNumber: "12345", parkingLocation: "Bay 2" },
        lines: [line],
      });
      assert(carSaved.status === 201, "car hop with vehicle");
      const savedCar = getOrder(carSaved.json.order.order_id);
      assert(savedCar.vehicle_number === "12345", "vehicle saved");
      assert(savedCar.parking_location === "Bay 2", "parking saved");
      pass("counter-and-takeaway-table-carhop");
    } catch (err) {
      fail("counter-and-takeaway-table-carhop", err);
    }

    try {
      const savedCustomer = await httpJson(port, "POST", "/v1/customers", device, {
        name: "Nora",
        phone: "33001122",
        blockNumber: "321",
      });
      assert(savedCustomer.status === 201, savedCustomer.json?.error || "delivery customer");
      deliveryCustomerId = savedCustomer.json.customer.customerId;
      const noBlock = await order(device, {
        orderNumber: "P23B-NOBLOCK",
        orderType: "DELIVERY",
        fulfillment: { deliveryChargeCents: 0, deliveryFeeOverride: false },
        lines: [line],
      });
      assert(noBlock.status === 400, "block required");
      const unknown = await order(device, {
        orderNumber: "P23B-UNKNOWN",
        orderType: "DELIVERY",
        fulfillment: {
          blockNumber: "NOPE",
          deliveryChargeCents: 0,
          deliveryFeeOverride: false,
        },
        lines: [line],
      });
      assert(unknown.status === 400, "unlisted block needs an explicit fee");

      await httpJson(port, "PUT", "/v1/block-delivery-rates", admin, {
        blockNumber: "321",
        chargeCents: 300,
        isActive: true,
      });
      await httpJson(port, "PUT", "/v1/block-delivery-rates", admin, {
        blockNumber: "000",
        chargeCents: 0,
        isActive: true,
      });
      const inactive = await httpJson(port, "PUT", "/v1/block-delivery-rates", admin, {
        blockNumber: "999",
        chargeCents: 500,
        isActive: false,
      });
      assert(inactive.status === 200, "inactive rate saved");

      const anon = await order(null, {
        orderNumber: "P23B-ANON",
        orderType: "DELIVERY",
        fulfillment: {
          blockNumber: "321",
          deliveryChargeCents: 100,
          deliveryFeeOverride: true,
          expectedBlockRateCents: 300,
        },
        lines: [line],
      });
      assert(anon.status === 401, "anonymous rejected");

      const negative = await order(device, {
        orderNumber: "P23B-NEG",
        orderType: "DELIVERY",
        fulfillment: {
          blockNumber: "321",
          deliveryChargeCents: -100,
          deliveryFeeOverride: true,
          expectedBlockRateCents: 300,
        },
        lines: [line],
      });
      assert(negative.status === 400, "negative fee");
      const fractional = await order(device, {
        orderNumber: "P23B-FRAC",
        orderType: "DELIVERY",
        fulfillment: {
          blockNumber: "321",
          deliveryChargeCents: 1.5,
          deliveryFeeOverride: true,
          expectedBlockRateCents: 300,
        },
        lines: [line],
      });
      assert(fractional.status === 400, "non-integer fee");
      const deadBlock = await order(device, {
        orderNumber: "P23B-INACTIVE",
        orderType: "DELIVERY",
        fulfillment: {
          blockNumber: "999",
          deliveryChargeCents: 500,
          deliveryFeeOverride: false,
          expectedBlockRateCents: 500,
        },
        lines: [line],
      });
      assert(deadBlock.status === 400, "inactive block");

      auto = await order(device, {
        orderNumber: "P23B-AUTO",
        orderType: "DELIVERY",
        fulfillment: {
          blockNumber: "321",
          customerName: "Nora",
          buildingNumber: "12",
          roadNumber: "58",
          deliveryChargeCents: 300,
          deliveryFeeOverride: false,
          expectedBlockRateCents: 300,
        },
        lines: [line],
      });
      assert(auto.status === 201, auto.json?.error || "auto delivery");
      autoOrder = getOrder(auto.json.order.order_id);
      assert(autoOrder.delivery_charge_cents === 300, "configured fee applied");
      assert(autoOrder.configured_delivery_cents === 300, "rate snapshot");
      assert(autoOrder.delivery_fee_override === 0, "not an override");
      assert(autoOrder.block_number === "321", "block snapshot");
      assert(autoOrder.delivery_fee_tax_treatment === "not_applied", "fee not taxed");
      assert(autoOrder.goods_cents === goods, "items total excludes fee");
      assert(autoOrder.tax_cents === tax, `tax stays on items ${autoOrder.tax_cents}!=${tax}`);
      assert(autoOrder.total_cents === goods + tax + 300, "customer total adds untaxed fee");

      const stale = await order(device, {
        orderNumber: "P23B-STALE",
        orderType: "DELIVERY",
        fulfillment: {
          blockNumber: "321",
          deliveryChargeCents: 200,
          deliveryFeeOverride: false,
          expectedBlockRateCents: 200,
        },
        lines: [line],
      });
      assert(stale.status === 409 && stale.json.code === "DELIVERY_RATE_CHANGED", "stale rate rejected");
      assert(stale.json.configuredChargeCents === 300, "new suggested rate returned");

      const edited = await order(device, {
        orderNumber: "P23B-EDIT",
        orderType: "DELIVERY",
        fulfillment: {
          blockNumber: "321",
          deliveryChargeCents: 100,
          deliveryFeeOverride: true,
          expectedBlockRateCents: 300,
        },
        customerTotalCents: goods + tax + 100,
        lines: [line],
      });
      assert(edited.status === 201, edited.json?.error || "staff override");
      editedOrder = getOrder(edited.json.order.order_id);
      assert(editedOrder.delivery_charge_cents === 100, "override saved");
      assert(editedOrder.configured_delivery_cents === 300, "master snapshot kept");
      assert(editedOrder.created_by_role === "cashier", "operator role");
      assert(editedOrder.created_by_device_id === cashierDeviceId, "operator id");
      const lied = await order(device, {
        orderNumber: "P23B-LIE",
        orderType: "DELIVERY",
        fulfillment: {
          blockNumber: "321",
          deliveryChargeCents: 100,
          deliveryFeeOverride: true,
          expectedBlockRateCents: 300,
        },
        customerTotalCents: 1,
        lines: [line],
      });
      assert(lied.status === 400, "manipulated total rejected");

      const rates = await httpJson(port, "GET", "/v1/block-delivery-rates", device);
      master = rates.json.rates.find((row) => row.blockNumber === "321");
      assert(master.chargeCents === 300, "master rate unchanged");

      const again = await order(device, {
        orderNumber: "P23B-AGAIN",
        orderType: "DELIVERY",
        fulfillment: {
          blockNumber: "321",
          deliveryChargeCents: 300,
          deliveryFeeOverride: false,
          expectedBlockRateCents: 300,
        },
        lines: [line],
      });
      assert(again.status === 201, "next order uses master rate");
      assert(getOrder(again.json.order.order_id).delivery_charge_cents === 300, "fresh suggestion");

      const zero = await order(device, {
        orderNumber: "P23B-ZERO",
        orderType: "DELIVERY",
        fulfillment: {
          blockNumber: "000",
          deliveryChargeCents: 0,
          deliveryFeeOverride: false,
          expectedBlockRateCents: 0,
        },
        lines: [line],
      });
      assert(zero.status === 201, zero.json?.error || "zero rate");
      const zeroOrder = getOrder(zero.json.order.order_id);
      assert(zeroOrder.delivery_charge_cents === 0, "zero fee");
      assert(zeroOrder.total_cents === goods + tax, "zero fee does not change items tax");

      const audit = getDb()
        .prepare(
          `SELECT * FROM audit_events
           WHERE action = 'order.delivery_fee.override' AND entity_id = ?`
        )
        .all(editedOrder.order_id);
      assert(audit.length === 1, "one override audit");
      const detail = JSON.parse(audit[0].detail_json);
      assert(detail.configuredChargeCents === 300, "audit configured");
      assert(detail.appliedChargeCents === 100, "audit applied");
      assert(detail.differenceCents === -200, "audit difference");
      assert(detail.deviceId === cashierDeviceId, "audit operator");
      assert(!JSON.stringify(detail).includes("token"), "audit has no token");

      const retry = await order(device, {
        orderNumber: "P23B-EDIT",
        orderType: "DELIVERY",
        fulfillment: {
          blockNumber: "321",
          deliveryChargeCents: 50,
          deliveryFeeOverride: true,
          expectedBlockRateCents: 300,
        },
        lines: [line],
      });
      assert(retry.status === 409 && retry.json.code === "SUBMISSION_CONFLICT", "different fee rejected");
      assert(getOrder(editedOrder.order_id).delivery_charge_cents === 100, "retry keeps snapshot");
      const auditsAfter = getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_events
           WHERE action = 'order.delivery_fee.override' AND entity_id = ?`
        )
        .get(editedOrder.order_id).n;
      assert(auditsAfter === 1, "retry does not add another audit");

      const taxedRate = await httpJson(port, "PUT", "/v1/block-delivery-rates", admin, {
        blockNumber: "322",
        chargeCents: 300,
        taxApplicable: true,
        isActive: true,
      });
      assert(taxedRate.status === 200 && taxedRate.json.rate.taxApplicable === true, "block tax saved");
      const feeTax = mulDivRoundHalfUp(300, 1000, 10000);
      const taxed = await order(device, {
        orderNumber: "P23B-FEE-TAX",
        orderType: "DELIVERY",
        fulfillment: {
          blockNumber: "322",
          customerName: "Nora",
          buildingNumber: "12",
          roadNumber: "58",
          deliveryChargeCents: 300,
          deliveryFeeOverride: false,
          expectedBlockRateCents: 300,
        },
        lines: [line],
      });
      assert(taxed.status === 201, taxed.json?.error || "taxable delivery");
      const taxedOrder = getOrder(taxed.json.order.order_id);
      assert(taxedOrder.delivery_fee_tax_treatment === "added", "exclusive fee tax is added");
      assert(taxedOrder.tax_cents === tax + feeTax, "item tax plus fee tax");
      assert(
        taxedOrder.total_cents === goods + tax + 300 + feeTax,
        "customer total adds the fee tax"
      );
      assert(taxedOrder.goods_cents === goods, "fee stays out of the items total");

      const renamed = await httpJson(port, "PUT", "/v1/order-types", admin, {
        orderTypeId: "otype_delivery",
        name: "Home Delivery",
        behavior: "DELIVERY",
        isActive: true,
      });
      assert(renamed.status === 200, "rename type");
      assert(getOrder(autoOrder.order_id).order_type_name === "Delivery", "old name snapshot");
      const repriced = await httpJson(port, "PUT", "/v1/block-delivery-rates", admin, {
        rateId: master.rateId,
        blockNumber: "321",
        chargeCents: 450,
        isActive: true,
      });
      assert(repriced.status === 200, "edit master");
      assert(getOrder(autoOrder.order_id).configured_delivery_cents === 300, "old rate snapshot");
      assert(getOrder(autoOrder.order_id).total_cents === goods + tax + 300, "old total frozen");

      const jobs = auto.json.jobs || [];
      const cashier = jobs.find((job) => job.job_type === "CASHIER");
      const kitchen = jobs.find((job) => job.job_type === "KITCHEN");
      assert(cashier && kitchen, "tickets queued");
      const cashierText = await httpJson(
        port,
        "GET",
        `/v1/print-jobs/${encodeURIComponent(cashier.job_id)}/preview`,
        device
      );
      assert(/Delivery charge/i.test(cashierText.json.text), "receipt fee line");
      assert(/Nora|BLOCK: 321|Block 321/i.test(cashierText.json.text), "receipt address");
      const kitchenText = await httpJson(
        port,
        "GET",
        `/v1/print-jobs/${encodeURIComponent(kitchen.job_id)}/preview`,
        device
      );
      assert(/BLOCK: 321/i.test(kitchenText.json.text), "kitchen block");
      assert(!/Delivery charge/i.test(kitchenText.json.text), "kitchen omits fee");
      const carTextJob = (carBlank.json.jobs || []).find((job) => job.job_type === "KITCHEN");
      const carText = await httpJson(
        port,
        "GET",
        `/v1/print-jobs/${encodeURIComponent(carTextJob.job_id)}/preview`,
        device
      );
      assert(!/VEHICLE:/i.test(carText.json.text), "blank vehicle is not printed");

      const dispatched = await httpJson(port, "POST", "/v1/dispatch/run", admin);
      assert(dispatched.status === 200, "mock dispatch");
      assert(
        dispatched.json.processed.some((row) => row.status === "DISPATCHED"),
        "mock printer dispatched"
      );
      pass("delivery-fee-tax-receipts");
    } catch (err) {
      fail("delivery-fee-tax-receipts", err);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const failed = results.filter((row) => !row.ok);
  log.info(`phase 2.3b ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
