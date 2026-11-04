/**
 * Step 1 — staff identity schema only.
 * Uses a temporary database. Does not touch the restaurant database or login.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig, ensureDataDirs, WELL_KNOWN_ADMIN_TOKEN, WELL_KNOWN_DEV_TOKEN } from "../config.js";
import { openRoleSessions } from "./testHttp.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger, log } from "../util/logger.js";
import { createServer } from "../http/server.js";
import { seedSampleData } from "../seed/sampleData.js";
import { up as staffIdentityUp } from "../db/migrations/020_staff_identity.js";
import { withSubmissionId } from "./orderRequest.js";

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

const HASH = "x".repeat(64);
const results = [];

function pass(name) {
  results.push(name);
  log.info(`PASS ${name}`);
}

function fail(name, err) {
  results.push(`FAIL ${name}`);
  log.error(`FAIL ${name}`, { error: String(err.message || err) });
  throw err;
}

function httpJson(port, method, urlPath, body, token, { bearer = false } = {}) {
  const payload = body == null ? null : JSON.stringify(withSubmissionId(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          Accept: "application/json",
          ...(token && bearer ? { Authorization: `Bearer ${token}` } : {}),
          ...(token && !bearer
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
        res.on("data", (chunk) => {
          data += chunk;
        });
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

function tableExists(db, name) {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name)
  );
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-staff-foundation-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  delete process.env.GTCT_ALLOW_LAN_BIND;
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;

  const config = loadConfig({ mode: "script" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  const db = getDb();

  try {
    await runMigrations(db);
    const ordersBefore = db.prepare(`SELECT COUNT(*) AS n FROM orders`).get().n;
    const customersBefore = db.prepare(`SELECT COUNT(*) AS n FROM shop_customers`).get().n;
    const devicesBefore = db.prepare(`SELECT COUNT(*) AS n FROM devices`).get().n;
    const auditBefore = db.prepare(`SELECT COUNT(*) AS n FROM audit_events`).get().n;
    pass("migrations-run");

    await runMigrations(db);
    staffIdentityUp(db);
    assert(ordersBefore === db.prepare(`SELECT COUNT(*) AS n FROM orders`).get().n, "orders changed");
    assert(
      customersBefore === db.prepare(`SELECT COUNT(*) AS n FROM shop_customers`).get().n,
      "customers changed"
    );
    assert(devicesBefore === db.prepare(`SELECT COUNT(*) AS n FROM devices`).get().n, "devices changed");
    assert(auditBefore === db.prepare(`SELECT COUNT(*) AS n FROM audit_events`).get().n, "audit changed");
    pass("migrations-rerun-safe");

    for (const name of [
      "staff_users",
      "staff_roles",
      "staff_permissions",
      "staff_role_permissions",
      "staff_user_roles",
      "staff_user_permissions",
      "staff_sessions",
    ]) {
      assert(tableExists(db, name), `missing ${name}`);
    }
    assert(db.prepare(`SELECT COUNT(*) AS n FROM staff_users`).get().n === 0, "no seeded users");
    pass("tables-created-without-accounts");

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO staff_users (
         user_id, shop_id, full_name, username, username_normalized, password_hash,
         is_active, created_at, updated_at
       ) VALUES (?, 'test-tenant-phase1', 'A', 'cashier.one', 'cashier.one', ?, 1, ?, ?)`
    ).run("user_a", HASH, now, now);

    let duplicateRejected = false;
    try {
      db.prepare(
        `INSERT INTO staff_users (
           user_id, shop_id, full_name, username, username_normalized, password_hash,
           is_active, created_at, updated_at
         ) VALUES (?, 'test-tenant-phase1', 'B', 'Cashier.One', 'cashier.one', ?, 1, ?, ?)`
      ).run("user_b", HASH, now, now);
    } catch (err) {
      duplicateRejected = /UNIQUE/i.test(String(err.message));
    }
    assert(duplicateRejected, "duplicate username was accepted");
    pass("duplicate-username-rejected");

    db.prepare(
      `INSERT INTO shop_settings (
         shop_id, display_name, currency_code, currency_label, currency_decimals,
         instruction_modifiers_json, instruction_targets_json, created_at, updated_at
       ) VALUES ('shop-other', 'Other', 'BHD', 'BD', 3, '[]', '[]', ?, ?)`
    ).run(now, now);
    db.prepare(
      `INSERT INTO staff_users (
         user_id, shop_id, full_name, username, username_normalized, password_hash,
         is_active, created_at, updated_at
       ) VALUES ('user_c', 'shop-other', 'C', 'cashier.one', 'cashier.one', ?, 1, ?, ?)`
    ).run(HASH, now, now);

    let badShop = false;
    try {
      db.prepare(
        `INSERT INTO staff_users (
           user_id, shop_id, full_name, username, username_normalized, password_hash,
           is_active, created_at, updated_at
         ) VALUES ('user_d', 'missing-shop', 'D', 'd', 'd', ?, 1, ?, ?)`
      ).run(HASH, now, now);
    } catch (err) {
      badShop = /FOREIGN KEY/i.test(String(err.message));
    }
    assert(badShop, "unknown shop was accepted");

    let crossedShop = false;
    try {
      db.prepare(
        `INSERT INTO staff_user_roles (shop_id, user_id, role_id, assigned_at)
         VALUES ('shop-other', 'user_a', 'role_cashier', ?)`
      ).run(now);
    } catch (err) {
      crossedShop = /FOREIGN KEY/i.test(String(err.message));
    }
    assert(crossedShop, "cross-shop role assignment was accepted");
    db.prepare(
      `INSERT INTO staff_user_roles (shop_id, user_id, role_id, assigned_at)
       VALUES ('test-tenant-phase1', 'user_a', 'role_cashier', ?)`
    ).run(now);
    pass("shop-foreign-keys");

    let duplicateGrant = false;
    try {
      db.prepare(
        `INSERT INTO staff_role_permissions (role_id, permission_code, granted_at)
         VALUES ('role_admin', 'sales.order.create', ?)`
      ).run(now);
    } catch (err) {
      duplicateGrant = /UNIQUE/i.test(String(err.message));
    }
    assert(duplicateGrant, "duplicate role permission was accepted");
    const cashierCodes = db
      .prepare(
        `SELECT permission_code FROM staff_role_permissions
         WHERE role_id = 'role_cashier' AND revoked_at IS NULL
         ORDER BY permission_code`
      )
      .all()
      .map((row) => row.permission_code);
    assert(!cashierCodes.includes("sales.price_override"), "cashier has selling-price override");
    assert(!cashierCodes.includes("sales.addon_price_override"), "cashier has add-on price override");
    assert(cashierCodes.includes("sales.delivery_fee.edit"), "cashier missing delivery-fee edit");
    assert(cashierCodes.includes("sales.order.create"), "cashier missing order create");
    pass("permission-grants");

    const sessionCols = db.prepare(`PRAGMA table_info(staff_sessions)`).all().map((col) => col.name);
    for (const col of [
      "session_id",
      "token_hash",
      "created_at",
      "last_activity_at",
      "absolute_expires_at",
      "idle_expires_at",
      "revoked_at",
    ]) {
      assert(sessionCols.includes(col), `session missing ${col}`);
    }
    db.prepare(
      `INSERT INTO staff_sessions (
         session_id, shop_id, user_id, token_hash, created_at, last_activity_at,
         absolute_expires_at, idle_expires_at, revoked_at
       ) VALUES ('sess_1', 'test-tenant-phase1', 'user_a', ?, ?, ?, ?, ?, ?)`
    ).run(HASH, now, now, now, now, now);
    const stored = db.prepare(`SELECT token_hash, revoked_at FROM staff_sessions WHERE session_id = 'sess_1'`).get();
    assert(stored.token_hash === HASH, "token hash not stored");
    assert(stored.revoked_at === now, "revocation timestamp not stored");
    pass("session-expiry-and-revocation");

    process.env.GTCT_ALLOW_DEV_TOKEN = "true";
    process.env.GTCT_LOCAL_HOST = "127.0.0.1";
    process.env.GTCT_LOCAL_PORT = "18991";
    const httpConfig = loadConfig({ mode: "http" });
    seedSampleData(httpConfig);
    const server = createServer(httpConfig);
    await new Promise((resolve, reject) => {
      server.listen(httpConfig.port, httpConfig.host, (err) => (err ? reject(err) : resolve()));
    });
    try {
      const retiredAdmin = await httpJson(httpConfig.port, "POST", "/v1/session/login", {
        token: WELL_KNOWN_ADMIN_TOKEN,
      });
      const retiredDevice = await httpJson(httpConfig.port, "POST", "/v1/session/login", {
        token: WELL_KNOWN_DEV_TOKEN,
      });
      assert(retiredAdmin.status === 401, "shared admin secret was accepted");
      assert(retiredDevice.status === 401, "shared device secret was accepted");
      const sessions = await openRoleSessions(httpConfig.port, httpConfig.testTenantId);
      const order = await httpJson(
        httpConfig.port,
        "POST",
        "/v1/test-orders",
        {
          orderNumber: `STAFF-FOUNDATION-${Date.now()}`,
          orderType: "TAKEAWAY",
          lines: [{ itemId: "item_chicken_burger", quantity: 1 }],
        },
        sessions.device
      );
      assert(order.status === 201, order.json?.error || "order was not created");
      const bearerOrder = await httpJson(
        httpConfig.port,
        "POST",
        "/v1/test-orders",
        {
          orderNumber: `STAFF-FOUNDATION-BEARER-${Date.now()}`,
          orderType: "TAKEAWAY",
          lines: [{ itemId: "item_chicken_burger", quantity: 1 }],
        },
        WELL_KNOWN_DEV_TOKEN,
        { bearer: true }
      );
      assert(bearerOrder.status === 401, "shared device secret created an order");
      pass("staff-login-and-retired-secrets");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } catch (err) {
    fail("staff-foundation", err);
  } finally {
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const failed = results.filter((name) => name.startsWith("FAIL"));
  if (failed.length) {
    process.exitCode = 1;
    return;
  }
  log.info(`staff foundation ${results.length} passed`);
}

await main();
