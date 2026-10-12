/**
 * Sync engine: push Staff Inventory IndexedDB queue to Firestore.
 */
import { upsertDailyReviewLine } from "./inventoryDailyReview.js";
import { recordInventoryStockUsage } from "./inventoryStockUsage.js";
import {
  STAFF_INV_ENTRY_TYPE,
  STAFF_INV_SYNC_STATUS,
  deleteStaffInvEntry,
  getStaffInvUnsyncedSummary,
  listPendingStaffInvEntries,
  updateStaffInvEntry,
} from "./staffInventoryQueue.js";

let syncRunning = false;
let syncListeners = new Set();
let lastSyncState = {
  online: typeof navigator !== "undefined" ? navigator.onLine : true,
  syncing: false,
  pending: 0,
  failed: 0,
  message: "",
  lastError: "",
};

function emit(partial = {}) {
  lastSyncState = { ...lastSyncState, ...partial };
  syncListeners.forEach((fn) => {
    try {
      fn(lastSyncState);
    } catch {
      // ignore listener errors
    }
  });
}

export function getStaffInvSyncState() {
  return lastSyncState;
}

export function subscribeStaffInvSync(listener) {
  syncListeners.add(listener);
  listener(lastSyncState);
  return () => syncListeners.delete(listener);
}

export async function refreshStaffInvSyncCounts(clientId = "") {
  const summary = await getStaffInvUnsyncedSummary(clientId);
  emit({
    pending: summary.pending,
    failed: summary.failed,
  });
  return summary;
}

function isOnline() {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function isPermanentFailure(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "").toLowerCase();
  if (code === "permission-denied") return true;
  if (message.includes("permission")) return true;
  if (message.includes("not enough stock")) return true;
  if (message.includes("not found")) return true;
  if (message.includes("does not belong")) return true;
  if (message.includes("required")) return true;
  if (message.includes("must be")) return true;
  if (message.includes("select ")) return true;
  if (message.includes("enter ")) return true;
  if (message.includes("invalid")) return true;
  return false;
}

async function syncOneEntry(record) {
  await updateStaffInvEntry(record.entryLocalId, {
    syncStatus: STAFF_INV_SYNC_STATUS.SYNCING,
    syncError: "",
  });

  if (record.type === STAFF_INV_ENTRY_TYPE.REVIEW) {
    await upsertDailyReviewLine({
      clientId: record.clientId,
      businessDate: record.businessDate,
      item: {
        id: record.itemId,
        itemCode: record.itemCode,
        itemName: record.itemName,
        currentStock: record.stockSnapshot,
      },
      attentionStatus: record.attentionStatus,
      requestedQty: record.requestedQty,
      notes: record.notes,
      userUid: record.userUid,
      userName: record.userName,
    });
    await deleteStaffInvEntry(record.entryLocalId);
    return { ok: true };
  }

  if (record.type === STAFF_INV_ENTRY_TYPE.USAGE) {
    await recordInventoryStockUsage({
      clientId: record.clientId,
      businessDate: record.businessDate,
      item: {
        id: record.itemId,
        itemCode: record.itemCode,
        itemName: record.itemName,
      },
      qty: record.qty,
      usageReason: record.usageReason,
      notes: record.notes,
      userUid: record.userUid,
      userName: record.userName,
      shiftId: record.shiftId,
      entryLocalId: record.entryLocalId,
    });
    await deleteStaffInvEntry(record.entryLocalId);
    return { ok: true };
  }

  throw new Error(`Unknown queue entry type: ${record.type}`);
}

/**
 * Push pending/failed Staff Inventory entries for a shop (FIFO).
 */
export async function runStaffInventorySync({
  clientId = "",
  userUid = "",
} = {}) {
  if (syncRunning) {
    return { skipped: true, ...lastSyncState };
  }
  if (!isOnline()) {
    emit({
      online: false,
      message: "Offline — entries stay on this device until you reconnect.",
    });
    await refreshStaffInvSyncCounts(clientId);
    return { skipped: true, offline: true, ...lastSyncState };
  }
  if (!userUid) {
    emit({ lastError: "Sign in required to sync." });
    return { skipped: true, ...lastSyncState };
  }

  syncRunning = true;
  emit({
    online: true,
    syncing: true,
    message: "Syncing…",
    lastError: "",
  });

  let synced = 0;
  let failed = 0;

  try {
    const queue = await listPendingStaffInvEntries({ clientId });
    for (const record of queue) {
      if (!isOnline()) {
        emit({
          online: false,
          message: "Went offline — remaining entries stay on device.",
        });
        break;
      }
      try {
        await syncOneEntry(record);
        synced += 1;
      } catch (error) {
        failed += 1;
        const message = error?.message || String(error) || "Sync failed.";
        const permanent = isPermanentFailure(error);
        await updateStaffInvEntry(record.entryLocalId, {
          syncStatus: STAFF_INV_SYNC_STATUS.FAILED,
          syncError: message,
        });
        emit({ lastError: message });
        // Permanent item failures: continue with other entries.
        // Transient: still continue so one bad network blip doesn't stall the queue forever;
        // FAILED rows can be retried on next sync.
        if (!permanent && /unavailable|network|offline|deadline/i.test(message)) {
          break;
        }
      }
    }

    const summary = await refreshStaffInvSyncCounts(clientId);
    const message =
      synced > 0 && summary.total === 0
        ? `Synced ${synced} entr${synced === 1 ? "y" : "ies"}.`
        : synced > 0
          ? `Synced ${synced}. ${summary.failed} need attention.`
          : summary.failed
            ? `${summary.failed} entr${summary.failed === 1 ? "y" : "ies"} failed — tap Sync to retry.`
            : summary.pending
              ? "Waiting to sync…"
              : "All caught up.";

    emit({
      syncing: false,
      message,
      pending: summary.pending,
      failed: summary.failed,
    });
    return { synced, failed, ...lastSyncState };
  } finally {
    syncRunning = false;
    emit({ syncing: false });
  }
}

export function bindStaffInventoryOnlineSync(getCtx) {
  if (typeof window === "undefined") return () => {};

  const run = () => {
    const ctx = typeof getCtx === "function" ? getCtx() : getCtx;
    if (!ctx?.userUid) return;
    void runStaffInventorySync(ctx);
  };

  const onOnline = () => {
    emit({ online: true });
    run();
  };
  const onOffline = () => {
    emit({
      online: false,
      message: "Offline — new saves stay on this device.",
    });
  };

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  emit({ online: isOnline() });

  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}
