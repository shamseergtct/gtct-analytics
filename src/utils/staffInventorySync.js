/**
 * Sync engine: push Staff Inventory IndexedDB queue to Firestore.
 */
import { upsertDailyReviewLine } from "./inventoryDailyReview.js";
import {
  fetchTodayStockUsage,
  recordInventoryStockUsage,
} from "./inventoryStockUsage.js";
import {
  STAFF_INV_ENTRY_TYPE,
  STAFF_INV_SYNC_STATUS,
  deleteStaffInvEntry,
  getStaffInvUnsyncedSummary,
  listPendingStaffInvEntries,
  updateStaffInvEntry,
} from "./staffInventoryQueue.js";

let syncRunning = false;
let syncQueued = false;
let syncListeners = new Set();
let lastSyncState = {
  online: typeof navigator !== "undefined" ? navigator.onLine : true,
  syncing: false,
  pending: 0,
  failed: 0,
  message: "",
  lastError: "",
  /** Bumps when usage rows may have changed on the server. */
  usageRefreshToken: 0,
  lastUsageClientId: "",
  lastUsageBusinessDate: "",
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
    return { ok: true, kind: "REVIEW" };
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
    return { ok: true, kind: "USAGE" };
  }

  throw new Error(`Unknown queue entry type: ${record.type}`);
}

/**
 * Push pending/failed Staff Inventory entries for a shop (FIFO).
 * Coalesces overlapping calls so saves stay instant while sync drains the queue.
 */
export async function runStaffInventorySync({
  clientId = "",
  userUid = "",
} = {}) {
  if (syncRunning) {
    syncQueued = true;
    return { skipped: true, queued: true, ...lastSyncState };
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
  let usageSynced = 0;
  let lastUsageBusinessDate = "";

  try {
    do {
      syncQueued = false;
      const queue = await listPendingStaffInvEntries({ clientId });
      const total = queue.length;
      let index = 0;
      for (const record of queue) {
        if (!isOnline()) {
          emit({
            online: false,
            message: "Went offline — remaining entries stay on device.",
          });
          break;
        }
        index += 1;
        emit({
          message: `Syncing ${index}/${total}…`,
        });
        try {
          const result = await syncOneEntry(record);
          synced += 1;
          if (result.kind === "USAGE") {
            usageSynced += 1;
            lastUsageBusinessDate = String(record.businessDate || "").trim();
            // Refresh Today's usage as soon as each usage lands.
            emit({
              usageRefreshToken: (lastSyncState.usageRefreshToken || 0) + 1,
              lastUsageClientId: clientId,
              lastUsageBusinessDate,
            });
          }
          // Drop pending count live so the bar feels responsive.
          await refreshStaffInvSyncCounts(clientId);
        } catch (error) {
          failed += 1;
          const message = error?.message || String(error) || "Sync failed.";
          const permanent = isPermanentFailure(error);
          await updateStaffInvEntry(record.entryLocalId, {
            syncStatus: STAFF_INV_SYNC_STATUS.FAILED,
            syncError: message,
          });
          emit({ lastError: message });
          await refreshStaffInvSyncCounts(clientId);
          if (!permanent && /unavailable|network|offline|deadline/i.test(message)) {
            break;
          }
        }
      }
    } while (syncQueued && isOnline());

    if (usageSynced > 0 && lastUsageBusinessDate) {
      try {
        await fetchTodayStockUsage(clientId, lastUsageBusinessDate);
      } catch {
        // StockUsage still refreshes via usageRefreshToken.
      }
      emit({
        usageRefreshToken: (lastSyncState.usageRefreshToken || 0) + 1,
        lastUsageClientId: clientId,
        lastUsageBusinessDate,
      });
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
    return { synced, failed, usageSynced, ...lastSyncState };
  } finally {
    syncRunning = false;
    emit({ syncing: false });
    if (syncQueued) {
      syncQueued = false;
      void runStaffInventorySync({ clientId, userUid });
    }
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
