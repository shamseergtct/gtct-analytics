/**
 * Delivery Entry → pending submissions → admin approval → normal external_sales_bills.
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { numMoney, roundMoney } from "./money.js";
import {
  DELIVERY_ACCOUNT_PAYMENT,
  EXTERNAL_ENTRY_SOURCE_MANUAL,
  externalSalesBillDocId,
  normalizeBillNumber,
  resolveDeliveryBoyCommission,
  calculateDeliveryCommission,
} from "./externalSales.js";
import { writeExternalSalesBill } from "./externalSalesBillWrite.js";
import { assertOperationalBankAccount } from "./bankAccountTypes.js";
import { findBankAccountName } from "./paymentModes.js";

export const DELIVERY_BILL_SUBMISSIONS = "delivery_bill_submissions";

export const SUBMISSION_STATUS = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
};

function clean(value) {
  return String(value || "").trim();
}

export function deliveryBillSubmissionDocId(entryLocalId) {
  return clean(entryLocalId);
}

/**
 * Upsert a pending submission from Delivery Entry sync (idempotent on entryLocalId).
 */
export async function upsertDeliveryBillSubmission({
  userUid,
  record,
  deliveryBoy = null,
  bankAccounts = [],
  currency = "",
  currencyDecimals = 3,
} = {}) {
  if (!userUid) throw new Error("You must be signed in.");
  const entryLocalId = clean(record?.entryLocalId);
  if (!entryLocalId) throw new Error("entryLocalId is required.");

  const clientId = clean(record.clientId);
  const businessDate = clean(record.businessDate).slice(0, 10);
  const terminalId = clean(record.terminalId);
  const terminalNameSnapshot = clean(record.terminalNameSnapshot);
  const billNo = normalizeBillNumber(record.billNumber);
  if (!clientId || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new Error("Shop and business date are required.");
  }
  if (!terminalId) throw new Error("Terminal is required.");
  if (!billNo) throw new Error("Bill number is required.");

  const amountNum = numMoney(record.billAmount);
  if (!Number.isFinite(amountNum)) {
    throw new Error("Bill amount must be a valid number.");
  }

  let paymentMode = clean(record.paymentMode).toUpperCase() || DELIVERY_ACCOUNT_PAYMENT;
  let bankAccountId = clean(record.bankAccountId);
  let bankAccountNameSnapshot = clean(record.bankAccountNameSnapshot);

  if (paymentMode === "BANK") {
    if (!bankAccountId) throw new Error("Select a bank account.");
    const bankCheck = assertOperationalBankAccount(bankAccounts, bankAccountId);
    if (!bankCheck.ok) throw new Error(bankCheck.message);
    bankAccountNameSnapshot =
      bankAccountNameSnapshot ||
      findBankAccountName(bankAccounts, bankAccountId);
  } else if (paymentMode === "CASH" || paymentMode === DELIVERY_ACCOUNT_PAYMENT) {
    bankAccountId = "";
    bankAccountNameSnapshot = "";
  } else {
    throw new Error("Invalid payment type.");
  }

  const chargeNum = Math.max(0, numMoney(record.deliveryCharge));
  const boy = deliveryBoy || {
    id: record.deliveryBoyId,
    name: record.deliveryBoyNameSnapshot,
    commissionEnabled: record.commissionEnabled,
    commissionRate: record.commissionRate,
  };
  if (!clean(boy?.id)) throw new Error("Delivery boy is required.");

  const boyCommission = resolveDeliveryBoyCommission(boy);
  const commissionSnap = calculateDeliveryCommission({
    saleType: "DELIVERY",
    deliveryCharge: chargeNum,
    commissionEnabled: boyCommission.enabled,
    commissionRate: boyCommission.rate,
    decimals: currencyDecimals,
  });

  const submissionId = deliveryBillSubmissionDocId(entryLocalId);
  const ref = doc(db, DELIVERY_BILL_SUBMISSIONS, submissionId);

  // Best-effort duplicate pending check before create.
  const dupSnap = await getDocs(
    query(
      collection(db, DELIVERY_BILL_SUBMISSIONS),
      where("clientId", "==", clientId),
      where("businessDate", "==", businessDate),
      where("terminalId", "==", terminalId),
      where("billNumber", "==", billNo),
      where("status", "==", SUBMISSION_STATUS.PENDING)
    )
  );
  const otherPending = dupSnap.docs.find((item) => item.id !== submissionId);
  if (otherPending) {
    throw new Error(
      `Bill ${billNo} is already waiting for approval for ${terminalNameSnapshot || "this terminal"}.`
    );
  }

  await runTransaction(db, async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists()) {
      const data = existing.data() || {};
      // Idempotent: already submitted / approved / rejected with same local id.
      if (clean(data.entryLocalId) === entryLocalId) {
        return;
      }
      throw new Error("A conflicting submission already exists.");
    }

    const nowMs = Date.now();
    tx.set(ref, {
      clientId,
      businessDate,
      terminalId,
      terminalNameSnapshot,
      billNumber: billNo,
      billAmount: roundMoney(amountNum, currencyDecimals),
      saleType: "DELIVERY",
      paymentMode,
      bankAccountId,
      bankAccountNameSnapshot,
      customerName: clean(record.customerName),
      deliveryCharge: roundMoney(chargeNum, currencyDecimals),
      deliveryBoyId: clean(boy.id),
      deliveryBoyNameSnapshot: clean(boy.name || record.deliveryBoyNameSnapshot),
      commissionEnabled: commissionSnap.commissionEnabled,
      commissionRate: commissionSnap.commissionRate,
      commissionAmount: commissionSnap.commissionAmount,
      currency: clean(currency || record.currency),
      currencyDecimals:
        currencyDecimals ?? record.currencyDecimals ?? 3,
      notes: clean(record.notes),
      entryLocalId,
      status: SUBMISSION_STATUS.PENDING,
      createdAt: serverTimestamp(),
      createdAtMs: Number(record.createdAtMs) || nowMs,
      createdBy: userUid,
      updatedAt: serverTimestamp(),
      updatedAtMs: nowMs,
      updatedBy: userUid,
    });
  });

  return { submissionId, status: SUBMISSION_STATUS.PENDING };
}

