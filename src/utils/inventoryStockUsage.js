import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { numMoney } from "./money.js";

export const USAGE_REASONS = [
  "DAILY_USE",
  "PRODUCTION",
  "WASTE",
  "SAMPLE",
  "OTHER",
];

export const USAGE_REASON_META = {
  DAILY_USE: { label: "Daily use" },
  PRODUCTION: { label: "Production" },
  WASTE: { label: "Waste" },
  SAMPLE: { label: "Sample" },
  OTHER: { label: "Other" },
};

export const STOCK_USAGE_SOURCE = "STOCK_USAGE";
export const STOCK_USAGE_REASON = "USAGE";

export function isUsageReason(value) {
  return USAGE_REASONS.includes(String(value || "").trim().toUpperCase());
}

/**
 * Deduct stock for daily usage.
 * When entryLocalId is provided, movement id is deterministic so retries
 * never double-deduct (offline queue sync safety).
 */
export async function recordInventoryStockUsage({
  clientId,
  businessDate,
  item,
  qty,
  usageReason,
  notes = "",
  userUid,
  userName = "",
  shiftId = "",
  entryLocalId = "",
}) {
  const shop = String(clientId || "").trim();
  const date = String(businessDate || "").trim();
  const uid = String(userUid || "").trim();
  const itemId = String(item?.id || "").trim();
  const reason = String(usageReason || "")
    .trim()
    .toUpperCase();
  const qtyNum = numMoney(qty);
  const noteText = String(notes || "").trim().slice(0, 500);
  const localId = String(entryLocalId || "").trim();

  if (!shop) throw new Error("Select an active shop first.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Business date is required. Open a shift first.");
  }
  if (!uid) throw new Error("You must be signed in.");
  if (!itemId) throw new Error("Item is required.");
  if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
    throw new Error("Enter a usage quantity greater than zero.");
  }
  if (!isUsageReason(reason)) {
    throw new Error("Select a usage reason.");
  }

  const itemRef = doc(db, "inventory", itemId);
  const movementRef = localId
    ? doc(db, "inventory_movements", localId)
    : doc(collection(db, "inventory_movements"));
  const nowMs = Date.now();
  let alreadyApplied = false;

  await runTransaction(db, async (tx) => {
    const reads = [tx.get(itemRef)];
    if (localId) reads.push(tx.get(movementRef));
    const [itemSnap, movementSnap] = await Promise.all(reads);

    if (localId && movementSnap?.exists()) {
      // Idempotent retry — movement already written for this local entry.
      alreadyApplied = true;
      return;
    }

    if (!itemSnap.exists()) {
      throw new Error("Item was not found.");
    }
    const data = itemSnap.data() || {};
    if (String(data.clientId || "") !== shop) {
      throw new Error("Item does not belong to this shop.");
    }

    const oldStock = numMoney(data.currentStock);
    if (qtyNum > oldStock) {
      throw new Error(
        `Not enough stock. On hand is ${oldStock}, usage is ${qtyNum}.`
      );
    }
    const totalStock = numMoney(oldStock - qtyNum);
    const unitCost = Math.max(0, numMoney(data.cost));
    const amount = numMoney(qtyNum * unitCost);

    tx.update(itemRef, {
      currentStock: totalStock,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    });

    tx.set(movementRef, {
      clientId: shop,
      businessDate: date,
      itemId,
      itemCode: String(data.itemCode || item.itemCode || "").trim(),
      itemName: String(data.itemName || item.itemName || "").trim(),
      type: "OUT",
      qty: qtyNum,
      unitCost,
      amount,
      oldStock,
      totalStock,
      source: STOCK_USAGE_SOURCE,
      reason: STOCK_USAGE_REASON,
      usageReason: reason,
      notes: noteText,
      shiftId: String(shiftId || "").trim(),
      sourceLocalId: localId || "",
      userId: uid,
      userName: String(userName || "").trim(),
      createdBy: uid,
      date: new Date(nowMs),
      dateMs: nowMs,
      createdAt: serverTimestamp(),
    });
  });

  return { movementId: movementRef.id, itemId, alreadyApplied };
}

function todayStockUsageQuery(clientId, businessDate) {
  return query(
    collection(db, "inventory_movements"),
    where("clientId", "==", clientId),
    where("businessDate", "==", businessDate),
    where("source", "==", STOCK_USAGE_SOURCE)
  );
}

function mapUsageSnap(snap) {
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => numMoney(b.dateMs) - numMoney(a.dateMs));
}

/** One-shot fetch for Today's usage (used after sync + as listener fallback). */
export async function fetchTodayStockUsage(clientId, businessDate) {
  const shop = String(clientId || "").trim();
  const date = String(businessDate || "").trim();
  if (!shop || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const snap = await getDocs(todayStockUsageQuery(shop, date));
  return mapUsageSnap(snap);
}

export function subscribeTodayStockUsage(
  clientId,
  businessDate,
  onRows,
  onError
) {
  const shop = String(clientId || "").trim();
  const date = String(businessDate || "").trim();
  if (!shop || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    onRows([]);
    return () => {};
  }

  const q = todayStockUsageQuery(shop, date);

  // Prefer an immediate get so the list is not empty while waiting on snapshot.
  void getDocs(q)
    .then((snap) => onRows(mapUsageSnap(snap)))
    .catch((err) => {
      onError?.(err);
    });

  return onSnapshot(
    q,
    (snap) => {
      onRows(mapUsageSnap(snap));
    },
    (err) => {
      onError?.(err);
      // Do not wipe existing rows on listener errors — keep last good list.
      void getDocs(q)
        .then((snap) => onRows(mapUsageSnap(snap)))
        .catch(() => {});
    }
  );
}
