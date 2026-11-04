/**
 * Phase 1.8 Mac acceptance — item/add-on tax applicability, mixed buckets.
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
import { getAddon } from "../services/addons.js";
import { updateShopSettings, getShopSettings } from "../services/shopSettings.js";
import { listAuditEvents } from "../services/audit.js";
import {
  computeOrderTaxFromBuckets,
  mulDivRoundHalfUp,
  splitUnitTaxBuckets,
} from "../services/tax.js";
import { formatMoneyMinor } from "../util/money.js";
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

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-phase18-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18798";
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
  let waterId;
  let cheeseId;
  let removeId;
  let iceId;
  let freeId;

  try {
    // --- Migration defaults ---
    try {
      const db = getDb();
      const cols = db.prepare(`PRAGMA table_info(menu_items)`).all();
      assert(
        cols.some((c) => c.name === "tax_applicable"),
        "menu tax_applicable col"
      );
      const acol = db.prepare(`PRAGMA table_info(addons)`).all();
      assert(
        acol.some((c) => c.name === "tax_applicable"),
        "addon tax_applicable col"
      );
      const items = await httpJson(port, "GET", "/v1/menu-items", admin);
      assert(items.status === 200, "list items");
      const seeded = items.json.menuItems || [];
      assert(seeded.length > 0, "seeded items");
      assert(
        seeded.every((i) => i.taxApplicable !== false),
        "existing items default taxable"
      );
      burgerId = seeded.find((i) => /burger/i.test(i.name))?.item_id;
      assert(burgerId, "burger id");
      pass("migrate-item-tax-defaults");
    } catch (err) {
      fail("migrate-item-tax-defaults", err);
    }

    // --- Menu item tax toggle + auth ---
    try {
      const deny = await httpJson(port, "PUT", "/v1/menu-items", device, {
        itemId: burgerId,
        name: "Chicken Burger",
        priceCents: 1800,
        taxApplicable: false,
      });
      assert(deny.status === 403, "device cannot set item tax");

      const off = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: burgerId,
        name: "Chicken Burger",
        priceCents: 1800,
        categoryId: getMenuItem(burgerId)?.category_id,
        stationIds: getMenuItem(burgerId)?.stationIds || ["station_grill"],
        taxApplicable: false,
      });
      assert(off.status === 200, `item tax off ${off.status}`);
      assert(off.json.menuItem.taxApplicable === false, "flag off");
      assert(getMenuItem(burgerId).taxApplicable === false, "db off");

      const on = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: burgerId,
        name: "Chicken Burger",
        priceCents: 1800,
        categoryId: getMenuItem(burgerId)?.category_id,
        stationIds: getMenuItem(burgerId)?.stationIds || ["station_grill"],
        taxApplicable: true,
      });
      assert(on.status === 200 && on.json.menuItem.taxApplicable === true, "re-enable");

      const audits = listAuditEvents({ limit: 50 });
      assert(
        audits.some((a) => {
          if (a.action !== "menu.tax_applicable" || a.entity_id !== burgerId) {
            return false;
          }
          const d = JSON.parse(a.detail_json || "{}");
          return d.newTaxApplicable === true;
        }),
        "item tax audit"
      );
      pass("menu-item-tax-toggle-auth");
    } catch (err) {
      fail("menu-item-tax-toggle-auth", err);
    }

    // --- Add-on tax defaults + toggle ---
    try {
      const cheese = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Double Cheese P18",
        priceCents: 300,
        taxApplicable: true,
      });
      assert(cheese.status === 200, "cheese create");
      cheeseId = cheese.json.addon.addonId;
      assert(cheese.json.addon.taxApplicable === true, "cheese taxable default");

      const remove = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Remove Cheese P18",
        priceCents: -100,
        taxApplicable: true,
      });
      removeId = remove.json.addon.addonId;

      const ice = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Extra Ice P18",
        priceCents: 0,
        taxApplicable: false,
      });
      iceId = ice.json.addon.addonId;
      assert(ice.json.addon.taxApplicable === false, "ice no tax");

      const free = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Free Sauce P18",
        priceCents: 0,
        taxApplicable: true,
      });
      freeId = free.json.addon.addonId;

      const denyAddon = await httpJson(port, "PUT", "/v1/addons", device, {
        addonId: cheeseId,
        name: "Double Cheese P18",
        priceCents: 300,
        taxApplicable: false,
      });
      assert(denyAddon.status === 403, "device cannot set addon tax");

      const toggle = await httpJson(port, "PUT", "/v1/addons", admin, {
        addonId: cheeseId,
        name: "Double Cheese P18",
        priceCents: 300,
        taxApplicable: false,
      });
      assert(toggle.json.addon.taxApplicable === false, "cheese off");
      assert(getAddon(cheeseId).taxApplicable === false, "persist off");

      await httpJson(port, "PUT", "/v1/addons", admin, {
        addonId: cheeseId,
        name: "Double Cheese P18",
        priceCents: 300,
        taxApplicable: true,
      });
      assert(getAddon(cheeseId).taxApplicable === true, "persist on");

      // Existing addons from any prior phase — library list defaults
      const lib = await httpJson(port, "GET", "/v1/addons", admin);
      assert(
        (lib.json.addons || []).every((a) => typeof a.taxApplicable === "boolean"),
        "all addons have tax flag"
      );
      pass("addon-tax-toggle-auth");
    } catch (err) {
      fail("addon-tax-toggle-auth", err);
    }

    // Water non-taxable + assign addons to burger
    try {
      updateShopSettings(
        shopId,
        { currencyPreset: "BHD", confirmCurrencyChange: true },
        { role: "admin" }
      );

      const water = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        name: "Bottled Water P18",
        priceCents: 500,
        category: "Drinks",
        stationIds: [],
        taxApplicable: false,
      });
      assert(water.status === 200, "water create");
      waterId = water.json.menuItem.item_id;
      assert(water.json.menuItem.taxApplicable === false, "water no tax");

      // Override price must not change taxability
      await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(burgerId)}/addons`,
        admin,
        {
          assignments: [
            { addonId: cheeseId, priceOverrideCents: 350 },
            { addonId: removeId, priceOverrideCents: null },
            { addonId: iceId, priceOverrideCents: null },
            { addonId: freeId, priceOverrideCents: null },
          ],
        }
      );
      const assigned = await httpJson(
        port,
        "GET",
        `/v1/menu-items/${encodeURIComponent(burgerId)}/addons`,
        admin
      );
      const cheeseAssign = (assigned.json.addons || []).find(
        (a) => a.addonId === cheeseId
      );
      assert(cheeseAssign?.priceOverrideCents === 350, "override kept");
      assert(cheeseAssign?.taxApplicable === true, "override independent of tax");
      pass("water-and-addon-overrides");
    } catch (err) {
      fail("water-and-addon-overrides", err);
    }

    // Unit: bucket split + engine
    try {
      const u = splitUnitTaxBuckets(1500, true, [
        { linePriceCents: 300, taxApplicable: true },
        { linePriceCents: 500, taxApplicable: false },
      ]);
      assert(u.taxableUnitCents === 1800 && u.nontaxableUnitCents === 500, "split");
      const ex = computeOrderTaxFromBuckets(
        { taxableCents: 1800, nontaxableCents: 500 },
        {
          taxEnabled: true,
          taxMode: "exclusive",
          taxRateBps: 1000,
          taxName: "VAT",
        }
      );
      assert(ex.goodsCents === 2300, "goods");
      assert(ex.taxCents === 180, "tax 10% of 1800");
      assert(ex.totalCents === 2480, "total excl");

      const inc = computeOrderTaxFromBuckets(
        { taxableCents: 1650, nontaxableCents: 500 },
        {
          taxEnabled: true,
          taxMode: "inclusive",
          taxRateBps: 1000,
          taxName: "VAT",
        }
      );
      assert(inc.totalCents === 2150, "incl total unchanged");
      assert(inc.taxCents === 150, "incl tax extracted");
      assert(inc.netCents === 2000, "incl net");

      let threw = false;
      try {
        computeOrderTaxFromBuckets(
          { taxableCents: -1, nontaxableCents: 0 },
          { taxEnabled: true, taxMode: "exclusive", taxRateBps: 1000 }
        );
      } catch {
        threw = true;
      }
      assert(threw, "reject negative taxable");
      pass("tax-bucket-engine");
    } catch (err) {
      fail("tax-bucket-engine", err);
    }

    // Exclusive scenarios
    try {
      await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: true,
        taxMode: "exclusive",
        taxRatePercent: "10",
        taxName: "VAT",
      });

      // Taxable item only (burger 1800)
      await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: burgerId,
        name: "Chicken Burger",
        priceCents: 1800,
        categoryId: getMenuItem(burgerId)?.category_id,
        stationIds: getMenuItem(burgerId)?.stationIds || ["station_grill"],
        taxApplicable: true,
      });
      let r = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P18-EX-ITEM-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: burgerId, quantity: 1 }],
      });
      let o = getOrder(r.json.order.order_id);
      assert(o.taxable_goods_cents === 1800, "excl item taxable");
      assert(o.nontaxable_goods_cents === 0, "excl item nontax 0");
      assert(o.tax_cents === 180, "excl item tax");
      assert(o.total_cents === 1980, "excl item total");

      // Non-taxable only
      r = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P18-EX-WATER-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: waterId, quantity: 1 }],
      });
      o = getOrder(r.json.order.order_id);
      assert(o.taxable_goods_cents === 0, "water taxable 0");
      assert(o.nontaxable_goods_cents === 500, "water nontax");
      assert(o.tax_cents === 0 && o.total_cents === 500, "water no tax");

      // Mixed items
      r = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P18-EX-MIX-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          { itemId: burgerId, quantity: 1 },
          { itemId: waterId, quantity: 1 },
        ],
      });
      o = getOrder(r.json.order.order_id);
      assert(o.goods_cents === 2300, "mix goods");
      assert(o.taxable_goods_cents === 1800, "mix taxable");
      assert(o.nontaxable_goods_cents === 500, "mix nontax");
      assert(o.tax_cents === 180 && o.total_cents === 2480, "mix totals");

      // Taxable addon on non-taxable item
      await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(waterId)}/addons`,
        admin,
        { assignments: [{ addonId: cheeseId, priceOverrideCents: 300 }] }
      );
      r = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P18-EX-WCH-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: waterId,
            quantity: 1,
            addons: [{ addonId: cheeseId, quantity: 1 }],
          },
        ],
      });
      o = getOrder(r.json.order.order_id);
      assert(o.taxable_goods_cents === 300, "taxable cheese only");
      assert(o.nontaxable_goods_cents === 500, "water nontax");
      assert(o.tax_cents === 30 && o.total_cents === 830, "water+cheese tax");

      // Non-taxable addon on taxable item
      r = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P18-EX-ICE-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: burgerId,
            quantity: 1,
            addons: [{ addonId: iceId, quantity: 1 }],
          },
        ],
      });
      o = getOrder(r.json.order.order_id);
      assert(o.taxable_goods_cents === 1800, "ice nontax addon");
      assert(o.nontaxable_goods_cents === 0, "ice 0 amount");
      assert(o.tax_cents === 180, "ice tax same as burger");

      // Free taxable addon
      r = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P18-EX-FREE-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: burgerId,
            quantity: 1,
            addons: [{ addonId: freeId, quantity: 1 }],
          },
        ],
      });
      o = getOrder(r.json.order.order_id);
      assert(o.goods_cents === 1800 && o.tax_cents === 180, "free addon");

      // Taxable negative addon
      r = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P18-EX-NEG-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: burgerId,
            quantity: 1,
            addons: [{ addonId: removeId, quantity: 1 }],
          },
        ],
      });
      o = getOrder(r.json.order.order_id);
      assert(o.taxable_goods_cents === 1700, "neg taxable base");
      assert(o.tax_cents === 170, "neg tax");
      assert(o.total_cents === 1870, "neg total");

      // Non-taxable negative on taxable item — create addon
      const negNt = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "Promo Disc P18",
        priceCents: -100,
        taxApplicable: false,
      });
      const discId = negNt.json.addon.addonId;
      await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(burgerId)}/addons`,
        admin,
        {
          assignments: [
            { addonId: cheeseId, priceOverrideCents: 350 },
            { addonId: removeId },
            { addonId: iceId },
            { addonId: freeId },
            { addonId: discId },
          ],
        }
      );
      r = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P18-EX-NTNEG-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: burgerId,
            quantity: 1,
            addons: [{ addonId: discId, quantity: 1 }],
          },
        ],
      });
      // Negative non-taxable bucket must reject (not clamp or transfer)
      assert(r.status === 400, "reject neg nontax bucket");
      assert(
        /non-taxable|negative/i.test(r.json?.error || ""),
        "neg nontax error"
      );

      // Qty 2
      r = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P18-EX-QTY-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: burgerId, quantity: 2 }],
      });
      o = getOrder(r.json.order.order_id);
      assert(o.taxable_goods_cents === 3600, "qty2 taxable");
      assert(o.tax_cents === 360 && o.total_cents === 3960, "qty2 tax");

      pass("exclusive-mixed-scenarios");
    } catch (err) {
      fail("exclusive-mixed-scenarios", err);
    }

    // Inclusive scenarios
    try {
      await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: true,
        taxMode: "inclusive",
        taxRatePercent: "10",
      });
      // Set burger to 1650 taxable inclusive sample + water
      await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: burgerId,
        name: "Chicken Burger",
        priceCents: 1650,
        categoryId: getMenuItem(burgerId)?.category_id,
        stationIds: getMenuItem(burgerId)?.stationIds || ["station_grill"],
        taxApplicable: true,
      });

      let r = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P18-IN-ITEM-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: burgerId, quantity: 1 }],
      });
      let o = getOrder(r.json.order.order_id);
      assert(o.total_cents === 1650, "incl total=goods");
      assert(o.net_cents + o.tax_cents === o.goods_cents, "incl reconcile");
      assert(o.tax_cents === 150, "incl tax 150");

      r = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P18-IN-MIX-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          { itemId: burgerId, quantity: 1 },
          { itemId: waterId, quantity: 1 },
        ],
      });
      o = getOrder(r.json.order.order_id);
      assert(o.total_cents === 2150, "incl mix total");
      assert(o.taxable_goods_cents === 1650, "incl mix taxable");
      assert(o.nontaxable_goods_cents === 500, "incl mix nontax");
      assert(o.tax_cents === 150, "incl mix tax from taxable only");
      assert(o.net_cents === 2000, "incl mix net");

      // Restore burger price
      await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: burgerId,
        name: "Chicken Burger",
        priceCents: 1800,
        categoryId: getMenuItem(burgerId)?.category_id,
        stationIds: getMenuItem(burgerId)?.stationIds || ["station_grill"],
        taxApplicable: true,
      });
      pass("inclusive-mixed-scenarios");
    } catch (err) {
      fail("inclusive-mixed-scenarios", err);
    }

    // Tax disabled + historical freeze
    let frozenOrderId;
    try {
      await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: true,
        taxMode: "exclusive",
        taxRatePercent: "10",
      });
      const created = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P18-FREEZE-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          { itemId: burgerId, quantity: 1 },
          { itemId: waterId, quantity: 1 },
        ],
      });
      frozenOrderId = created.json.order.order_id;
      const before = getOrder(frozenOrderId);

      await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: burgerId,
        name: "Chicken Burger",
        priceCents: 1800,
        categoryId: getMenuItem(burgerId)?.category_id,
        stationIds: getMenuItem(burgerId)?.stationIds || ["station_grill"],
        taxApplicable: false,
      });
      await httpJson(port, "PUT", "/v1/addons", admin, {
        addonId: cheeseId,
        name: "Double Cheese P18",
        priceCents: 300,
        taxApplicable: false,
      });
      await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: true,
        taxMode: "inclusive",
        taxRatePercent: "15",
      });
      const after = getOrder(frozenOrderId);
      assert(after.tax_cents === before.tax_cents, "tax frozen");
      assert(after.taxable_goods_cents === before.taxable_goods_cents, "bucket frozen");
      assert(after.total_cents === before.total_cents, "total frozen");
      assert(after.tax_mode === "exclusive", "mode snap frozen");

      await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: false,
      });
      const offOrd = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P18-OFF-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: burgerId, quantity: 1 }],
      });
      const oo = getOrder(offOrd.json.order.order_id);
      assert(oo.tax_cents === 0 && oo.total_cents === oo.goods_cents, "tax off");

      // Restore flags for later restart check
      await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId: burgerId,
        name: "Chicken Burger",
        priceCents: 1800,
        categoryId: getMenuItem(burgerId)?.category_id,
        stationIds: getMenuItem(burgerId)?.stationIds || ["station_grill"],
        taxApplicable: true,
      });
      await httpJson(port, "PUT", "/v1/addons", admin, {
        addonId: cheeseId,
        name: "Double Cheese P18",
        priceCents: 300,
        taxApplicable: true,
      });
      pass("historical-freeze-and-tax-off");
    } catch (err) {
      fail("historical-freeze-and-tax-off", err);
    }

    // Currency formats + idempotency + mock print
    try {
      updateShopSettings(
        shopId,
        {
          taxEnabled: true,
          taxMode: "exclusive",
          taxRatePercent: "10",
        },
        { role: "admin" }
      );
      assert(
        formatMoneyMinor(1500, getShopSettings(shopId)) === "BHD 1.500",
        "BHD fmt"
      );

      const dupNum = `P18-DUP-${Date.now()}`;
      const a = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: dupNum,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: burgerId, quantity: 1 }],
      });
      const b = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: dupNum,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: burgerId, quantity: 1 }],
      });
      assert(a.json.order.order_id === b.json.order.order_id, "idempotent");
      assert(b.json.created === false, "dup not recreated");

      await processAllPending(config);
      const jobs = await httpJson(
        port,
        "GET",
        `/v1/print-jobs?orderId=${encodeURIComponent(a.json.order.order_id)}`,
        device
      );
      assert((jobs.json.jobs || []).length > 0, "mock jobs");
      const cashier = (jobs.json.jobs || []).find((j) => j.job_type === "CASHIER");
      assert(cashier, "cashier job");
      const prev = await httpJson(
        port,
        "GET",
        `/v1/print-jobs/${encodeURIComponent(cashier.job_id)}/preview`,
        device
      );
      assert(prev.status === 200, "preview");
      assert(/Taxable|VAT|Subtotal|TOTAL/i.test(prev.json.text || ""), "receipt tax");
      assert(!/PHYSICAL/i.test(prev.json.text || ""), "no physical");
      pass("currency-idempotency-mock-print");
    } catch (err) {
      fail("currency-idempotency-mock-print", err);
    }

    // Restart persistence
    try {
      closeDatabase();
      openDatabase(config.dbPath);
      await runMigrations(getDb());
      assert(getMenuItem(burgerId).taxApplicable === true, "item flag after reopen");
      assert(getAddon(cheeseId).taxApplicable === true, "addon flag after reopen");
      if (frozenOrderId) {
        const o = getOrder(frozenOrderId);
        assert(o.taxable_goods_cents > 0, "order snap after reopen");
      }
      pass("restart-persistence");
    } catch (err) {
      fail("restart-persistence", err);
    }

    // QAR / INR engine smoke (no float drift)
    try {
      assert(mulDivRoundHalfUp(10000, 1000, 10000) === 1000, "QAR-like");
      assert(mulDivRoundHalfUp(199, 1000, 10000) === 20, "half-up");
      const buckets = computeOrderTaxFromBuckets(
        { taxableCents: 199, nontaxableCents: 1 },
        { taxEnabled: true, taxMode: "exclusive", taxRateBps: 1000 }
      );
      assert(buckets.taxCents === 20, "round on taxable only");
      assert(buckets.totalCents === 220, "goods+tax");
      pass("rounding-no-float-drift");
    } catch (err) {
      fail("rounding-no-float-drift", err);
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
  console.log("\n=== Phase 1.8 acceptance ===");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
  }
  console.log(
    `\n${results.length - failed.length}/${results.length} passed`
  );
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