export async function findDeliveryBillSubmissionByLocalId(entryLocalId) {
  const id = deliveryBillSubmissionDocId(entryLocalId);
  if (!id) return null;
  const snap = await getDoc(doc(db, DELIVERY_BILL_SUBMISSIONS, id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * Approve a pending submission → create normal external_sales_bills via shared writer.
 */
export async function approveDeliveryBillSubmission({
  submissionId,
  userUid,
  bankAccounts = [],
  deliveryBoys = [],
  currency = "",
  currencyDecimals = 3,
} = {}) {
  if (!userUid) throw new Error("You must be signed in.");
  const id = clean(submissionId);
  if (!id) throw new Error("Submission id is required.");

  const ref = doc(db, DELIVERY_BILL_SUBMISSIONS, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Submission not found.");
  const submission = snap.data() || {};
  if (submission.status !== SUBMISSION_STATUS.PENDING) {
    throw new Error("This submission is no longer pending.");
  }

  const boy =
    deliveryBoys.find((row) => row.id === submission.deliveryBoyId) || {
      id: submission.deliveryBoyId,
      name: submission.deliveryBoyNameSnapshot,
      commissionEnabled: submission.commissionEnabled,
      commissionRate: submission.commissionRate,
    };

  const billResult = await writeExternalSalesBill({
    userUid,
    clientId: submission.clientId,
    currency: currency || submission.currency || "",
    currencyDecimals:
      currencyDecimals ?? submission.currencyDecimals ?? 3,
    businessDate: submission.businessDate,
    terminal: {
      id: submission.terminalId,
      name: submission.terminalNameSnapshot || "",
    },
    billNumber: submission.billNumber,
    billAmount: submission.billAmount,
    saleType: "DELIVERY",
    paymentMode: submission.paymentMode,
    bankAccounts,
    bankAccountId: submission.bankAccountId || "",
    bankAccountNameSnapshot: submission.bankAccountNameSnapshot || "",
    customerId: "",
    customerName: submission.customerName || "",
    customerLocation: "",
    deliveryBoy: boy,
    deliveryCharge: submission.deliveryCharge,
    notes: submission.notes || "",
    // Approved bills become normal terminal entries.
    entrySource: EXTERNAL_ENTRY_SOURCE_MANUAL,
    entryLocalId: submission.entryLocalId || "",
    createdAtMs: submission.createdAtMs,
    createdBy: userUid,
    editMode: false,
  });

  await runTransaction(db, async (tx) => {
    const fresh = await tx.get(ref);
    if (!fresh.exists()) return;
    if (fresh.data()?.status !== SUBMISSION_STATUS.PENDING) return;
    const nowMs = Date.now();
    tx.update(ref, {
      status: SUBMISSION_STATUS.APPROVED,
      approvedAt: serverTimestamp(),
      approvedAtMs: nowMs,
      approvedBy: userUid,
      approvedBillId: billResult.docId,
      updatedAt: serverTimestamp(),
      updatedAtMs: nowMs,
      updatedBy: userUid,
    });
  });

  return billResult;
}

export async function rejectDeliveryBillSubmission({
  submissionId,
  userUid,
  reason = "",
} = {}) {
  if (!userUid) throw new Error("You must be signed in.");
  const id = clean(submissionId);
  if (!id) throw new Error("Submission id is required.");

  const ref = doc(db, DELIVERY_BILL_SUBMISSIONS, id);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Submission not found.");
    if (snap.data()?.status !== SUBMISSION_STATUS.PENDING) {
      throw new Error("This submission is no longer pending.");
    }
    const nowMs = Date.now();
    tx.update(ref, {
      status: SUBMISSION_STATUS.REJECTED,
      rejectReason: clean(reason) || "Rejected by admin.",
      rejectedAt: serverTimestamp(),
      rejectedAtMs: nowMs,
      rejectedBy: userUid,
      updatedAt: serverTimestamp(),
      updatedAtMs: nowMs,
      updatedBy: userUid,
    });
  });
}
