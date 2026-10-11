import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { numMoney } from "./money.js";

export const ATTENTION_STATUSES = [
  "ENOUGH",
  "LOW",
  "URGENT",
  "VERY_URGENT",
];

export const ATTENTION_STATUS_META = {
  ENOUGH: {
    label: "Enough",
    short: "OK",
    tone: "emerald",
    textClass: "text-emerald-300",
  },
  LOW: {
    label: "Low",
    short: "Low",
    tone: "amber",
    textClass: "text-amber-300",
  },
  URGENT: {
    label: "Urgent",
    short: "Urgent",
    tone: "orange",
    textClass: "text-orange-300",
  },
  VERY_URGENT: {
    label: "Very Urgent",
    short: "V.Urgent",
    tone: "rose",
    textClass: "text-rose-300",
  },
};

/** Deterministic review id: one document per shop per business date. */
export function dailyReviewId(clientId, businessDate) {
  const shop = String(clientId || "").trim();
  const date = String(businessDate || "").trim();
  if (!shop || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("clientId and businessDate (YYYY-MM-DD) are required.");
  }
  return `${shop}_${date}`;
}

/** Line id = inventory item id — one line per item per day. */
export function dailyReviewLineId(itemId) {
  const id = String(itemId || "").trim();
  if (!id) throw new Error("itemId is required.");
  return id;
}

export function dailyReviewRef(clientId, businessDate) {
  return doc(db, "inventory_daily_reviews", dailyReviewId(clientId, businessDate));
}

export function dailyReviewLineRef(clientId, businessDate, itemId) {
  return doc(
    collection(dailyReviewRef(clientId, businessDate), "lines"),
    dailyReviewLineId(itemId)
  );
}

export function isAttentionStatus(value) {
  return ATTENTION_STATUSES.includes(String(value || "").trim().toUpperCase());
}

export function normalizeRequestedQty(value) {
  if (value === "" || value == null) return null;
  const n = numMoney(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error("Requested quantity must be a non-negative number.");
  }
  return n;
}

/**
 * Create/update a single checklist line without touching inventory stock.
 * Parent review + line share one transaction for idempotent multi-staff use.
 */
export async function upsertDailyReviewLine({
  clientId,
  businessDate,
  item,
  attentionStatus,
  requestedQty = null,
  notes = "",
  userUid,
  userName = "",
}) {
  const shop = String(clientId || "").trim();
  const date = String(businessDate || "").trim();
  const uid = String(userUid || "").trim();
  const itemId = String(item?.id || "").trim();
  const status = String(attentionStatus || "")
    .trim()
    .toUpperCase();

  if (!shop) throw new Error("Select an active shop first.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Business date is required.");
  }
  if (!uid) throw new Error("You must be signed in.");
  if (!itemId) throw new Error("Item is required.");
  if (!isAttentionStatus(status)) {
    throw new Error("Select Enough, Low, Urgent, or Very Urgent.");
  }

  let qty = null;
  try {
    qty = normalizeRequestedQty(requestedQty);
  } catch (err) {
    throw err;
  }
  // Treat explicit 0 like "no qty entered".
  if (qty === 0) qty = null;
  if (status !== "ENOUGH" && (qty == null || qty <= 0)) {
    throw new Error("Enter the required quantity for Low, Urgent, or Very Urgent.");
  }

  const noteText = String(notes || "").trim().slice(0, 500);
  const itemCode = String(item.itemCode || "").trim() || itemId;
  const itemName = String(item.itemName || "").trim() || itemCode;
  const stockSnapshot = numMoney(item.currentStock);
  const reviewRef = dailyReviewRef(shop, date);
  const lineRef = dailyReviewLineRef(shop, date, itemId);
  const nowMs = Date.now();

  await runTransaction(db, async (tx) => {
    const [reviewSnap, lineSnap] = await Promise.all([
      tx.get(reviewRef),
      tx.get(lineRef),
    ]);

    if (!reviewSnap.exists()) {
      tx.set(reviewRef, {
        clientId: shop,
        businessDate: date,
        status: "OPEN",
        createdAt: serverTimestamp(),
        createdAtMs: nowMs,
        createdBy: uid,
        updatedAt: serverTimestamp(),
        updatedAtMs: nowMs,
        updatedBy: uid,
      });
    } else {
      const existing = reviewSnap.data() || {};
      if (existing.clientId !== shop || existing.businessDate !== date) {
        throw new Error("Review document scope mismatch.");
      }
      tx.update(reviewRef, {
        status: "OPEN",
        updatedAt: serverTimestamp(),
        updatedAtMs: nowMs,
        updatedBy: uid,
      });
    }

    const payload = {
      clientId: shop,
      businessDate: date,
      itemId,
      itemCode,
      itemName,
      stockSnapshot,
      attentionStatus: status,
      requestedQty: qty,
      notes: noteText,
      completed: true,
      reviewedBy: uid,
      reviewedByName: String(userName || "").trim(),
      reviewedAtMs: nowMs,
      updatedAt: serverTimestamp(),
      updatedAtMs: nowMs,
      updatedBy: uid,
    };

    if (!lineSnap.exists()) {
      tx.set(lineRef, {
        ...payload,
        createdAt: serverTimestamp(),
        createdAtMs: nowMs,
        createdBy: uid,
      });
    } else {
      const prev = lineSnap.data() || {};
      if (prev.clientId !== shop || prev.itemId !== itemId) {
        throw new Error("Review line scope mismatch.");
      }
      tx.update(lineRef, payload);
    }
  });

  return { reviewId: dailyReviewId(shop, date), lineId: itemId };
}

export function subscribeDailyReviewLines(
  clientId,
  businessDate,
  onRows,
  onError
) {
  let shop;
  let date;
  try {
    shop = String(clientId || "").trim();
    date = String(businessDate || "").trim();
    if (!shop || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      onRows([]);
      return () => {};
    }
  } catch {
    onRows([]);
    return () => {};
  }

  const linesQuery = query(
    collection(dailyReviewRef(shop, date), "lines"),
    where("clientId", "==", shop)
  );
  return onSnapshot(
    linesQuery,
    (snap) => {
      onRows(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    },
    (err) => {
      onError?.(err);
      onRows([]);
    }
  );
}

export async function ensureDailyReviewExists({
  clientId,
  businessDate,
  userUid,
}) {
  const shop = String(clientId || "").trim();
  const date = String(businessDate || "").trim();
  const uid = String(userUid || "").trim();
  if (!shop || !uid || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const ref = dailyReviewRef(shop, date);
  const snap = await getDoc(ref);
  if (snap.exists()) return { id: ref.id, ...snap.data() };

  const nowMs = Date.now();
  await runTransaction(db, async (tx) => {
    const again = await tx.get(ref);
    if (again.exists()) return;
    tx.set(ref, {
      clientId: shop,
      businessDate: date,
      status: "OPEN",
      createdAt: serverTimestamp(),
      createdAtMs: nowMs,
      createdBy: uid,
      updatedAt: serverTimestamp(),
      updatedAtMs: nowMs,
      updatedBy: uid,
    });
  });
  return { id: ref.id, clientId: shop, businessDate: date, status: "OPEN" };
}
