/** Read-only, single-source order status derived from Kitchen + Dispatch.
 * orders.status='OPEN' is a record/edit lifecycle field, not prep status.
 * Delivery Boy acceptance is sourced only from the atomic claims table.
 * Settlement phases are NOT inferred from dispatch readiness or acceptance.
 */
import { createHash } from 'node:crypto';
import { getOrderPrepProgress } from './prepBoard.js';
import { readDeliveryPaymentReport } from './deliveryPaymentReports.js';
import { readDeliveryLifecycle } from './deliveryLifecycle.js';
import { readSplitReview } from './deliverySplitReview.js';

/**
 * Stage-1 temporary: prep station screens are not in daily use yet.
 * When false, Monitor may confirm packing / ready-for-delivery without
 * every preparation station marking FINISHED. Set back to true when
 * kitchen prep boards go live.
 */
export const REQUIRE_PREP_FINISHED_FOR_DISPATCH = false;

function revisionFor(order, prep) {
  return createHash('sha256').update(JSON.stringify([
    order.order_id, order.updated_at, prep.unassignedLineCount,
    prep.stations.map(s => [s.stationId, s.status, s.revision]),
  ])).digest('hex');
}

export function readOrderOperationalState(db, shopId, order) {
  const prep = getOrderPrepProgress(shopId, order.order_id);
  const revision = revisionFor(order, prep);
  const confirmed = db.prepare(`SELECT status, prep_revision, confirmed_by_user_id, confirmed_at
    FROM order_dispatch_readiness WHERE shop_id = ? AND order_id = ?`
  ).get(shopId, order.order_id);
  const deliveryClaim = db.prepare(`SELECT c.driver_user_id, c.accepted_at, u.full_name
    FROM order_delivery_claims c JOIN staff_users u
      ON u.user_id = c.driver_user_id AND u.shop_id = c.shop_id
    WHERE c.shop_id = ? AND c.order_id = ?`).get(shopId, order.order_id);
  const isDelivery = order.fulfillment_behavior === 'DELIVERY';
  // Shop credit may pre-date Delivery Boy self-accept. Expose it for monitor without a claim.
  const shopCreditAuthorization = isDelivery
    ? db.prepare(`SELECT c.state,c.version,c.updated_at,u.full_name AS approved_by
      FROM delivery_shop_credit_authorizations c
      LEFT JOIN staff_users u ON u.shop_id=c.shop_id AND u.user_id=c.updated_by_user_id
      WHERE c.shop_id=? AND c.order_id=?`).get(shopId,order.order_id) || null
    : null;
  const deliveryPaymentReport = isDelivery && deliveryClaim
    ? readDeliveryPaymentReport(db, shopId, order.order_id, deliveryClaim.driver_user_id, order.total_cents)
    : null;
  // Rider multiple payment: state of the cash / shop-paid / credit parts.
  // Rider payment review: every shop-paid / credit part (single mode or multiple payment).
  const deliverySplitReview = isDelivery && deliveryPaymentReport
    ? readSplitReview(db, shopId, order.order_id) : null;
  const deliveryLifecycle = isDelivery && deliveryClaim
    ? readDeliveryLifecycle(db, shopId, order.order_id) : null;
  const isOpenTest = order.status === 'OPEN' && Number(order.is_test) === 1;
  const kitchenOkForDispatch =
    !REQUIRE_PREP_FINISHED_FOR_DISPATCH || prep.allFinished;
  const ready = Boolean(
    confirmed &&
      confirmed.prep_revision === revision &&
      kitchenOkForDispatch &&
      isOpenTest
  );
  const dispatchStatus = !isDelivery ? 'NOT_APPLICABLE'
    : ready ? 'READY_FOR_DELIVERY'
    : confirmed ? 'PACKING_RECHECK_REQUIRED'
    : kitchenOkForDispatch ? 'AWAITING_PACKING_CONFIRMATION'
    : 'WAITING_FOR_KITCHEN';
  const status = order.status !== 'OPEN' ? order.status
    : isDelivery && deliveryClaim && deliveryLifecycle?.status !== 'PENDING'
      ? `DELIVERY_${deliveryLifecycle.status}`
    : isDelivery && deliveryClaim && !ready ? 'PACKING_RECHECK_REQUIRED'
    : isDelivery && deliveryClaim ? 'ACCEPTED_BY_DELIVERY_BOY'
    : isDelivery && ready ? 'READY_FOR_DELIVERY'
    : isDelivery && confirmed ? 'PACKING_RECHECK_REQUIRED'
    : isDelivery && kitchenOkForDispatch ? 'AWAITING_PACKING_CONFIRMATION'
    : prep.stage;
  return {
    operationalStatus: status,
    kitchenStatus: prep.stage,
    dispatchStatus,
    // Driver identity is read from durable TEST delivery claims, never guessed.
    deliveryBoyName: deliveryClaim?.full_name || null,
    deliveryAcceptedAt: deliveryClaim?.accepted_at || null,
    deliveryPaymentReport,
    deliverySplitReview,
    deliveryLifecycle,
    shopCreditAuthorization,
    preparation: prep,
    dispatch: {
      status: dispatchStatus,
      ready,
      canMarkReady: isDelivery && kitchenOkForDispatch && !ready && isOpenTest,
      // Shop may reverse packing confirmation until a rider claims the order.
      canUnmarkReady: isDelivery && ready && !deliveryClaim && isOpenTest,
      confirmedAt: ready ? confirmed.confirmed_at : null,
      revision,
      requirePrepFinished: REQUIRE_PREP_FINISHED_FOR_DISPATCH,
    },
  };
}

/** Throws 409 ORDER_NOT_EDITABLE when record/dispatch state blocks edit. */
export function assertOrderEditable(db, shopId, order) {
  if (order.status !== "OPEN") {
    throw Object.assign(new Error("Only open orders can be edited."), {
      status: 409,
      code: "ORDER_NOT_EDITABLE",
    });
  }
  const ops = readOrderOperationalState(db, shopId, order);
  const life = String(ops.deliveryLifecycle?.status || "");
  if (life === "DELIVERED" || ops.operationalStatus === "DELIVERY_DELIVERED") {
    throw Object.assign(new Error("Delivered orders cannot be edited."), {
      status: 409,
      code: "ORDER_NOT_EDITABLE",
    });
  }
  if (life === "CANCELLED" || ops.operationalStatus === "DELIVERY_CANCELLED") {
    throw Object.assign(new Error("Cancelled orders cannot be edited."), {
      status: 409,
      code: "ORDER_NOT_EDITABLE",
    });
  }
  if (life === "CANCEL_REQUESTED" || ops.operationalStatus === "DELIVERY_CANCEL_REQUESTED") {
    throw Object.assign(new Error("Orders with a cancellation request cannot be edited."), {
      status: 409,
      code: "ORDER_NOT_EDITABLE",
    });
  }
  if (ops.deliveryBoyName || ops.deliveryAcceptedAt) {
    throw Object.assign(new Error("Out for delivery — cannot be edited."), {
      status: 409,
      code: "ORDER_NOT_EDITABLE",
    });
  }
}
