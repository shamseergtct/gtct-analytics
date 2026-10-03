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

/** Screen order for billing terminal cards (Setup ↑↓). */
export function compareBillingTerminals(a, b) {
  const orderA = Number(a?.sortOrder);
  const orderB = Number(b?.sortOrder);
  const hasA = Number.isFinite(orderA);
  const hasB = Number.isFinite(orderB);
  if (hasA && hasB && orderA !== orderB) return orderA - orderB;
  if (hasA && !hasB) return -1;
  if (!hasA && hasB) return 1;
  return String(a?.name || "").localeCompare(String(b?.name || ""));
}

export function sortBillingTerminals(terminals = []) {
  return [...terminals].sort(compareBillingTerminals);
}

/**
 * Parse a bill number as a whole-number sequence (digits only).
 * Used for start/end range checks and missing-bill detection.
 */
export function parseBillSequence(value) {
  const normalized = normalizeBillNumber(value);
  if (!/^\d+$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isSafeInteger(n) ? n : null;
}

const MAX_BILL_RANGE_SPAN = 5000;

/**
 * Find missing whole-number bill sequences between start and end
 * for the given entered bills (voided bills do not count as present).
 */
export function findMissingBillNumbers({
  startBillNumber,
  endBillNumber,
  bills = [],
}) {
  const start = parseBillSequence(startBillNumber);
  const end = parseBillSequence(endBillNumber);
  if (start == null || end == null) {
    throw new Error("Start and last bill numbers must be whole numbers (digits only).");
  }
  if (end < start) {
    throw new Error("Last bill number must be greater than or equal to the starting bill number.");
  }
  if (end - start + 1 > MAX_BILL_RANGE_SPAN) {
    throw new Error(
      `Bill range is too large (max ${MAX_BILL_RANGE_SPAN} bills). Narrow the start/last numbers.`
    );
  }

  const present = new Set();
  for (const bill of bills) {
    if (bill?.voided === true) continue;
    const seq = parseBillSequence(bill?.billNumber);
    if (seq != null && seq >= start && seq <= end) {
      present.add(seq);
    }
  }

  const missing = [];
  for (let seq = start; seq <= end; seq += 1) {
    if (!present.has(seq)) missing.push(String(seq));
  }

  return {
    start,
    end,
    expectedCount: end - start + 1,
    enteredCount: present.size,
    missingCount: missing.length,
    missing,
  };
}

/** Deterministic doc id for per-terminal daily bill range. */
export function externalTerminalBillRangeDocId({
  clientId,
  businessDate,
  terminalId,
}) {
  return [
    slugPart(clientId),
    slugPart(businessDate),
    slugPart(terminalId),
  ].join("__");
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

/** Delivery bills owed by the boy (vs paid directly to the shop). */
export function isDeliveryBoyAccountPayment(billOrMode) {
  if (billOrMode && typeof billOrMode === "object") {
    if (normalizeExternalSaleType(billOrMode.saleType) !== "DELIVERY") {
      return false;
    }
    const mode = String(billOrMode.paymentMode || "")
      .trim()
      .toUpperCase();
    // Legacy delivery bills with no mode were on the boy's account.
    return !mode || mode === DELIVERY_ACCOUNT_PAYMENT;
  }
  const mode = String(billOrMode || "")
    .trim()
    .toUpperCase();
  return !mode || mode === DELIVERY_ACCOUNT_PAYMENT;
}

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
    if (isDeliveryBoyAccountPayment(bill)) return "Delivery Boy Account";
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
    // Paid directly to shop (cash/bank/credit) does not add to boy payable.
    if (!isDeliveryBoyAccountPayment(bill)) continue;
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

/**
 * Cash / bank / credit / delivery-boy-account totals for non-voided bills.
 * Shop tenders (cash/bank/credit) are paid at the counter; delivery account
 * is owed by the boy until Collect.
 */
export function summarizeExternalBillTenders(bills = []) {
  const summary = {
    billCount: 0,
    cashTotal: 0,
    bankTotal: 0,
    creditTotal: 0,
    deliveryAccountTotal: 0,
    shopGrossTotal: 0,
    grossTotal: 0,
    bankByAccount: {},
  };

  for (const bill of bills) {
    if (bill?.voided === true) continue;
    const amount = numMoney(bill.billAmount);
    if (amount <= 0) continue;

    summary.billCount += 1;
    summary.grossTotal += amount;

    if (isDeliveryBoyAccountPayment(bill)) {
      summary.deliveryAccountTotal += amount;
      continue;
    }

    const mode = String(bill.paymentMode || "")
      .trim()
      .toUpperCase();

    if (mode === "BANK") {
      summary.bankTotal += amount;
      summary.shopGrossTotal += amount;
      const accountId = String(bill.bankAccountId || "").trim() || "_unassigned";
      if (!summary.bankByAccount[accountId]) {
        summary.bankByAccount[accountId] = {
          bankAccountId: accountId === "_unassigned" ? "" : accountId,
          bankAccountName: bill.bankAccountNameSnapshot || "Bank",
          amount: 0,
        };
      }
      summary.bankByAccount[accountId].amount += amount;
    } else if (mode === "CREDIT") {
      summary.creditTotal += amount;
      summary.shopGrossTotal += amount;
    } else {
      // CASH (or blank on non-delivery)
      summary.cashTotal += amount;
      summary.shopGrossTotal += amount;
    }
  }

  summary.cashTotal = roundMoney(summary.cashTotal);
  summary.bankTotal = roundMoney(summary.bankTotal);
  summary.creditTotal = roundMoney(summary.creditTotal);
  summary.deliveryAccountTotal = roundMoney(summary.deliveryAccountTotal);
  summary.shopGrossTotal = roundMoney(summary.shopGrossTotal);
  summary.grossTotal = roundMoney(summary.grossTotal);
  summary.bankByAccount = Object.values(summary.bankByAccount).map((row) => ({
    ...row,
    amount: roundMoney(row.amount),
  }));

  return summary;
}

/** Cash/bank received from delivery-boy Collect settlements. */
export function summarizeDeliveryBoyCollections(collections = []) {
  let cashTotal = 0;
  let bankTotal = 0;
  let settledTotal = 0;
  const bankByAccount = {};

  for (const row of collections) {
    const cash = Math.max(0, numMoney(row.paidCash));
    const bank = Math.max(0, numMoney(row.paidBank));
    cashTotal += cash;
    bankTotal += bank;
    settledTotal += cash + bank;
    if (bank > 0) {
      const accountId = String(row.bankAccountId || "").trim() || "_unassigned";
      if (!bankByAccount[accountId]) {
        bankByAccount[accountId] = {
          bankAccountId: accountId === "_unassigned" ? "" : accountId,
          bankAccountName: row.bankAccountNameSnapshot || "Bank",
          amount: 0,
        };
      }
      bankByAccount[accountId].amount += bank;
    }
  }

  return {
    cashTotal: roundMoney(cashTotal),
    bankTotal: roundMoney(bankTotal),
    settledTotal: roundMoney(settledTotal),
    bankByAccount: Object.values(bankByAccount).map((row) => ({
      ...row,
      amount: roundMoney(row.amount),
    })),
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
    if (bill?.voided === true) continue;
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
