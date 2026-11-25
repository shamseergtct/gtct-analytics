/** Restaurant POS delivery pool mirrored to Firestore for cellular Delivery Boys. */

export const RESTAURANT_DELIVERY_ORDERS = "restaurant_delivery_orders";

export const POOL_STATUS = {
  AVAILABLE: "AVAILABLE",
  CLAIMED: "CLAIMED",
  DELIVERED: "DELIVERED",
  CANCEL_REQUESTED: "CANCEL_REQUESTED",
  CANCELLED: "CANCELLED",
};

export const PAYMENT_STATUS = {
  UNMARKED: "UNMARKED",
  CASH_WITH_BOY: "CASH_WITH_BOY",
  SHOP_PAID_REPORTED: "SHOP_PAID_REPORTED",
  CREDIT_REPORTED: "CREDIT_REPORTED",
  PARTIAL_SHOP: "PARTIAL_SHOP",
  PAID_CONFIRMED: "PAID_CONFIRMED",
  CREDIT_APPROVED: "CREDIT_APPROVED",
  CREDIT_REJECTED: "CREDIT_REJECTED",
};

export function restaurantOrderDocId(clientId, localOrderId) {
  return `${String(clientId || "").trim()}_${String(localOrderId || "").trim()}`;
}

/** Currency decimals of a pool order (0–4). Missing → 2; a real 0 stays 0. */
export function orderCurrencyDecimals(order) {
  const raw = order?.currencyDecimals;
  const n = Number(raw);
  if (raw === null || raw === undefined || raw === "" || !Number.isFinite(n)) return 2;
  return Math.min(Math.max(Math.trunc(n), 0), 4);
}

export function formatPoolMoney(order, amountCents = order?.totalCents) {
  const decimals = orderCurrencyDecimals(order);
  const code = String(order?.currencyCode || "").trim();
  const amount = (Number(amountCents || 0) / 10 ** decimals).toFixed(decimals);
  return code ? `${amount} ${code}` : amount;
}

export function poolStatusLabel(status) {
  switch (String(status || "")) {
    case POOL_STATUS.AVAILABLE:
      return "Available";
    case POOL_STATUS.CLAIMED:
      return "Accepted";
    case POOL_STATUS.DELIVERED:
      return "Delivered";
    case POOL_STATUS.CANCEL_REQUESTED:
      return "Cancel requested";
    case POOL_STATUS.CANCELLED:
      return "Cancelled";
    default:
      return status || "—";
  }
}

export function paymentStatusLabel(status) {
  switch (String(status || "")) {
    case PAYMENT_STATUS.CASH_WITH_BOY:
      return "Cash with me";
    case PAYMENT_STATUS.SHOP_PAID_REPORTED:
      return "Paid at shop";
    case PAYMENT_STATUS.CREDIT_REPORTED:
      return "Credit reported";
    case PAYMENT_STATUS.PARTIAL_SHOP:
      return "Partial payment";
    case PAYMENT_STATUS.PAID_CONFIRMED:
      return "Paid · verified";
    case PAYMENT_STATUS.CREDIT_APPROVED:
      return "Credit approved";
    case PAYMENT_STATUS.CREDIT_REJECTED:
      return "Credit rejected";
    default:
      return "Not marked";
  }
}
