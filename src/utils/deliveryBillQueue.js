/**
 * IndexedDB queue for GTCT Delivery Entry pending bills.
 * This is the source of truth for unsynced bills — never localStorage.
 */

export const SYNC_STATUS = {
  PENDING: "PENDING",
  SYNCING: "SYNCING",
  SYNCED: "SYNCED",
  FAILED: "FAILED",
};

const DB_NAME = "gtct_delivery_entry";
const DB_VERSION = 1;
const STORE_BILLS = "bills";
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
      if (!db.objectStoreNames.contains(STORE_BILLS)) {
        const store = db.createObjectStore(STORE_BILLS, { keyPath: "entryLocalId" });
        store.createIndex("syncStatus", "syncStatus", { unique: false });
        store.createIndex("clientId", "clientId", { unique: false });
        store.createIndex(
          "dupKey",
          ["clientId", "businessDate", "terminalId", "billNumber"],
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

export function createEntryLocalId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

export async function getDeliveryMeta(key) {
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

export async function setDeliveryMeta(key, value) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_META, "readwrite");
    tx.objectStore(STORE_META).put({ key: String(key), value });
    await txDone(tx);
  } finally {
    db.close();
  }
}

/**
 * Local duplicate check: same shop/date/terminal/bill number still pending/failed.
 */
export async function findLocalDuplicateBill({
  clientId,
  businessDate,
  terminalId,
  billNumber,
  excludeEntryLocalId = "",
}) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_BILLS, "readonly");
    const index = tx.objectStore(STORE_BILLS).index("dupKey");
    const rows = await reqToPromise(
      index.getAll([
        String(clientId || ""),
        String(businessDate || ""),
        String(terminalId || ""),
        String(billNumber || "").trim(),
      ])
    );
    await txDone(tx);
    return (rows || []).find(
      (row) =>
        row.entryLocalId !== excludeEntryLocalId &&
        row.syncStatus !== SYNC_STATUS.SYNCED
    ) || null;
  } finally {
    db.close();
  }
}

export async function putLocalBill(record) {
  if (!record?.entryLocalId) {
    throw new Error("entryLocalId is required for local bill storage.");
  }
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_BILLS, "readwrite");
    tx.objectStore(STORE_BILLS).put(record);
    await txDone(tx);
    return record;
  } finally {
    db.close();
  }
}

export async function getLocalBill(entryLocalId) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_BILLS, "readonly");
    const row = await reqToPromise(
      tx.objectStore(STORE_BILLS).get(String(entryLocalId))
    );
    await txDone(tx);
    return row || null;
  } finally {
    db.close();
  }
}

export async function updateLocalBill(entryLocalId, patch = {}) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_BILLS, "readwrite");
    const store = tx.objectStore(STORE_BILLS);
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

export async function deleteLocalBill(entryLocalId) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_BILLS, "readwrite");
    tx.objectStore(STORE_BILLS).delete(String(entryLocalId));
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function listLocalBills() {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_BILLS, "readonly");
    const rows = await reqToPromise(tx.objectStore(STORE_BILLS).getAll());
    await txDone(tx);
    return Array.isArray(rows) ? rows : [];
  } finally {
    db.close();
  }
}

export async function listPendingLocalBills() {
  const rows = await listLocalBills();
  return rows
    .filter(
      (row) =>
        row.syncStatus === SYNC_STATUS.PENDING ||
        row.syncStatus === SYNC_STATUS.SYNCING ||
        row.syncStatus === SYNC_STATUS.FAILED
    )
    .sort((a, b) => Number(a.createdAtMs || 0) - Number(b.createdAtMs || 0));
}

export async function countUnsyncedLocalBills() {
  const rows = await listPendingLocalBills();
  return rows.filter((row) => row.syncStatus !== SYNC_STATUS.FAILED).length +
    rows.filter((row) => row.syncStatus === SYNC_STATUS.FAILED).length;
}

export async function getUnsyncedSummary() {
  const rows = await listPendingLocalBills();
  const pending = rows.filter(
    (row) =>
      row.syncStatus === SYNC_STATUS.PENDING ||
      row.syncStatus === SYNC_STATUS.SYNCING
  ).length;
  const failed = rows.filter((row) => row.syncStatus === SYNC_STATUS.FAILED)
    .length;
  return {
    pending,
    failed,
    total: pending + failed,
    rows,
  };
}
