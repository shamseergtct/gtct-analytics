/**
 * Phase 1.9 Mac acceptance — Sales UI variants + category nav foundations.
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
import { getMenuItem } from "../services/menuMappings.js";
import { updateShopSettings } from "../services/shopSettings.js";
import { listVariantsForItem } from "../services/variants.js";
import { renderKitchenTicket, renderCashierReceipt } from "../print/ticketFormat.js";
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

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-phase19-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18799";
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
  await new Promise((resolve) =>
    server.listen(config.port, config.host, resolve)
  );
  const port = config.port;
  const sessions = await openRoleSessions(port, config.testTenantId);
  const admin = sessions.admin;
  const device = sessions.device;
  const shopId = config.testTenantId;

  let juiceId;
  let burgerId;
  let smallId;
  let mediumId;
  let largeId;

  try {
    try {
      updateShopSettings(
        shopId,
        {
          currencyPreset: "BHD",
          confirmCurrencyChange: true,
          taxEnabled: true,
          taxMode: "exclusive",
          taxRatePercent: "10",
        },
        { role: "admin" }
      );
      const items = await httpJson(port, "GET", "/v1/menu-items", device);
      assert(items.status === 200, "menu load");
      const list = items.json.menuItems || [];
      assert(list.length >= 3, "seeded items");
      burgerId = list.find((i) => /burger/i.test(i.name))?.item_id;
      const oj = list.find((i) => /orange|juice/i.test(i.name));
      assert(burgerId && oj, "burger+juice");
      juiceId = oj.item_id;
      assert(oj.hasVariants === false, "default no variants");
      assert(oj.item_id === "item_orange_juice" || Boolean(oj.item_id), "id stable");
      pass("menu-loads-non-variant");
    } catch (err) {
      fail("menu-loads-non-variant", err);
    }

    try {
      const deny = await httpJson(port, "PUT", "/v1/menu-items", device, {
        itemId: juiceId,
        name: "Orange Juice",
        priceCents: 800,
        hasVariants: true,
        variants: [{ name: "Small", priceCents: 600 }],
      });
      assert(deny.status === 403, "device cannot create variants");

      const created = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: juiceId,
        name: "Orange Juice",
        priceCents: 800,
        category: "Beverages",
        subcategory: "Fresh Juice",
        stationIds: [],
        hasVariants: true,
        variants: [
          { name: "Small", priceCents: 600, sortOrder: 0, isDefault: true },
          { name: "Medium", priceCents: 800, sortOrder: 1 },
          { name: "Large", priceCents: 1100, sortOrder: 2 },
        ],
      });
      assert(created.status === 200, `create ${created.status} ${created.json?.error}`);
      assert(created.json.menuItem.hasVariants === true, "has variants");
      assert(created.json.menuItem.variants.length === 3, "3 variants");
      assert(created.json.menuItem.startingPriceCents === 600, "from price");
      smallId = created.json.menuItem.variants.find((v) => v.name === "Small")
        ?.variantId;
      mediumId = created.json.menuItem.variants.find((v) => v.name === "Medium")
        ?.variantId;
      largeId = created.json.menuItem.variants.find((v) => v.name === "Large")
        ?.variantId;
      assert(smallId && mediumId && largeId, "variant ids");

      const dup = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: juiceId,
        name: "Orange Juice",
        priceCents: 800,
        category: "Beverages",
        subcategory: "Fresh Juice",
        stationIds: [],
        hasVariants: true,
        variants: [
          { variantId: smallId, name: "Small", priceCents: 600 },
          { name: "small", priceCents: 700 },
        ],
      });
      assert(dup.status === 409, "duplicate name rejected");

      const badPrice = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: juiceId,
        name: "Orange Juice",
        priceCents: 800,
        category: "Beverages",
        stationIds: [],
        hasVariants: true,
        variants: [{ name: "Tiny", priceCents: 12.5 }],
      });
      assert(badPrice.status === 400, "non-integer price rejected");
      pass("variant-crud-validation");
    } catch (err) {
      fail("variant-crud-validation", err);
    }

    try {
      // Sold-out Large
      await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: juiceId,
        name: "Orange Juice",
        priceCents: 800,
        category: "Beverages",
        subcategory: "Fresh Juice",
        stationIds: [],
        hasVariants: true,
        variants: [
          { variantId: smallId, name: "Small", priceCents: 600, sortOrder: 0 },
          { variantId: mediumId, name: "Medium", priceCents: 800, sortOrder: 1 },
          {
            variantId: largeId,
            name: "Large",
            priceCents: 1100,
            sortOrder: 2,
            isSoldOut: true,
          },
        ],
      });
      const sold = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P19-SO-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: juiceId, variantId: largeId, quantity: 1 }],
      });
      assert(sold.status === 400, "sold-out variant blocked");

      const inactiveVar = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: juiceId,
        name: "Orange Juice",
        priceCents: 800,
        category: "Beverages",
        stationIds: [],
        hasVariants: true,
        variants: [
          { variantId: smallId, name: "Small", priceCents: 600, isActive: true },
          {
            variantId: mediumId,
            name: "Medium",
            priceCents: 800,
            isActive: false,
          },
          {
            variantId: largeId,
            name: "Large",
            priceCents: 1100,
            isActive: true,
            isSoldOut: false,
          },
        ],
      });
      assert(inactiveVar.status === 200, "deactivate medium");
      const midOrder = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P19-INA-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: juiceId, variantId: mediumId, quantity: 1 }],
      });
      assert(midOrder.status === 400, "inactive variant blocked");

      // Parent sold out blocks
      await httpJson(
        port,
        "PATCH",
        `/v1/menu-items/${encodeURIComponent(juiceId)}/availability`,
        admin,
        { isSoldOut: true }
      );
      const parentSo = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P19-PSO-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: juiceId, variantId: smallId, quantity: 1 }],
      });
      assert(parentSo.status === 400, "parent sold out blocks");
      await httpJson(
        port,
        "PATCH",
        `/v1/menu-items/${encodeURIComponent(juiceId)}/availability`,
        admin,
        { isSoldOut: false }
      );

      // Parent inactive
      await httpJson(
        port,
        "PATCH",
        `/v1/menu-items/${encodeURIComponent(juiceId)}/availability`,
        admin,
        { isActive: false }
      );
      const parentOff = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P19-PIN-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: juiceId, variantId: smallId, quantity: 1 }],
      });
      assert(parentOff.status === 400, "parent inactive blocks");
      await httpJson(
        port,
        "PATCH",
        `/v1/menu-items/${encodeURIComponent(juiceId)}/availability`,
        admin,
        { isActive: true }
      );

      // Restore usable variants
      await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: juiceId,
        name: "Orange Juice",
        priceCents: 800,
        category: "Beverages",
        subcategory: "Fresh Juice",
        stationIds: [],
        hasVariants: true,
        variants: [
          { variantId: smallId, name: "Small", priceCents: 600, sortOrder: 0 },
          { variantId: mediumId, name: "Medium", priceCents: 800, sortOrder: 1 },
          { variantId: largeId, name: "Large", priceCents: 1100, sortOrder: 2 },
        ],
      });
      pass("variant-availability-rules");
    } catch (err) {
      fail("variant-availability-rules", err);
    }

    let orderId;
    try {
      const missing = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P19-NOV-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: juiceId, quantity: 1 }],
      });
      assert(missing.status === 400, "variant required");

      const tamper = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P19-TAMPER-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: juiceId,
            variantId: largeId,
            quantity: 2,
            unitBasePriceCents: 1,
          },
        ],
      });
      assert(tamper.status === 409, "client price tamper rejected");

      const ok = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P19-OK-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: juiceId,
            variantId: largeId,
            quantity: 2,
            unitBasePriceCents: 1100,
          },
        ],
      });
      assert(ok.status === 200 || ok.status === 201, "variant order");
      orderId = ok.json.order.order_id;
      const order = getOrder(orderId);
      assert(order.lines[0].variant_id === largeId, "variant snap id");
      assert(order.lines[0].variant_name === "Large", "variant snap name");
      assert(order.lines[0].unit_base_price_cents === 1100, "server price");
      assert(order.goods_cents === 2200, "goods 2×1100");
      assert(order.tax_cents === 220, "10% tax");
      assert(order.total_cents === 2420, "total");

      // Non-variant burger still works
      const burger = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P19-BURG-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: burgerId, quantity: 1 }],
      });
      assert(burger.status === 200 || burger.status === 201, "burger ok");
      const bo = getOrder(burger.json.order.order_id);
      assert(!bo.lines[0].variant_id, "no variant on burger");
      assert(bo.lines[0].unit_base_price_cents === 1800, "burger price");
      pass("order-variant-pricing-tax");
    } catch (err) {
      fail("order-variant-pricing-tax", err);
    }

    try {
      // Historical freeze after price edit
      const before = getOrder(orderId);
      await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: juiceId,
        name: "Orange Juice",
        priceCents: 800,
        category: "Beverages",
        stationIds: [],
        hasVariants: true,
        variants: [
          { variantId: smallId, name: "Small", priceCents: 600 },
          { variantId: mediumId, name: "Medium", priceCents: 800 },
          { variantId: largeId, name: "XLarge", priceCents: 1500 },
        ],
      });
      const after = getOrder(orderId);
      assert(after.lines[0].variant_name === "Large", "name frozen");
      assert(after.lines[0].unit_base_price_cents === 1100, "price frozen");
      assert(after.total_cents === before.total_cents, "total frozen");
      pass("historical-variant-frozen");
    } catch (err) {
      fail("historical-variant-frozen", err);
    }

    try {
      const kitchen = renderKitchenTicket({
        orderNumber: "T",
        ticketId: "T-K",
        stationName: "JUICE",
        orderType: "TAKEAWAY",
        createdAt: new Date().toISOString(),
        items: [
          {
            quantity: 2,
            name: "Orange Juice",
            variantName: "Large",
            instructions: ["Less Sugar"],
            addons: [],
          },
        ],
      });
      assert(/ORANGE JUICE/i.test(kitchen), "kitchen item");
      assert(/SIZE:\s*LARGE/i.test(kitchen), "kitchen size");

      const cashier = renderCashierReceipt({
        orderNumber: "T",
        orderType: "TAKEAWAY",
        createdAt: new Date().toISOString(),
        currencyCode: "BHD",
        currencyLabel: "BHD",
        currencyDecimals: 3,
        totalCents: 2200,
        goodsCents: 2200,
        items: [
          {
            quantity: 2,
            name: "Orange Juice",
            variantName: "Large",
            unitBasePriceCents: 1100,
            lineTotalCents: 2200,
            instructions: [],
            addons: [],
          },
        ],
      });
      assert(/Orange Juice — Large/i.test(cashier), "cashier variant");
      assert(/Unit BHD 1\.100/i.test(cashier), "cashier unit");
      pass("ticket-variant-text");
    } catch (err) {
      fail("ticket-variant-text", err);
    }

    try {
      await processAllPending(config);
      const jobs = await httpJson(
        port,
        "GET",
        `/v1/print-jobs?orderId=${encodeURIComponent(orderId)}`,
        device
      );
      assert((jobs.json.jobs || []).length > 0, "mock jobs");
      const kitchenJob = (jobs.json.jobs || []).find(
        (j) => j.job_type === "KITCHEN" || j.job_type === "CASHIER"
      );
      assert(kitchenJob, "job exists");
      pass("mock-print-jobs");
    } catch (err) {
      fail("mock-print-jobs", err);
    }

    try {
      const pub = path.join(process.cwd(), "public");
      const indexHtml = fs.readFileSync(path.join(pub, "index.html"), "utf8");
      assert(/variant-dialog/i.test(indexHtml), "variant dialog markup");
      assert(/mobile-cart-bar/i.test(indexHtml), "mobile cart bar");
      assert(/category-filters/i.test(indexHtml), "category chips");
      const menuHtml = fs.readFileSync(path.join(pub, "menu.html"), "utf8");
      assert(/Has Variants/i.test(menuHtml), "menu setup variants");
      const appJs = fs.readFileSync(path.join(pub, "app.js"), "utf8");
      assert(/openVariantPicker/i.test(appJs), "direct variant add");
      assert(/lineMergeKey/i.test(appJs), "merge key");
      pass("ui-assets");
    } catch (err) {
      fail("ui-assets", err);
    }

    try {
      const num = `P19-DUP-${Date.now()}`;
      const a = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: num,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: juiceId,
            variantId: smallId,
            quantity: 1,
            unitBasePriceCents: 600,
          },
        ],
      });
      const b = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: num,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: juiceId,
            variantId: smallId,
            quantity: 1,
            unitBasePriceCents: 600,
          },
        ],
      });
      assert(a.json.order.order_id === b.json.order.order_id, "idempotent");
      assert(b.json.created === false, "not recreated");
      pass("idempotency");
    } catch (err) {
      fail("idempotency", err);
    }

    try {
      closeDatabase();
      openDatabase(config.dbPath);
      await runMigrations(getDb());
      const vars = listVariantsForItem(juiceId);
      assert(vars.length >= 3, "variants after restart");
      assert(getMenuItem(juiceId).hasVariants === true, "flag after restart");
      assert(getOrder(orderId).lines[0].variant_name === "Large", "order snap");
      pass("restart-persistence");
    } catch (err) {
      fail("restart-persistence", err);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      closeDatabase();
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n=== Phase 1.9 acceptance ===");
  for (const r of results) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`
    );
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
