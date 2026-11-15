/**
 * TEST shop reports — read-only aggregations over orders / payments / shifts.
 * Not accounting day-end and not cloud Analytics.
 */
import { getDb } from "../db/db.js";
import { getShopSettings } from "./shopSettings.js";
import { readAllocationSummary } from "./paymentAllocations.js";

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}

function requireDate(value, label) {
  const str = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    fail(400, `${label} must be YYYY-MM-DD.`, "INVALID_DATE");
  }
  const dt = new Date(`${str}T00:00:00Z`);
  if (!Number.isFinite(dt.getTime()) || dt.toISOString().slice(0, 10) !== str) {
    fail(400, `${label} is not a valid calendar date.`, "INVALID_DATE");
  }
  return str;
}

function shopToday(shopId) {
  const zone = getShopSettings(shopId).timezone || "UTC";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function moneyMeta(shopId) {
  try {
    const shop = getShopSettings(shopId);
    return {
      currencyCode: shop.currencyCode || "",
      currencyLabel: shop.currencyLabel || shop.currencyCode || "",
      currencyDecimals: Number(shop.currencyDecimals ?? 2),
      timezone: shop.timezone || "UTC",
      displayName: shop.displayName || "",
    };
  } catch {
    return {
      currencyCode: "",
      currencyLabel: "",
      currencyDecimals: 2,
      timezone: "UTC",
      displayName: "",
    };
  }
}

function parseFilters(shopId, query = {}) {
  const today = shopToday(shopId);
  const from = query.from ? requireDate(query.from, "From date") : today;
  const to = query.to ? requireDate(query.to, "To date") : from;
  if (from > to) fail(400, "From date must be on or before to date.", "INVALID_RANGE");
  const shiftId = String(query.shiftId || "").trim() || null;
  return { from, to, shiftId, today };
}

function orderDateExpr() {
  return `COALESCE(NULLIF(o.business_date, ''), substr(o.created_at, 1, 10))`;
}

function orderScopeSql(filters, { includeVoid = false } = {}) {
  const clauses = [`o.tenant_id = ?`, `o.is_test = 1`];
  if (!includeVoid) clauses.push(`o.status != 'VOID'`);
  const params = [];
  if (filters.shiftId) {
    clauses.push(`o.business_shift_id = ?`);
    params.push(filters.shiftId);
  } else {
    clauses.push(`${orderDateExpr()} >= ?`);
    clauses.push(`${orderDateExpr()} <= ?`);
    params.push(filters.from, filters.to);
  }
  return { sql: clauses.join(" AND "), params };
}

function hourInZone(iso, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date(iso));
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    return Number.isFinite(hour) ? hour % 24 : null;
  } catch {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.getUTCHours();
  }
}

