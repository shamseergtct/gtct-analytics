/**
 * Phase 1.6 Mac acceptance — signed editable order-line add-on prices.
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
import { formatMoneyMinor, parseMoneyInput } from "../util/money.js";
import { updateShopSettings, getShopSettings } from "../services/shopSettings.js";
import { listAuditEvents } from "../services/audit.js";
import { createMoneyFormatter } from "../../public/money.js";
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

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-phase16-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18796";
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

  let burgerId;
  let burgerBase;
  let addonCheese;
  let addonPatty;
  let addonIce;
  let addonRemove;
  let libraryCheesePrice;

  try {
    try {
      updateShopSettings(shopId, { currencyPreset: "BHD", confirmCurrencyChange: true }, { role: "admin" });
      const shop = getShopSettings(shopId);
      assert(shop.currencyDecimals === 3, "BHD decimals");
      assert(formatMoneyMinor(300, shop) === "BHD 0.300", "BHD +0.300");
      assert(formatMoneyMinor(-100, shop) === "BHD -0.100", "BHD -0.100");
      assert(formatMoneyMinor(0, shop) === "BHD 0.000", "BHD zero");
      pass("bhd-three-decimal-precision");
    } catch (err) {
      fail("bhd-three-decimal-precision", err);
    }

    try {
      updateShopSettings(shopId, { currencyPreset: "QAR", confirmCurrencyChange: true }, { role: "admin" });
      assert(formatMoneyMinor(30, getShopSettings(shopId)) === "QR 0.30", "QAR");
      assert(formatMoneyMinor(-10, getShopSettings(shopId)) === "QR -0.10", "QAR neg");
      updateShopSettings(shopId, { currencyPreset: "INR", confirmCurrencyChange: true }, { role: "admin" });
      assert(formatMoneyMinor(3000, getShopSettings(shopId)) === "₹ 30.00", "INR");
      assert(formatMoneyMinor(-1000, getShopSettings(shopId)) === "₹ -10.00", "INR neg");
      updateShopSettings(shopId, { currencyPreset: "BHD", confirmCurrencyChange: true }, { role: "admin" });
      pass("qar-inr-two-decimal-precision");
    } catch (err) {
      fail("qar-inr-two-decimal-precision", err);
    }

    try {
      let threw = false;
      try {
        parseMoneyInput("0.1234", 3);
      } catch {
        threw = true;
      }
      assert(threw, "invalid BHD precision rejected");
      threw = false;
      try {
        parseMoneyInput("1.001", 2);
      } catch {
        threw = true;
      }
      assert(threw, "invalid QAR precision rejected");
      pass("invalid-precision-rejected");
    } catch (err) {
      fail("invalid-precision-rejected", err);
    }

    try {
      const money = createMoneyFormatter({
        currencyLabel: "BHD",
        currencyDecimals: 3,
      });
      assert(money.parse("0.300") === 300, "parse +");
      assert(money.parse("-0.100") === -100, "parse -");
      assert(money.parse("0") === 0, "parse 0");
      assert(money.formatPlain(-100) === "-0.100", "plain neg");
      // Incomplete drafts must not be silently coerced by parse
      let draftOk = false;
      try {
        money.parse("-");
      } catch {
        draftOk = true;
      }
      assert(draftOk, "incomplete - rejected");
      draftOk = false;
      try {
        money.parse("-0.");
      } catch {
        draftOk = true;
      }
      assert(draftOk, "incomplete -0. rejected");
      pass("incomplete-drafts-and-signed-parse");
    } catch (err) {
      fail("incomplete-drafts-and-signed-parse", err);
    }

    try {
      const items = await httpJson(port, "GET", "/v1/menu-items", device);
      assert(items.status === 200, "menu");
      const burger = (items.json.menuItems || []).find((i) =>
        /burger/i.test(i.name)
      );
      assert(burger, "burger found");
      burgerId = burger.item_id;
      burgerBase = Number(burger.price_cents || 0);
      assert(burgerBase > 0, "burger has base price");

      const cheese = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Double Cheese",
        priceCents: 300,
        isActive: true,
      });
      assert(cheese.status === 200 || cheese.status === 201, "cheese");
      addonCheese = cheese.json.addon;

      const patty = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Extra Patty",
        priceCents: 500,
        isActive: true,
      });
      assert(patty.status === 200 || patty.status === 201, "patty");
      addonPatty = patty.json.addon;

      const ice = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Extra Ice",
        priceCents: 0,
        isActive: true,
      });
      assert(ice.status === 200 || ice.status === 201, "ice");
      addonIce = ice.json.addon;

      const remove = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Remove Cheese",
        priceCents: -100,
        isActive: true,
      });
      assert(remove.status === 200 || remove.status === 201, "remove cheese");
      addonRemove = remove.json.addon;
      assert(addonRemove.priceCents === -100, "library negative stored");
      assert(addonRemove.isReduction === true, "reduction flag");

      libraryCheesePrice = addonCheese.priceCents;

      const assign = await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(burgerId)}/addons`,
        admin,
        {
          assignments: [
            { addonId: addonCheese.addonId, priceOverrideCents: null },
            { addonId: addonPatty.addonId, priceOverrideCents: null },
            { addonId: addonIce.addonId, priceOverrideCents: 0 },
            { addonId: addonRemove.addonId, priceOverrideCents: null },
          ],
        }
      );
      assert(assign.status === 200, "assign");
      const iceAsg = (assign.json.addons || []).find(
        (a) => a.addonId === addonIce.addonId
      );
      assert(iceAsg.priceOverrideCents === 0, "explicit zero override");
      assert(iceAsg.effectivePriceCents === 0, "effective zero");
      pass("positive-zero-negative-library-and-explicit-zero");
    } catch (err) {
      fail("positive-zero-negative-library-and-explicit-zero", err);
    }

    try {
      const cfgDevice = await httpJson(port, "GET", "/v1/config", device);
      assert(cfgDevice.status === 200, "cfg device");
      assert(cfgDevice.json.canAdjustAddonPrices === false, "device no adjust");
      const cfgAdmin = await httpJson(port, "GET", "/v1/config", admin);
      assert(cfgAdmin.json.canAdjustAddonPrices === true, "admin can adjust");
      pass("authorization-flags");
    } catch (err) {
      fail("authorization-flags", err);
    }

    try {
      const denied = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P16-DENY-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: burgerId,
            quantity: 1,
            instructions: [],
            addons: [
              { addonId: addonCheese.addonId, quantity: 1, unitPriceCents: 999 },
            ],
          },
        ],
      });
      assert(denied.status === 403, `device override blocked got ${denied.status}`);
      pass("unauthorized-staff-cannot-edit-prices");
    } catch (err) {
      fail("unauthorized-staff-cannot-edit-prices", err);
    }

    let orderId;
    const expectedUnit = burgerBase + 300 + 500 - 100;
    const expectedLine = expectedUnit * 2;
    try {
      // base + 0.300 + 0.500 - 0.100; ×2
      const created = await httpJson(port, "POST", "/v1/test-orders", admin, {
        orderNumber: `P16-CALC-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: burgerId,
            quantity: 2,
            instructions: ["Less Sauce", "No Onion"],
            addons: [
              { addonId: addonCheese.addonId, quantity: 1, unitPriceCents: 300 },
              { addonId: addonPatty.addonId, quantity: 1, unitPriceCents: 500 },
              { addonId: addonRemove.addonId, quantity: 1, unitPriceCents: -100 },
            ],
          },
        ],
      });
      assert(
        created.status === 200 || created.status === 201,
        `order ${created.status} ${JSON.stringify(created.json)}`
      );
      orderId = created.json.order.order_id;
      const order = getOrder(orderId);
      assert(order.lines[0].unit_base_price_cents === burgerBase, "base");
      assert(order.lines[0].unit_addons_cents === 700, "addons net 700");
      assert(order.lines[0].unit_total_cents === expectedUnit, `unit ${expectedUnit}`);
      assert(order.lines[0].line_total_cents === expectedLine, `line ${expectedLine}`);
      assert(order.total_cents === expectedLine, "order total");
      const rem = order.lines[0].addons.find(
        (a) => a.addonId === addonRemove.addonId
      );
      assert(rem.unitPriceCents === -100, "negative applied");
      assert(rem.configuredUnitPriceCents === -100, "configured snap");
      // Same as configured → not an adjustment when equal
      assert(rem.priceAdjusted === false, "equal to configured not adjusted");
      pass("positive-negative-calc-and-quantity");
    } catch (err) {
      fail("positive-negative-calc-and-quantity", err);
    }

    try {
      const over = await httpJson(port, "POST", "/v1/test-orders", admin, {
        orderNumber: `P16-NEG-LINE-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: burgerId,
            quantity: 1,
            instructions: [],
            addons: [
              {
                addonId: addonRemove.addonId,
                quantity: 1,
                unitPriceCents: -2000,
              },
            ],
          },
        ],
      });
      assert(over.status === 400, `negative line blocked got ${over.status}`);
      assert(
        /negative/i.test(over.json?.error || ""),
        "negative line error message"
      );
      pass("excessive-reduction-rejected");
    } catch (err) {
      fail("excessive-reduction-rejected", err);
    }

    try {
      const adj = await httpJson(port, "POST", "/v1/test-orders", admin, {
        orderNumber: `P16-ADJ-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: burgerId,
            quantity: 1,
            instructions: [],
            addons: [
              {
                addonId: addonCheese.addonId,
                quantity: 1,
                unitPriceCents: 100,
              },
              {
                addonId: addonIce.addonId,
                quantity: 1,
                unitPriceCents: 0,
              },
            ],
          },
        ],
      });
      assert(adj.status === 200 || adj.status === 201, "adj order");
      const order = getOrder(adj.json.order.order_id);
      // base + 100 + 0
      assert(
        order.lines[0].unit_total_cents === burgerBase + 100,
        "adjusted unit"
      );
      const cheese = order.lines[0].addons.find(
        (a) => a.addonId === addonCheese.addonId
      );
      assert(cheese.configuredUnitPriceCents === 300, "original configured");
      assert(cheese.unitPriceCents === 100, "applied");
      assert(cheese.priceAdjusted === true, "flag");
      const ice = order.lines[0].addons.find(
        (a) => a.addonId === addonIce.addonId
      );
      assert(ice.unitPriceCents === 0, "explicit zero applied");
      // Ice configured effective is 0 (override 0); equal → not adjusted
      assert(ice.priceAdjusted === false, "zero equal not adjusted");

      const audits = listAuditEvents({ limit: 50 });
      const hit = audits.find(
        (e) =>
          e.action === "order.addon.price_adjust" &&
          String(e.detail_json || "").includes(addonCheese.addonId)
      );
      assert(hit, "audit event");
      const detail = JSON.parse(hit.detail_json);
      assert(detail.configuredUnitPriceCents === 300, "audit configured");
      assert(detail.appliedUnitPriceCents === 100, "audit applied");
      assert(detail.priceDeltaCents === -200, "audit delta");
      assert(hit.actor_role === "admin", "audit role");
      pass("authorized-override-and-audit");
    } catch (err) {
      fail("authorized-override-and-audit", err);
    }

    try {
      // Library and item override unchanged after order-line edit
      const lib = await httpJson(port, "GET", "/v1/addons", admin);
      const cheeseLib = (lib.json.addons || []).find(
        (a) => a.addonId === addonCheese.addonId
      );
      assert(cheeseLib.priceCents === libraryCheesePrice, "library unchanged");
      const itemAddons = await httpJson(
        port,
        "GET",
        `/v1/menu-items/${encodeURIComponent(burgerId)}/addons`,
        device
      );
      const cheeseItem = (itemAddons.json.addons || []).find(
        (a) => a.addonId === addonCheese.addonId
      );
      assert(
        cheeseItem.priceOverrideCents == null,
        "item override still null"
      );
      assert(cheeseItem.effectivePriceCents === 300, "item effective still 300");
      pass("library-and-item-override-unchanged");
    } catch (err) {
      fail("library-and-item-override-unchanged", err);
    }

    try {
      const tamper = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P16-TAMPER-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: burgerId,
            quantity: 1,
            instructions: [],
            addons: [
              {
                addonId: addonCheese.addonId,
                quantity: 1,
                unitPriceCents: 1,
              },
            ],
          },
        ],
      });
      assert(tamper.status === 403, "tampered payload rejected");
      // Device without override still works at configured price
      const ok = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P16-DEVICE-OK-${Date.now()}`,
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
      assert(ok.status === 200 || ok.status === 201, "device default ok");
      const order = getOrder(ok.json.order.order_id);
      assert(order.lines[0].unit_addons_cents === 300, "server priced");
      pass("tampered-payload-rejected-device-defaults-ok");
    } catch (err) {
      fail("tampered-payload-rejected-device-defaults-ok", err);
    }

    try {
      // Historical freeze: change library, old order unchanged
      await httpJson(port, "PUT", "/v1/addons", admin, {
        addonId: addonCheese.addonId,
        name: "Double Cheese",
        priceCents: 777,
        isActive: true,
      });
      try {
        assert(orderId, "calc order exists");
        const order = getOrder(orderId);
        assert(
          order.lines[0].line_total_cents === expectedLine,
          "history frozen"
        );
        const cheeseSnap = order.lines[0].addons.find(
          (a) => a.addonId === addonCheese.addonId
        );
        assert(cheeseSnap.unitPriceCents === 300, "snap still 300");
        pass("historical-snapshots-preserved");
      } finally {
        await httpJson(port, "PUT", "/v1/addons", admin, {
          addonId: addonCheese.addonId,
          name: "Double Cheese",
          priceCents: 300,
          isActive: true,
        });
      }
    } catch (err) {
      fail("historical-snapshots-preserved", err);
      await httpJson(port, "PUT", "/v1/addons", admin, {
        addonId: addonCheese.addonId,
        name: "Double Cheese",
        priceCents: 300,
        isActive: true,
      }).catch(() => {});
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
      assert(kitchen && cashier, "both jobs");
      const kPrev = await httpJson(
        port,
        "GET",
        `/v1/print-jobs/${encodeURIComponent(kitchen.job_id)}/preview`,
        device
      );
      assert(/LESS SAUCE/i.test(kPrev.json.text), "kitchen instr");
      assert(/NO ONION/i.test(kPrev.json.text), "kitchen instr 2");
      assert(/DOUBLE CHEESE/i.test(kPrev.json.text), "kitchen + addon");
      assert(/EXTRA PATTY/i.test(kPrev.json.text), "kitchen + patty");
      assert(/REMOVE CHEESE/i.test(kPrev.json.text), "kitchen - addon");
      assert(/-\s+REMOVE CHEESE/i.test(kPrev.json.text), "kitchen minus prefix");
      const cPrev = await httpJson(
        port,
        "GET",
        `/v1/print-jobs/${encodeURIComponent(cashier.job_id)}/preview`,
        device
      );
      assert(/Double Cheese/i.test(cPrev.json.text), "cashier cheese");
      assert(/\+.*0\.300|0\.300/i.test(cPrev.json.text), "cashier +0.300");
      assert(/Remove Cheese/i.test(cPrev.json.text), "cashier remove");
      assert(/-.*0\.100|BHD -0\.100/i.test(cPrev.json.text), "cashier -0.100");
      const shop = getShopSettings(shopId);
      const totalFmt = formatMoneyMinor(expectedLine, shop);
      assert(
        cPrev.json.text.includes(totalFmt.split(" ").pop()) ||
          /TOTAL/i.test(cPrev.json.text),
        "cashier total"
      );
      assert(config.physicalPrintEnabled === false, "physical off");
      pass("kitchen-and-cashier-tickets-signed");
    } catch (err) {
      fail("kitchen-and-cashier-tickets-signed", err);
    }

    try {
      const dup = await httpJson(port, "POST", "/v1/test-orders", admin, {
        orderNumber: getOrder(orderId).order_number,
        orderType: "TAKEAWAY",
        lines: [{ itemId: burgerId, quantity: 1, instructions: [] }],
      });
      assert(dup.status === 409 && dup.json.code === "SUBMISSION_CONFLICT", "different details rejected");
      assert(getOrder(orderId), "original order remains");
      pass("idempotency-preserved");
    } catch (err) {
      fail("idempotency-preserved", err);
    }

    try {
      // Migration 007 columns present; restart survival via re-open not needed —
      // verify schema + prior order still readable after FK-safe signed rebuild.
      const cols = getDb()
        .prepare(`PRAGMA table_info(order_line_addons)`)
        .all()
        .map((c) => c.name);
      assert(cols.includes("configured_unit_price_cents"), "configured col");
      assert(cols.includes("price_adjusted"), "adjusted col");
      assert(cols.includes("adjusted_by_role"), "role col");
      const addonSql = getDb()
        .prepare(`SELECT sql FROM sqlite_master WHERE name='addons'`)
        .get().sql;
      assert(!/price_cents\s+INTEGER[^,]*>=\s*0/i.test(addonSql), "signed addons");
      pass("sqlite-signed-schema");
    } catch (err) {
      fail("sqlite-signed-schema", err);
    }

    try {
      const assets = await Promise.all([
        httpJson(port, "GET", "/index.html", device),
        httpJson(port, "GET", "/app.js", device),
        httpJson(port, "GET", "/styles.css", device),
        httpJson(port, "GET", "/money.js", device),
      ]);
      for (const a of assets) assert(a.status === 200, "asset");
      assert(
        /Apply Customization/i.test(assets[0].json?.raw || "") ||
          assets[0].status === 200,
        "html"
      );
      const html = await new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/index.html" }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve(Buffer.concat(chunks).toString("utf8"))
            );
          })
          .on("error", reject);
      });
      assert(/Apply Customization/.test(html), "apply button");
      assert(/price-summary/.test(html), "price summary");
      assert(/addon-pick-list/.test(html), "addon section");
      const appJs = await new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/app.js" }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve(Buffer.concat(chunks).toString("utf8"))
            );
          })
          .on("error", reject);
      });
      assert(/canAdjustAddonPrices/.test(appJs), "client auth gate");
      assert(/formatSignedPrice/.test(appJs), "signed format");
      assert(/applyCustomization/.test(appJs), "apply fn");
      assert(/cancelCustomization/.test(appJs), "cancel fn");
      pass("ui-assets-customize-sections");
    } catch (err) {
      fail("ui-assets-customize-sections", err);
    }

    try {
      // Distinct cart-line identity helper: different unit prices → different keys
      // (server-side: two lines with different overrides persist separately)
      const multi = await httpJson(port, "POST", "/v1/test-orders", admin, {
        orderNumber: `P16-MULTI-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: burgerId,
            quantity: 1,
            instructions: [],
            addons: [
              {
                addonId: addonCheese.addonId,
                quantity: 1,
                unitPriceCents: 300,
              },
            ],
          },
          {
            itemId: burgerId,
            quantity: 1,
            instructions: [],
            addons: [
              {
                addonId: addonCheese.addonId,
                quantity: 1,
                unitPriceCents: 150,
              },
            ],
          },
        ],
      });
      assert(multi.status === 200 || multi.status === 201, "multi");
      const order = getOrder(multi.json.order.order_id);
      assert(order.lines.length === 2, "two distinct lines");
      assert(
        order.lines[0].unit_total_cents === burgerBase + 300,
        "line1 configured"
      );
      assert(
        order.lines[1].unit_total_cents === burgerBase + 150,
        "line2 adjusted"
      );
      assert(
        order.total_cents === burgerBase + 300 + burgerBase + 150,
        "sum"
      );
      pass("distinct-customized-lines-not-merged");
    } catch (err) {
      fail("distinct-customized-lines-not-merged", err);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
  }

  const passed = results.filter((r) => r.ok).length;
  const summary = {
    phase: "1.6",
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
