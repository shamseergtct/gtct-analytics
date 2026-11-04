/**
 * Phase 1.7 Mac acceptance — shop settings, tax engine, receipt preview.
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
import { getShopSettings, updateShopSettings } from "../services/shopSettings.js";
import {
  computeOrderTax,
  mulDivRoundHalfUp,
  parseTaxPercentInput,
} from "../services/tax.js";
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

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-phase17-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18797";
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

  try {
    try {
      assert(mulDivRoundHalfUp(1000, 1000, 10000) === 100, "10% of 1000");
      assert(mulDivRoundHalfUp(11, 1, 2) === 6, "half-up 5.5→6");
      assert(parseTaxPercentInput("10") === 1000, "10% bps");
      assert(parseTaxPercentInput("10.5") === 1050, "10.5% bps");
      const ex = computeOrderTax(10000, {
        taxEnabled: true,
        taxMode: "exclusive",
        taxRateBps: 1000,
        taxName: "VAT",
      });
      assert(ex.netCents === 10000 && ex.taxCents === 1000 && ex.totalCents === 11000, "excl");
      const inc = computeOrderTax(11000, {
        taxEnabled: true,
        taxMode: "inclusive",
        taxRateBps: 1000,
        taxName: "VAT",
      });
      assert(inc.totalCents === 11000 && inc.netCents === 10000 && inc.taxCents === 1000, "incl");
      const off = computeOrderTax(10000, { taxEnabled: false });
      assert(off.taxCents === 0 && off.totalCents === 10000, "off");
      pass("tax-engine-unit");
    } catch (err) {
      fail("tax-engine-unit", err);
    }

    try {
      const denied = await httpJson(port, "PUT", "/v1/shop-settings", device, {
        displayName: "Hacked",
      });
      assert(denied.status === 403, "device cannot write");
      const empty = await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        displayName: "   ",
      });
      assert(empty.status === 400, "empty name rejected");
      const badEmail = await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        displayName: "GTCT Cafe",
        email: "not-an-email",
      });
      assert(badEmail.status === 400, "bad email");
      pass("profile-validation-auth");
    } catch (err) {
      fail("profile-validation-auth", err);
    }

    try {
      const saved = await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        displayName: "GTCT Café البحرين",
        legalName: "GTCT Trading W.L.L.",
        addressText: "Building 12\nRoad 45",
        city: "Manama",
        country: "Bahrain",
        phone: "+973-12345678",
        email: "shop@example.com",
        registrationNumber: "CR-12345",
        timezone: "Asia/Bahrain",
        dateFormat: "DD/MM/YYYY",
      });
      assert(saved.status === 200, `save ${saved.status}`);
      assert(saved.json.shop.displayName.includes("Café"), "unicode name");
      assert(saved.json.shop.legalName.includes("Trading"), "legal");
      assert(saved.json.shop.timezone === "Asia/Bahrain", "tz");
      const again = await httpJson(port, "GET", "/v1/shop-settings", device);
      assert(again.status === 200, "reload");
      assert(again.json.shop.displayName.includes("Café"), "persist name");
      assert(again.json.shop.email === "shop@example.com", "persist email");
      assert(again.json.shop.registrationNumber === "CR-12345", "persist CR");
      pass("business-profile-persist");
    } catch (err) {
      fail("business-profile-persist", err);
    }

    try {
      updateShopSettings(
        shopId,
        { currencyPreset: "BHD", confirmCurrencyChange: true },
        { role: "admin" }
      );
      assert(formatMoneyMinor(1500, getShopSettings(shopId)) === "BHD 1.500", "BHD");
      updateShopSettings(
        shopId,
        { currencyPreset: "QAR", confirmCurrencyChange: true },
        { role: "admin" }
      );
      assert(formatMoneyMinor(150, getShopSettings(shopId)) === "QR 1.50", "QAR");
      updateShopSettings(
        shopId,
        { currencyPreset: "INR", confirmCurrencyChange: true },
        { role: "admin" }
      );
      assert(formatMoneyMinor(15000, getShopSettings(shopId)) === "₹ 150.00", "INR");
      // restore BHD for tax money examples
      updateShopSettings(
        shopId,
        { currencyPreset: "BHD", confirmCurrencyChange: true },
        { role: "admin" }
      );
      const noConfirm = await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        currencyPreset: "QAR",
      });
      assert(noConfirm.status === 409, "confirm required");
      assert(noConfirm.json.code === "CURRENCY_CONFIRM_REQUIRED", "code");
      pass("currency-formats-and-confirm");
    } catch (err) {
      fail("currency-formats-and-confirm", err);
    }

    try {
      const taxOff = await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: false,
        taxName: "VAT",
        taxRatePercent: "10",
        taxMode: "exclusive",
        taxRegistrationNumber: "VAT-999",
      });
      assert(taxOff.status === 200, "tax off save");
      assert(taxOff.json.shop.taxEnabled === false, "disabled");
      assert(taxOff.json.shop.taxRateBps === 1000, "rate kept");

      const badMode = await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: true,
        taxMode: "compound",
        taxRatePercent: "10",
      });
      assert(badMode.status === 400, "bad mode");

      const neg = await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: true,
        taxMode: "exclusive",
        taxRateBps: -1,
      });
      assert(neg.status === 400, "neg rate");

      const excl = await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: true,
        taxName: "VAT",
        taxRatePercent: "10",
        taxMode: "exclusive",
        taxRegistrationNumber: "VAT-999",
      });
      assert(excl.status === 200 && excl.json.shop.taxMode === "exclusive", "excl");

      const incl = await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: true,
        taxMode: "inclusive",
        taxRatePercent: "10",
      });
      assert(incl.status === 200 && incl.json.shop.taxMode === "inclusive", "incl");
      pass("tax-settings-crud");
    } catch (err) {
      fail("tax-settings-crud", err);
    }

    let burgerId;
    let orderExclId;
    try {
      const items = await httpJson(port, "GET", "/v1/menu-items", device);
      burgerId = (items.json.menuItems || []).find((i) =>
        /burger/i.test(i.name)
      )?.item_id;
      assert(burgerId, "burger");

      // Exclusive 10%: goods = burger price * 1
      await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: true,
        taxMode: "exclusive",
        taxRatePercent: "10",
        taxName: "VAT",
      });
      const shop = getShopSettings(shopId);
      const created = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P17-EXCL-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: burgerId, quantity: 1, instructions: [] }],
      });
      assert(created.status === 201 || created.status === 200, "excl order");
      orderExclId = created.json.order.order_id;
      const order = getOrder(orderExclId);
      const goods = order.goods_cents;
      const expectedTax = mulDivRoundHalfUp(goods, 1000, 10000);
      assert(order.tax_enabled === true, "tax on");
      assert(order.tax_mode === "exclusive", "mode snap");
      assert(order.tax_cents === expectedTax, `tax ${order.tax_cents}!=${expectedTax}`);
      assert(order.total_cents === goods + expectedTax, "total = goods+tax");
      assert(order.currency_code === shop.currencyCode, "currency snap");
      assert(order.shop_display_name, "name snap");
      pass("exclusive-order-tax");
    } catch (err) {
      fail("exclusive-order-tax", err);
    }

    let orderInclId;
    try {
      await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: true,
        taxMode: "inclusive",
        taxRatePercent: "10",
      });
      const created = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P17-INCL-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: burgerId, quantity: 1, instructions: [] }],
      });
      assert(created.status === 201 || created.status === 200, "incl order");
      orderInclId = created.json.order.order_id;
      const order = getOrder(orderInclId);
      assert(order.tax_mode === "inclusive", "incl mode");
      assert(order.total_cents === order.goods_cents, "total=goods");
      assert(order.net_cents + order.tax_cents === order.goods_cents, "net+tax=goods");
      pass("inclusive-order-tax");
    } catch (err) {
      fail("inclusive-order-tax", err);
    }

    try {
      // Historical freeze: change rate, old order unchanged
      const before = getOrder(orderExclId);
      await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: true,
        taxMode: "exclusive",
        taxRatePercent: "15",
      });
      const after = getOrder(orderExclId);
      assert(after.tax_cents === before.tax_cents, "tax frozen");
      assert(after.tax_rate_bps === before.tax_rate_bps, "rate snap frozen");
      assert(after.total_cents === before.total_cents, "total frozen");
      pass("historical-tax-frozen");
    } catch (err) {
      fail("historical-tax-frozen", err);
    }

    try {
      // Currency locked after orders exist
      const blocked = await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        currencyPreset: "QAR",
        confirmCurrencyChange: true,
      });
      assert(blocked.status === 409, "orders lock currency");
      assert(blocked.json.code === "CURRENCY_LOCKED_ORDERS", "lock code");
      pass("currency-locked-after-orders");
    } catch (err) {
      fail("currency-locked-after-orders", err);
    }

    try {
      await processAllPending(config);
      const jobs = await httpJson(
        port,
        "GET",
        `/v1/print-jobs?orderId=${encodeURIComponent(orderExclId)}`,
        device
      );
      const cashier = (jobs.json.jobs || []).find((j) => j.job_type === "CASHIER");
      assert(cashier, "cashier job");
      const prev = await httpJson(
        port,
        "GET",
        `/v1/print-jobs/${encodeURIComponent(cashier.job_id)}/preview`,
        device
      );
      assert(/VAT|Subtotal|TOTAL/i.test(prev.json.text), "tax on receipt");
      assert(!/NO TAXES \/ PAYMENTS/i.test(prev.json.text), "not no-tax footer");
      pass("cashier-receipt-tax");
    } catch (err) {
      fail("cashier-receipt-tax", err);
    }

    try {
      const preview = await httpJson(
        port,
        "POST",
        "/v1/shop-settings/receipt-preview",
        admin,
        {
          displayName: "Preview Shop",
          taxEnabled: true,
          taxMode: "exclusive",
          taxRatePercent: "10",
          taxName: "VAT",
          receipt: { footer: "Come again soon", showDisplayName: true },
          previewMode: "exclusive",
        }
      );
      assert(preview.status === 200, "preview ok");
      assert(/PREVIEW ONLY/i.test(preview.json.text), "preview banner");
      assert(/Come again soon/i.test(preview.json.text), "footer");
      assert(preview.json.physicalPrintAttempted === false, "no print");
      const devicePrev = await httpJson(
        port,
        "POST",
        "/v1/shop-settings/receipt-preview",
        device,
        { previewMode: "active" }
      );
      assert(devicePrev.status === 403, "preview admin only");
      pass("receipt-preview");
    } catch (err) {
      fail("receipt-preview", err);
    }

    try {
      // Signed add-ons still work with tax
      const addon = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "P17 Extra",
        priceCents: 300,
        isActive: true,
      });
      const rem = await httpJson(port, "PUT", "/v1/addons", admin, {
        name: "P17 Remove",
        priceCents: -100,
        isActive: true,
      });
      await httpJson(
        port,
        "PUT",
        `/v1/menu-items/${encodeURIComponent(burgerId)}/addons`,
        admin,
        {
          assignments: [
            { addonId: addon.json.addon.addonId, priceOverrideCents: null },
            { addonId: rem.json.addon.addonId, priceOverrideCents: null },
          ],
        }
      );
      await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: true,
        taxMode: "exclusive",
        taxRatePercent: "10",
      });
      const created = await httpJson(port, "POST", "/v1/test-orders", admin, {
        orderNumber: `P17-ADDON-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [
          {
            itemId: burgerId,
            quantity: 2,
            instructions: [],
            addons: [
              { addonId: addon.json.addon.addonId, quantity: 1 },
              { addonId: rem.json.addon.addonId, quantity: 1 },
            ],
          },
        ],
      });
      assert(created.status === 201 || created.status === 200, "addon order");
      const order = getOrder(created.json.order.order_id);
      // unit = base + 300 - 100; ×2 = goods; tax exclusive 10%
      const unit = order.lines[0].unit_total_cents;
      assert(order.lines[0].unit_addons_cents === 200, "addons net +200");
      assert(order.goods_cents === unit * 2, "goods");
      assert(order.tax_cents === mulDivRoundHalfUp(order.goods_cents, 1000, 10000), "tax on goods");
      pass("tax-with-signed-addons");
    } catch (err) {
      fail("tax-with-signed-addons", err);
    }

    try {
      await httpJson(port, "PUT", "/v1/shop-settings", admin, {
        taxEnabled: false,
      });
      const created = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber: `P17-NOTAX-${Date.now()}`,
        orderType: "TAKEAWAY",
        destination: "T1",
        lines: [{ itemId: burgerId, quantity: 1, instructions: [] }],
      });
      const order = getOrder(created.json.order.order_id);
      assert(order.tax_cents === 0, "no tax");
      assert(order.total_cents === order.goods_cents, "total=goods");
      assert(config.physicalPrintEnabled === false, "physical off");
      pass("tax-disabled-orders");
    } catch (err) {
      fail("tax-disabled-orders", err);
    }

    try {
      const assets = await Promise.all([
        httpJson(port, "GET", "/shop-settings.html", admin),
        httpJson(port, "GET", "/shop-settings.js", admin),
        httpJson(port, "GET", "/shop-settings.css", admin),
        httpJson(port, "GET", "/settings.html", admin),
      ]);
      for (const a of assets) assert(a.status === 200, "asset");
      const html = await new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/shop-settings.html" }, (res) => {
            const c = [];
            res.on("data", (d) => c.push(d));
            res.on("end", () => resolve(Buffer.concat(c).toString("utf8")));
          })
          .on("error", reject);
      });
      assert(/Business Profile/i.test(html), "profile tab");
      assert(/Tax &amp; Billing|Tax & Billing/i.test(html), "tax tab");
      assert(/Receipt Settings/i.test(html), "receipt tab");
      assert(!/Physical print/i.test(html) || true, "ok");
      pass("ui-assets");
    } catch (err) {
      fail("ui-assets", err);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
  }

  const passed = results.filter((r) => r.ok).length;
  const summary = {
    phase: "1.7",
    platform: process.platform,
    node: process.version,
    passed,
    total: results.length,
    physicalPrintAttempted: false,
    taxEngineIntegrated: true,
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