function buildStationVolume(db, shopId, filters) {
  const scope = orderScopeSql(filters);
  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(s.name, ''), NULLIF(ol.station_id, ''), 'No station') AS station_name,
              ol.station_id AS station_id,
              COUNT(DISTINCT ol.order_id) AS order_count,
              SUM(ol.quantity) AS item_qty,
              SUM(ol.line_total_cents) AS revenue_cents,
              COUNT(ol.line_id) AS line_count
       FROM order_lines ol
       INNER JOIN orders o ON o.order_id = ol.order_id
       LEFT JOIN stations s ON s.station_id = ol.station_id
       WHERE ${scope.sql}
       GROUP BY ol.station_id, station_name
       ORDER BY item_qty DESC, revenue_cents DESC, station_name ASC`
    )
    .all(shopId, ...scope.params);

  const kitchenJobs = db
    .prepare(
      `SELECT COALESCE(NULLIF(s.name, ''), NULLIF(pj.station_id, ''), 'No station') AS station_name,
              COUNT(*) AS kitchen_tickets,
              SUM(CASE WHEN pj.status IN ('DISPATCHED','CONFIRMED') THEN 1 ELSE 0 END) AS dispatched_tickets,
              SUM(CASE WHEN pj.status IN ('FAILED','UNKNOWN','NEEDS_REVIEW') THEN 1 ELSE 0 END) AS problem_tickets
       FROM print_jobs pj
       INNER JOIN orders o ON o.order_id = pj.order_id
       LEFT JOIN stations s ON s.station_id = pj.station_id
       WHERE ${scope.sql}
         AND pj.job_type = 'KITCHEN'
       GROUP BY pj.station_id, station_name
       ORDER BY kitchen_tickets DESC, station_name ASC`
    )
    .all(shopId, ...scope.params);

  const jobMap = new Map(kitchenJobs.map((r) => [r.station_name, r]));
  return rows.map((r) => {
    const jobs = jobMap.get(r.station_name) || {};
    return {
      stationId: r.station_id || "",
      stationName: r.station_name,
      orderCount: Number(r.order_count || 0),
      itemQty: Number(r.item_qty || 0),
      lineCount: Number(r.line_count || 0),
      revenueCents: Number(r.revenue_cents || 0),
      kitchenTickets: Number(jobs.kitchen_tickets || 0),
      dispatchedTickets: Number(jobs.dispatched_tickets || 0),
      problemTickets: Number(jobs.problem_tickets || 0),
    };
  });
}

function buildHourlyHeat(orders, timeZone) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: `${String(hour).padStart(2, "0")}:00`,
    orderCount: 0,
    totalCents: 0,
  }));
  for (const order of orders) {
    const hour = hourInZone(order.created_at, timeZone);
    if (hour == null) continue;
    buckets[hour].orderCount += 1;
    buckets[hour].totalCents += Number(order.total_cents || 0);
  }
  const peak = buckets.reduce(
    (best, row) => (row.orderCount > best.orderCount ? row : best),
    buckets[0]
  );
  return {
    timezone: timeZone,
    peakHour: peak.orderCount > 0 ? peak.label : null,
    peakOrderCount: peak.orderCount,
    hours: buckets,
  };
}

function buildOpsAudit(db, shopId, filters) {
  const voidParams = [shopId, filters.from, filters.to];
  let voidSql = `SELECT v.order_id, v.invoice_number, v.reason, v.voided_at, v.voided_by_user_id,
                        o.business_date, o.order_type_name, o.order_type, o.total_cents,
                        o.customer_name, u.username AS voided_by_username
                 FROM order_void_events v
                 INNER JOIN orders o ON o.order_id = v.order_id
                 LEFT JOIN staff_users u ON u.user_id = v.voided_by_user_id
                 WHERE v.shop_id = ?
                   AND o.is_test = 1
                   AND substr(v.voided_at, 1, 10) >= ?
                   AND substr(v.voided_at, 1, 10) <= ?`;
  if (filters.shiftId) {
    voidSql += ` AND o.business_shift_id = ?`;
    voidParams.push(filters.shiftId);
  }
  voidSql += ` ORDER BY v.voided_at DESC`;

  const voids = db
    .prepare(voidSql)
    .all(...voidParams)
    .map((r) => ({
      orderId: r.order_id,
      orderNumber: r.invoice_number,
      businessDate: r.business_date || "",
      orderType: r.order_type_name || r.order_type || "",
      customerName: r.customer_name || "",
      totalCents: Number(r.total_cents || 0),
      reason: r.reason || "",
      voidedAt: r.voided_at,
      voidedBy: r.voided_by_username || r.voided_by_user_id || "",
    }));

  const scope = orderScopeSql(filters, { includeVoid: true });
  const edits = db
    .prepare(
      `SELECT o.order_id, o.order_number, o.business_date, o.order_type_name, o.order_type,
              o.customer_name, o.total_cents, o.created_at, o.updated_at, o.status,
              COALESCE(MAX(pj.ticket_revision), 1) AS max_revision,
              SUM(CASE WHEN pj.job_type = 'KITCHEN' THEN 1 ELSE 0 END) AS kitchen_jobs
       FROM orders o
       LEFT JOIN print_jobs pj ON pj.order_id = o.order_id
       WHERE ${scope.sql}
       GROUP BY o.order_id
       HAVING max_revision > 1 OR o.updated_at > o.created_at
       ORDER BY o.updated_at DESC`
    )
    .all(shopId, ...scope.params)
    .map((r) => ({
      orderId: r.order_id,
      orderNumber: r.order_number,
      businessDate: r.business_date || "",
      orderType: r.order_type_name || r.order_type || "",
      customerName: r.customer_name || "",
      totalCents: Number(r.total_cents || 0),
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ticketRevision: Number(r.max_revision || 1),
      kitchenJobs: Number(r.kitchen_jobs || 0),
      edited: Number(r.max_revision || 1) > 1 || r.updated_at > r.created_at,
    }));

  const priceAudits = db
    .prepare(
      `SELECT a.event_id, a.action, a.entity_id, a.actor_role, a.actor_user_id,
              a.created_at, a.detail_json, u.username AS actor_username
       FROM audit_events a
       LEFT JOIN staff_users u ON u.user_id = a.actor_user_id
       WHERE a.action IN (
           'order.line.base_price_adjust',
           'order.addon.price_adjust',
           'order.addon.price_entered',
           'order.delivery_fee.override',
           'sales.invoice.void'
         )
         AND substr(a.created_at, 1, 10) >= ?
         AND substr(a.created_at, 1, 10) <= ?
       ORDER BY a.created_at DESC
       LIMIT 200`
    )
    .all(filters.from, filters.to)
    .map((r) => {
      let detail = {};
      try {
        detail = JSON.parse(r.detail_json || "{}");
      } catch {
        detail = {};
      }
      return {
        eventId: r.event_id,
        action: r.action,
        entityId: r.entity_id,
        actorRole: r.actor_role || "",
        actor: r.actor_username || r.actor_user_id || r.actor_role || "",
        createdAt: r.created_at,
        detail,
      };
    });

  return {
    voidCount: voids.length,
    editCount: edits.length,
    voids,
    edits,
    priceAudits,
  };
}

function deliveryDateClause(filters, columnSql) {
  if (filters.shiftId) {
    return {
      sql: `o.business_shift_id = ?`,
      params: [filters.shiftId],
    };
  }
  return {
    sql: `${columnSql} >= ? AND ${columnSql} <= ?`,
    params: [filters.from, filters.to],
  };
}

function buildRiderCashHandover(db, shopId, filters) {
  const handedScope = deliveryDateClause(
    filters,
    `COALESCE(NULLIF(o.business_date, ''), substr(h.created_at, 1, 10))`
  );
  const handedRows = db
    .prepare(
      `SELECT h.driver_user_id AS rider_user_id,
              COALESCE(NULLIF(u.full_name, ''), u.username, h.driver_user_id) AS rider_name,
              COUNT(*) AS handover_count,
              SUM(h.amount_cents) AS amount_cents,
              MIN(h.created_at) AS first_at,
              MAX(h.created_at) AS last_at
       FROM delivery_cash_handovers h
       INNER JOIN orders o ON o.order_id = h.order_id AND o.tenant_id = h.shop_id
       LEFT JOIN staff_users u ON u.shop_id = h.shop_id AND u.user_id = h.driver_user_id
       WHERE h.shop_id = ?
         AND o.is_test = 1
         AND ${handedScope.sql}
       GROUP BY h.driver_user_id, rider_name
       ORDER BY amount_cents DESC, rider_name ASC`
    )
    .all(shopId, ...handedScope.params)
    .map((r) => ({
      riderUserId: r.rider_user_id,
      riderName: r.rider_name,
      handoverCount: Number(r.handover_count || 0),
      amountCents: Number(r.amount_cents || 0),
      firstAt: r.first_at || "",
      lastAt: r.last_at || "",
    }));

  const pendingScope = deliveryDateClause(
    filters,
    `COALESCE(NULLIF(o.business_date, ''), substr(r.reported_at, 1, 10))`
  );
  const pendingRows = db
    .prepare(
      `SELECT r.driver_user_id AS rider_user_id,
              COALESCE(NULLIF(u.full_name, ''), u.username, r.driver_user_id) AS rider_name,
              COUNT(*) AS pending_count,
              SUM(r.amount_cents) AS amount_cents
       FROM delivery_order_payment_reports r
       INNER JOIN orders o ON o.order_id = r.order_id AND o.tenant_id = r.shop_id
       INNER JOIN order_delivery_claims c
         ON c.shop_id = r.shop_id AND c.order_id = r.order_id
         AND c.driver_user_id = r.driver_user_id
       LEFT JOIN delivery_order_lifecycle l
         ON l.shop_id = r.shop_id AND l.order_id = r.order_id
       LEFT JOIN staff_users u ON u.shop_id = r.shop_id AND u.user_id = r.driver_user_id
       WHERE r.shop_id = ?
         AND r.report_type = 'CASH_WITH_BOY'
         AND o.is_test = 1
         AND o.status = 'OPEN'
         AND o.fulfillment_behavior = 'DELIVERY'
         AND l.status = 'DELIVERED'
         AND NOT EXISTS (
           SELECT 1 FROM delivery_cash_handovers h
           WHERE h.shop_id = r.shop_id AND h.order_id = r.order_id
         )
         AND ${pendingScope.sql}
       GROUP BY r.driver_user_id, rider_name
       ORDER BY amount_cents DESC, rider_name ASC`
    )
    .all(shopId, ...pendingScope.params)
    .map((r) => ({
      riderUserId: r.rider_user_id,
      riderName: r.rider_name,
      pendingCount: Number(r.pending_count || 0),
      amountCents: Number(r.amount_cents || 0),
    }));

  const handedTotal = handedRows.reduce((n, r) => n + r.amountCents, 0);
  const pendingTotal = pendingRows.reduce((n, r) => n + r.amountCents, 0);
  return {
    handedOver: handedRows,
    pendingWithBoy: pendingRows,
    totals: {
      handedOverCents: handedTotal,
      handedOverCount: handedRows.reduce((n, r) => n + r.handoverCount, 0),
      pendingCents: pendingTotal,
      pendingCount: pendingRows.reduce((n, r) => n + r.pendingCount, 0),
    },
    note: "Cashier-confirmed rider cash handovers vs still-pending CASH_WITH_BOY. Not a ledger Z-report.",
  };
}

function buildCommissionStatus(db, shopId, filters) {
  const dateSql = filters.shiftId
    ? `a.business_date = (
         SELECT business_date FROM shop_business_shifts
         WHERE shop_id = ? AND shift_id = ?
       )`
    : `a.business_date >= ? AND a.business_date <= ?`;
  const dateParams = filters.shiftId
    ? [shopId, filters.shiftId]
    : [filters.from, filters.to];

  const rows = db
    .prepare(
      `SELECT a.rider_user_id,
              COALESCE(NULLIF(u.full_name, ''), u.username, a.rider_user_id) AS rider_name,
              a.business_date,
              a.accrual_id,
              a.eligible_delivery_count,
              a.total_bill_minor,
              a.delivery_charge_minor,
              a.amount_minor AS accrued_minor,
              COALESCE(s.commission_minor, 0) AS paid_minor,
              CASE WHEN s.settlement_id IS NULL THEN 0 ELSE 1 END AS settled
       FROM delivery_commission_accruals a
       LEFT JOIN delivery_rider_net_settlements s ON s.accrual_id = a.accrual_id
       LEFT JOIN staff_users u ON u.shop_id = a.shop_id AND u.user_id = a.rider_user_id
       WHERE a.shop_id = ?
         AND ${dateSql}
       ORDER BY a.business_date DESC, rider_name ASC`
    )
    .all(shopId, ...dateParams)
    .map((r) => {
      const accrued = Number(r.accrued_minor || 0);
      const paid = Number(r.paid_minor || 0);
      return {
        accrualId: r.accrual_id,
        riderUserId: r.rider_user_id,
        riderName: r.rider_name,
        businessDate: r.business_date,
        deliveryCount: Number(r.eligible_delivery_count || 0),
        billCents: Number(r.total_bill_minor || 0),
        deliveryChargeCents: Number(r.delivery_charge_minor || 0),
        accruedCents: accrued,
        paidCents: paid,
        payableCents: Math.max(0, accrued - paid),
        settled: Boolean(r.settled),
      };
    });

  const byRiderMap = new Map();
  for (const row of rows) {
    if (!byRiderMap.has(row.riderUserId)) {
      byRiderMap.set(row.riderUserId, {
        riderUserId: row.riderUserId,
        riderName: row.riderName,
        accrualCount: 0,
        deliveryCount: 0,
        accruedCents: 0,
        paidCents: 0,
        payableCents: 0,
      });
    }
    const agg = byRiderMap.get(row.riderUserId);
    agg.accrualCount += 1;
    agg.deliveryCount += row.deliveryCount;
    agg.accruedCents += row.accruedCents;
    agg.paidCents += row.paidCents;
    agg.payableCents += row.payableCents;
  }

  return {
    accruals: rows,
    byRider: [...byRiderMap.values()].sort(
      (a, b) => b.accruedCents - a.accruedCents || a.riderName.localeCompare(b.riderName)
    ),
    totals: {
      accrualCount: rows.length,
      deliveryCount: rows.reduce((n, r) => n + r.deliveryCount, 0),
      accruedCents: rows.reduce((n, r) => n + r.accruedCents, 0),
      paidCents: rows.reduce((n, r) => n + r.paidCents, 0),
      payableCents: rows.reduce((n, r) => n + r.payableCents, 0),
    },
    note: "Commission subledger only — accrued vs paid via rider net settlement. Not shop general ledger.",
  };
}

function buildDeliverySalesMix(db, shopId, filters, orders) {
  const delivery = {
    orderCount: 0,
    totalCents: 0,
    goodsCents: 0,
    taxCents: 0,
    deliveryChargeCents: 0,
  };
  const nonDelivery = {
    orderCount: 0,
    totalCents: 0,
    goodsCents: 0,
    taxCents: 0,
    deliveryChargeCents: 0,
  };
  for (const order of orders) {
    const bucket =
      String(order.fulfillment_behavior || "").toUpperCase() === "DELIVERY"
        ? delivery
        : nonDelivery;
    bucket.orderCount += 1;
    bucket.totalCents += Number(order.total_cents || 0);
    bucket.goodsCents += Number(order.goods_cents || 0);
    bucket.taxCents += Number(order.tax_cents || 0);
    bucket.deliveryChargeCents += Number(order.delivery_charge_cents || 0);
  }

  const scope = orderScopeSql(filters);
  const byRider = db
    .prepare(
      `SELECT c.driver_user_id AS rider_user_id,
              COALESCE(NULLIF(u.full_name, ''), u.username, c.driver_user_id) AS rider_name,
              COUNT(*) AS order_count,
              SUM(o.total_cents) AS total_cents,
              SUM(o.delivery_charge_cents) AS delivery_charge_cents
       FROM orders o
       INNER JOIN order_delivery_claims c
         ON c.shop_id = o.tenant_id AND c.order_id = o.order_id
       LEFT JOIN staff_users u ON u.shop_id = c.shop_id AND u.user_id = c.driver_user_id
       WHERE ${scope.sql}
         AND o.fulfillment_behavior = 'DELIVERY'
       GROUP BY c.driver_user_id, rider_name
       ORDER BY total_cents DESC, rider_name ASC`
    )
    .all(shopId, ...scope.params)
    .map((r) => ({
      riderUserId: r.rider_user_id,
      riderName: r.rider_name,
      orderCount: Number(r.order_count || 0),
      totalCents: Number(r.total_cents || 0),
      deliveryChargeCents: Number(r.delivery_charge_cents || 0),
    }));

  const allTotal = delivery.totalCents + nonDelivery.totalCents;
  return {
    delivery,
    nonDelivery,
    deliverySharePct:
      allTotal > 0 ? Math.round((delivery.totalCents / allTotal) * 1000) / 10 : 0,
    byRider,
    note: "Delivery vs other fulfillment from TEST orders in range.",
  };
}

function listScopedOrders(db, shopId, filters) {
  const scope = orderScopeSql(filters);
  return db
    .prepare(
      `SELECT o.order_id, o.order_number, o.order_type, o.order_type_name,
              o.fulfillment_behavior, o.status, o.total_cents, o.goods_cents,
              o.net_cents, o.tax_cents, o.delivery_charge_cents,
              o.currency_code, o.currency_label, o.currency_decimals,
              o.customer_name, o.customer_phone, o.created_at, o.business_date,
              o.business_shift_id, o.token_number,
              ${orderDateExpr()} AS report_date
       FROM orders o
       WHERE ${scope.sql}
       ORDER BY o.created_at ASC, o.order_number ASC`
    )
    .all(shopId, ...scope.params);
}

function paymentSnapshot(db, shopId, order) {
  try {
    const summary = readAllocationSummary(
      db,
      shopId,
      order.order_id,
      Number(order.total_cents || 0)
    );
    return {
      cashCents: summary.cashCents,
      bankCents: summary.bankCents,
      creditCents: summary.creditCents,
      paidCents: summary.paidCents,
      balanceCents: summary.balanceCents,
      unallocatedCents: summary.unallocatedCents,
      paymentStatus: summary.paymentStatus,
    };
  } catch {
    return {
      cashCents: 0,
      bankCents: 0,
      creditCents: 0,
      paidCents: 0,
      balanceCents: Number(order.total_cents || 0),
      unallocatedCents: Number(order.total_cents || 0),
      paymentStatus: "UNPAID",
    };
  }
}

export function listReportShifts(shopId, limit = 30) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT shift_id, business_date, status, opened_at, closed_at, last_token_number
       FROM shop_business_shifts
       WHERE shop_id = ?
       ORDER BY opened_at DESC
       LIMIT ?`
    )
    .all(shopId, Math.min(Math.max(Number(limit) || 30, 1), 100));
  return rows.map((r) => ({
    shiftId: r.shift_id,
    businessDate: r.business_date,
    status: r.status,
    openedAt: r.opened_at,
    closedAt: r.closed_at || null,
    lastTokenNumber: Number(r.last_token_number || 0),
  }));
}

