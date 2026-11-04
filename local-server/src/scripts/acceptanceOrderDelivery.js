/**
 * Order type and block delivery charge setup.
 * Does not change sales order totals.
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
import { formatMoneyMinor, parseMoneyInput } from "../util/money.js";
import { getOrder } from "../services/orders.js";
import { getShopSettings } from "../services/shopSettings.js";
import { listOrderTypes, listBlockRates } from "../services/orderSetup.js";
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
        res.on("data", (c) => chunks.push(c));
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
    const html = fs.readFileSync(path.join(root, "public/shop-settings.html"), "utf8");
    const ordersSrc = fs.readFileSync(path.join(root, "src/services/orders.js"), "utf8");
    const appSrc = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
    assert(html.includes("Order &amp; Delivery"), "settings tab");
    assert(html.includes('id="order-type-dialog"'), "order type dialog");
    assert(html.includes('id="block-rate-dialog"'), "block dialog");
    assert(ordersSrc.includes("resolveSaleFulfillment"), "sales resolves fulfillment on the server");
    assert(appSrc.includes("/v1/block-delivery-rates"), "sales reads block rates");
    assert(parseMoneyInput("0.200", 3) === 200, "0.200 → 200");
    assert(parseMoneyInput(".5", 3) === 500, ".5 → 500");
    let tooFine = false;
    try {
      parseMoneyInput("0.2000", 3);
    } catch {
      tooFine = true;
    }
    assert(tooFine, "extra decimals rejected");
    pass("setup-boundaries");
  } catch (err) {
    fail("setup-boundaries", err);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-order-delivery-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18824";
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
  const shopId = config.testTenantId;

  try {
    try {
      const listed = await httpJson(port, "GET", "/v1/order-types", admin);
      assert(listed.status === 200, "list types");
      const byCode = Object.fromEntries(
        (listed.json.orderTypes || []).map((row) => [row.code, row])
      );
      assert(byCode.TAKEAWAY?.behavior === "TAKEAWAY", "takeaway kept");
      assert(byCode.DINE_IN?.behavior === "TABLE", "dine-in maps to table");
      assert(byCode.DINE_IN?.name === "Dine in", "dine-in display name");
      assert(listed.json.deliveryChargeTax?.perBlock === true, "fee tax is set per block");
      const emptyRates = await httpJson(port, "GET", "/v1/block-delivery-rates", admin);
      assert(emptyRates.status === 200 && emptyRates.json.rates.length === 0, "no seeded rates");

      const created = await httpJson(port, "PUT", "/v1/order-types", admin, {
        name: "Home Delivery",
        behavior: "DELIVERY",
        isActive: true,
      });
      assert(created.status === 200, `create type ${created.status}`);
      assert(created.json.orderType.code !== "Home Delivery", "code is not the display name");
      assert(created.json.orderType.behavior === "DELIVERY", "delivery behavior");
      assert(
        created.json.orderType.fieldRequirements.some((field) => field.key === "blockNumber"),
        "block field"
      );
      const typeId = created.json.orderType.orderTypeId;
      const code = created.json.orderType.code;

      const renamed = await httpJson(port, "PUT", "/v1/order-types", admin, {
        orderTypeId: typeId,
        name: "House Delivery",
        behavior: "DELIVERY",
        isActive: false,
      });
      assert(renamed.status === 200, "edit type");
      assert(renamed.json.orderType.orderTypeId === typeId, "same type id");
      assert(renamed.json.orderType.code === code, "code stable");
      assert(renamed.json.orderType.isActive === false, "deactivated");

      const ids = listed.json.orderTypes.map((row) => row.orderTypeId);
      ids.unshift(ids.pop());
      const reordered = await httpJson(port, "PUT", "/v1/order-types/reorder", admin, {
        orderTypeIds: [typeId, ...ids],
      });
      assert(reordered.status === 200, "reorder");
      assert(reordered.json.orderTypes[0].orderTypeId === typeId, "custom type first");
      pass("order-types");
    } catch (err) {
      fail("order-types", err);
    }

    try {
      const currency = await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        currencyCode: "BHD",
        currencyLabel: "BHD",
        currencyDecimals: 3,
        confirmCurrencyChange: true,
      });
      assert(currency.status === 200, `currency ${currency.status} ${currency.json?.error || ""}`);
      const shop = getShopSettings(shopId);
      assert(
        formatMoneyMinor(parseMoneyInput("0.200", shop.currencyDecimals), {
          currency_decimals: shop.currencyDecimals,
          currency_label: shop.currencyLabel,
        }) === "BHD 0.200",
        "bhd precision"
      );

      const zero = await httpJson(port, "PUT", "/v1/block-delivery-rates", admin, {
        blockNumber: "000",
        chargeCents: 0,
        isActive: true,
      });
      assert(zero.status === 200 && zero.json.rate.chargeCents === 0, "zero charge");

      const negative = await httpJson(port, "PUT", "/v1/block-delivery-rates", admin, {
        blockNumber: "999",
        chargeCents: -1,
      });
      assert(negative.status === 400, "negative rejected");

      const fractional = await httpJson(port, "PUT", "/v1/block-delivery-rates", admin, {
        blockNumber: "998",
        chargeCents: 1.5,
      });
      assert(fractional.status === 400, "non-integer rejected");

      const added = await httpJson(port, "PUT", "/v1/block-delivery-rates", admin, {
        blockNumber: "123",
        chargeCents: parseMoneyInput("0.200", 3),
        isActive: true,
      });
      assert(added.status === 200 && added.json.rate.chargeCents === 200, "block 123");
      const rateId = added.json.rate.rateId;

      const dup = await httpJson(port, "PUT", "/v1/block-delivery-rates", admin, {
        blockNumber: " 123 ",
        chargeCents: 300,
      });
      assert(dup.status === 409, "duplicate block");

      const edited = await httpJson(port, "PUT", "/v1/block-delivery-rates", admin, {
        rateId,
        blockNumber: "123",
        chargeCents: parseMoneyInput("0.300", 3),
        isActive: false,
      });
      assert(edited.status === 200, "edit rate");
      assert(edited.json.rate.rateId === rateId, "same rate id");
      assert(edited.json.rate.chargeCents === 300, "updated charge");
      assert(edited.json.rate.isActive === false, "rate inactive");

      const audits = getDb()
        .prepare(
          `SELECT detail_json FROM audit_events
           WHERE action = 'delivery_block.upsert' AND entity_id = ?`
        )
        .all(rateId)
        .map((row) => JSON.parse(row.detail_json));
      assert(
        audits.some((detail) => detail.chargeCents === 300 && detail.previousChargeCents === 200),
        "audit previous charge"
      );

      const denied = await httpJson(port, "PUT", "/v1/block-delivery-rates", device, {
        blockNumber: "456",
        chargeCents: 500,
      });
      assert(denied.status === 403, "device cannot write rates");
      const deniedType = await httpJson(port, "PUT", "/v1/order-types", device, {
        name: "Side door",
        behavior: "COUNTER",
      });
      assert(deniedType.status === 403, "device cannot write types");
      const anon = await httpJson(port, "PUT", "/v1/order-types", null, {
        name: "Side door",
        behavior: "COUNTER",
      });
      assert(anon.status === 401, "anonymous write rejected");
      pass("block-rates");
    } catch (err) {
      fail("block-rates", err);
    }

    try {
      const menu = await httpJson(port, "GET", "/v1/menu-items", admin);
      const item = (menu.json.menuItems || []).find((row) => row.is_active);
      assert(item?.item_id, "menu item");
      const created = await httpJson(port, "POST", "/v1/test-orders", admin, {
        orderNumber: `OD-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "",
        lines: [{ itemId: item.item_id, quantity: 1, instructions: [] }],
      });
      assert(created.status === 200 || created.status === 201, "order created");
      const before = getOrder(created.json.order.order_id);
      const takeaway = (await httpJson(port, "GET", "/v1/order-types", admin)).json.orderTypes.find(
        (row) => row.code === "TAKEAWAY"
      );
      const locked = await httpJson(port, "PUT", "/v1/order-types", admin, {
        orderTypeId: takeaway.orderTypeId,
        name: "Pickup",
        behavior: "COUNTER",
        isActive: true,
      });
      assert(locked.status === 409, "referenced behavior locked");
      const renamed = await httpJson(port, "PUT", "/v1/order-types", admin, {
        orderTypeId: takeaway.orderTypeId,
        name: "Pickup",
        behavior: "TAKEAWAY",
        isActive: true,
      });
      assert(renamed.status === 200 && renamed.json.orderType.code === "TAKEAWAY", "rename keeps code");
      const after = getOrder(before.order_id);
      assert(after.order_type === "TAKEAWAY", "historical order type unchanged");
      assert(after.total_cents === before.total_cents, "order total unchanged");
      pass("existing-orders");
    } catch (err) {
      fail("existing-orders", err);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
  }

  try {
    openDatabase(config.dbPath);
    const types = listOrderTypes(shopId);
    const rates = listBlockRates(shopId);
    assert(types.some((row) => row.name === "House Delivery" && row.code !== "House Delivery"), "type persisted");
    assert(types.some((row) => row.code === "DINE_IN"), "dine-in persisted");
    const block = rates.find((row) => row.blockNumber === "123");
    assert(block && block.chargeCents === 300 && block.isActive === false, "rate persisted");
    pass("persists-after-reopen");
  } catch (err) {
    fail("persists-after-reopen", err);
  } finally {
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const failed = results.filter((row) => !row.ok);
  log.info(`order delivery setup ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
