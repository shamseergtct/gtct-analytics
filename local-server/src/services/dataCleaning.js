/**
 * Admin-only pilot data cleaning (TEST tenant).
 * Scopes: transactions | items | customers | master
 */
import { getDb } from "../db/db.js";
import { recordAudit } from "./audit.js";

const SCOPES = new Set(["transactions", "items", "customers", "master"]);

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}

function requireAdmin(role) {
  if (role !== "admin") {
    fail(403, "Admin role required.", "ADMIN_REQUIRED");
  }
}

export function dataCleaningConfirmPhrase(shopId) {
  return `CLEAN ${String(shopId || "").trim()}`;
}

function tableExists(db, name) {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`
    )
    .get(name);
  return Boolean(row);
}

function countTable(db, sql, ...params) {
  try {
    return Number(db.prepare(sql).get(...params)?.n || 0);
  } catch {
    return 0;
  }
}

function deleteWhere(db, table, whereSql, ...params) {
  if (!tableExists(db, table)) return 0;
  try {
    return Number(db.prepare(`DELETE FROM ${table} WHERE ${whereSql}`).run(...params).changes || 0);
  } catch (err) {
    fail(
      500,
      `Failed deleting from ${table}: ${err.message || err}`,
      "CLEAN_DELETE_FAILED"
    );
  }
}

export function getDataCleaningSummary(shopId) {
  const id = String(shopId || "").trim();
  if (!id) fail(400, "Shop id is required.", "SHOP_REQUIRED");
  const db = getDb();
  return {
    shopId: id,
    confirmPhrase: dataCleaningConfirmPhrase(id),
    counts: {
      testOrders: countTable(
        db,
        `SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND is_test = 1`,
        id
      ),
      allOrders: countTable(
        db,
        `SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ?`,
        id
      ),
      menuItems: countTable(db, `SELECT COUNT(*) AS n FROM menu_items`),
      categories: countTable(db, `SELECT COUNT(*) AS n FROM menu_categories`),
      subcategories: countTable(db, `SELECT COUNT(*) AS n FROM menu_subcategories`),
      customers: countTable(
        db,
        `SELECT COUNT(*) AS n FROM shop_customers WHERE shop_id = ?`,
        id
      ),
      addons: countTable(
        db,
        `SELECT COUNT(*) AS n FROM addons WHERE shop_id = ?`,
        id
      ),
      businessShifts: countTable(
        db,
        `SELECT COUNT(*) AS n FROM shop_business_shifts WHERE shop_id = ?`,
        id
      ),
    },
  };
}

function assertConfirm(shopId, { confirm, confirmPhrase } = {}) {
  if (!confirm) {
    fail(400, "confirm=true is required.", "CONFIRM_REQUIRED");
  }
  const expected = dataCleaningConfirmPhrase(shopId);
  if (String(confirmPhrase || "").trim() !== expected) {
    fail(
      400,
      `Type ${expected} to confirm.`,
      "CONFIRM_PHRASE_MISMATCH"
    );
  }
}

/** Child rows that block DELETE FROM orders (RESTRICT / NO ACTION). */
function wipeOrderChildren(db, shopId, orderIds) {
  const summary = {};
  if (!orderIds.length) return summary;

  const placeholders = orderIds.map(() => "?").join(",");
  const byOrder = (table, col = "order_id") => {
    summary[table] = deleteWhere(
      db,
      table,
      `${col} IN (${placeholders})`,
      ...orderIds
    );
  };

  // RESTRICT / NO ACTION first
  byOrder("delivery_cash_handovers");
  byOrder("delivery_commission_accrual_orders");
  byOrder("delivery_rider_net_settlement_orders");
  byOrder("order_payment_allocations");
  byOrder("order_payment_balances");
  byOrder("order_settlements");
  byOrder("order_dispatch_readiness");

  // CASCADE tables — explicit delete is fine / clearer in summary
  byOrder("delivery_credit_reviews");
  byOrder("delivery_order_lifecycle");
  byOrder("delivery_order_payment_reports");
  byOrder("delivery_shop_credit_authorizations");
  byOrder("order_delivery_claims");
  byOrder("order_void_events");
  byOrder("station_prep_tickets");

  // Print jobs: events then jobs
  if (tableExists(db, "print_jobs")) {
    const jobIds = db
      .prepare(
        `SELECT job_id FROM print_jobs WHERE order_id IN (${placeholders})`
      )
      .all(...orderIds)
      .map((r) => r.job_id);
    if (jobIds.length) {
      const jp = jobIds.map(() => "?").join(",");
      summary.print_job_events = deleteWhere(
        db,
        "print_job_events",
        `job_id IN (${jp})`,
        ...jobIds
      );
      summary.print_jobs = deleteWhere(
        db,
        "print_jobs",
        `job_id IN (${jp})`,
        ...jobIds
      );
    } else {
      summary.print_jobs = 0;
    }
  }

  // Order lines cascade from orders, but clear addons/instructions first if needed
  if (tableExists(db, "order_lines")) {
    const lineIds = db
      .prepare(
        `SELECT line_id FROM order_lines WHERE order_id IN (${placeholders})`
      )
      .all(...orderIds)
      .map((r) => r.line_id);
    if (lineIds.length) {
      const lp = lineIds.map(() => "?").join(",");
      summary.order_line_addons = deleteWhere(
        db,
        "order_line_addons",
        `line_id IN (${lp})`,
        ...lineIds
      );
      summary.order_line_instructions = deleteWhere(
        db,
        "order_line_instructions",
        `line_id IN (${lp})`,
        ...lineIds
      );
      summary.order_lines = deleteWhere(
        db,
        "order_lines",
        `line_id IN (${lp})`,
        ...lineIds
      );
    }
  }

  return summary;
}

function wipeShopDaySideTables(db, shopId) {
  const summary = {};

  // Commission accruals / journals for the shop (orders already unlinked)
  if (tableExists(db, "delivery_commission_journal_lines")) {
    summary.delivery_commission_journal_lines = deleteWhere(
      db,
      "delivery_commission_journal_lines",
      "shop_id = ?",
      shopId
    );
  }
  if (tableExists(db, "delivery_commission_accruals")) {
    summary.delivery_commission_accruals = deleteWhere(
      db,
      "delivery_commission_accruals",
      "shop_id = ?",
      shopId
    );
  }

  if (tableExists(db, "delivery_rider_tender_events")) {
    summary.delivery_rider_tender_events = deleteWhere(
      db,
      "delivery_rider_tender_events",
      "shop_id = ?",
      shopId
    );
  }
  if (tableExists(db, "delivery_rider_settlement_journal")) {
    summary.delivery_rider_settlement_journal = deleteWhere(
      db,
      "delivery_rider_settlement_journal",
      "shop_id = ?",
      shopId
    );
  }
  if (tableExists(db, "delivery_rider_tender_journal")) {
    summary.delivery_rider_tender_journal = deleteWhere(
      db,
      "delivery_rider_tender_journal",
      "shop_id = ?",
      shopId
    );
  }
  if (tableExists(db, "delivery_rider_net_settlements")) {
    summary.delivery_rider_net_settlements = deleteWhere(
      db,
      "delivery_rider_net_settlements",
      "shop_id = ?",
      shopId
    );
  }

  // Remaining handovers for shop (safety)
  summary.delivery_cash_handovers_shop = deleteWhere(
    db,
    "delivery_cash_handovers",
    "shop_id = ?",
    shopId
  );

  summary.shop_business_shifts = deleteWhere(
    db,
    "shop_business_shifts",
    "shop_id = ?",
    shopId
  );

  if (tableExists(db, "shop_order_counters")) {
    db.prepare(
      `UPDATE shop_order_counters SET last_number = 0 WHERE shop_id = ?`
    ).run(shopId);
    summary.shop_order_counters_reset = 1;
  }

  // Meta keys tied to orders
  const metaKeys = db
    .prepare(`SELECT key FROM meta WHERE key LIKE 'unmapped:%'`)
    .all()
    .map((r) => r.key);
  let metaDeleted = 0;
  const delMeta = db.prepare(`DELETE FROM meta WHERE key = ?`);
  for (const key of metaKeys) metaDeleted += delMeta.run(key).changes;
  summary.meta = metaDeleted;

  return summary;
}

function cleanTransactions(shopId) {
  const db = getDb();
  return db.transaction(() => {
    const orderIds = db
      .prepare(
        `SELECT order_id FROM orders WHERE tenant_id = ? AND is_test = 1`
      )
      .all(shopId)
      .map((r) => r.order_id);

    const childSummary = wipeOrderChildren(db, shopId, orderIds);
    const ordersDeleted = deleteWhere(
      db,
      "orders",
      "tenant_id = ? AND is_test = 1",
      shopId
    );
    const sideSummary = wipeShopDaySideTables(db, shopId);

    // Non-test leftovers (should be rare in pilot)
    const remaining = countTable(
      db,
      `SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ?`,
      shopId
    );

    return {
      scope: "transactions",
      deleted: { ...childSummary, orders: ordersDeleted, ...sideSummary },
      remainingOrders: remaining,
    };
  })();
}

function assertNoOrderItemRefs(db, shopId) {
  const n = countTable(
    db,
    `SELECT COUNT(*) AS n
     FROM order_lines ol
     JOIN orders o ON o.order_id = ol.order_id
     WHERE o.tenant_id = ?`,
    shopId
  );
  if (n > 0) {
    fail(
      409,
      "Orders still reference menu items. Run Transaction cleaning first.",
      "ORDERS_REFERENCE_ITEMS"
    );
  }
}

function assertNoCustomerRefs(db, shopId) {
  const creditRefs = countTable(
    db,
    `SELECT COUNT(*) AS n FROM order_payment_allocations
     WHERE shop_id = ? AND credit_customer_id IS NOT NULL AND credit_customer_id != ''`,
    shopId
  );
  const orderRefs = countTable(
    db,
    `SELECT COUNT(*) AS n FROM orders
     WHERE tenant_id = ? AND customer_id IS NOT NULL AND customer_id != ''`,
    shopId
  );
  if (creditRefs > 0 || orderRefs > 0) {
    fail(
      409,
      "Orders or payments still reference customers. Run Transaction cleaning first.",
      "ORDERS_REFERENCE_CUSTOMERS"
    );
  }
}

function cleanItems(shopId) {
  const db = getDb();
  return db.transaction(() => {
    assertNoOrderItemRefs(db, shopId);
    const before = countTable(db, `SELECT COUNT(*) AS n FROM menu_items`);
    // Child tables mostly CASCADE; delete items (single-tenant catalog).
    const deleted = deleteWhere(db, "menu_items", "1 = 1");
    return {
      scope: "items",
      deleted: { menu_items: deleted },
      before,
      remaining: countTable(db, `SELECT COUNT(*) AS n FROM menu_items`),
    };
  })();
}

function cleanCustomers(shopId) {
  const db = getDb();
  return db.transaction(() => {
    assertNoCustomerRefs(db, shopId);
    const addresses = deleteWhere(
      db,
      "shop_customer_addresses",
      "shop_id = ?",
      shopId
    );
    const customers = deleteWhere(
      db,
      "shop_customers",
      "shop_id = ?",
      shopId
    );
    return {
      scope: "customers",
      deleted: {
        shop_customer_addresses: addresses,
        shop_customers: customers,
      },
      remaining: countTable(
        db,
        `SELECT COUNT(*) AS n FROM shop_customers WHERE shop_id = ?`,
        shopId
      ),
    };
  })();
}

function cleanMasterExtras(shopId) {
  const db = getDb();
  const summary = {};
  // Clear item FKs to categories before deleting categories
  if (tableExists(db, "menu_items")) {
    db.prepare(
      `UPDATE menu_items SET category_id = NULL, subcategory_id = NULL`
    ).run();
  }
  summary.menu_subcategories = deleteWhere(db, "menu_subcategories", "1 = 1");
  summary.menu_categories = deleteWhere(db, "menu_categories", "1 = 1");
  summary.addons = deleteWhere(db, "addons", "shop_id = ?", shopId);
  return summary;
}

function cleanMaster(shopId) {
  const txn = cleanTransactions(shopId);
  const items = cleanItems(shopId);
  const customers = cleanCustomers(shopId);
  const db = getDb();
  const extras = db.transaction(() => cleanMasterExtras(shopId))();
  return {
    scope: "master",
    deleted: {
      ...txn.deleted,
      ...items.deleted,
      ...customers.deleted,
      ...extras,
    },
    remainingOrders: txn.remainingOrders,
    remainingItems: items.remaining,
    remainingCustomers: customers.remaining,
  };
}

/**
 * @param {string} shopId
 * @param {{ role: string, scope: string, confirm?: boolean, confirmPhrase?: string, actorUserId?: string }} opts
 */
export function runDataCleaning(shopId, opts = {}) {
  requireAdmin(opts.role);
  const id = String(shopId || "").trim();
  if (!id) fail(400, "Shop id is required.", "SHOP_REQUIRED");

  const scope = String(opts.scope || "").trim().toLowerCase();
  if (!SCOPES.has(scope)) {
    fail(
      400,
      "scope must be one of: transactions, items, customers, master",
      "INVALID_SCOPE"
    );
  }

  assertConfirm(id, opts);

  let result;
  if (scope === "transactions") result = cleanTransactions(id);
  else if (scope === "items") result = cleanItems(id);
  else if (scope === "customers") result = cleanCustomers(id);
  else result = cleanMaster(id);

  recordAudit({
    actorRole: opts.role || "admin",
    actorUserId: opts.actorUserId || "",
    action: `data.clean.${scope}`,
    entityType: "shop",
    entityId: id,
    detail: {
      scope,
      deleted: result.deleted,
      remainingOrders: result.remainingOrders ?? null,
      remainingItems: result.remainingItems ?? result.remaining ?? null,
      remainingCustomers: result.remainingCustomers ?? null,
    },
  });

  return {
    ...result,
    shopId: id,
    confirmPhrase: dataCleaningConfirmPhrase(id),
    summary: getDataCleaningSummary(id),
  };
}