export function getShopReports(shopId, query = {}) {
  const filters = parseFilters(shopId, query);
  const db = getDb();
  const money = moneyMeta(shopId);
  const orders = listScopedOrders(db, shopId, filters);

  const dailyMap = new Map();
  const typeMap = new Map();
  const payments = {
    cashCents: 0,
    bankCents: 0,
    creditCents: 0,
    paidCents: 0,
    outstandingCents: 0,
    byStatus: { PAID: 0, CREDIT: 0, PARTIAL: 0, UNPAID: 0 },
  };
  const unpaid = [];
  let goodsCents = 0;
  let taxCents = 0;
  let deliveryCents = 0;
  let totalCents = 0;

  for (const order of orders) {
    const pay = paymentSnapshot(db, shopId, order);
    const day = order.report_date || filters.from;
    if (!dailyMap.has(day)) {
      dailyMap.set(day, {
        businessDate: day,
        orderCount: 0,
        goodsCents: 0,
        taxCents: 0,
        deliveryCents: 0,
        totalCents: 0,
        paidCents: 0,
        creditCents: 0,
        outstandingCents: 0,
      });
    }
    const daily = dailyMap.get(day);
    daily.orderCount += 1;
    daily.goodsCents += Number(order.goods_cents || 0);
    daily.taxCents += Number(order.tax_cents || 0);
    daily.deliveryCents += Number(order.delivery_charge_cents || 0);
    daily.totalCents += Number(order.total_cents || 0);
    daily.paidCents += pay.paidCents;
    daily.creditCents += pay.creditCents;
    daily.outstandingCents += pay.unallocatedCents;

    const typeKey =
      String(order.order_type_name || order.order_type || "UNKNOWN").trim() ||
      "UNKNOWN";
    if (!typeMap.has(typeKey)) {
      typeMap.set(typeKey, {
        orderType: typeKey,
        orderCount: 0,
        totalCents: 0,
        paidCents: 0,
        creditCents: 0,
        outstandingCents: 0,
      });
    }
    const typeRow = typeMap.get(typeKey);
    typeRow.orderCount += 1;
    typeRow.totalCents += Number(order.total_cents || 0);
    typeRow.paidCents += pay.paidCents;
    typeRow.creditCents += pay.creditCents;
    typeRow.outstandingCents += pay.unallocatedCents;

    payments.cashCents += pay.cashCents;
    payments.bankCents += pay.bankCents;
    payments.creditCents += pay.creditCents;
    payments.paidCents += pay.paidCents;
    payments.outstandingCents += pay.unallocatedCents;
    payments.byStatus[pay.paymentStatus] =
      (payments.byStatus[pay.paymentStatus] || 0) + 1;

    goodsCents += Number(order.goods_cents || 0);
    taxCents += Number(order.tax_cents || 0);
    deliveryCents += Number(order.delivery_charge_cents || 0);
    totalCents += Number(order.total_cents || 0);

    if (pay.unallocatedCents > 0 || pay.creditCents > 0) {
      unpaid.push({
        orderId: order.order_id,
        orderNumber: order.order_number,
        businessDate: day,
        orderType: typeKey,
        customerName: order.customer_name || "",
        customerPhone: order.customer_phone || "",
        totalCents: Number(order.total_cents || 0),
        paidCents: pay.paidCents,
        creditCents: pay.creditCents,
        outstandingCents: pay.unallocatedCents,
        paymentStatus: pay.paymentStatus,
        createdAt: order.created_at,
      });
    }
  }

  const scope = orderScopeSql(filters);
  const itemRows = db
    .prepare(
      `SELECT ol.item_id,
              ol.item_name,
              COALESCE(ol.variant_id, '') AS variant_id,
              COALESCE(NULLIF(ol.variant_name, ''), '') AS variant_name,
              COALESCE(NULLIF(mi.category, ''), 'Uncategorized') AS category,
              SUM(ol.quantity) AS quantity,
              SUM(ol.line_total_cents) AS revenue_cents,
              COUNT(DISTINCT ol.order_id) AS order_count
       FROM order_lines ol
       INNER JOIN orders o ON o.order_id = ol.order_id
       LEFT JOIN menu_items mi ON mi.item_id = ol.item_id
       WHERE ${scope.sql}
       GROUP BY ol.item_id, ol.item_name, COALESCE(ol.variant_id, ''),
                COALESCE(NULLIF(ol.variant_name, ''), ''), category
       ORDER BY revenue_cents DESC, quantity DESC, ol.item_name ASC,
                variant_name ASC`
    )
    .all(shopId, ...scope.params)
    .map((r) => {
      const variantName = r.variant_name || "";
      const itemName = variantName
        ? `${r.item_name} (${variantName})`
        : r.item_name;
      return {
        itemId: r.item_id,
        variantId: r.variant_id || "",
        variantName,
        itemName,
        baseItemName: r.item_name,
        category: r.category,
        quantity: Number(r.quantity || 0),
        revenueCents: Number(r.revenue_cents || 0),
        orderCount: Number(r.order_count || 0),
      };
    });

  const categoryMap = new Map();
  for (const item of itemRows) {
    if (!categoryMap.has(item.category)) {
      categoryMap.set(item.category, {
        category: item.category,
        quantity: 0,
        revenueCents: 0,
        itemCount: 0,
      });
    }
    const cat = categoryMap.get(item.category);
    cat.quantity += item.quantity;
    cat.revenueCents += item.revenueCents;
    cat.itemCount += 1;
  }

  let shift = null;
  if (filters.shiftId) {
    const row = db
      .prepare(
        `SELECT shift_id, business_date, status, opened_at, closed_at, last_token_number
         FROM shop_business_shifts WHERE shop_id = ? AND shift_id = ?`
      )
      .get(shopId, filters.shiftId);
    if (row) {
      shift = {
        shiftId: row.shift_id,
        businessDate: row.business_date,
        status: row.status,
        openedAt: row.opened_at,
        closedAt: row.closed_at || null,
        lastTokenNumber: Number(row.last_token_number || 0),
        orderCount: orders.length,
        totalCents,
        paidCents: payments.paidCents,
        creditCents: payments.creditCents,
        outstandingCents: payments.outstandingCents,
        cashCents: payments.cashCents,
        bankCents: payments.bankCents,
      };
    }
  } else {
    const open = db
      .prepare(
        `SELECT shift_id, business_date, status, opened_at, closed_at, last_token_number
         FROM shop_business_shifts WHERE shop_id = ? AND status = 'OPEN'`
      )
      .get(shopId);
    if (open) {
      shift = {
        shiftId: open.shift_id,
        businessDate: open.business_date,
        status: open.status,
        openedAt: open.opened_at,
        closedAt: null,
        lastTokenNumber: Number(open.last_token_number || 0),
        note: "Open shift snapshot (not limited to the selected date range).",
      };
    }
  }

  return {
    filters: {
      from: filters.from,
      to: filters.to,
      shiftId: filters.shiftId,
      today: filters.today,
    },
    money,
    summary: {
      orderCount: orders.length,
      goodsCents,
      taxCents,
      deliveryCents,
      totalCents,
      paidCents: payments.paidCents,
      creditCents: payments.creditCents,
      outstandingCents: payments.outstandingCents,
      cashCents: payments.cashCents,
      bankCents: payments.bankCents,
    },
    daily: [...dailyMap.values()].sort((a, b) =>
      a.businessDate.localeCompare(b.businessDate)
    ),
    payments,
    byOrderType: [...typeMap.values()].sort((a, b) => b.totalCents - a.totalCents),
    items: itemRows,
    categories: [...categoryMap.values()].sort(
      (a, b) => b.revenueCents - a.revenueCents
    ),
    unpaid: unpaid.sort((a, b) => b.outstandingCents - a.outstandingCents),
    shift,
    shifts: listReportShifts(shopId),
    stations: buildStationVolume(db, shopId, filters),
    hourly: buildHourlyHeat(orders, money.timezone || "UTC"),
    opsAudit: buildOpsAudit(db, shopId, filters),
    riderCash: buildRiderCashHandover(db, shopId, filters),
    commission: buildCommissionStatus(db, shopId, filters),
    deliveryMix: buildDeliverySalesMix(db, shopId, filters, orders),
  };
}
