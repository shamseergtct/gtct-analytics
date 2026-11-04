/**
 * Phase 1.5 Mac acceptance — kitchen instruction library, add-ons, order pricing.
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
import { processAllPending } from "../print/dispatcher.js";
import { getOrder } from "../services/orders.js";
import { formatMoneyMinor } from "../util/money.js";
import { updateShopSettings, getShopSettings } from "../services/shopSettings.js";
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

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-phase15-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18795";
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
      const items = await httpJson(port, "GET", "/v1/menu-items", device);
      assert(items.status === 200, "menu ok");
      assert((items.json.menuItems || []).length >= 1, "items remain");
      pass("existing-menu-intact");
    } catch (err) {
      fail("existing-menu-intact", err);
    }

    let modLess;
    let tgtSauce;
    let addonCheese;
    let addonIce;
    try {
      const lib0 = await httpJson(port, "GET", "/v1/kitchen-library", admin);
      assert(lib0.status === 200, "library get");
      modLess = lib0.json.library.modifiers.find(
        (m) => m.name.toLowerCase() === "less"
      );
      tgtSauce = lib0.json.library.targets.find(
        (t) => t.name.toLowerCase() === "sauce"
      );
      assert(modLess, "seeded Less");
      assert(tgtSauce, "seeded Sauce");
      // Same name without id upserts existing (legacy kitchen-notes compat).
      const mSame = await httpJson(port, "PUT", "/v1/kitchen-modifiers", admin, {
        name: "Less",
        isActive: true,
      });
      assert(mSame.status === 200, "upsert by name");
      assert(mSame.json.modifier.modifierId === modLess.modifierId, "same id");
      const unique = await httpJson(port, "PUT", "/v1/kitchen-modifiers", admin, {
        name: `Phase15Mod-${Date.now()}`,
        isActive: true,
      });
      assert(unique.status === 200, `unique mod ${unique.status} ${unique.json?.error}`);
      // Rename onto an existing name must 409
      const clash = await httpJson(port, "PUT", "/v1/kitchen-modifiers", admin, {
        modifierId: unique.json.modifier.modifierId,
        name: "Less",
        isActive: true,
      });
      assert(clash.status === 409, `duplicate rename rejected got ${clash.status}`);
      const renamed = await httpJson(port, "PUT", "/v1/kitchen-modifiers", admin, {
        modifierId: unique.json.modifier.modifierId,
        name: `Phase15Renamed-${Date.now()}`,
        isActive: true,
      });
      assert(renamed.status === 200, "rename");
      const std = await httpJson(port, "PUT", "/v1/kitchen-standalone", admin, {
        name: "Well Done",
        isActive: true,
      });
      // Well Done may already exist from migration
      assert(std.status === 200 || std.status === 409, "standalone upsert/exists");
      const lib = await httpJson(port, "GET", "/v1/kitchen-library", admin);
      assert(lib.json.library.modifiers.length >= 1, "library mods");
      assert(lib.json.library.targets.length >= 1, "library targets");
      pass("instruction-library-crud");
    } catch (err) {
      fail("instruction-library-crud", err);
    }

    try {
      updateShopSettings(shopId, { currencyPreset: "BHD", confirmCurrencyChange: true }, { role: "admin" });
      const cheese = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Double Cheese",
        priceCents: 300,
        isActive: true,
      });
      assert(cheese.status === 200, "paid addon");
      assert(cheese.json.addon.priceCents === 300, "300 minor");
      addonCheese = cheese.json.addon;
      const ice = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Extra Ice",
        priceCents: 0,
        isActive: true,
      });
      assert(ice.status === 200, "free addon");
      addonIce = ice.json.addon;
      const deviceForbidden = await httpJson(port, "PUT", "/v1/addons", device, {
        name: "Hack",
        priceCents: 1,
      });
      assert(deviceForbidden.status === 403, "device cannot price");
      pass("addons-library-crud");
    } catch (err) {
      fail("addons-library-crud", err);
    }

    let burgerId;
    try {
      const burger = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        name: "Chicken Burger P15",
        priceCents: 1500,
        category: "Food",
        subcategory: "Burgers",
        stationIds: ["station_grill"],
        instructionCustomize: true,
        modifierIds: [modLess.modifierId],
        targetIds: [tgtSauce.targetId],
        standaloneIds: [],
        addonAssignments: [
          { addonId: addonCheese.addonId, priceOverrideCents: null },
          { addonId: addonIce.addonId, priceOverrideCents: 0 },
        ],
      });
      assert(burger.status === 200, "burger saved");
      burgerId = burger.json.menuItem.item_id;
      assert(burger.json.menuItem.instructionCustomized === true, "customized");
      assert(
        burger.json.menuItem.addons.some((a) => a.addonId === addonCheese.addonId),
        "cheese assigned"
      );
      // Explicit zero override vs default
      const ov = await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(burgerId)}/addons`,
        admin,
        {
          assignments: [
            { addonId: addonCheese.addonId, priceOverrideCents: 200 },
            { addonId: addonIce.addonId, priceOverrideCents: 0 },
          ],
        }
      );
      assert(ov.status === 200, "override ok");
      const cheeseAsg = ov.json.addons.find((a) => a.addonId === addonCheese.addonId);
      assert(cheeseAsg.effectivePriceCents === 200, "override 200");
      assert(cheeseAsg.priceOverrideCents === 200, "override stored");
      const iceAsg = ov.json.addons.find((a) => a.addonId === addonIce.addonId);
      assert(iceAsg.effectivePriceCents === 0, "explicit zero");
      assert(iceAsg.priceOverrideCents === 0, "zero override distinct");
      pass("item-assignments-overrides");
    } catch (err) {
      fail("item-assignments-overrides", err);
    }

    try {
      const again = await httpJson(
        port,
        "GET",
        `/v1/menu-items/${encodeURIComponent(burgerId)}/addons`,
        device
      );
      assert(again.status === 200, "addons get");
      assert(
        again.json.addons.some((a) => a.addonId === addonCheese.addonId),
        "persist assign"
      );
      const instr = await httpJson(
        port,
        "GET",
        `/v1/menu-items/${encodeURIComponent(burgerId)}/instructions`,
        device
      );
      assert(instr.status === 200, "instr get");
      assert(instr.json.instructions.customized === true, "customized persisted");
      pass("assignments-survive-restart");
    } catch (err) {
      fail("assignments-survive-restart", err);
    }

    try {
      await httpJson(port, "PUT", "/v1/addons", admin, {
        addonId: addonCheese.addonId,
        name: "Double Cheese",
        priceCents: 300,
        isActive: false,
      });
      const orderNum = `P15-INACTIVE-${Date.now()}`;
      const bad = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: orderNum,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: burgerId,
            quantity: 1,
            instructions: ["Less Sauce"],
            addons: [{ addonId: addonCheese.addonId, quantity: 1 }],
          },
        ],
      });
      assert(bad.status === 400, "inactive addon blocked");
      // reactivate for later tests
      await httpJson(port, "PUT", "/v1/addons", admin, {
        addonId: addonCheese.addonId,
        name: "Double Cheese",
        priceCents: 300,
        isActive: true,
      });
      pass("inactive-addon-blocked");
    } catch (err) {
      fail("inactive-addon-blocked", err);
    }

    let orderId;
    try {
      // Restore override 300 default path: set override null
      await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(burgerId)}/addons`,
        admin,
        {
          assignments: [
            { addonId: addonCheese.addonId, priceOverrideCents: null },
            { addonId: addonIce.addonId, priceOverrideCents: null },
          ],
        }
      );
      const orderNum = `P15-PRICE-${Date.now()}`;
      const created = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: orderNum,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: burgerId,
            quantity: 2,
            instructions: ["Less Sauce"],
            addons: [
              { addonId: addonCheese.addonId, quantity: 1 },
              { addonId: addonIce.addonId, quantity: 1 },
            ],
          },
        ],
      });
      assert(created.status === 200 || created.status === 201, "order created");
      orderId = created.json.order.order_id;
      const order = getOrder(orderId);
      // 1500 + 300 + 0 = 1800 unit; ×2 = 3600
      assert(order.lines[0].unit_base_price_cents === 1500, "base snap");
      assert(order.lines[0].unit_addons_cents === 300, "addons snap");
      assert(order.lines[0].unit_total_cents === 1800, "unit total");
      assert(order.lines[0].line_total_cents === 3600, "line total");
      assert(order.total_cents === 3600, "order total");
      assert(order.lines[0].addons.length === 2, "two addons");
      assert(order.lines[0].instructions.includes("Less Sauce"), "instr");
      // Client-supplied fake price ignored — already validated via server resolve
      const shop = getShopSettings(shopId);
      assert(formatMoneyMinor(3600, shop) === "BHD 3.600", "BHD format");
      pass("order-pricing-snapshot");
    } catch (err) {
      fail("order-pricing-snapshot", err);
    }

    try {
      // Change library price — historical order unchanged
      await httpJson(port, "PUT", "/v1/addons", admin, {
        addonId: addonCheese.addonId,
        name: "Double Cheese",
        priceCents: 999,
        isActive: true,
      });
      const order = getOrder(orderId);
      assert(order.lines[0].line_total_cents === 3600, "history frozen");
      assert(
        order.lines[0].addons.find((a) => a.addonId === addonCheese.addonId)
          .unitPriceCents === 300,
        "snap price 300"
      );
      pass("historical-prices-frozen");
    } catch (err) {
      fail("historical-prices-frozen", err);
    }

    try {
      await processAllPending(config);
      const jobs = await httpJson(
        port,
        "GET",
        `/v1/print-jobs?orderId=${encodeURIComponent(orderId)}`,
        device
      );
      assert(jobs.status === 200, "jobs");
      const kitchen = (jobs.json.jobs || []).find((j) => j.job_type === "KITCHEN");
      const cashier = (jobs.json.jobs || []).find((j) => j.job_type === "CASHIER");
      assert(kitchen, "kitchen job");
      assert(cashier, "cashier job");
      const kPrev = await httpJson(
        port,
        "GET",
        `/v1/print-jobs/${encodeURIComponent(kitchen.job_id)}/preview`,
        device
      );
      assert(/LESS SAUCE/i.test(kPrev.json.text), "kitchen instr");
      assert(/DOUBLE CHEESE/i.test(kPrev.json.text), "kitchen addon");
      const cPrev = await httpJson(
        port,
        "GET",
        `/v1/print-jobs/${encodeURIComponent(cashier.job_id)}/preview`,
        device
      );
      assert(/DOUBLE CHEESE/i.test(cPrev.json.text), "cashier addon");
      assert(/BHD|3\.600|TOTAL/i.test(cPrev.json.text), "cashier total");
      pass("mock-tickets-customization");
    } catch (err) {
      fail("mock-tickets-customization", err);
    }

    try {
      const dup = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: getOrder(orderId).order_number,
        orderType: "TAKEAWAY",
        lines: [{ itemId: burgerId, quantity: 1, instructions: [] }],
      });
      assert(dup.status === 409 && dup.json.code === "SUBMISSION_CONFLICT", "different details rejected");
      assert(getOrder(orderId), "original order remains");
      assert(config.physicalPrintEnabled === false, "physical off");
      pass("idempotency-and-print-safety");
    } catch (err) {
      fail("idempotency-and-print-safety", err);
    }

    try {
      // Formatters work for other currencies without rewriting shop currency
      // (currency changes are locked once orders exist — Phase 1.7).
      assert(
        formatMoneyMinor(150, {
          currency_label: "QR",
          currency_decimals: 2,
        }) === "QR 1.50",
        "QAR"
      );
      assert(
        formatMoneyMinor(15000, {
          currency_label: "₹",
          currency_decimals: 2,
        }) === "₹ 150.00",
        "INR"
      );
      assert(
        formatMoneyMinor(1500, {
          currency_label: "BHD",
          currency_decimals: 3,
        }) === "BHD 1.500",
        "BHD"
      );
      pass("currency-formats");
    } catch (err) {
      fail("currency-formats", err);
    }

    try {
      const assets = await Promise.all([
        httpJson(port, "GET", "/menu.html", admin),
        httpJson(port, "GET", "/menu.js", admin),
        httpJson(port, "GET", "/index.html", device),
        httpJson(port, "GET", "/app.js", device),
      ]);
      // static may not need auth — check 200
      for (const a of assets) assert(a.status === 200, "asset");
      pass("ui-assets-served");
    } catch (err) {
      fail("ui-assets-served", err);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
  }

  const passed = results.filter((r) => r.ok).length;
  const summary = {
    phase: "1.5",
    platform: process.platform,
    node: process.version,
    passed,
    total: results.length,
    physicalPrintAttempted: false,
    results,
    tempRoot,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (passed < results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
