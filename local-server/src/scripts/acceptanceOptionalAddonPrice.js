/**
 * Optional add-on price: blank library price, item price, or price entered at sale.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openRoleSessions } from "./testHttp.js";
import { openDatabase, closeDatabase, runMigrations, getDb } from "../db/db.js";
import { seedSampleData } from "../seed/sampleData.js";
import { createServer } from "../http/server.js";
import { initLogger, log } from "../util/logger.js";
import { getOrder } from "../services/orders.js";
import { listAuditEvents } from "../services/audit.js";
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

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-addon-price-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18822";
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;
  delete process.env.GTCT_LOCAL_ADMIN_TOKEN;
  delete process.env.GTCT_LOCAL_API_TOKEN;

  const config = loadConfig({ mode: "http" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedSampleData(config);

  const priceCol = getDb()
    .prepare(`PRAGMA table_info(addons)`)
    .all()
    .find((c) => c.name === "price_cents");
  assert(priceCol && priceCol.notnull === 0, "addons.price_cents is nullable");

  const server = createServer(config);
  await new Promise((resolve) =>
    server.listen(config.port, config.host, resolve)
  );
  const port = config.port;
  const sessions = await openRoleSessions(port, config.testTenantId);
  const admin = sessions.admin;
  const device = sessions.device;

  try {
    let unsetId;
    let freeId;
    let pricedId;
    let itemUnset;
    let itemPriced;
    let itemFree;

    try {
      const unset = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Double Burger Open",
        priceCents: null,
      });
      assert(unset.status === 200, `blank save ${unset.status} ${JSON.stringify(unset.json)}`);
      assert(unset.json.addon.priceCents === null, "blank stored as null");
      assert(unset.json.addon.priceUnset === true, "blank is unset");
      assert(unset.json.addon.isFree === false, "blank is not free");
      unsetId = unset.json.addon.addonId;

      const omitted = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Sauce Later",
      });
      assert(omitted.status === 200, "omitted price saved");
      assert(omitted.json.addon.priceCents === null, "omitted price is null");

      const free = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Napkin",
        priceCents: 0,
      });
      assert(free.json.addon.priceCents === 0, "zero stays zero");
      assert(free.json.addon.priceUnset === false, "zero is set");
      assert(free.json.addon.isFree === true, "zero is free");
      freeId = free.json.addon.addonId;

      const priced = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Cheese Slice",
        priceCents: 300,
      });
      assert(priced.json.addon.priceCents === 300, "priced addon");
      pricedId = priced.json.addon.addonId;

      const kept = await httpJson(port, "PUT", "/v1/addons", admin, {
        addonId: unsetId,
        name: "Double Burger Open",
        isActive: true,
      });
      assert(kept.json.addon.priceCents === null, "update without price keeps null");
      pass("library-blank-zero-and-priced");
    } catch (err) {
      fail("library-blank-zero-and-priced", err);
    }

    try {
      const blankItem = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        name: "Open Price Burger",
        priceCents: 1000,
        category: "Food",
        addonAssignments: [
          { addonId: unsetId, priceOverrideCents: null },
          { addonId: freeId, priceOverrideCents: null },
        ],
      });
      assert(blankItem.status === 200, `item ${blankItem.status} ${JSON.stringify(blankItem.json)}`);
      itemUnset = blankItem.json.menuItem.item_id;
      const open = blankItem.json.menuItem.addons.find((a) => a.addonId === unsetId);
      assert(open.priceUnset === true, "item inherits unset");
      assert(open.effectivePriceCents === null, "no effective price");
      const napkin = blankItem.json.menuItem.addons.find((a) => a.addonId === freeId);
      assert(napkin.effectivePriceCents === 0, "free library price");
      assert(napkin.priceUnset === false, "free is set");

      const pricedItem = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        name: "Item Priced Extra",
        priceCents: 1000,
        category: "Food",
        addonAssignments: [
          { addonId: unsetId, priceOverrideCents: 450 },
          { addonId: pricedId, priceOverrideCents: null },
        ],
      });
      assert(pricedItem.status === 200, "priced item saved");
      itemPriced = pricedItem.json.menuItem.item_id;
      const specific = pricedItem.json.menuItem.addons.find((a) => a.addonId === unsetId);
      assert(specific.effectivePriceCents === 450, "item price wins");
      assert(specific.priceUnset === false, "item price is set");
      const cheese = pricedItem.json.menuItem.addons.find((a) => a.addonId === pricedId);
      assert(cheese.effectivePriceCents === 300, "library price used");

      const freeItem = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        name: "Free Extra Item",
        priceCents: 800,
        category: "Food",
        addonAssignments: [{ addonId: freeId, priceOverrideCents: null }],
      });
      itemFree = freeItem.json.menuItem.item_id;
      pass("item-price-or-library-price");
    } catch (err) {
      fail("item-price-or-library-price", err);
    }

    try {
      const missing = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `ADDON-MISS-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: itemUnset,
            quantity: 1,
            addons: [{ addonId: unsetId, quantity: 1 }],
          },
        ],
      });
      assert(missing.status === 400, `missing price ${missing.status}`);
      assert(
        String(missing.json?.error || "").includes("Enter a price"),
        `message ${missing.json?.error}`
      );

      const entered = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `ADDON-ENTER-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: itemUnset,
            quantity: 1,
            addons: [{ addonId: unsetId, quantity: 1, unitPriceCents: 250 }],
          },
        ],
      });
      assert(
        entered.status === 200 || entered.status === 201,
        `entered ${entered.status} ${JSON.stringify(entered.json)}`
      );
      const order = getOrder(entered.json.order.order_id);
      const snap = order.lines[0].addons.find((a) => a.addonId === unsetId);
      assert(snap.unitPriceCents === 250, "sale price stored");
      assert(snap.priceAdjusted === false, "entered price is not an override");
      assert(order.lines[0].unit_addons_cents === 250, "addon total");
      const audits = listAuditEvents({ limit: 30 });
      assert(
        audits.some((e) => e.action === "order.addon.price_entered"),
        "audit price entered"
      );

      const blocked = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `ADDON-BLOCK-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: itemPriced,
            quantity: 1,
            addons: [{ addonId: pricedId, quantity: 1, unitPriceCents: 999 }],
          },
        ],
      });
      assert(blocked.status === 403, `priced override still blocked ${blocked.status}`);

      const itemPrice = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `ADDON-ITEM-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: itemPriced,
            quantity: 1,
            addons: [{ addonId: unsetId, quantity: 1 }],
          },
        ],
      });
      assert(itemPrice.status === 200 || itemPrice.status === 201, "item price order");
      const pricedOrder = getOrder(itemPrice.json.order.order_id);
      const pricedSnap = pricedOrder.lines[0].addons.find((a) => a.addonId === unsetId);
      assert(pricedSnap.unitPriceCents === 450, "used item price");
      assert(pricedSnap.priceAdjusted === false, "item price not an adjustment");

      const freeOrder = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `ADDON-FREE-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: itemFree,
            quantity: 1,
            addons: [{ addonId: freeId, quantity: 1 }],
          },
        ],
      });
      assert(freeOrder.status === 200 || freeOrder.status === 201, "free addon order");
      const freeSnap = getOrder(freeOrder.json.order.order_id).lines[0].addons[0];
      assert(freeSnap.unitPriceCents === 0, "free stays free");
      pass("sale-asks-only-when-unset");
    } catch (err) {
      fail("sale-asks-only-when-unset", err);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  log.info(`optional addon price ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
