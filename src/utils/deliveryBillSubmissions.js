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
  EXTERNAL_ENTRY_SOURCE_DELIVERY_APP,
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
  /** Boy edited an already-approved bill — shop must re-check. */
  EDITED_PENDING: "EDITED_PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
};

/** Statuses waiting for shop review (new or re-check after boy edit). */
export const SUBMISSION_REVIEW_STATUSES = [
  SUBMISSION_STATUS.PENDING,
  SUBMISSION_STATUS.EDITED_PENDING,
];

export function isSubmissionAwaitingReview(status) {
  return SUBMISSION_REVIEW_STATUSES.includes(String(status || "").trim());
}

export function isEditedSubmission(status) {
  return String(status || "").trim() === SUBMISSION_STATUS.EDITED_PENDING;
}

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
  if (!billNo) {
    throw new Error("Bill number must be a whole number (e.g. 1, 2, 3).");
  }

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

  // Best-effort duplicate pending check (scoped to this delivery boy for rules).
  try {
    const dupSnap = await getDocs(
      query(
        collection(db, DELIVERY_BILL_SUBMISSIONS),
        where("clientId", "==", clientId),
        where("businessDate", "==", businessDate),
        where("terminalId", "==", terminalId),
        where("billNumber", "==", billNo),
        where("status", "in", SUBMISSION_REVIEW_STATUSES),
        where("deliveryBoyId", "==", clean(boy.id))
      )
    );
    const otherPending = dupSnap.docs.find((item) => item.id !== submissionId);
    if (otherPending) {
      throw new Error(
        `Bill ${billNo} is already waiting for approval for ${terminalNameSnapshot || "this terminal"}.`
      );
    }
  } catch (error) {
    if (error?.message?.includes("already waiting")) throw error;
    // Index / permission issues must not block create — approve path is final authority.
    console.warn("delivery submission duplicate check skipped:", error);
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
  try {
    const snap = await getDoc(doc(db, DELIVERY_BILL_SUBMISSIONS, id));
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data() };
  } catch {
    // Treat permission / offline as "not found" so sync can attempt create.
    return null;
  }
}

function buildSubmissionFieldPatch({
  record,
  deliveryBoy,
  bankAccounts,
  currency,
  currencyDecimals,
}) {
  const billNo = normalizeBillNumber(record.billNumber);
  if (!billNo) {
    throw new Error("Bill number must be a whole number (e.g. 1, 2, 3).");
  }

  const amountNum = numMoney(record.billAmount);
  if (!Number.isFinite(amountNum)) {
    throw new Error("Bill amount must be a valid number.");
  }

  let paymentMode =
    clean(record.paymentMode).toUpperCase() || DELIVERY_ACCOUNT_PAYMENT;
  let bankAccountId = clean(record.bankAccountId);
  let bankAccountNameSnapshot = clean(record.bankAccountNameSnapshot);

  if (paymentMode === "BANK") {
    if (!bankAccountId) throw new Error("Select a bank account.");
    const bankCheck = assertOperationalBankAccount(bankAccounts, bankAccountId);
    if (!bankCheck.ok) throw new Error(bankCheck.message);
    bankAccountNameSnapshot =
      bankAccountNameSnapshot ||
      findBankAccountName(bankAccounts, bankAccountId);
  } else if (
    paymentMode === "CASH" ||
    paymentMode === DELIVERY_ACCOUNT_PAYMENT
  ) {
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

  return {
    terminalId: clean(record.terminalId),
    terminalNameSnapshot: clean(record.terminalNameSnapshot),
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
    currencyDecimals: currencyDecimals ?? record.currencyDecimals ?? 3,
    notes: clean(record.notes),
  };
}

/**
 * Delivery boy edits their own submission.
 * PENDING stays PENDING; APPROVED / EDITED_PENDING → EDITED_PENDING for shop re-check.
 * After approval, terminal / date / bill number stay locked.
 */
export async function updateDeliveryBillSubmissionByBoy({
  userUid,
  submissionId,
  record,
  deliveryBoy = null,
  bankAccounts = [],
  currency = "",
  currencyDecimals = 3,
} = {}) {
  if (!userUid) throw new Error("You must be signed in.");
  const id = clean(submissionId);
  if (!id) throw new Error("Submission id is required.");

  const patch = buildSubmissionFieldPatch({
    record,
    deliveryBoy,
    bankAccounts,
    currency,
    currencyDecimals,
  });

  const ref = doc(db, DELIVERY_BILL_SUBMISSIONS, id);
  let nextStatus = SUBMISSION_STATUS.PENDING;

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Bill not found.");
    const data = snap.data() || {};
    const current = clean(data.status);

    if (current === SUBMISSION_STATUS.REJECTED) {
      throw new Error("Rejected bills cannot be edited.");
    }
    if (
      current !== SUBMISSION_STATUS.PENDING &&
      current !== SUBMISSION_STATUS.APPROVED &&
      current !== SUBMISSION_STATUS.EDITED_PENDING
    ) {
      throw new Error("This bill cannot be edited right now.");
    }

    const lockedAfterApproval =
      current === SUBMISSION_STATUS.APPROVED ||
      current === SUBMISSION_STATUS.EDITED_PENDING;

    if (lockedAfterApproval) {
      if (clean(data.businessDate) !== clean(record.businessDate).slice(0, 10)) {
        throw new Error("Business date cannot change after approval.");
      }
      if (clean(data.terminalId) !== patch.terminalId) {
        throw new Error("Terminal cannot change after approval.");
      }
      if (clean(data.billNumber) !== patch.billNumber) {
        throw new Error("Bill number cannot change after approval.");
      }
      nextStatus = SUBMISSION_STATUS.EDITED_PENDING;
    } else {
      nextStatus = SUBMISSION_STATUS.PENDING;
    }

    const nowMs = Date.now();
    tx.update(ref, {
      ...patch,
      status: nextStatus,
      lastEditSource: "delivery_boy",
      editedAt: serverTimestamp(),
      editedAtMs: nowMs,
      editedBy: userUid,
      updatedAt: serverTimestamp(),
      updatedAtMs: nowMs,
      updatedBy: userUid,
    });
  });

  return { submissionId: id, status: nextStatus };
}

