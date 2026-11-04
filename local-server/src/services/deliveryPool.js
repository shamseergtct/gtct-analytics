/**
 * P2-E2A: Local TEST-only delivery availability and first-wins acceptance.
 * This is NOT a cloud/mobile sync endpoint. No collected cash, commission,
 * sales posting, pickup, or delivered events are written here.
 */
import { getDb } from '../db/db.js';
import { nowIso } from '../util/time.js';
import { recordAudit } from './audit.js';
import { readOrderOperationalState } from './orderOperationalState.js';
import { readDeliveryPaymentReport } from './deliveryPaymentReports.js';
import { readDeliveryLifecycle } from './deliveryLifecycle.js';

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}

function driverGuard(db, shopId, actor, permission) {
  if (actor?.role !== 'delivery' || !actor.userId || !(actor.permissions || []).includes(permission)) {
    fail(403, 'Delivery Boy access required.', 'DELIVERY_FORBIDDEN');
  }
  const active = db.prepare(`SELECT 1 FROM staff_users u
    JOIN staff_user_roles r ON r.shop_id = u.shop_id AND r.user_id = u.user_id
    WHERE u.shop_id = ? AND u.user_id = ? AND u.is_active = 1
      AND r.role_id = 'role_delivery' AND r.revoked_at IS NULL`).get(shopId, actor.userId);
  if (!active) fail(403, 'Delivery account is not active for this shop.', 'DELIVERY_INACTIVE');
}

function orderInfo(order) {
  return {
    orderId: order.order_id, orderNumber: order.order_number,
    tokenNumber: order.token_number == null ? null : Number(order.token_number),
    businessDate: order.business_date || '',
    customerName: order.customer_name || '', customerPhone: order.customer_phone || '',
    blockNumber: order.block_number || '', roadNumber: order.road_number || '',
    buildingNumber: order.building_number || '', addressNote: order.address_note || '',
    currencyCode: order.currency_code || '', currencyDecimals: Number(order.currency_decimals ?? 2),
    totalCents: Number(order.total_cents || 0),
    createdAt: order.created_at,
  };
}

const ACTIVE_ORDER = `o.tenant_id = ? AND o.is_test = 1 AND o.status = 'OPEN'
  AND o.fulfillment_behavior = 'DELIVERY'`;

function cleanFilter(v) {
  if (typeof v !== 'string') return '';
  const val = v.trim();
  if (val.length > 30 || /[\x00-\x1f]/.test(val)) fail(400, 'Invalid filter.', 'INVALID_FILTER');
  return val;
}

/** All authorized Delivery Boys share the same unclaimed, readiness-verified pool. */
export function listAvailableDeliveries(shopId, actor, filters = {}) {
  const db = getDb();
  driverGuard(db, shopId, actor, 'delivery.pool.view');
  const block = cleanFilter(filters.block || '');
  const road = cleanFilter(filters.road || '');
  const priorityRoad = cleanFilter(filters.priorityRoad || '');
  const sql = `SELECT o.* FROM orders o
    JOIN order_dispatch_readiness r ON r.shop_id = o.tenant_id AND r.order_id = o.order_id
    LEFT JOIN order_delivery_claims c ON c.shop_id = o.tenant_id AND c.order_id = o.order_id
    WHERE ${ACTIVE_ORDER} AND c.order_id IS NULL
    ${block ? 'AND o.block_number = ?' : ''}
    ${road ? 'AND o.road_number = ?' : ''}
    ORDER BY ${priorityRoad ? 'CASE WHEN o.road_number = ? THEN 0 ELSE 1 END,' : ''} o.created_at ASC
    LIMIT 200`;
  const rows = db.prepare(sql).all(shopId, ...(block ? [block] : []), ...(road ? [road] : []),
    ...(priorityRoad ? [priorityRoad] : []));
  const orders = [];
  for (const o of rows) {
    const state = readOrderOperationalState(db, shopId, o);
    if (state.dispatch.ready) orders.push({ ...orderInfo(o), expectedRevision: state.dispatch.revision });
    if (orders.length >= 100) break;
  }
  return { orders, count: orders.length, limit: 100 };
}

