/**
 * Step 3 — cashier accounts, user management, and server-enforced permissions.
 * Uses a temporary database. Does not modify the restaurant database.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  loadConfig,
  ensureDataDirs,
  WELL_KNOWN_ADMIN_TOKEN,
  WELL_KNOWN_DEV_TOKEN,
} from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger, log } from "../util/logger.js";
import { createServer } from "../http/server.js";
import { seedSampleData } from "../seed/sampleData.js";
import { createFirstAdmin, hashPassword } from "../services/staffAuth.js";
import { createTestOrder } from "../services/orders.js";
import { withSubmissionId } from "./orderRequest.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const liveDbPath = path.join(root, "data", "gtct-local.sqlite");
const PORT = 18993;
const ADMIN_USER = "owner.admin";
const ADMIN_PASSWORD = "Harbor-Cedar-21";
const CASHIER_USER = "cashier.one";
const CASHIER_PASSWORD = "Market-Cedar-22";
const CASHIER_PASSWORD_2 = "Market-Cedar-23";
const OTHER_PASSWORD = "Other-Shop-48";

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

function liveSnapshot() {
  if (!fs.existsSync(liveDbPath)) return null;
  const db = new Database(liveDbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  try {
    const count = (table) => {
      const exists = db
        .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table);
      return exists ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : null;
    };
    return {
      customers: count("shop_customers"),
      orders: count("orders"),
      menu: count("menu_items"),
    };
  } finally {
    db.close();
  }
}

function httpRaw(port, method, urlPath, { body, token, cookie, origin } = {}) {
  const payload = body == null ? null : JSON.stringify(withSubmissionId(body));
  return new Promise((resolve, reject) => {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = `gtct_ls_session=${encodeURIComponent(cookie)}`;
    if (origin) headers.Origin = origin;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode, json, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sessionCookie(res) {
  const raw = res.headers["set-cookie"];
  const joined = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
  const match = /gtct_ls_session=([^;]+)/.exec(joined);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function listen(server, config) {
  return new Promise((resolve, reject) => {
    server.listen(config.port, config.host, (err) => (err ? reject(err) : resolve()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function noSecret(json) {
  const text = JSON.stringify(json || {});
  assert(!text.includes("scrypt$"), "response included a password hash");
  assert(!Object.prototype.hasOwnProperty.call(json || {}, "password"), "response included a password");
  assert(!Object.prototype.hasOwnProperty.call(json || {}, "token"), "response included a session token");
  assert(!text.includes(CASHIER_PASSWORD), "response included a password");
  assert(!text.includes(ADMIN_PASSWORD), "response included a password");
}

async function main() {
  const results = [];
  const pass = (name) => {
    results.push(name);
    log.info(`PASS ${name}`);
  };

  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  const usersHtml = fs.readFileSync(path.join(root, "public/users.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
  assert(html.includes('id="users-link"'), "sales nav has user management");
  assert(usersHtml.includes("Add User"), "add user control");
  assert(usersHtml.includes("Full name"), "name field");
  assert(!usersHtml.includes("password_hash") && !usersHtml.includes("scrypt$"), "page hides hashes");
  assert(appJs.includes("menu.sold_out.update"), "sold-out control uses permission");
  assert(!appJs.includes('|| state.role === "admin"'), "price flag comes from the server");
  pass("user-management-markup");

  const before = liveSnapshot();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-staff-access-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = String(PORT);
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;
  delete process.env.GTCT_ALLOW_LAN_BIND;
  delete process.env.GTCT_LOCAL_ADMIN_TOKEN;
  delete process.env.GTCT_LOCAL_API_TOKEN;

  const config = loadConfig({ mode: "http" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedSampleData(config);
  const shopId = config.testTenantId;
  const origin = `http://127.0.0.1:${config.port}`;

  const cols = getDb().prepare(`PRAGMA table_info(orders)`).all().map((col) => col.name);
  assert(cols.includes("created_by_user_id"), "order staff column");
  const auditCols = getDb().prepare(`PRAGMA table_info(audit_events)`).all().map((col) => col.name);
  assert(auditCols.includes("actor_user_id"), "audit staff column");
  const manage = getDb()
    .prepare(
      `SELECT 1 AS ok FROM staff_role_permissions
       WHERE role_id = 'role_admin' AND permission_code = 'staff.manage' AND revoked_at IS NULL`
    )
    .get();
  assert(manage, "admin can manage staff");
  pass("migration-021");

  createFirstAdmin({
    shopId,
    fullName: "Owner Admin",
    username: ADMIN_USER,
    password: ADMIN_PASSWORD,
  });

  let server = createServer(config);
  await listen(server, config);
  const port = config.port;
  const call = (method, urlPath, extra) => httpRaw(port, method, urlPath, extra);

  try {
    const adminLogin = await call("POST", "/v1/session/login", {
      origin,
      body: { username: ADMIN_USER, password: ADMIN_PASSWORD },
    });
    assert(adminLogin.status === 200, "admin login");
    const adminCookie = sessionCookie(adminLogin);
    assert(adminCookie && !JSON.stringify(adminLogin.json).includes(adminCookie), "cookie not in body");
    const adminMe = await call("GET", "/v1/session/me", { cookie: adminCookie });
    assert(adminMe.json.role === "admin" && adminMe.json.staff === true, "admin session");
    assert(adminMe.json.permissions.includes("staff.manage"), "admin permission");
    assert(adminMe.json.canAdjustBasePrices === true, "admin price flag");
    noSecret(adminMe.json);
    pass("admin-login");

    const bearerUsers = await call("GET", "/v1/staff-users", { token: WELL_KNOWN_ADMIN_TOKEN });
    assert(bearerUsers.status === 401, "shared admin secret cannot manage users");
    const deviceUsers = await call("GET", "/v1/staff-users", { token: WELL_KNOWN_DEV_TOKEN });
    assert(deviceUsers.status === 401, "device secret cannot manage users");
    pass("legacy-secrets-blocked-from-user-management");

    const badPassword = await call("POST", "/v1/staff-users", {
      origin,
      cookie: adminCookie,
      body: {
        fullName: "Cashier One",
        username: CASHIER_USER,
        password: "short",
        confirmPassword: "short",
        role: "cashier",
      },
    });
    assert(badPassword.status === 400, "weak password rejected");
    pass("password-strength");

    const created = await call("POST", "/v1/staff-users", {
      origin,
      cookie: adminCookie,
      body: {
        fullName: "Cashier One",
        username: CASHIER_USER,
        password: CASHIER_PASSWORD,
        confirmPassword: CASHIER_PASSWORD,
        role: "cashier",
        isActive: true,
        permissions: [],
      },
    });
    assert(created.status === 201, created.json?.error || "create cashier");
    noSecret(created.json);
    const cashierId = created.json.user.userId;
    const stored = getDb()
      .prepare(`SELECT password_hash FROM staff_users WHERE user_id = ?`)
      .get(cashierId);
    assert(String(stored.password_hash).startsWith("scrypt$"), "password stored as a hash");
    assert(!stored.password_hash.includes(CASHIER_PASSWORD), "hash is not the password");
    const duplicate = await call("POST", "/v1/staff-users", {
      origin,
      cookie: adminCookie,
      body: {
        fullName: "Cashier One Copy",
        username: CASHIER_USER.toUpperCase(),
        password: CASHIER_PASSWORD,
        confirmPassword: CASHIER_PASSWORD,
        role: "cashier",
      },
    });
    assert(duplicate.status === 409, "duplicate username rejected");
    const unknownPerm = await call("POST", "/v1/staff-users", {
      origin,
      cookie: adminCookie,
      body: {
        fullName: "Cashier Two",
        username: "cashier.two",
        password: CASHIER_PASSWORD,
        confirmPassword: CASHIER_PASSWORD,
        role: "cashier",
        permissions: ["staff.manage"],
      },
    });
    assert(unknownPerm.status === 400, "unrecognized permission rejected");
    const createAudit = getDb()
      .prepare(`SELECT actor_user_id FROM audit_events WHERE action = 'staff.user.create' AND entity_id = ?`)
      .get(cashierId);
    assert(createAudit?.actor_user_id === adminMe.json.userId, "create audit has staff id");
    pass("create-cashier");

    const wrong = await call("POST", "/v1/session/login", {
      origin,
      body: { username: CASHIER_USER, password: "not-the-password" },
    });
    assert(wrong.status === 401, "wrong password rejected");
    const cashierLogin = await call("POST", "/v1/session/login", {
      origin,
      body: { username: CASHIER_USER, password: CASHIER_PASSWORD },
    });
    assert(cashierLogin.status === 200 && cashierLogin.json.role === "cashier", "cashier login");
    let cashierCookie = sessionCookie(cashierLogin);
    const cashierMe = await call("GET", "/v1/session/me", { cookie: cashierCookie });
    assert(cashierMe.json.staff === true, "cashier is staff");
    assert(cashierMe.json.permissions.includes("sales.order.create"), "can create orders");
    assert(cashierMe.json.permissions.includes("customers.manage"), "can manage customers");
    assert(cashierMe.json.permissions.includes("sales.delivery_fee.edit"), "can edit delivery fee");
    assert(cashierMe.json.permissions.includes("menu.sold_out.update"), "can mark sold out");
    assert(!cashierMe.json.permissions.includes("sales.price_override"), "no item price permission");
    assert(!cashierMe.json.permissions.includes("sales.addon_price_override"), "no add-on price permission");
    assert(!cashierMe.json.permissions.includes("staff.manage"), "no user management");
    assert(cashierMe.json.canAdjustBasePrices === false, "price flag off");
    assert(cashierMe.json.canAdjustAddonPrices === false, "add-on flag off");
    noSecret(cashierMe.json);
    pass("cashier-login");

    const stillAdmin = await call("GET", "/v1/session/me", { cookie: adminCookie });
    assert(stillAdmin.status === 200 && stillAdmin.json.role === "admin", "admin session remains");
    pass("admin-session-remains");

    const legacyOrder = await call("POST", "/v1/test-orders", {
      token: WELL_KNOWN_DEV_TOKEN,
      body: {
        orderNumber: "S3-LEGACY",
        orderType: "TAKEAWAY",
        destination: "Counter",
        lines: [{ itemId: "item_chicken_burger", quantity: 1 }],
      },
    });
    assert(legacyOrder.status === 401, "shared device secret was accepted");
    createTestOrder(
      {
        orderNumber: "S3-LEGACY",
        submissionId: "sub-S3-LEGACY",
        orderType: "TAKEAWAY",
        destination: "Counter",
        lines: [{ itemId: "item_chicken_burger", quantity: 1 }],
      },
      config,
      { role: "device", deviceId: "retired-device", permissions: null }
    );
    const legacyRow = getDb()
      .prepare(`SELECT created_by_user_id, created_by_role FROM orders WHERE order_number = 'S3-LEGACY'`)
      .get();
    assert(!legacyRow.created_by_user_id, "legacy order has no staff id");
    const menuPrice = getDb()
      .prepare(`SELECT price_cents FROM menu_items WHERE item_id = 'item_chicken_burger'`)
      .get().price_cents;

    const sale = await call("POST", "/v1/test-orders", {
      origin,
      cookie: cashierCookie,
      body: {
        orderNumber: "S3-CASHIER",
        orderType: "TAKEAWAY",
        destination: "Counter",
        lines: [{ itemId: "item_chicken_burger", quantity: 1 }],
      },
    });
    assert(sale.status === 201, sale.json?.error || "cashier order");
    const saleRow = getDb()
      .prepare(
        `SELECT created_by_user_id, created_by_role, created_by_device_id
         FROM orders WHERE order_number = 'S3-CASHIER'`
      )
      .get();
    assert(saleRow.created_by_user_id === cashierId, "order staff id");
    assert(saleRow.created_by_role === "cashier", "order role");
    assert(saleRow.created_by_device_id, "device id preserved");
    const legacyAgain = getDb()
      .prepare(`SELECT created_by_user_id FROM orders WHERE order_number = 'S3-LEGACY'`)
      .get();
    assert(!legacyAgain.created_by_user_id, "historical order unchanged");
    pass("order-identity");

    const customer = await call("POST", "/v1/customers", {
      origin,
      cookie: cashierCookie,
      body: { name: "Nora Cashier", phone: "33112244", blockNumber: "410" },
    });
    assert(customer.status === 201, customer.json?.error || "cashier customer");
    pass("cashier-customer");

    const blockDenied = await call("PUT", "/v1/block-delivery-rates", {
      origin,
      cookie: cashierCookie,
      body: { blockNumber: "410", chargeCents: 300, isActive: true },
    });
    assert(blockDenied.status === 403, "cashier cannot edit block rates");
    const block = await call("PUT", "/v1/block-delivery-rates", {
      origin,
      cookie: adminCookie,
      body: { blockNumber: "410", chargeCents: 300, isActive: true },
    });
    assert(block.status === 200, "admin can still save a block rate");
    const deliveryBody = {
      orderNumber: "S3-DELIVERY",
      orderType: "DELIVERY",
      fulfillment: {
        customerId: customer.json.customer.customerId,
        blockNumber: "410",
        deliveryChargeCents: 250,
        deliveryFeeOverride: true,
        expectedBlockRateCents: 300,
      },
      lines: [{ itemId: "item_chicken_burger", quantity: 1 }],
    };
    const delivery = await call("POST", "/v1/test-orders", {
      origin,
      cookie: cashierCookie,
      body: deliveryBody,
    });
    assert(delivery.status === 201, delivery.json?.error || "delivery override");
    const deliveryAudit = getDb()
      .prepare(
        `SELECT actor_user_id FROM audit_events
         WHERE action = 'order.delivery_fee.override' AND entity_id = ?`
      )
      .get(delivery.json.order.order_id);
    assert(deliveryAudit?.actor_user_id === cashierId, "delivery audit staff id");
    const replay = await call("POST", "/v1/test-orders", {
      origin,
      cookie: cashierCookie,
      body: deliveryBody,
    });
    assert(replay.json.order.order_id === delivery.json.order.order_id, "replay returns the same order");
    const deliveryAudits = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_events
         WHERE action = 'order.delivery_fee.override' AND entity_id = ?`
      )
      .get(delivery.json.order.order_id).n;
    assert(deliveryAudits === 1, "replay does not duplicate the fee audit");
    pass("delivery-fee-and-replay");

    const sold = await call("PATCH", `/v1/menu-items/item_chicken_burger/availability`, {
      origin,
      cookie: cashierCookie,
      body: { isSoldOut: true },
    });
    assert(sold.status === 200 && sold.json.menuItem.is_sold_out, "sold out");
    const priceAfterSold = getDb()
      .prepare(`SELECT price_cents FROM menu_items WHERE item_id = 'item_chicken_burger'`)
      .get().price_cents;
    assert(priceAfterSold === menuPrice, "sold out does not change the menu price");
    await call("PATCH", `/v1/menu-items/item_chicken_burger/availability`, {
      origin,
      cookie: cashierCookie,
      body: { isSoldOut: false },
    });
    pass("sold-out");

    const denied = async (method, urlPath, body) => {
      const res = await call(method, urlPath, { origin, cookie: cashierCookie, body });
      assert(res.status === 403, `${method} ${urlPath} should be forbidden`);
    };
    await denied("PUT", "/v1/menu-items", { name: "Nope" });
    await denied("PUT", "/v1/shop-settings", { displayName: "Nope" });
    await denied("PUT", "/v1/printers", { displayName: "Nope" });
    await denied("PUT", "/v1/order-types", { name: "Nope" });
    await denied("GET", "/v1/audit-events");
    await denied("GET", "/v1/staff-users");
    await denied("POST", "/v1/print-jobs/job_missing/reprint", {});
    const jobs = await call("GET", "/v1/print-jobs", { cookie: cashierCookie });
    assert(jobs.status === 200, "cashier can view print jobs");
    pass("cashier-boundaries");

    const priceDenied = await call("POST", "/v1/test-orders", {
      origin,
      cookie: cashierCookie,
      body: {
        orderNumber: "S3-PRICE-DENY",
        orderType: "TAKEAWAY",
        destination: "Counter",
        lines: [
          {
            itemId: "item_chicken_burger",
            quantity: 1,
            unitBasePriceCents: menuPrice + 100,
            basePriceOverride: true,
          },
        ],
      },
    });
    assert(priceDenied.status === 403, "price override denied");
    pass("price-override-denied");

    const variantsBefore = JSON.stringify(
      getDb().prepare(`SELECT variant_id, price_cents FROM menu_item_variants`).all()
    );
    const granted = await call("PATCH", `/v1/staff-users/${encodeURIComponent(cashierId)}`, {
      origin,
      cookie: adminCookie,
      body: { permissions: ["sales.price_override"] },
    });
    assert(granted.status === 200, granted.json?.error || "grant price");
    const priceOk = await call("POST", "/v1/test-orders", {
      origin,
      cookie: cashierCookie,
      body: {
        orderNumber: "S3-PRICE-OK",
        orderType: "TAKEAWAY",
        destination: "Counter",
        lines: [
          {
            itemId: "item_chicken_burger",
            quantity: 1,
            unitBasePriceCents: menuPrice + 100,
            basePriceOverride: true,
          },
        ],
      },
    });
    assert(priceOk.status === 201, priceOk.json?.error || "authorized override");
    const line = getDb()
      .prepare(
        `SELECT unit_base_price_cents, configured_unit_base_price_cents
         FROM order_lines WHERE order_id = ?`
      )
      .get(priceOk.json.order.order_id);
    assert(Number(line.unit_base_price_cents) === menuPrice + 100, "line price changed");
    assert(Number(line.configured_unit_base_price_cents) === menuPrice, "configured price kept");
    const menuStill = getDb()
      .prepare(`SELECT price_cents FROM menu_items WHERE item_id = 'item_chicken_burger'`)
      .get().price_cents;
    assert(menuStill === menuPrice, "menu price unchanged");
    const variantsAfter = JSON.stringify(
      getDb().prepare(`SELECT variant_id, price_cents FROM menu_item_variants`).all()
    );
    assert(variantsBefore === variantsAfter, "variant prices unchanged");
    const priceAudit = getDb()
      .prepare(
        `SELECT actor_user_id, detail_json FROM audit_events
         WHERE action = 'order.line.base_price_adjust'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get();
    assert(priceAudit?.actor_user_id === cashierId, "price audit staff id");
    assert(
      JSON.parse(priceAudit.detail_json).orderId === priceOk.json.order.order_id,
      "price audit order"
    );
    pass("authorized-price-override");

    const addon = await call("PUT", "/v1/addons", {
      origin,
      cookie: adminCookie,
      body: { name: "Test Cheese", priceCents: 300, isActive: true },
    });
    assert(addon.status === 200 || addon.status === 201, "addon created");
    const assigned = await call(
      "PUT",
      "/v1/menu-items/item_chicken_burger/addons",
      {
        origin,
        cookie: adminCookie,
        body: { assignments: [{ addonId: addon.json.addon.addonId, priceOverrideCents: null }] },
      }
    );
    assert(assigned.status === 200, "addon assigned");
    const addonDenied = await call("POST", "/v1/test-orders", {
      origin,
      cookie: cashierCookie,
      body: {
        orderNumber: "S3-ADDON-DENY",
        orderType: "TAKEAWAY",
        destination: "Counter",
        lines: [
          {
            itemId: "item_chicken_burger",
            quantity: 1,
            addons: [{ addonId: addon.json.addon.addonId, quantity: 1, unitPriceCents: 999 }],
          },
        ],
      },
    });
    assert(addonDenied.status === 403, "item-price grant does not allow add-on prices");
    const libraryPrice = getDb()
      .prepare(`SELECT price_cents FROM addons WHERE addon_id = ?`)
      .get(addon.json.addon.addonId).price_cents;
    assert(Number(libraryPrice) === 300, "add-on library price unchanged");
    pass("addon-price-separate");

    const revoked = await call("PATCH", `/v1/staff-users/${encodeURIComponent(cashierId)}`, {
      origin,
      cookie: adminCookie,
      body: { permissions: [] },
    });
    assert(revoked.status === 200, "revoke price");
    const priceAgain = await call("POST", "/v1/test-orders", {
      origin,
      cookie: cashierCookie,
      body: {
        orderNumber: "S3-PRICE-AGAIN",
        orderType: "TAKEAWAY",
        destination: "Counter",
        lines: [
          {
            itemId: "item_chicken_burger",
            quantity: 1,
            unitBasePriceCents: menuPrice + 50,
            basePriceOverride: true,
          },
        ],
      },
    });
    assert(priceAgain.status === 403, "revoked price permission blocks the next order");
    pass("revoke-price-permission");

    const knowledge = await call("PUT", "/v1/menu-items/item_chicken_burger/product-knowledge", {
      origin,
      cookie: adminCookie,
      body: {
        detailedDescription: "Crispy chicken",
        staffTrainingNotes: "Internal training note",
      },
    });
    assert(knowledge.status === 200, knowledge.json?.error || "knowledge saved");
    const knowledgeRead = await call(
      "GET",
      "/v1/menu-items/item_chicken_burger/product-knowledge",
      { cookie: cashierCookie }
    );
    assert(knowledgeRead.status === 200, "cashier can read product knowledge");
    const profile = knowledgeRead.json.productKnowledge;
    assert(profile?.detailedDescription === "Crispy chicken", "customer knowledge visible");
    assert(profile?.staffTrainingNotes == null, "staff notes hidden");
    const knowledgeWrite = await call("PUT", "/v1/menu-items/item_chicken_burger/product-knowledge", {
      origin,
      cookie: cashierCookie,
      body: { detailedDescription: "Changed" },
    });
    assert(knowledgeWrite.status === 403, "cashier cannot edit product knowledge");
    pass("product-knowledge");

    const selfOff = await call("PATCH", `/v1/staff-users/${encodeURIComponent(adminMe.json.userId)}`, {
      origin,
      cookie: adminCookie,
      body: { isActive: false },
    });
    assert(selfOff.status === 409, "last admin cannot be deactivated");
    const selfRole = await call("PATCH", `/v1/staff-users/${encodeURIComponent(adminMe.json.userId)}`, {
      origin,
      cookie: adminCookie,
      body: { role: "cashier" },
    });
    assert(selfRole.status === 409, "last admin cannot be demoted");
    pass("last-admin-guard");

    const deactivated = await call("PATCH", `/v1/staff-users/${encodeURIComponent(cashierId)}`, {
      origin,
      cookie: adminCookie,
      body: { isActive: false },
    });
    assert(deactivated.status === 200 && deactivated.json.user.isActive === false, "deactivated");
    const oldSession = await call("GET", "/v1/session/me", { cookie: cashierCookie });
    assert(oldSession.status === 401, "deactivation revokes the session");
    const inactiveLogin = await call("POST", "/v1/session/login", {
      origin,
      body: { username: CASHIER_USER, password: CASHIER_PASSWORD },
    });
    assert(inactiveLogin.status === 401, "inactive user cannot sign in");
    pass("deactivation");

    const restored = await call("PATCH", `/v1/staff-users/${encodeURIComponent(cashierId)}`, {
      origin,
      cookie: adminCookie,
      body: { isActive: true },
    });
    assert(restored.status === 200, "reactivated");
    const again = await call("POST", "/v1/session/login", {
      origin,
      body: { username: CASHIER_USER, password: CASHIER_PASSWORD },
    });
    assert(again.status === 200, "reactivated login");
    cashierCookie = sessionCookie(again);
    const reset = await call("POST", `/v1/staff-users/${encodeURIComponent(cashierId)}/password`, {
      origin,
      cookie: adminCookie,
      body: { password: CASHIER_PASSWORD_2, confirmPassword: CASHIER_PASSWORD_2 },
    });
    assert(reset.status === 200, reset.json?.error || "password reset");
    noSecret(reset.json);
    const afterReset = await call("GET", "/v1/session/me", { cookie: cashierCookie });
    assert(afterReset.status === 401, "password reset revokes sessions");
    const oldPassword = await call("POST", "/v1/session/login", {
      origin,
      body: { username: CASHIER_USER, password: CASHIER_PASSWORD },
    });
    assert(oldPassword.status === 401, "old password rejected");
    const newPassword = await call("POST", "/v1/session/login", {
      origin,
      body: { username: CASHIER_USER, password: CASHIER_PASSWORD_2 },
    });
    assert(newPassword.status === 200, "new password works");
    cashierCookie = sessionCookie(newPassword);
    pass("password-reset");

    const shopCols = getDb().prepare(`PRAGMA table_info(shop_settings)`).all().map((col) => col.name);
    const shopRow = getDb().prepare(`SELECT * FROM shop_settings WHERE shop_id = ?`).get(shopId);
    const otherShop = "other-shop-step3";
    getDb()
      .prepare(
        `INSERT INTO shop_settings (${shopCols.join(",")}) VALUES (${shopCols.map(() => "?").join(",")})`
      )
      .run(...shopCols.map((name) => (name === "shop_id" ? otherShop : shopRow[name])));
    const otherHash = hashPassword(OTHER_PASSWORD);
    getDb()
      .prepare(
        `INSERT INTO staff_users (
           user_id, shop_id, full_name, username, username_normalized, password_hash,
           is_active, created_at, updated_at
         ) VALUES ('user_other_shop', ?, 'Other Cashier', 'other.cashier', 'other.cashier', ?, 1, ?, ?)`
      )
      .run(otherShop, otherHash, new Date().toISOString(), new Date().toISOString());
    const listed = await call("GET", "/v1/staff-users", { cookie: adminCookie });
    assert(listed.status === 200, "list users");
    assert(!listed.json.users.some((user) => user.userId === "user_other_shop"), "other shop hidden");
    assert(!JSON.stringify(listed.json).includes("scrypt$"), "list hides hashes");
    const cross = await call("PATCH", "/v1/staff-users/user_other_shop", {
      origin,
      cookie: adminCookie,
      body: { fullName: "Taken" },
    });
    assert(cross.status === 404, "cross-shop update blocked");
    const otherLogin = await call("POST", "/v1/session/login", {
      origin,
      body: { username: "other.cashier", password: OTHER_PASSWORD },
    });
    assert(otherLogin.status === 401, "other shop cannot sign in here");
    pass("cross-shop");

    await closeServer(server);
    closeDatabase();
    openDatabase(config.dbPath);
    server = createServer(config);
    await listen(server, config);
    const afterRestart = await call("GET", "/v1/session/me", { cookie: cashierCookie });
    assert(afterRestart.status === 200 && afterRestart.json.userId === cashierId, "session survives restart");
    pass("session-restart");

    const loggedOut = await call("POST", "/v1/session/logout", { origin, cookie: cashierCookie });
    assert(loggedOut.status === 200, "logout");
    const afterLogout = await call("GET", "/v1/session/me", { cookie: cashierCookie });
    assert(afterLogout.status === 401, "logout revokes the session");
    pass("logout");

    const after = liveSnapshot();
    if (before && after) {
      assert(after.customers >= before.customers, "live customers unchanged");
      assert(after.orders >= before.orders, "live orders unchanged");
      assert(after.menu >= before.menu, "live menu unchanged");
    }
    pass("live-database-untouched");
  } finally {
    await closeServer(server);
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  log.info(`staff access ${results.length} passed`);
}

main().catch((err) => {
  log.error(err.message || String(err));
  process.exit(1);
});
