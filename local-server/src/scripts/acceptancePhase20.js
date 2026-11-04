/**
 * Phase 2.0 Mac acceptance — Product Knowledge & Salesman Training.
 * Informational only; does not alter prices, tax, cart math, or printing.
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
import { getMenuItem } from "../services/menuMappings.js";
import { getProductKnowledge } from "../services/productKnowledge.js";
import { processAllPending } from "../print/dispatcher.js";
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
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            json,
          });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function httpText(port, pathName) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method: "GET",
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
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

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-phase20-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18820";
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

  let sampleItemId = null;
  let samplePriceCents = null;
  let sampleName = null;

  try {
    // 1. Existing items load without Product Knowledge
    try {
      const list = await httpJson(port, "GET", "/v1/menu-items?includeInactive=0", device);
      assert(list.ok, `menu list ${list.status}`);
      assert(Array.isArray(list.json.menuItems) && list.json.menuItems.length > 0, "menu empty");
      const item = list.json.menuItems[0];
      sampleItemId = item.item_id;
      samplePriceCents = Number(item.price_cents);
      sampleName = item.name;
      const pk = await httpJson(
        port,
        "GET",
        `/v1/menu-items/${encodeURIComponent(sampleItemId)}/product-knowledge`,
        device
      );
      assert(pk.ok, `pk get ${pk.status}`);
      assert(pk.json.itemId === sampleItemId, "itemId mismatch");
      assert(pk.json.productKnowledge, "missing productKnowledge");
      assert(
        Object.prototype.hasOwnProperty.call(pk.json.productKnowledge, "staffTrainingNotes") === false,
        "device must not see staffTrainingNotes"
      );
      pass("1 existing items load without product knowledge");
    } catch (err) {
      fail("1 existing items load without product knowledge", err);
    }

    // 2–4 Admin add/edit + persistence fields
    try {
      const payload = {
        detailedDescription:
          "A tortilla wrap prepared using chicken nuggets, twister and a special mix, served with French fries.",
        salesmanQuickAnswer:
          "It's a special tortilla wrap with chicken nuggets, twister and our special mix, served with French fries.",
        specialFeatures: "Crispy texture · served with fries",
        ingredients: ["Chicken Nuggets", "Twister", "Tortilla Bread", "Special Mix", "French Fries"],
        brand: "House Special",
        ingredientBrand: "",
        prepTimeMin: 5,
        prepTimeMax: 8,
        servingStyle: "Served as a wrap",
        servingAccompaniments: "French fries",
        serviceNotes: "Hand to customer with napkin",
        allergenNotes: "Contains gluten and dairy",
        allergenVerified: true,
        staffTrainingNotes: "Remind staff to upsell drink",
      };
      const put = await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(sampleItemId)}/product-knowledge`,
        admin,
        payload
      );
      assert(put.ok, `admin put ${put.status} ${put.json?.error || ""}`);
      assert(put.json.productKnowledge.salesmanQuickAnswer.includes("tortilla"), "quick answer");
      assert(put.json.productKnowledge.ingredients.length === 5, "ingredients count");
      assert(put.json.productKnowledge.staffTrainingNotes.includes("upsell"), "admin training notes");

      const again = await httpJson(
        port,
        "GET",
        `/v1/menu-items/${encodeURIComponent(sampleItemId)}/product-knowledge`,
        admin
      );
      assert(again.ok, "admin get after put");
      assert(again.json.hasContent === true, "hasContent");
      assert(again.json.productKnowledge.prepTimeMin === 5, "prep min");
      assert(again.json.productKnowledge.prepTimeMax === 8, "prep max");
      assert(again.json.productKnowledge.brand === "House Special", "brand");

      const edit = await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(sampleItemId)}/product-knowledge`,
        admin,
        { salesmanQuickAnswer: "Crispy chicken wrap with fries — our special mix." }
      );
      assert(edit.ok, `edit ${edit.status}`);
      assert(
        edit.json.productKnowledge.salesmanQuickAnswer.startsWith("Crispy chicken"),
        "edited quick answer"
      );
      assert(edit.json.productKnowledge.ingredients.length === 5, "ingredients preserved on partial edit");
      pass("2-4 admin add/edit product knowledge");
    } catch (err) {
      fail("2-4 admin add/edit product knowledge", err);
    }

    // 5 Device can read allowed fields
    try {
      const pk = await httpJson(
        port,
        "GET",
        `/v1/menu-items/${encodeURIComponent(sampleItemId)}/product-knowledge`,
        device
      );
      assert(pk.ok, `device read ${pk.status}`);
      assert(pk.json.productKnowledge.salesmanQuickAnswer, "device sees quick answer");
      assert(pk.json.productKnowledge.ingredients?.length === 5, "device sees ingredients");
      assert(
        !Object.prototype.hasOwnProperty.call(
          pk.json.productKnowledge,
          "staffTrainingNotes"
        ),
        "device no training notes"
      );
      pass("5 device can read product knowledge");
    } catch (err) {
      fail("5 device can read product knowledge", err);
    }

    // 6 Device cannot edit
    try {
      const denied = await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(sampleItemId)}/product-knowledge`,
        device,
        { salesmanQuickAnswer: "Hacked" }
      );
      assert(denied.status === 403 || denied.status === 401, `expected 403 got ${denied.status}`);
      const check = getProductKnowledge(sampleItemId, { role: "admin" });
      assert(!check.salesmanQuickAnswer.includes("Hacked"), "device write blocked");
      pass("6 device cannot edit product knowledge");
    } catch (err) {
      fail("6 device cannot edit product knowledge", err);
    }

    // 7–9 Sales UI markup: Info control present; card structure avoids nested buttons
    try {
      const page = await httpText(port, "/");
      assert(page.status === 200, "sales html");
      assert(page.text.includes('id="pk-dialog"'), "pk dialog markup");
      const appJs = await httpText(port, "/app.js");
      assert(appJs.status === 200, "app.js");
      assert(appJs.text.includes("menu-card-info"), "info button class");
      assert(appJs.text.includes("openProductKnowledge"), "openProductKnowledge");
      assert(appJs.text.includes("View information about"), "accessible name");
      assert(appJs.text.includes("stopPropagation"), "click isolation");
      assert(appJs.text.includes('createElement("article")'), "article card shell");
      pass("7-9 sales info button markup and isolation hooks");
    } catch (err) {
      fail("7-9 sales info button markup and isolation hooks", err);
    }

    // 10–12 Cart / variants still work (API-level; UI manual)
    try {
      const menu = await httpJson(port, "GET", "/v1/menu-items?includeInactive=0", device);
      const item = menu.json.menuItems.find((i) => i.item_id === sampleItemId);
      assert(item, "sample item");
      assert(Number(item.price_cents) === samplePriceCents, "price unchanged after PK");

      const order = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `PK-TEST-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: sampleItemId,
            quantity: 1,
          },
        ],
      });
      assert(order.ok, `order ${order.status} ${order.json?.error || ""}`);
      assert(order.json.order?.order_id, "order id");
      pass("10-12 order submission still works; price unchanged");
    } catch (err) {
      fail("10-12 order submission still works; price unchanged", err);
    }

    // 13–18 Content fields, empty state, prep time honesty
    try {
      const emptyItem = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        name: `PK Empty ${Date.now()}`,
        priceCents: 100,
        category: "Test",
        description: "",
        stationIds: [],
        isActive: true,
      });
      assert(emptyItem.ok, `create empty ${emptyItem.status} ${emptyItem.json?.error || ""}`);
      const emptyId = emptyItem.json.menuItem.item_id;
      const emptyPk = await httpJson(
        port,
        "GET",
        `/v1/menu-items/${encodeURIComponent(emptyId)}/product-knowledge`,
        device
      );
      assert(emptyPk.ok, "empty pk get");
      assert(emptyPk.json.hasContent === false, "empty hasContent false");

      const partial = await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(emptyId)}/product-knowledge`,
        admin,
        { brand: "Only Brand" }
      );
      assert(partial.ok, "partial put");
      const partialGet = await httpJson(
        port,
        "GET",
        `/v1/menu-items/${encodeURIComponent(emptyId)}/product-knowledge`,
        device
      );
      assert(partialGet.json.hasContent === true, "partial has content");
      assert(partialGet.json.productKnowledge.prepTimeMin == null, "no invented prep time");
      assert(partialGet.json.productKnowledge.brand === "Only Brand", "brand only");
      pass("13-18 content, empty state, no invented prep time");
    } catch (err) {
      fail("13-18 content, empty state, no invented prep time", err);
    }

    // 20 XSS / script injection stored safely as text (API returns raw; UI escapes)
    try {
      const xss = await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(sampleItemId)}/product-knowledge`,
        admin,
        {
          salesmanQuickAnswer: `<script>alert("x")</script>`,
          detailedDescription: `<img src=x onerror=alert(1)>`,
        }
      );
      assert(xss.ok, `xss put ${xss.status}`);
      assert(
        xss.json.productKnowledge.salesmanQuickAnswer.includes("<script>"),
        "stored as plain text"
      );
      const appJs = await httpText(port, "/app.js");
      assert(appJs.text.includes("escapeHtml"), "UI escapes HTML");
      assert(appJs.text.includes("pkPlainPara"), "plain text renderer");
      pass("20 script content stored as text; UI escape helpers present");
    } catch (err) {
      fail("20 script content stored as text; UI escape helpers present", err);
    }

    // 21 Unicode
    try {
      const uni = await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(sampleItemId)}/product-knowledge`,
        admin,
        {
          salesmanQuickAnswer: "ചിക്കൻ ക്രിസ്പി — دجاج مقرمش — Crispy ✓",
          ingredients: ["നുഗറ്റ്", "خبز", "Fries"],
        }
      );
      assert(uni.ok, `unicode ${uni.status}`);
      assert(uni.json.productKnowledge.salesmanQuickAnswer.includes("ചിക്കൻ"), "ml");
      assert(uni.json.productKnowledge.salesmanQuickAnswer.includes("دجاج"), "ar");
      pass("21 unicode descriptions persist");
    } catch (err) {
      fail("21 unicode descriptions persist", err);
    }

    // 26 Menu Setup save via upsert with productKnowledge
    try {
      const before = getMenuItem(sampleItemId);
      const upsert = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: sampleItemId,
        name: before.name,
        priceCents: before.price_cents,
        categoryId: before.category_id,
        subcategoryId: before.subcategory_id,
        description: "A special crispy chicken tortilla wrap served with French fries.",
        stationIds: before.stationIds || [],
        isActive: true,
        isSoldOut: false,
        taxApplicable: before.taxApplicable !== false,
        productKnowledge: {
          salesmanQuickAnswer: "Saved via menu upsert workflow.",
          ingredients: ["Chicken Nuggets", "Tortilla"],
        },
      });
      assert(upsert.ok, `upsert ${upsert.status} ${upsert.json?.error || ""}`);
      assert(Number(upsert.json.menuItem.price_cents) === samplePriceCents, "price preserved");
      const pk = getProductKnowledge(sampleItemId, { role: "admin" });
      assert(pk.salesmanQuickAnswer.includes("menu upsert"), "pk via upsert");
      assert(upsert.json.menuItem.description.includes("crispy chicken"), "short desc reused");
      pass("26 menu setup upsert preserves item and saves knowledge");
    } catch (err) {
      fail("26 menu setup upsert preserves item and saves knowledge", err);
    }

    // 27–28 prices/tax unchanged smoke via menu item
    try {
      const item = getMenuItem(sampleItemId);
      assert(Number(item.price_cents) === samplePriceCents, "price stable");
      assert(typeof item.taxApplicable === "boolean", "tax flag present");
      pass("27-28 prices and tax flags unchanged");
    } catch (err) {
      fail("27-28 prices and tax flags unchanged", err);
    }

    // 31–32 MOCK print still works; physical disabled
    try {
      assert(!process.env.GTCT_ENABLE_PHYSICAL_PRINT, "physical print env off");
      const order = await httpJson(port, "POST", "/v1/test-orders", admin, {
        orderNumber: `PK-PRINT-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T2",
        lines: [{ itemId: sampleItemId, quantity: 1 }],
      });
      assert(order.ok, `print order ${order.status}`);
      await processAllPending(config);
      pass("31-32 MOCK dispatcher runs; physical printing disabled");
    } catch (err) {
      fail("31-32 MOCK dispatcher runs; physical printing disabled", err);
    }

    // 33 DB not reset — migration table still has prior migrations + 013
    try {
      const rows = getDb()
        .prepare(`SELECT name FROM schema_migrations ORDER BY name`)
        .all()
        .map((r) => r.name);
      assert(rows.includes("013_product_knowledge.js"), "013 applied");
      assert(rows.some((n) => n.startsWith("001_")), "baseline retained");
      const items = getDb().prepare(`SELECT COUNT(*) AS c FROM menu_items`).get().c;
      assert(items > 0, "menu items retained");
      pass("33 sqlite not reset; migration 013 applied");
    } catch (err) {
      fail("33 sqlite not reset; migration 013 applied", err);
    }

    // Validation: length / prep range
    try {
      const bad = await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(sampleItemId)}/product-knowledge`,
        admin,
        { prepTimeMin: 10, prepTimeMax: 5 }
      );
      assert(bad.status === 400, `prep range ${bad.status}`);
      const long = await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(sampleItemId)}/product-knowledge`,
        admin,
        { brand: "x".repeat(200) }
      );
      assert(long.status === 400, `brand length ${long.status}`);
      pass("validation rejects bad prep range and overlong brand");
    } catch (err) {
      fail("validation rejects bad prep range and overlong brand", err);
    }

    // Menu Setup UI present
    try {
      const menuHtml = await httpText(port, "/menu.html");
      assert(menuHtml.status === 200, "menu.html");
      assert(menuHtml.text.includes("product-knowledge-section"), "pk section");
      assert(
        menuHtml.text.includes("What should the salesman tell the customer?"),
        "quick answer field"
      );
      assert(menuHtml.text.includes("f-pk-quick"), "quick answer id");
      pass("menu setup product information editor present");
    } catch (err) {
      fail("menu setup product information editor present", err);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    JSON.stringify(
      {
        phase: "2.0",
        passed: results.filter((r) => r.ok).length,
        failed: failed.length,
        sampleItemId,
        sampleName,
        results,
      },
      null,
      2
    )
  );
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
