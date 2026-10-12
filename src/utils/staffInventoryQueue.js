/**
 * IndexedDB queue for Staff Inventory offline-first checklist + usage.
 * Mirrors delivery bill queue: save on device → sync to Firestore.
 */

export const STAFF_INV_SYNC_STATUS = {
  PENDING: "PENDING",
  SYNCING: "SYNCING",
  FAILED: "FAILED",
};

export const STAFF_INV_ENTRY_TYPE = {
  REVIEW: "REVIEW",
  USAGE: "USAGE",
};

const DB_NAME = "gtct_staff_inventory";
const DB_VERSION = 1;
const STORE_ENTRIES = "entries";
const STORE_META = "meta";

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available on this device."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
        const store = db.createObjectStore(STORE_ENTRIES, {
          keyPath: "entryLocalId",
        });
        store.createIndex("syncStatus", "syncStatus", { unique: false });
        store.createIndex("clientId", "clientId", { unique: false });
        store.createIndex(
          "clientDateType",
          ["clientId", "businessDate", "type"],
          { unique: false }
        );
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Failed to open IndexedDB."));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
  });
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("IndexedDB request failed."));
  });
}

export function createStaffInvLocalId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

/** One pending review per item per shop/date — later edits overwrite. */
export function reviewEntryLocalId(clientId, businessDate, itemId) {
  return `review_${String(clientId || "").trim()}_${String(businessDate || "").trim()}_${String(itemId || "").trim()}`;
}

export async function getStaffInvMeta(key) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_META, "readonly");
    const row = await reqToPromise(tx.objectStore(STORE_META).get(String(key)));
    await txDone(tx);
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

export async function setStaffInvMeta(key, value) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_META, "readwrite");
    tx.objectStore(STORE_META).put({ key: String(key), value });
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function putStaffInvEntry(record) {
  if (!record?.entryLocalId) {
    throw new Error("entryLocalId is required.");
  }
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_ENTRIES, "readwrite");
    tx.objectStore(STORE_ENTRIES).put(record);
    await txDone(tx);
    return record;
  } finally {
    db.close();
  }
}

export async function updateStaffInvEntry(entryLocalId, patch = {}) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_ENTRIES, "readwrite");
    const store = tx.objectStore(STORE_ENTRIES);
    const existing = await reqToPromise(store.get(String(entryLocalId)));
    if (!existing) {
      await txDone(tx);
      return null;
    }
    const next = {
      ...existing,
      ...patch,
      entryLocalId: existing.entryLocalId,
      updatedAtMs: Date.now(),
    };
    store.put(next);
    await txDone(tx);
    return next;
  } finally {
    db.close();
  }
}

export async function deleteStaffInvEntry(entryLocalId) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_ENTRIES, "readwrite");
    tx.objectStore(STORE_ENTRIES).delete(String(entryLocalId));
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function listStaffInvEntries() {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_ENTRIES, "readonly");
    const rows = await reqToPromise(tx.objectStore(STORE_ENTRIES).getAll());
    await txDone(tx);
    return Array.isArray(rows) ? rows : [];
  } finally {
    db.close();
  }
}

export async function listPendingStaffInvEntries({
  clientId = "",
  businessDate = "",
  type = "",
} = {}) {
  const rows = await listStaffInvEntries();
  const shop = String(clientId || "").trim();
  const date = String(businessDate || "").trim();
  const entryType = String(type || "").trim();
  return rows
    .filter((row) => {
      const status = String(row.syncStatus || "");
      if (
        status !== STAFF_INV_SYNC_STATUS.PENDING &&
        status !== STAFF_INV_SYNC_STATUS.SYNCING &&
        status !== STAFF_INV_SYNC_STATUS.FAILED
      ) {
        return false;
      }
      if (shop && String(row.clientId || "") !== shop) return false;
      if (date && String(row.businessDate || "") !== date) return false;
      if (entryType && String(row.type || "") !== entryType) return false;
      return true;
    })
    .sort((a, b) => Number(a.createdAtMs || 0) - Number(b.createdAtMs || 0));
}

export async function getStaffInvUnsyncedSummary(clientId = "") {
  const rows = await listPendingStaffInvEntries({ clientId });
  const pending = rows.filter(
    (row) =>
      row.syncStatus === STAFF_INV_SYNC_STATUS.PENDING ||
      row.syncStatus === STAFF_INV_SYNC_STATUS.SYNCING
  ).length;
  const failed = rows.filter(
    (row) => row.syncStatus === STAFF_INV_SYNC_STATUS.FAILED
  ).length;
  return { pending, failed, total: pending + failed, rows };
}

/**
 * Queue a checklist review (instant). Replaces any prior pending review for same item/day.
 */
export async function enqueueStaffReview({
  clientId,
  businessDate,
  item,
  attentionStatus,
  requestedQty = "",
  notes = "",
  userUid,
  userName = "",
}) {
  const shop = String(clientId || "").trim();
  const date = String(businessDate || "").trim();
  const itemId = String(item?.id || "").trim();
  const nowMs = Date.now();
  const entryLocalId = reviewEntryLocalId(shop, date, itemId);

  const record = {
    entryLocalId,
    type: STAFF_INV_ENTRY_TYPE.REVIEW,
    syncStatus: STAFF_INV_SYNC_STATUS.PENDING,
    syncError: "",
    clientId: shop,
    businessDate: date,
    itemId,
    itemCode: String(item?.itemCode || "").trim(),
    itemName: String(item?.itemName || "").trim(),
    stockSnapshot: Number(item?.currentStock) || 0,
    attentionStatus: String(attentionStatus || "").trim().toUpperCase(),
    requestedQty:
      requestedQty === "" || requestedQty == null ? "" : String(requestedQty),
    notes: String(notes || "").trim().slice(0, 500),
    userUid: String(userUid || "").trim(),
    userName: String(userName || "").trim(),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  await putStaffInvEntry(record);
  return record;
}

/**
 * Queue a stock usage deduction (instant). Each save is a new local row.
 */
export async function enqueueStaffUsage({
  clientId,
  businessDate,
  item,
  qty,
  usageReason,
  notes = "",
  userUid,
  userName = "",
  shiftId = "",
}) {
  const shop = String(clientId || "").trim();
  const date = String(businessDate || "").trim();
  const itemId = String(item?.id || "").trim();
  const nowMs = Date.now();
  const entryLocalId = createStaffInvLocalId();

  const record = {
    entryLocalId,
    type: STAFF_INV_ENTRY_TYPE.USAGE,
    syncStatus: STAFF_INV_SYNC_STATUS.PENDING,
    syncError: "",
    clientId: shop,
    businessDate: date,
    itemId,
    itemCode: String(item?.itemCode || "").trim(),
    itemName: String(item?.itemName || "").trim(),
    qty: String(qty ?? "").trim(),
    usageReason: String(usageReason || "").trim().toUpperCase(),
    notes: String(notes || "").trim().slice(0, 500),
    userUid: String(userUid || "").trim(),
    userName: String(userName || "").trim(),
    shiftId: String(shiftId || "").trim(),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  await putStaffInvEntry(record);
  return record;
}
