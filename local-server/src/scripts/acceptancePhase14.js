/**
 * Phase 1.4 Mac acceptance — Menu Setup redesign APIs + shop currency.
 * Isolated temp DB. No physical prints.
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
import { formatMoneyMinor, parseMoneyInput } from "../util/money.js";
import { getShopSettings, updateShopSettings } from "../services/shopSettings.js";
import { listMenuItems } from "../services/menuMappings.js";
import { processAllPending } from "../print/dispatcher.js";
import { withSubmissionId } from "./orderRequest.js";

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function httpJson(port, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(withSubmissionId(body)) : null;
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
        res.on("data", (c) => (data += c));
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

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-phase14-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18790";
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;
  delete process.env.GTCT_SHOP_CURRENCY;
  delete process.env.GTCT_SHOP_CURRENCY_DECIMALS;
  delete process.env.GTCT_SHOP_CURRENCY_LABEL;

  const config = loadConfig({ mode: "http" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedSampleData(config);

  const server = createServer(config);
  await new Promise((resolve, reject) => {
    server.listen(config.port, config.host, (err) => (err ? reject(err) : resolve()));
  });

  const port = config.port;
  const sessions = await openRoleSessions(port, config.testTenantId);
  const admin = sessions.admin;
  const device = sessions.device;

  try {
    try {
      const shop = getShopSettings(config.testTenantId);
      assert(shop.currencyCode === "QAR", "default QAR");
      assert(shop.currencyDecimals === 2, "default 2 decimals");
      assert(formatMoneyMinor(150, shop) === "QR 1.50", "QR format");
      assert(formatMoneyMinor(800, shop) === "QR 8.00", "seed OJ price display");
      pass("currency-default-qar");
    } catch (err) {
      fail("currency-default-qar", err);
    }

    try {
      const bhd = updateShopSettings(
        config.testTenantId,
        { currencyPreset: "BHD", confirmCurrencyChange: true },
        { role: "admin" }
      );
      assert(bhd.currencyDecimals === 3, "BHD 3dp");
      assert(formatMoneyMinor(1500, bhd) === "BHD 1.500", "BHD format");
      assert(parseMoneyInput("1.500", 3) === 1500, "parse BHD");
      try {
        parseMoneyInput("1.5000", 3);
        assert(false, "should reject extra precision");
      } catch (e) {
        assert(e.status === 400, "reject extra decimals");
      }
      const inr = updateShopSettings(
        config.testTenantId,
        { currencyPreset: "INR", confirmCurrencyChange: true },
        { role: "admin" }
      );
      assert(formatMoneyMinor(15000, inr) === "₹ 150.00", "INR format");
      const qar = updateShopSettings(
        config.testTenantId,
        { currencyPreset: "QAR", confirmCurrencyChange: true },
        { role: "admin" }
      );
      assert(formatMoneyMinor(150, qar) === "QR 1.50", "QAR restored");
      // Existing minor units unchanged after preset flips
      const oj = listMenuItems().find((i) => i.item_id === "item_orange_juice");
      assert(oj.price_cents === 800, "stored price unchanged");
      pass("currency-presets-no-rescale");
    } catch (err) {
      fail("currency-presets-no-rescale", err);
    }

    try {
      const pages = ["/menu.html", "/menu-setup.css", "/menu.js", "/money.js"];
      for (const p of pages) {
        const res = await httpJson(port, "GET", p, null);
        assert(res.status === 200, `${p} served`);
      }
      const shopApi = await httpJson(port, "GET", "/v1/shop-settings", device);
      assert(shopApi.status === 200, "shop settings api");
      assert(shopApi.json.shop.currencyCode, "currency code present");
      pass("menu-setup-assets");
    } catch (err) {
      fail("menu-setup-assets", err);
    }

    try {
      const created = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        name: "Pepsi Can",
        sku: "",
        category: "Beverages",
        subcategory: "Soft Drinks",
        priceCents: 200,
        stationIds: [],
        isActive: true,
        isSoldOut: false,
      });
      assert(created.status === 200, "create no-sku no-prep");
      assert(created.json.menuItem.sku == null, "blank sku");
      assert(created.json.menuItem.requiresPreparation === false, "no prep");
      const id = created.json.menuItem.item_id;

      const sold = await httpJson(
        port,
        "PATCH",
        `/v1/menu-items/${encodeURIComponent(id)}/availability`,
        device,
        { isSoldOut: true }
      );
      assert(sold.status === 200 && sold.json.menuItem.is_sold_out === 1, "sold out");
      const blocked = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P14-SOLD-${Date.now()}`,
        orderType: "TAKEAWAY",
        lines: [{ itemId: id, quantity: 1 }],
      });
      assert(blocked.status === 400, "sold out blocked");

      await httpJson(
        port,
        "PATCH",
        `/v1/menu-items/${encodeURIComponent(id)}/availability`,
        device,
        { isSoldOut: false }
      );

      const order = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P14-MIX-${Date.now()}`,
        orderType: "TAKEAWAY",
        lines: [
          { itemId: id, quantity: 1 },
          { itemId: "item_orange_juice", quantity: 1 },
        ],
      });
      assert(order.status === 201, "order ok");
      await processAllPending(config);
      const jobs = await httpJson(
        port,
        "GET",
        `/v1/print-jobs?orderId=${encodeURIComponent(order.json.order.order_id)}`,
        device
      );
      const kitchen = (jobs.json.jobs || []).filter((j) => j.job_type === "KITCHEN");
      assert(
        kitchen.every((j) => j.station_id === "station_juice"),
        "only juice kitchen"
      );
      pass("no-prep-and-availability");
    } catch (err) {
      fail("no-prep-and-availability", err);
    }

    try {
      const notes = await httpJson(port, "PUT", "/v1/kitchen-notes", admin, {
        modifiers: ["Less", "No", "Extra"],
        targets: ["Sugar", "Ice", "Onion"],
      });
      assert(notes.status === 200, "notes save");
      assert(notes.json.modifiers.includes("Less"), "modifiers");
      const get = await httpJson(port, "GET", "/v1/kitchen-notes", device);
      assert(get.json.targets.includes("Ice"), "targets persist");
      pass("kitchen-notes-api");
    } catch (err) {
      fail("kitchen-notes-api", err);
    }

    try {
      assert(config.physicalPrintEnabled === false, "physical off");
      const settings = await httpJson(port, "GET", "/settings.html", null);
      assert(settings.status === 200, "settings page");
      pass("printer-settings-intact");
    } catch (err) {
      fail("printer-settings-intact", err);
    }

    try {
      closeDatabase();
      openDatabase(config.dbPath);
      await runMigrations(getDb());
      const shop = getShopSettings(config.testTenantId);
      assert(shop.currencyCode === "QAR", "shop persists");
      assert(listMenuItems().some((i) => i.item_id === "item_orange_juice"), "items persist");
      pass("restart-persistence");
    } catch (err) {
      fail("restart-persistence", err);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      closeDatabase();
    } catch {
      // ignore
    }
  }

  const summary = {
    phase: "1.4",
    platform: process.platform,
    node: process.version,
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    physicalPrintAttempted: false,
    results,
    tempRoot,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