export function listMyDeliveries(shopId, actor) {
  const db = getDb();
  driverGuard(db, shopId, actor, 'delivery.pool.view');
  const rows = db.prepare(`SELECT o.*, c.accepted_at, c.prep_revision FROM order_delivery_claims c
    JOIN orders o ON o.tenant_id = c.shop_id AND o.order_id = c.order_id
    WHERE c.shop_id = ? AND c.driver_user_id = ? AND o.is_test = 1
    ORDER BY c.accepted_at DESC LIMIT 100`).all(shopId, actor.userId);
  const orders = rows.map(o => {
    const state = readOrderOperationalState(db, shopId, o);
    return { ...orderInfo(o), acceptedAt: o.accepted_at,
      status: o.status === 'VOID' ? 'VOID' : state.dispatch.ready ? 'ACCEPTED_BY_DELIVERY_BOY' : 'PACKING_RECHECK_REQUIRED',
      deliveryLifecycle: readDeliveryLifecycle(db, shopId, o.order_id),
      paymentReport: readDeliveryPaymentReport(db, shopId, o.order_id, actor.userId, o.total_cents) };
  });
  // Query the full claim set, not the 100-card page, to avoid undercounting
  // rider cash when many accepted orders exist. Still OBSERVATION only.
  const pendingCashByCurrency = db.prepare(`
    SELECT r.currency_code AS currencyCode, r.currency_decimals AS currencyDecimals,
           SUM(r.amount_cents) AS amountCents, COUNT(*) AS orderCount
    FROM delivery_order_payment_reports r
    JOIN order_delivery_claims c ON c.shop_id = r.shop_id
       AND c.order_id = r.order_id AND c.driver_user_id = r.driver_user_id
    JOIN orders o ON o.tenant_id = r.shop_id AND o.order_id = r.order_id
    LEFT JOIN order_payment_balances b
      ON b.shop_id = r.shop_id AND b.order_id = r.order_id
    LEFT JOIN delivery_order_lifecycle l ON l.shop_id = r.shop_id AND l.order_id = r.order_id
    WHERE r.shop_id = ? AND r.driver_user_id = ?
      AND (l.status IS NULL OR l.status NOT IN ('CANCEL_REQUESTED','CANCELLED'))
      AND r.report_type = 'CASH_WITH_BOY' AND o.is_test = 1 AND o.status = 'OPEN'
      AND o.total_cents = r.amount_cents
      AND (b.order_id IS NULL OR b.paid_cents = 0)
      AND NOT EXISTS (SELECT 1 FROM order_payment_allocations a
        WHERE a.shop_id=r.shop_id AND a.order_id=r.order_id)
    GROUP BY r.currency_code, r.currency_decimals`).all(shopId, actor.userId);
  return { orders, pendingCashByCurrency,
    notice: 'Recorded rider cash is pending handover; no shop payment posted.' };
}

