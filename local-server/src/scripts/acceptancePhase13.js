/**
 * Phase 1.3 Mac acceptance — menu setup, images, kitchen instructions, sales UX APIs.
 * Isolated temp DB. Never touches physical printers or production Firebase.
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
import { processAllPending } from "../print/dispatcher.js";
import { getMenuItem, listMenuItems } from "../services/menuMappings.js";
import { getOrder } from "../services/orders.js";
import { listPrinters } from "../services/printers.js";
import { withSubmissionId } from "./orderRequest.js";

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function httpJson(port, method, urlPath, token, body, { maxRedirects: _ } = {}) {
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
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const contentType = String(res.headers["content-type"] || "");
          let json = null;
          if (contentType.includes("application/json")) {
            try {
              json = JSON.parse(buf.toString("utf8") || "null");
            } catch {
              json = { raw: buf.toString("utf8") };
            }
          }
          resolve({
            status: res.statusCode,
            json,
            buffer: buf,
            contentType,
            headers: res.headers,
          });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 1x1 PNG
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-phase13-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18789";
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;
  delete process.env.GTCT_ALLOW_TCP_PROBE;
  delete process.env.GTCT_ALLOW_LAN_BIND;

  const config = loadConfig({ mode: "http" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedSampleData(config);

  assert(fs.existsSync(config.menuImagesDir), "menu-images dir exists");
  assert(config.physicalPrintEnabled === false, "physical print off");

  const server = createServer(config);
  await new Promise((resolve, reject) => {
    server.listen(config.port, config.host, (err) => (err ? reject(err) : resolve()));
  });

  const port = config.port;
  const sessions = await openRoleSessions(port, config.testTenantId);
  const admin = sessions.admin;
  const device = sessions.device;

  try {
    // 1. Existing seed menu IDs preserved with new fields
    try {
      const items = listMenuItems();
      assert(items.length >= 3, "seed menu items present");
      const oj = items.find((i) => i.item_id === "item_orange_juice");
      assert(oj, "orange juice id preserved");
      assert(oj.category === "Beverages", "category remapped");
      assert(oj.price_cents === 800, "price backfilled");
      assert(oj.instructionTargets.includes("Ice"), "item instruction targets");
      pass("existing-menu-ids-preserved");
    } catch (err) {
      fail("existing-menu-ids-preserved", err);
    }

    // 2. Device cannot mutate menu; admin can
    try {
      const denied = await httpJson(port, "PUT", "/v1/menu-items", device, {
        itemId: "item_orange_juice",
        name: "Hacked",
        sku: "TEST-OJ",
      });
      assert(denied.status === 403, "device menu put denied");

      const created = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        name: "Mint Lemonade",
        sku: "TEST-ML",
        category: "Beverages",
        subcategory: "Fresh Juice",
        description: "Test drink",
        priceCents: 900,
        code: "ML",
        sortOrder: 15,
        stationIds: ["station_juice"],
        isActive: true,
        isSoldOut: false,
        instructionModifiers: ["Less", "No", "Extra"],
        instructionTargets: ["Sugar", "Ice"],
      });
      assert(created.status === 200, "admin create item");
      assert(created.json.menuItem?.name === "Mint Lemonade", "name saved");
      assert(created.json.menuItem?.price_cents === 900, "price saved");
      const mintId = created.json.menuItem.item_id;

      const edited = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: mintId,
        name: "Mint Lemonade",
        sku: "TEST-ML",
        category: "Beverages",
        priceCents: 950,
        stationIds: ["station_juice"],
        isSoldOut: true,
        sortOrder: 16,
      });
      assert(edited.status === 200, "admin edit item");
      assert(edited.json.menuItem.is_sold_out === 1, "sold out flag");
      assert(edited.json.menuItem.item_id === mintId, "id preserved on edit");
      pass("menu-crud-admin-only");
    } catch (err) {
      fail("menu-crud-admin-only", err);
    }

    // 3. Image upload persists on disk + reload
    try {
      const mint = listMenuItems().find((i) => i.sku === "TEST-ML");
      assert(mint, "mint item exists");
      const up = await httpJson(
        port,
        "POST",
        `/v1/menu-items/${encodeURIComponent(mint.item_id)}/image`,
        admin,
        { mimeType: "image/png", base64Data: TINY_PNG_B64 }
      );
      assert(up.status === 200, "image upload ok");
      assert(up.json.menuItem.image_filename, "filename stored");
      const diskPath = path.join(
        config.menuImagesDir,
        up.json.menuItem.image_filename
      );
      assert(fs.existsSync(diskPath), "image file on disk");

      const img = await httpJson(
        port,
        "GET",
        `/v1/menu-images/${encodeURIComponent(up.json.menuItem.image_filename)}`,
        device
      );
      assert(img.status === 200, "image fetch ok");
      assert(img.contentType.includes("image/png"), "png content type");
      assert(img.buffer.length > 10, "image bytes returned");
      pass("menu-image-persist");
    } catch (err) {
      fail("menu-image-persist", err);
    }

    // 4. Categories + filter fields on list
    try {
      const list = await httpJson(port, "GET", "/v1/menu-items", device);
      assert(list.status === 200, "list menu");
      assert(
        list.json.menuItems.some((i) => i.category === "Beverages"),
        "category on list"
      );
      const cats = await httpJson(port, "GET", "/v1/menu-categories", device);
      assert(cats.status === 200, "categories endpoint");
      assert(
        (cats.json.categories || []).some((c) => c.name === "Beverages"),
        "beverages category"
      );
      pass("category-listing");
    } catch (err) {
      fail("category-listing", err);
    }

    // 5. Kitchen instructions persist + dedupe + ticket preview
    try {
      const orderNumber = `TEST-P13-${Date.now()}`;
      const create = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber,
        orderType: "TAKEAWAY",
        destination: "Counter P13",
        lines: [
          {
            itemId: "item_orange_juice",
            quantity: 1,
            instructions: ["Less Sugar", "Less Sugar", "No Ice"],
          },
          {
            itemId: "item_chicken_shawarma",
            quantity: 2,
            instructions: ["No Onion", "Extra Sauce"],
          },
        ],
      });
      assert(create.status === 201, "order created");
      const orderId = create.json.order.order_id;
      const order = getOrder(orderId);
      const ojLine = order.lines.find((l) => l.item_id === "item_orange_juice");
      assert(ojLine.instructions.length === 2, "duplicate instruction removed");
      assert(ojLine.instructions.includes("Less Sugar"), "less sugar kept");
      assert(ojLine.instructions.includes("No Ice"), "no ice kept");

      // duplicate submit protection
      const again = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber,
        orderType: "TAKEAWAY",
        destination: "Counter P13",
        lines: [{ itemId: "item_orange_juice", quantity: 9, instructions: [] }],
      });
      assert(again.status === 409 && again.json.code === "SUBMISSION_CONFLICT", "different details rejected");
      assert(getOrder(orderId).order_id === orderId, "original order remains");

      await processAllPending(config);
      const jobs = await httpJson(
        port,
        "GET",
        `/v1/print-jobs?orderId=${encodeURIComponent(orderId)}`,
        device
      );
      assert(jobs.status === 200, "jobs listed");
      assert(jobs.json.jobs.length >= 2, "kitchen + cashier jobs");
      const kitchen = jobs.json.jobs.find((j) => j.job_type === "KITCHEN");
      assert(kitchen, "kitchen job");
      const preview = await httpJson(
        port,
        "GET",
        `/v1/print-jobs/${encodeURIComponent(kitchen.job_id)}/preview`,
        device
      );
      assert(preview.status === 200, "ticket preview");
      assert(/LESS SUGAR|NO ICE/i.test(preview.json.text), "instructions on ticket");
      pass("instructions-order-ticket");
    } catch (err) {
      fail("instructions-order-ticket", err);
    }

    // 6. Printer settings still work (admin list + MOCK printers)
    try {
      const printers = await httpJson(port, "GET", "/v1/printers", admin);
      assert(printers.status === 200, "printers list");
      assert(
        (printers.json.printers || []).every((p) => p.connection_type === "MOCK"),
        "mock printers remain"
      );
      assert(listPrinters().length >= 4, "seed printers intact");
      const deniedDevice = await httpJson(port, "PUT", "/v1/printers", device, {
        displayName: "Nope",
        connectionType: "MOCK",
      });
      assert(deniedDevice.status === 403, "device cannot edit printers");
      pass("printer-settings-intact");
    } catch (err) {
      fail("printer-settings-intact", err);
    }

    // 7. Restart persistence (re-open DB)
    try {
      const before = getMenuItem(
        listMenuItems().find((i) => i.sku === "TEST-ML").item_id
      );
      assert(before.image_filename, "image before reopen");
      closeDatabase();
      openDatabase(config.dbPath);
      await runMigrations(getDb());
      const after = getMenuItem(before.item_id);
      assert(after, "item after reopen");
      assert(after.name === before.name, "name persisted");
      assert(after.price_cents === before.price_cents, "price persisted");
      assert(after.image_filename === before.image_filename, "image ref persisted");
      assert(
        fs.existsSync(path.join(config.menuImagesDir, after.image_filename)),
        "image file still on disk"
      );
      pass("restart-persistence");
    } catch (err) {
      fail("restart-persistence", err);
    }

    // 8. Static UI pages present
    try {
      for (const p of ["/", "/menu.html", "/settings.html", "/styles.css", "/app.js", "/menu.js"]) {
        const res = await httpJson(port, "GET", p, null);
        assert(res.status === 200, `${p} served`);
      }
      pass("ui-pages-served");
    } catch (err) {
      fail("ui-pages-served", err);
    }

    // 9. Optional SKU (blank allowed; duplicate nonblank rejected)
    try {
      const a = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        name: "House Salad A",
        sku: "",
        category: "Food",
        subcategory: "Sandwiches",
        priceCents: 500,
        stationIds: ["station_grill"],
      });
      assert(a.status === 200, "create without sku");
      assert(a.json.menuItem.sku == null || a.json.menuItem.sku === "", "blank sku");
      const b = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        name: "House Salad B",
        sku: null,
        category: "Food",
        priceCents: 500,
        stationIds: ["station_grill"],
      });
      assert(b.status === 200, "second item without sku");
      assert(a.json.menuItem.item_id !== b.json.menuItem.item_id, "distinct ids");
      const dup = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        name: "Dup SKU",
        sku: "TEST-OJ",
        stationIds: ["station_juice"],
      });
      assert(dup.status === 409, "duplicate sku rejected");
      pass("optional-sku");
    } catch (err) {
      fail("optional-sku", err);
    }

    // 10. Sold out blocked on orders; restore works; inactive hidden path
    try {
      const cola = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        name: "Coca-Cola",
        sku: "",
        category: "Beverages",
        subcategory: "Soft Drinks",
        priceCents: 300,
        code: "COKE",
        stationIds: [],
        isActive: true,
        isSoldOut: false,
      });
      assert(cola.status === 200, "coca-cola created");
      const colaId = cola.json.menuItem.item_id;
      assert(cola.json.menuItem.requiresPreparation === false, "no prep flag");

      const sold = await httpJson(
        port,
        "PATCH",
        `/v1/menu-items/${encodeURIComponent(colaId)}/availability`,
        device,
        { isSoldOut: true }
      );
      assert(sold.status === 200, "device can mark sold out");
      assert(sold.json.menuItem.is_sold_out === 1, "sold out set");

      const blocked = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P13-SOLD-${Date.now()}`,
        orderType: "TAKEAWAY",
        lines: [{ itemId: colaId, quantity: 1 }],
      });
      assert(blocked.status === 400, "sold out order rejected");
      assert(/sold out/i.test(blocked.json?.error || ""), "sold out message");

      const restored = await httpJson(
        port,
        "PATCH",
        `/v1/menu-items/${encodeURIComponent(colaId)}/availability`,
        device,
        { isSoldOut: false }
      );
      assert(restored.status === 200 && restored.json.menuItem.is_sold_out === 0, "restored");

      const inactiveDenied = await httpJson(
        port,
        "PATCH",
        `/v1/menu-items/${encodeURIComponent(colaId)}/availability`,
        device,
        { isActive: false }
      );
      assert(inactiveDenied.status === 403, "device cannot archive");

      await httpJson(
        port,
        "PATCH",
        `/v1/menu-items/${encodeURIComponent(colaId)}/availability`,
        admin,
        { isActive: false }
      );
      const inactiveOrder = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P13-INACT-${Date.now()}`,
        orderType: "TAKEAWAY",
        lines: [{ itemId: colaId, quantity: 1 }],
      });
      assert(inactiveOrder.status === 400, "inactive order rejected");
      // restore active for later no-prep test
      await httpJson(
        port,
        "PATCH",
        `/v1/menu-items/${encodeURIComponent(colaId)}/availability`,
        admin,
        { isActive: true, isSoldOut: false }
      );
      pass("availability-enforcement");
    } catch (err) {
      fail("availability-enforcement", err);
    }

    // 11. No-preparation routing: cashier only, no kitchen prep ticket
    try {
      const cola = listMenuItems().find((i) => i.name === "Coca-Cola");
      assert(cola, "coca-cola present");
      const orderNumber = `P13-NOPREP-${Date.now()}`;
      const create = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber,
        orderType: "TAKEAWAY",
        destination: "Counter NP",
        lines: [
          { itemId: cola.item_id, quantity: 2 },
          { itemId: "item_orange_juice", quantity: 1, instructions: ["No Ice"] },
        ],
      });
      assert(create.status === 201, "mixed order created");
      await processAllPending(config);
      const jobs = await httpJson(
        port,
        "GET",
        `/v1/print-jobs?orderId=${encodeURIComponent(create.json.order.order_id)}`,
        device
      );
      const kitchen = (jobs.json.jobs || []).filter((j) => j.job_type === "KITCHEN");
      const cashier = (jobs.json.jobs || []).filter((j) => j.job_type === "CASHIER");
      assert(cashier.length === 1, "one cashier job");
      assert(
        kitchen.every((j) => j.station_id === "station_juice"),
        "only juice kitchen ticket (no fake NONE station)"
      );
      assert(
        !kitchen.some((j) => j.status === "NEEDS_REVIEW"),
        "no unmapped NEEDS_REVIEW for intentional no-prep"
      );
      const cashierPreview = await httpJson(
        port,
        "GET",
        `/v1/print-jobs/${encodeURIComponent(cashier[0].job_id)}/preview`,
        device
      );
      assert(/COCA-COLA|Coca-Cola/i.test(cashierPreview.json.text), "cola on cashier");
      assert(!/NONE/i.test(cashierPreview.json.text), "cashier ticket has no fake station");
      assert(/ORANGE JUICE/i.test(cashierPreview.json.text), "juice on cashier");
      pass("no-preparation-routing");
    } catch (err) {
      fail("no-preparation-routing", err);
    }

    // 12. Physical print still off
    try {
      assert(config.physicalPrintEnabled === false, "physical off");
      pass("physical-print-disabled");
    } catch (err) {
      fail("physical-print-disabled", err);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      closeDatabase();
    } catch {
      // already closed
    }
  }

  const failed = results.filter((r) => !r.ok);
  const summary = {
    phase: "1.3",
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
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
