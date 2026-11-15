/**
 * Device-local menu item images (IndexedDB).
 * Not synced across browsers/devices — intentional for POS speed.
 */

const DB_NAME = "gtct-menu-images-v1";
const STORE = "images";
const DB_VERSION = 1;

function imageKey(clientId, itemId) {
  return `${String(clientId || "").trim()}_${String(itemId || "").trim()}`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser does not support local image storage."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Could not open local image storage."));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Local image storage request failed."));
  });
}

export async function saveMenuImageLocal(clientId, itemId, fileOrBlob) {
  if (!clientId || !itemId) {
    throw new Error("Missing shop or item for local image.");
  }
  const key = imageKey(clientId, itemId);
  if (!fileOrBlob) throw new Error("No image selected.");

  const blob =
    fileOrBlob instanceof Blob
      ? fileOrBlob
      : new Blob([fileOrBlob], { type: "image/jpeg" });

  if (!String(blob.type || "").startsWith("image/")) {
    throw new Error("Selected file is not a valid image.");
  }
  if (blob.size > 5 * 1024 * 1024) {
    throw new Error("Item image must be 5 MB or smaller.");
  }

  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    await requestToPromise(
      store.put({
        key,
        clientId: String(clientId),
        itemId: String(itemId),
        blob,
        mimeType: blob.type || "image/jpeg",
        updatedAtMs: Date.now(),
      })
    );
  } finally {
    db.close();
  }
}

export async function getMenuImageLocal(clientId, itemId) {
  if (!clientId || !itemId) return null;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const row = await requestToPromise(
      tx.objectStore(STORE).get(imageKey(clientId, itemId))
    );
    return row?.blob instanceof Blob ? row.blob : null;
  } finally {
    db.close();
  }
}

export async function deleteMenuImageLocal(clientId, itemId) {
  if (!clientId || !itemId) return;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await requestToPromise(
      tx.objectStore(STORE).delete(imageKey(clientId, itemId))
    );
  } finally {
    db.close();
  }
}

/**
 * Load object URLs for many items. Caller should revoke URLs when done.
 * @returns {Record<string, string>} itemId -> object URL
 */
export async function loadMenuImageUrlMap(clientId, itemIds = []) {
  const map = {};
  if (!clientId || !itemIds.length) return map;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    await Promise.all(
      itemIds.map(async (itemId) => {
        if (!itemId) return;
        const row = await requestToPromise(
          store.get(imageKey(clientId, itemId))
        );
        if (row?.blob instanceof Blob) {
          map[itemId] = URL.createObjectURL(row.blob);
        }
      })
    );
  } finally {
    db.close();
  }
  return map;
}

export function revokeMenuImageUrlMap(map) {
  for (const url of Object.values(map || {})) {
    if (url && String(url).startsWith("blob:")) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
  }
}
