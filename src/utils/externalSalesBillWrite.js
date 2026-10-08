/**
 * Single source of truth for writing external_sales_bills.
 * Used by Analytics Bill Entry and GTCT Delivery Entry sync.
 */
import {
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import { assertOperationalBankAccount } from "./bankAccountTypes.js";
import { findBankAccountName } from "./paymentModes.js";
import { numMoney, roundMoney } from "./money.js";
import {
  DELIVERY_ACCOUNT_PAYMENT,
  EXTERNAL_ENTRY_SOURCE_MANUAL,
  EXTERNAL_SALES_SOURCE,
  SPLIT_PAYMENT,
  calculateDeliveryCommission,
  externalSalesBillDocId,
  normalizeBillNumber,
  normalizeExternalSaleType,
  resolveDeliveryBoyCommission,
} from "./externalSales.js";

function cleanString(value) {
  return String(value || "").trim();
}

/**
 * Build + validate the Firestore payload for an external sales bill.
 * Throws Error with a human-readable message on validation failure.
 */
export function buildExternalSalesBillPayload({
  clientId,
  currency = "",
  currencyDecimals = 3,
  businessDate,
  terminal,
  billNumber,
  billAmount,
  saleType = "DELIVERY",
  paymentMode,
  bankAccounts = [],
  bankAccountId = "",
  bankAccountNameSnapshot = "",
  paidCash = 0,
  paidBank = 0,
  customerId = "",
  customerName = "",
  customerLocation = "",
  deliveryBoy = null,
  deliveryCharge = 0,
  notes = "",
  entrySource = EXTERNAL_ENTRY_SOURCE_MANUAL,
  entryLocalId = "",
  userUid,
  createdAtMs,
  createdBy,
  preserveCreated = null,
}) {
  const date = cleanString(businessDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Business date is required.");
  }
  if (!cleanString(clientId)) throw new Error("Shop is required.");
  if (!terminal?.id) throw new Error("Terminal is required.");
  if (!userUid) throw new Error("You must be signed in.");

  const billNo = normalizeBillNumber(billNumber);
  if (!billNo) throw new Error("Bill number is required.");
  if (!/^[\w./#-]+(?:\s[\w./#-]+)*$/i.test(billNo) || billNo.length > 40) {
    throw new Error("Bill number format is invalid.");
  }

  if (billAmount === "" || billAmount === null || billAmount === undefined) {
    throw new Error("Bill amount is required.");
  }
  const amountNum = numMoney(billAmount);
  if (!Number.isFinite(Number(billAmount)) || !Number.isFinite(amountNum)) {
    throw new Error("Bill amount must be a valid number.");
  }

  const type = normalizeExternalSaleType(saleType);
  if (!type) throw new Error("Sale type is required.");

  let savedPaymentMode = cleanString(paymentMode).toUpperCase();
  let resolvedBankId = cleanString(bankAccountId);
  let resolvedBankName = cleanString(bankAccountNameSnapshot);
  let resolvedCustomerId = cleanString(customerId);
  let resolvedCustomerName = cleanString(customerName);
  let cashPart = numMoney(paidCash);
  let bankPart = numMoney(paidBank);

  if (savedPaymentMode === SPLIT_PAYMENT || savedPaymentMode === "SPLIT") {
    savedPaymentMode = SPLIT_PAYMENT;
    if (amountNum <= 0) {
      throw new Error(
        "Multiple payment is only available for positive bill amounts."
      );
    }
    cashPart = roundMoney(cashPart, currencyDecimals);
    bankPart = roundMoney(bankPart, currencyDecimals);
    if (cashPart <= 0 || bankPart <= 0) {
      throw new Error(
        "Enter both cash and bank amounts greater than zero for multiple payment."
      );
    }
    if (
      roundMoney(cashPart + bankPart, currencyDecimals) !==
      roundMoney(amountNum, currencyDecimals)
    ) {
      throw new Error("Cash + bank must equal bill amount.");
    }
    if (!resolvedBankId) {
      throw new Error("Select a bank account for the bank portion.");
    }
    const bankCheck = assertOperationalBankAccount(bankAccounts, resolvedBankId);
    if (!bankCheck.ok) throw new Error(bankCheck.message);
    resolvedBankName =
      resolvedBankName || findBankAccountName(bankAccounts, resolvedBankId);
    if (!resolvedBankName) {
      throw new Error("Selected bank account is not available.");
    }
    resolvedCustomerId = "";
  } else if (
    type === "DELIVERY" &&
    savedPaymentMode === DELIVERY_ACCOUNT_PAYMENT
  ) {
    resolvedBankId = "";
    resolvedBankName = "";
  } else if (savedPaymentMode === "BANK") {
    if (!resolvedBankId) throw new Error("Select a saved bank account.");
    const bankCheck = assertOperationalBankAccount(bankAccounts, resolvedBankId);
    if (!bankCheck.ok) throw new Error(bankCheck.message);
    resolvedBankName =
      resolvedBankName || findBankAccountName(bankAccounts, resolvedBankId);
    if (!resolvedBankName) {
      throw new Error("Selected bank account is not available.");
    }
  } else if (savedPaymentMode === "CREDIT") {
    if (!resolvedCustomerId || !resolvedCustomerName) {
      throw new Error("Credit requires a customer.");
    }
    resolvedBankId = "";
    resolvedBankName = "";
  } else if (savedPaymentMode === "CASH") {
    resolvedBankId = "";
    resolvedBankName = "";
  } else {
    throw new Error(
      "Payment mode must be the delivery boy, Cash, a bank account, or Credit."
    );
  }

  let boy = null;
  let chargeNum = 0;
  if (type === "DELIVERY") {
    boy = deliveryBoy;
    if (!boy?.id) {
      throw new Error("Delivery boy is required for Delivery sales.");
    }
    if (
      deliveryCharge === "" ||
      deliveryCharge === null ||
      deliveryCharge === undefined
    ) {
      chargeNum = 0;
    } else {
      chargeNum = numMoney(deliveryCharge);
      if (!Number.isFinite(Number(deliveryCharge)) || chargeNum < 0) {
        throw new Error("Delivery charge must be a non-negative number.");
      }
    }
  }

  const boyCommission = resolveDeliveryBoyCommission(boy);
  const commissionSnap = calculateDeliveryCommission({
    saleType: type,
    deliveryCharge: chargeNum,
    commissionEnabled: boyCommission.enabled,
    commissionRate: boyCommission.rate,
    decimals: currencyDecimals,
  });

  const nowMs = Date.now();
  const created = preserveCreated || {
    createdAt: serverTimestamp(),
    createdAtMs: createdAtMs || nowMs,
    createdBy: createdBy || userUid,
  };

  const payload = {
    clientId: cleanString(clientId),
    businessDate: date,
    terminalId: cleanString(terminal.id),
    terminalNameSnapshot: cleanString(terminal.name),
    billNumber: billNo,
    billAmount: roundMoney(amountNum, currencyDecimals),
    saleType: type,
    paymentMode: savedPaymentMode,
    bankAccountId: resolvedBankId,
    bankAccountNameSnapshot: resolvedBankName,
    ...(savedPaymentMode === SPLIT_PAYMENT
      ? { paidCash: cashPart, paidBank: bankPart }
      : {}),
    customerId: resolvedCustomerId,
    customerName: resolvedCustomerName,
    customerLocation: cleanString(customerLocation),
    deliveryBoyId: type === "DELIVERY" ? cleanString(boy.id) : "",
    deliveryBoyNameSnapshot: type === "DELIVERY" ? cleanString(boy.name) : "",
    deliveryCharge:
      type === "DELIVERY" ? roundMoney(chargeNum, currencyDecimals) : 0,
    commissionEnabled: commissionSnap.commissionEnabled,
    commissionRate: commissionSnap.commissionRate,
    commissionAmount: commissionSnap.commissionAmount,
    notes: cleanString(notes),
    salesSource: EXTERNAL_SALES_SOURCE,
    entrySource: cleanString(entrySource) || EXTERNAL_ENTRY_SOURCE_MANUAL,
    entryLocalId: cleanString(entryLocalId),
    voided: false,
    currency: cleanString(currency),
    ...created,
    updatedAt: serverTimestamp(),
    updatedAtMs: nowMs,
    updatedBy: userUid,
  };

  const docId = externalSalesBillDocId({
    clientId: payload.clientId,
    businessDate: payload.businessDate,
    terminalId: payload.terminalId,
    billNumber: payload.billNumber,
  });

  return { docId, payload, billNo, terminalName: payload.terminalNameSnapshot };
}

/**
 * Write an external sales bill with deterministic doc id + entryLocalId idempotency.
 *
 * @returns {{
 *   docId: string,
 *   status: 'created' | 'updated' | 'idempotent',
 *   billNumber: string,
 *   terminalName: string,
 * }}
 */
export async function writeExternalSalesBill(options = {}) {
  const { editMode = false, existingMeta = null, userUid } = options;
  const built = buildExternalSalesBillPayload(options);
  const { docId, payload, billNo, terminalName } = built;

  const result = await runTransaction(db, async (tx) => {
    const ref = doc(db, "external_sales_bills", docId);
    const existing = await tx.get(ref);
    const existsActive =
      existing.exists() && existing.data()?.voided !== true;
    const existingData = existing.exists() ? existing.data() || {} : null;
    const incomingLocalId = cleanString(payload.entryLocalId);

    if (existsActive && !editMode) {
      const existingLocalId = cleanString(existingData?.entryLocalId);
      // Idempotent retry: same local bill already on server.
      if (
        incomingLocalId &&
        existingLocalId &&
        incomingLocalId === existingLocalId
      ) {
        return { status: "idempotent" };
      }
      throw new Error(
        `Bill ${billNo} already exists for ${terminalName || "this terminal"}.`
      );
    }

    if (editMode && !existsActive) {
      throw new Error(
        `Bill ${billNo} is no longer available to edit. Clear and enter again.`
      );
    }

    const nowMs = Date.now();
    const wasVoided = existing.exists() && existingData?.voided === true;
    const preserveCreated =
      editMode || wasVoided
        ? {
            createdAt:
              existingData?.createdAt ||
              existingMeta?.createdAt ||
              serverTimestamp(),
            createdAtMs:
              existingData?.createdAtMs ||
              existingMeta?.createdAtMs ||
              nowMs,
            createdBy:
              existingData?.createdBy ||
              existingMeta?.createdBy ||
              userUid,
          }
        : {
            createdAt: serverTimestamp(),
            createdAtMs: payload.createdAtMs || nowMs,
            createdBy: userUid,
          };

    tx.set(ref, {
      ...payload,
      ...preserveCreated,
      updatedAt: serverTimestamp(),
      updatedAtMs: nowMs,
      updatedBy: userUid,
    });

    return { status: editMode || wasVoided ? "updated" : "created" };
  });

  return {
    docId,
    status: result.status,
    billNumber: billNo,
    terminalName,
  };
}

/**
 * Resolve an already-synced bill by deterministic id (for offline sync retries).
 */
export async function findExternalSalesBillByDocId(docId) {
  const snap = await getDoc(doc(db, "external_sales_bills", docId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}