/** BEGIN IMMEDIATE: atomic first claimant; no optimistic UI-only locks. */
export function acceptAvailableDelivery(shopId, orderId, expectedRevision, actor) {
  if (!/^[a-f0-9]{64}$/.test(String(expectedRevision || ''))) {
    fail(400, 'Refresh the available orders and retry.', 'REVISION_REQUIRED');
  }
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(String(orderId || ''))) {
    fail(404, 'Order not found.', 'ORDER_NOT_FOUND');
  }
  const db = getDb();
  const transaction = db.transaction(() => {
    driverGuard(db, shopId, actor, 'delivery.pool.accept');
    const o = db.prepare(`SELECT * FROM orders WHERE tenant_id = ? AND order_id = ?`)
      .get(shopId, orderId);
    if (!o) fail(404, 'Order not found.', 'ORDER_NOT_FOUND');
    if (Number(o.is_test) !== 1) fail(403, 'Only TEST orders can be accepted.', 'REAL_ORDER_DISABLED');
    if (o.fulfillment_behavior !== 'DELIVERY') fail(400, 'Not a delivery order.', 'NOT_DELIVERY');
    const current = db.prepare(`SELECT driver_user_id, accepted_at FROM order_delivery_claims
      WHERE shop_id = ? AND order_id = ?`).get(shopId, orderId);
    if (current) {
      if (current.driver_user_id !== actor.userId) {
        fail(409, 'Another Delivery Boy already accepted this order.', 'ALREADY_ACCEPTED');
      }
      return { orderId, status: 'ACCEPTED_BY_DELIVERY_BOY', alreadyAccepted: true,
        acceptedAt: current.accepted_at };
    }
    if (o.status !== 'OPEN') fail(409, 'Order is no longer open.', 'ORDER_NOT_OPEN');
    const state = readOrderOperationalState(db, shopId, o);
    if (!state.dispatch.ready) fail(409, 'Order is not ready for delivery.', 'NOT_READY');
    if (state.dispatch.revision !== expectedRevision) {
      fail(409, 'Order has changed. Refresh and review.', 'STALE_ORDER');
    }
    const at = nowIso();
    db.prepare(`INSERT INTO order_delivery_claims
      (shop_id, order_id, driver_user_id, accepted_at, prep_revision)
      VALUES (?, ?, ?, ?, ?)`).run(shopId, orderId, actor.userId, at, expectedRevision);
    recordAudit({ actorRole: 'delivery', actorUserId: actor.userId,
      action: 'delivery.order.accept', entityType: 'order_delivery_claim', entityId: orderId,
      detail: { shopId, orderId, driverUserId: actor.userId } });
    return { orderId, status: 'ACCEPTED_BY_DELIVERY_BOY', alreadyAccepted: false,
      acceptedAt: at, blockNumber: o.block_number || '', roadNumber: o.road_number || '' };
  });
  const result = transaction.immediate();
  // Suggestions never reserve orders. After claim, use the same authorized
  // driver-owned read endpoint as future "Find nearby" requests.
  if (!result.alreadyAccepted) {
    const suggestions = listRouteSuggestions(shopId, actor, orderId);
    result.sameBlockSuggestions = suggestions.orders;
  } else result.sameBlockSuggestions = [];
  return result;
}

/**
 * P2-E2B: Driver-owned route suggestions from the currently unclaimed pool.
 * Only literal same-road/same-block comparisons; no geospatial assumptions.
 * A claimed order is only a suggestion anchor when it belongs to this driver.
 */
export function listRouteSuggestions(shopId, actor, acceptedOrderId) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(String(acceptedOrderId || ''))) {
    fail(400, 'Invalid accepted order.', 'INVALID_ORDER');
  }
  const db = getDb();
  driverGuard(db, shopId, actor, 'delivery.pool.view');
  const anchor = db.prepare(`SELECT o.order_id, o.order_number, o.block_number, o.road_number
    FROM order_delivery_claims c
    JOIN orders o ON o.tenant_id = c.shop_id AND o.order_id = c.order_id
    WHERE c.shop_id = ? AND c.driver_user_id = ? AND c.order_id = ?
      AND o.is_test = 1 AND o.fulfillment_behavior = 'DELIVERY'`)
    .get(shopId, actor.userId, acceptedOrderId);
  if (!anchor) fail(404, 'Accepted order not found in My Orders.', 'CLAIM_NOT_OWNED');
  const block = cleanFilter(anchor.block_number || '');
  const road = cleanFilter(anchor.road_number || '');
  if (!block) return { anchorOrderNumber: anchor.order_number, blockNumber: '', orders: [] };
  // listAvailableDeliveries checks ACTIVE_ORDER, packing revision, auth,
  // and claim absence. It returns fresh expectedRevision for atomic Accept.
  const available = listAvailableDeliveries(shopId, actor, { block, priorityRoad: road }).orders;
  const orders = available.map(o => ({ ...o, sameRoad: Boolean(road && o.roadNumber === road),
    suggestion: road && o.roadNumber === road ? 'SAME_ROAD' : 'SAME_BLOCK' }));
  // Stable ties retain queue age; prior list order is created_at ASC.
  orders.sort((a, b) => Number(b.sameRoad) - Number(a.sameRoad));
  return { anchorOrderNumber: anchor.order_number, blockNumber: block, orders: orders.slice(0, 10) };
}
