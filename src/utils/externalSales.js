import { roundMoney, numMoney } from "./money.js";

/** External bill sale types (centralized). */
export const EXTERNAL_SALE_TYPES = [
  { value: "DELIVERY", label: "Delivery" },
  { value: "DINE_IN", label: "Dine In" },
  { value: "PICK_UP", label: "Pick Up" },
];

const SALE_TYPE_SET = new Set(EXTERNAL_SALE_TYPES.map((item) => item.value));

export const DEFAULT_DELIVERY_COMMISSION = {
  enabled: false,
  rate: 0,
};

export function normalizeExternalSaleType(value) {
  const key = String(value || "")
    .trim()
    .toUpperCase()
    .replaceAll(" ", "_")
    .replaceAll("-", "_");
  if (key === "DINEIN") return "DINE_IN";
  if (key === "PICKUP" || key === "TAKEAWAY") return "PICK_UP";
  return SALE_TYPE_SET.has(key) ? key : "";
}

export function externalSaleTypeLabel(value) {
  const key = normalizeExternalSaleType(value);
  return EXTERNAL_SALE_TYPES.find((item) => item.value === key)?.label || key || "—";
}

export function isDeliverySaleType(value) {
  return normalizeExternalSaleType(value) === "DELIVERY";
}

export function normalizeBillNumber(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

/** Safe Firestore doc id fragment. */
function slugPart(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

/**
 * Deterministic unique key:
 * client + businessDate + terminal + billNumber
 * (same bill no on different terminals is allowed)
 */
export function externalSalesBillDocId({
  clientId,
  businessDate,
  terminalId,
  billNumber,
}) {
  const bill = normalizeBillNumber(billNumber);
  return [
    slugPart(clientId),
    slugPart(businessDate),
    slugPart(terminalId),
    slugPart(bill) || "bill",
  ].join("__");
}

/**
 * Per-delivery-boy commission settings.
 * Prefer top-level commissionEnabled / commissionRate on the delivery boy doc.
 * Falls back to nested deliveryCommission for older docs.
 */
export function resolveDeliveryBoyCommission(deliveryBoy) {
  if (!deliveryBoy || typeof deliveryBoy !== "object") {
    return { ...DEFAULT_DELIVERY_COMMISSION };
  }
  const nested = deliveryBoy.deliveryCommission;
  const enabled =
    deliveryBoy.commissionEnabled != null
      ? Boolean(deliveryBoy.commissionEnabled)
      : Boolean(nested?.enabled);
  const rawRate =
    deliveryBoy.commissionRate != null
      ? deliveryBoy.commissionRate
      : nested?.rate;
  const rate = Math.max(0, numMoney(rawRate));
  return {
    enabled,
    rate: Number.isFinite(rate) ? rate : 0,
  };
}

/** @deprecated Use resolveDeliveryBoyCommission — shop-level commission removed. */
export function resolveDeliveryCommissionSettings(settingsOrBoy) {
  if (settingsOrBoy?.deliveryCommission && settingsOrBoy.commissionEnabled == null) {
    const raw = settingsOrBoy.deliveryCommission;
    return {
      enabled: Boolean(raw?.enabled),
      rate: Math.max(0, numMoney(raw?.rate)) || 0,
    };
  }
  return resolveDeliveryBoyCommission(settingsOrBoy);
}

export const EXTERNAL_SALES_SOURCE = "EXTERNAL_BILL_ENTRY";
export const EXTERNAL_ENTRY_SOURCE_MANUAL = "MANUAL";

export const EXTERNAL_PAYMENT_MODES = ["CASH", "BANK", "CREDIT", "DELIVERY_ACCOUNT"];
export const DELIVERY_ACCOUNT_PAYMENT = "DELIVERY_ACCOUNT";

export function externalPaymentModeLabel(bill) {
  const mode = String(bill?.paymentMode || "").toUpperCase();
  if (mode === "DELIVERY_ACCOUNT") return "Delivery Boy Account";
  if (mode === "BANK") {
    return bill?.bankAccountNameSnapshot
      ? `Bank: ${bill.bankAccountNameSnapshot}`
      : "Bank";
  }
  if (mode === "CREDIT") return "Credit";
  if (mode === "CASH" || !mode) {
    // Legacy delivery bills without mode still show Cash; new delivery uses DELIVERY_ACCOUNT.
    if (normalizeExternalSaleType(bill?.saleType) === "DELIVERY" && !bill?.paymentMode) {
      return "Delivery Boy Account";
    }
    return "Cash";
  }
  return mode;
}

/**
 * Amount a delivery boy owes for a day's delivery bills.
 * Bill amount already includes delivery charge — do not add charge again.
 * Payable = bill amount − commission (commission still based on delivery charge on each bill).
 */
export function deliveryBoyPayableFromBills(bills = [], deliveryBoyId) {
  const boyId = String(deliveryBoyId || "").trim();
  let gross = 0;
  let commission = 0;
  let billCount = 0;
  for (const bill of bills) {
    if (!boyId || bill.voided === true) continue;
    if (normalizeExternalSaleType(bill.saleType) !== "DELIVERY") continue;
    if (bill.deliveryBoyId !== boyId) continue;
    gross += numMoney(bill.billAmount);
    commission += numMoney(bill.commissionAmount);
    billCount += 1;
  }
  const grossAmount = roundMoney(gross);
  const commissionAmount = roundMoney(commission);
  return {
    billCount,
    grossAmount,
    commissionAmount,
    payableAmount: roundMoney(Math.max(0, grossAmount - commissionAmount)),
  };
}

/**
 * Remaining amount still to collect after prior collection rows for the same boy/day.
 * excludeCollectionId: ignore that row (used while editing it).
 */
export function deliveryBoyOutstandingPayable({
  bills = [],
  collections = [],
  deliveryBoyId,
  excludeCollectionId = "",
} = {}) {
  const base = deliveryBoyPayableFromBills(bills, deliveryBoyId);
  const boyId = String(deliveryBoyId || "").trim();
  const skipId = String(excludeCollectionId || "").trim();
  let alreadyCollected = 0;
  for (const row of collections) {
    if (!boyId || row.deliveryBoyId !== boyId) continue;
    if (skipId && row.id === skipId) continue;
    alreadyCollected += numMoney(row.paidCash) + numMoney(row.paidBank);
  }
  alreadyCollected = roundMoney(alreadyCollected);
  const remainingPayable = roundMoney(
    Math.max(0, base.payableAmount - alreadyCollected)
  );
  return {
    ...base,
    alreadyCollected,
    remainingPayable,
    // Form default payable is only what is still outstanding
    payableAmount: remainingPayable,
  };
}

/**
 * Commission is calculated on delivery charge only (never bill amount).
 */
export function calculateDeliveryCommission({
  saleType,
  deliveryCharge,
  commissionEnabled,
  commissionRate,
  decimals,
}) {
  if (!isDeliverySaleType(saleType) || !commissionEnabled) {
    return {
      commissionEnabled: false,
      commissionRate: 0,
      commissionAmount: 0,
    };
  }
  const charge = Math.max(0, numMoney(deliveryCharge));
  const rate = Math.max(0, numMoney(commissionRate));
  const amount = roundMoney((charge * rate) / 100, decimals);
  return {
    commissionEnabled: true,
    commissionRate: rate,
    commissionAmount: amount,
  };
}

export function summarizeExternalBills(bills = []) {
  const summary = {
    totalBills: 0,
    totalSales: 0,
    deliveryBills: 0,
    dineInBills: 0,
    pickUpBills: 0,
    totalDeliveryCharges: 0,
    totalCommission: 0,
    byTerminal: {},
    byDeliveryBoy: {},
  };

  for (const bill of bills) {
    const amount = numMoney(bill.billAmount);
    const charge = numMoney(bill.deliveryCharge);
    const commission = numMoney(bill.commissionAmount);
    const type = normalizeExternalSaleType(bill.saleType);

    summary.totalBills += 1;
    summary.totalSales += amount;
    summary.totalDeliveryCharges += charge;
    summary.totalCommission += commission;

    if (type === "DELIVERY") summary.deliveryBills += 1;
    else if (type === "DINE_IN") summary.dineInBills += 1;
    else if (type === "PICK_UP") summary.pickUpBills += 1;

    const terminalKey = bill.terminalId || "unknown";
    if (!summary.byTerminal[terminalKey]) {
      summary.byTerminal[terminalKey] = {
        terminalId: bill.terminalId || "",
        terminalName: bill.terminalNameSnapshot || "—",
        bills: 0,
        sales: 0,
      };
    }
    summary.byTerminal[terminalKey].bills += 1;
    summary.byTerminal[terminalKey].sales += amount;

    if (type === "DELIVERY" && bill.deliveryBoyId) {
      const boyKey = bill.deliveryBoyId;
      if (!summary.byDeliveryBoy[boyKey]) {
        summary.byDeliveryBoy[boyKey] = {
          deliveryBoyId: bill.deliveryBoyId,
          deliveryBoyName: bill.deliveryBoyNameSnapshot || "—",
          bills: 0,
          sales: 0,
          deliveryCharges: 0,
          commission: 0,
        };
      }
      summary.byDeliveryBoy[boyKey].bills += 1;
      summary.byDeliveryBoy[boyKey].sales += amount;
      summary.byDeliveryBoy[boyKey].deliveryCharges += charge;
      summary.byDeliveryBoy[boyKey].commission += commission;
    }
  }

  summary.totalSales = roundMoney(summary.totalSales);
  summary.totalDeliveryCharges = roundMoney(summary.totalDeliveryCharges);
  summary.totalCommission = roundMoney(summary.totalCommission);

  return summary;
}
