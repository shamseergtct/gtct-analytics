/**
 * Phase 1.9 customize UX — admin base-price override + permission gates.
 * Staff-specific sales.price_override is deferred (no per-staff identity).
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
import { updateShopSettings } from "../services/shopSettings.js";
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
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-p19c-"));
  process.env.GTCT_LOCAL_DATA_DIR = tmp;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18809";
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;
  delete process.env.GTCT_LOCAL_ADMIN_TOKEN;
  delete process.env.GTCT_LOCAL_API_TOKEN;

  const config = loadConfig({ mode: "http" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedSampleData(config);

  updateShopSettings(
    config.testTenantId,
    {
      currencyPreset: "BHD",
      confirmCurrencyChange: true,
      taxEnabled: true,
      taxMode: "inclusive",
      taxRateBps: 1000,
      taxName: "VAT",
    },
    { role: "admin" }
  );

  const server = createServer(config);
  await new Promise((r) => server.listen(config.port, config.host, r));
  const port = config.port;
  const sessions = await openRoleSessions(port, config.testTenantId);
  const admin = sessions.admin;
  const device = sessions.device;
  let passed = 0;
  let failed = 0;
  const pass = (name) => {
    passed += 1;
    log.info(`PASS ${name}`);
    console.log(`PASS ${name}`);
  };
  const fail = (name, err) => {
    failed += 1;
    console.error(`FAIL ${name}: ${err.message || err}`);
  };

  try {
    const cfgAdmin = await httpJson(port, "GET", "/v1/config", admin);
    const cfgDevice = await httpJson(port, "GET", "/v1/config", device);
    assert(cfgAdmin.json.canAdjustBasePrices === true, "admin base override");
    assert(cfgDevice.json.canAdjustBasePrices === false, "device no base override");
    assert(cfgAdmin.json.canAdjustAddonPrices === true, "admin addon");
    assert(cfgDevice.json.canAdjustAddonPrices === false, "device addon");
    pass("permission-flags");

    const menu = await httpJson(port, "GET", "/v1/menu-items?includeInactive=0", device);
    const burger = (menu.json.menuItems || []).find((i) =>
      /burger/i.test(i.name)
    );
    assert(burger, "burger item");
    const base = Number(burger.price_cents);

    const stale = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: `P19C-STALE-${Date.now()}`,
      orderType: "TAKEAWAY",
      destination: "T1",
      lines: [
        {
          itemId: burger.item_id,
          quantity: 1,
          unitBasePriceCents: base + 50,
        },
      ],
    });
    assert(stale.status === 409, "stale mismatch 409");
    assert(stale.json.code === "PRICE_CHANGED", "PRICE_CHANGED code");
    pass("price-changed-preserved");

    const forbidden = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: `P19C-FORBID-${Date.now()}`,
      orderType: "TAKEAWAY",
      destination: "T1",
      lines: [
        {
          itemId: burger.item_id,
          quantity: 1,
          unitBasePriceCents: base + 100,
          basePriceOverride: true,
        },
      ],
    });
    assert(forbidden.status === 403, "device override forbidden");
    assert(
      forbidden.json.code === "BASE_PRICE_OVERRIDE_FORBIDDEN",
      "override forbidden code"
    );
    pass("device-override-rejected");

    const overrideCents = base + 150;
    const okAdmin = await httpJson(port, "POST", "/v1/test-orders", admin, {
      orderNumber: `P19C-ADMIN-${Date.now()}`,
      orderType: "TAKEAWAY",
      destination: "T1",
      lines: [
        {
          itemId: burger.item_id,
          quantity: 2,
          unitBasePriceCents: overrideCents,
          basePriceOverride: true,
        },
      ],
    });
    assert(okAdmin.ok, `admin override ok: ${okAdmin.json?.error}`);
    const order = getOrder(okAdmin.json.order.order_id);
    const line = order.lines[0];
    assert(line.unit_base_price_cents === overrideCents, "applied override");
    assert(
      Number(line.configured_unit_base_price_cents) === base,
      "configured snapshot"
    );
    assert(Number(line.base_price_adjusted) === 1, "adjusted flag");
    assert(line.base_price_adjusted_by_role === "admin", "adjusted by admin");
    pass("admin-override-snapshot");

    const audits = getDb()
      .prepare(
        `SELECT * FROM audit_events WHERE action = ? ORDER BY created_at DESC LIMIT 5`
      )
      .all("order.line.base_price_adjust");
    assert(audits.length >= 1, "audit present");
    const detail = JSON.parse(audits[0].detail_json || "{}");
    assert(detail.configuredUnitBasePriceCents === base, "audit configured");
    assert(detail.appliedUnitBasePriceCents === overrideCents, "audit applied");
    assert(detail.permission === "sales.price_override", "audit permission tag");
    pass("override-audit");

    const neg = await httpJson(port, "POST", "/v1/test-orders", admin, {
      orderNumber: `P19C-NEG-${Date.now()}`,
      orderType: "TAKEAWAY",
      destination: "T1",
      lines: [
        {
          itemId: burger.item_id,
          quantity: 1,
          unitBasePriceCents: -1,
          basePriceOverride: true,
        },
      ],
    });
    assert(neg.status === 400, "negative rejected");
    pass("negative-base-rejected");

    const pub = path.join(process.cwd(), "public");
    const indexHtml = fs.readFileSync(path.join(pub, "index.html"), "utf8");
    const appJs = fs.readFileSync(path.join(pub, "app.js"), "utf8");
    assert(/customize-unit-price/.test(indexHtml), "unit price field");
    assert(/kitchen-step-1/.test(indexHtml), "kitchen step 1");
    assert(/kitchen-step-2/.test(indexHtml), "kitchen step 2");
    assert(/data-act="customize"/.test(appJs), "card tap customize");
    assert(/basePriceOverride/.test(appJs), "client override intent");
    assert(/canAdjustBasePrices/.test(appJs), "client base gate");
    assert(/setKitchenStep/.test(appJs), "two-step kitchen");
    pass("ui-assets");
  } finally {
    await new Promise((r) => server.close(r));
    closeDatabase();
  }

  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