/**
 * Approve a pending / edited submission → create or update external_sales_bills.
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
  if (!isSubmissionAwaitingReview(submission.status)) {
    throw new Error("This submission is no longer pending.");
  }

  const boy =
    deliveryBoys.find((row) => row.id === submission.deliveryBoyId) || {
      id: submission.deliveryBoyId,
      name: submission.deliveryBoyNameSnapshot,
      commissionEnabled: submission.commissionEnabled,
      commissionRate: submission.commissionRate,
    };

  const reApprove = Boolean(clean(submission.approvedBillId));
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
    entrySource: EXTERNAL_ENTRY_SOURCE_DELIVERY_APP,
    entryLocalId: submission.entryLocalId || "",
    createdAtMs: submission.createdAtMs,
    createdBy: userUid,
    editMode: reApprove,
    existingMeta: reApprove
      ? {
          createdAt: submission.createdAt || null,
          createdAtMs: submission.createdAtMs || null,
          createdBy: submission.createdBy || null,
        }
      : null,
  });

  await runTransaction(db, async (tx) => {
    const fresh = await tx.get(ref);
    if (!fresh.exists()) return;
    if (!isSubmissionAwaitingReview(fresh.data()?.status)) return;
    const prior = fresh.data() || {};
    const nowMs = Date.now();
    tx.update(ref, {
      status: SUBMISSION_STATUS.APPROVED,
      approvedAt: serverTimestamp(),
      approvedAtMs: nowMs,
      approvedBy: userUid,
      approvedBillId: billResult.docId,
      lastEditSource:
        prior.status === SUBMISSION_STATUS.EDITED_PENDING
          ? "shop"
          : prior.lastEditSource || "",
      updatedAt: serverTimestamp(),
      updatedAtMs: nowMs,
      updatedBy: userUid,
    });
  });

  return billResult;
}

/**
 * Mark a pending/edited submission APPROVED after the admin saved via the
 * terminal form.
 */
export async function markDeliveryBillSubmissionApproved({
  submissionId,
  userUid,
  approvedBillId = "",
} = {}) {
  if (!userUid) throw new Error("You must be signed in.");
  const id = clean(submissionId);
  if (!id) throw new Error("Submission id is required.");

  const ref = doc(db, DELIVERY_BILL_SUBMISSIONS, id);
  await runTransaction(db, async (tx) => {
    const fresh = await tx.get(ref);
    if (!fresh.exists()) throw new Error("Submission not found.");
    if (!isSubmissionAwaitingReview(fresh.data()?.status)) {
      throw new Error("This submission is no longer pending.");
    }
    const prior = fresh.data() || {};
    const nowMs = Date.now();
    tx.update(ref, {
      status: SUBMISSION_STATUS.APPROVED,
      approvedAt: serverTimestamp(),
      approvedAtMs: nowMs,
      approvedBy: userUid,
      approvedBillId: clean(approvedBillId) || clean(prior.approvedBillId),
      lastEditSource:
        prior.status === SUBMISSION_STATUS.EDITED_PENDING
          ? "shop"
          : prior.lastEditSource || "",
      updatedAt: serverTimestamp(),
      updatedAtMs: nowMs,
      updatedBy: userUid,
    });
  });
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
    if (!isSubmissionAwaitingReview(snap.data()?.status)) {
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
