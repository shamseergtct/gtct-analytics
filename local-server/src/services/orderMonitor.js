/**
 * P2-E1: Central order monitor. TEST order-only dispatch readiness.
 * Kitchen state is DERIVED from existing station ticket logic; payment is
 * read-only from the existing settlement model. Nothing posts to ledgers.
 * Delivery assignment, driver collection, credit and commission are future phases.
 */
import { getDb } from '../db/db.js';
import { nowIso } from '../util/time.js';
import { recordAudit } from './audit.js';
import {
  REQUIRE_PREP_FINISHED_FOR_DISPATCH,
  readOrderOperationalState,
} from './orderOperationalState.js';
import { getOrderRegisterDetail, listOrderRegister } from './orderRegister.js';

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}

function orderRow(db, shopId, orderId) {
  const row = db.prepare(`SELECT order_id, tenant_id, status, is_test, fulfillment_behavior,
      updated_at, order_number FROM orders WHERE tenant_id = ? AND order_id = ?`
  ).get(shopId, String(orderId || '').trim());
  if (!row) fail(404, 'Order not found.', 'ORDER_NOT_FOUND');
  return row;
}


export function listOrderMonitor(shopId, query) {
  const register = listOrderRegister(shopId, query);
  const db = getDb();
  return {
    ...register,
    orders: register.orders.map((item) => {
      const row = orderRow(db, shopId, item.orderId);
      return { ...item, ...readOrderOperationalState(db, shopId, row) };
    }),
  };
}

export function getOrderMonitorDetail(shopId, orderId) {
  const db = getDb();
  const row = orderRow(db, shopId, orderId);
  return { ...getOrderRegisterDetail(shopId, orderId), ...readOrderOperationalState(db, shopId, row) };
}

/** Requires server-authorized Admin/Cashier staff; caller checks permissions.
 * BEGIN IMMEDIATE + revision validation protects against stale Kitchen edits
 * and competing packing confirmations. Repeated identical requests are safe.
 */
export function markOrderReadyForDelivery(shopId, orderId, expectedRevision, actor) {
  if (!/^[a-f0-9]{64}$/.test(String(expectedRevision || ''))) {
    fail(400, 'Refresh the order monitor before confirming packing.', 'MONITOR_REVISION_REQUIRED');
  }
  if (!actor?.userId || !['admin', 'cashier'].includes(actor.role)) {
    fail(403, 'Cashier or Admin privileges required.', 'DISPATCH_FORBIDDEN');
  }
  const db = getDb();
  const transaction = db.transaction(() => {
    const order = orderRow(db, shopId, orderId);
    if (Number(order.is_test) !== 1) fail(403, 'Only TEST orders are supported.', 'REAL_ORDER_DISABLED');
    if (order.status !== 'OPEN') fail(409, 'Order is no longer open.', 'ORDER_NOT_OPEN');
    if (order.fulfillment_behavior !== 'DELIVERY') {
      fail(400, 'Ready for delivery applies only to delivery orders.', 'NOT_DELIVERY');
    }
    const monitor = readOrderOperationalState(db, shopId, order);
    if (monitor.dispatch.revision !== expectedRevision) {
      fail(409, 'Order or kitchen status changed. Refresh and review again.', 'MONITOR_STALE');
    }
    if (REQUIRE_PREP_FINISHED_FOR_DISPATCH && !monitor.preparation.allFinished) {
      fail(409, 'All preparation stations must finish before packing confirmation.', 'KITCHEN_NOT_FINISHED');
    }
    if (monitor.dispatch.ready) {
      return { orderId, status: 'READY_FOR_DELIVERY', alreadyReady: true };
    }
    const ts = nowIso();
    db.prepare(`INSERT INTO order_dispatch_readiness
        (shop_id, order_id, status, prep_revision, confirmed_by_user_id, confirmed_at)
      VALUES (?, ?, 'READY_FOR_DELIVERY', ?, ?, ?)
      ON CONFLICT (shop_id, order_id) DO UPDATE SET
        status = excluded.status,
        prep_revision = excluded.prep_revision,
        confirmed_by_user_id = excluded.confirmed_by_user_id,
        confirmed_at = excluded.confirmed_at`
    ).run(shopId, order.order_id, monitor.dispatch.revision, actor.userId, ts);
    recordAudit({
      actorRole: actor.role,
      actorUserId: actor.userId,
      action: 'order.dispatch.ready',
      entityType: 'order_dispatch_readiness',
      entityId: order.order_id,
      detail: { shopId, orderId: order.order_id, from: monitor.dispatch.status, to: 'READY_FOR_DELIVERY' },
    });
    return { orderId: order.order_id, status: 'READY_FOR_DELIVERY', alreadyReady: false };
  });
  return transaction.immediate();
}

/** Revert packing confirmation so the order returns to Pending on Monitor.
 * Blocked after a Delivery Boy claims the order.
 */
export function unmarkOrderReadyForDelivery(shopId, orderId, expectedRevision, actor) {
  if (!/^[a-f0-9]{64}$/.test(String(expectedRevision || ''))) {
    fail(400, 'Refresh the order monitor before changing status.', 'MONITOR_REVISION_REQUIRED');
  }
  if (!actor?.userId || !['admin', 'cashier'].includes(actor.role)) {
    fail(403, 'Cashier or Admin privileges required.', 'DISPATCH_FORBIDDEN');
  }
  const db = getDb();
  const transaction = db.transaction(() => {
    const order = orderRow(db, shopId, orderId);
    if (Number(order.is_test) !== 1) fail(403, 'Only TEST orders are supported.', 'REAL_ORDER_DISABLED');
    if (order.status !== 'OPEN') fail(409, 'Order is no longer open.', 'ORDER_NOT_OPEN');
    if (order.fulfillment_behavior !== 'DELIVERY') {
      fail(400, 'Ready status applies only to delivery orders.', 'NOT_DELIVERY');
    }
    const monitor = readOrderOperationalState(db, shopId, order);
    if (monitor.dispatch.revision !== expectedRevision) {
      fail(409, 'Order or kitchen status changed. Refresh and review again.', 'MONITOR_STALE');
    }
    if (monitor.deliveryBoyName) {
      fail(409, 'A delivery rider already accepted this order.', 'ALREADY_CLAIMED');
    }
    if (!monitor.dispatch.ready) {
      return { orderId: order.order_id, status: monitor.dispatch.status, alreadyUnmarked: true };
    }
    db.prepare(`DELETE FROM order_dispatch_readiness WHERE shop_id = ? AND order_id = ?`)
      .run(shopId, order.order_id);
    recordAudit({
      actorRole: actor.role,
      actorUserId: actor.userId,
      action: 'order.dispatch.unready',
      entityType: 'order_dispatch_readiness',
      entityId: order.order_id,
      detail: { shopId, orderId: order.order_id, from: 'READY_FOR_DELIVERY', to: 'AWAITING_PACKING_CONFIRMATION' },
    });
    return { orderId: order.order_id, status: 'AWAITING_PACKING_CONFIRMATION', alreadyUnmarked: false };
  });
  return transaction.immediate();
}
