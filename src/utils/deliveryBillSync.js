/**
 * Sync engine: push IndexedDB pending bills to Firestore as
 * delivery_bill_submissions (pending admin approval).
 * Approved bills become normal external_sales_bills in Analytics.
 */
import {
  SYNC_STATUS,
  getUnsyncedSummary,
  listPendingLocalBills,
  updateLocalBill,
  deleteLocalBill,
} from "./deliveryBillQueue.js";
import {
  findDeliveryBillSubmissionByLocalId,
  upsertDeliveryBillSubmission,
  SUBMISSION_STATUS,
} from "./deliveryBillSubmissions.js";

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

export function getDeliverySyncState() {
  return lastSyncState;
}

export function subscribeDeliverySync(listener) {
  syncListeners.add(listener);
  listener(lastSyncState);
  return () => syncListeners.delete(listener);
}

export async function refreshDeliverySyncCounts() {
  const summary = await getUnsyncedSummary();
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
  if (message.includes("already exists")) return true;
  if (message.includes("already waiting")) return true;
  if (message.includes("permission")) return true;
  if (message.includes("not available")) return true;
  if (message.includes("invalid")) return true;
  if (message.includes("required")) return true;
  if (message.includes("reserve")) return true;
  if (message.includes("not assigned")) return true;
  if (message.includes("conflicting")) return true;
  return false;
}

async function syncOneBill(record, ctx) {
  const {
    userUid,
    bankAccounts = [],
    deliveryBoy,
    currency,
    currencyDecimals,
  } = ctx;

  // Lost-response recovery: submission already accepted for this local id.
  try {
    const existing = await findDeliveryBillSubmissionByLocalId(
      record.entryLocalId
    );
    if (existing) {
      if (
        existing.status === SUBMISSION_STATUS.PENDING ||
        existing.status === SUBMISSION_STATUS.EDITED_PENDING ||
        existing.status === SUBMISSION_STATUS.APPROVED
      ) {
        await deleteLocalBill(record.entryLocalId);
        return { ok: true, status: "idempotent" };
      }
      if (existing.status === SUBMISSION_STATUS.REJECTED) {
        await updateLocalBill(record.entryLocalId, {
          syncStatus: SYNC_STATUS.FAILED,
          syncError:
            existing.rejectReason ||
            "This bill was rejected by the shop admin.",
        });
        return {
          ok: false,
          permanent: true,
          message: existing.rejectReason || "Rejected by admin.",
        };
      }
    }
  } catch {
    // continue to write attempt
  }

  await updateLocalBill(record.entryLocalId, {
    syncStatus: SYNC_STATUS.SYNCING,
    syncError: "",
  });

  try {
    await upsertDeliveryBillSubmission({
      userUid,
      record,
      deliveryBoy: deliveryBoy || {
        id: record.deliveryBoyId,
        name: record.deliveryBoyNameSnapshot,
        commissionEnabled: record.commissionEnabled,
        commissionRate: record.commissionRate,
      },
      bankAccounts,
      currency: currency || record.currency || "",
      currencyDecimals:
        currencyDecimals ?? record.currencyDecimals ?? 3,
    });

    await deleteLocalBill(record.entryLocalId);
    return { ok: true, status: "submitted" };
  } catch (error) {
    const message = error?.message || String(error);
    if (isPermanentFailure(error)) {
      await updateLocalBill(record.entryLocalId, {
        syncStatus: SYNC_STATUS.FAILED,
        syncError: message,
      });
      return { ok: false, permanent: true, message };
    }
    await updateLocalBill(record.entryLocalId, {
      syncStatus: SYNC_STATUS.PENDING,
      syncError: message,
    });
    return { ok: false, permanent: false, message };
  }
}

/**
 * Run sync for pending bills. Safe to call frequently; coalesces concurrent runs.
 */
export async function runDeliveryBillSync(ctx = {}) {
  if (syncRunning) return lastSyncState;
  if (!ctx.userUid) {
    emit({ message: "Sign in to sync.", lastError: "" });
    return lastSyncState;
  }
  if (!isOnline()) {
    const summary = await refreshDeliverySyncCounts();
    emit({
      online: false,
      syncing: false,
      message:
        summary.total > 0
          ? `${summary.total} bill${summary.total === 1 ? "" : "s"} waiting to sync`
          : "Offline",
    });
    return lastSyncState;
  }

  syncRunning = true;
  emit({ online: true, syncing: true, message: "Syncing…", lastError: "" });

  try {
    const pending = await listPendingLocalBills();
    const work = pending.filter(
      (row) =>
        row.syncStatus === SYNC_STATUS.PENDING ||
        row.syncStatus === SYNC_STATUS.SYNCING ||
        (ctx.retryFailed && row.syncStatus === SYNC_STATUS.FAILED)
    );

    let synced = 0;
    let failed = 0;
    for (const record of work) {
      if (!isOnline()) break;
      emit({
        message: `Syncing ${synced + failed + 1} of ${work.length}…`,
      });
      const result = await syncOneBill(record, ctx);
      if (result.ok) synced += 1;
      else {
        failed += 1;
        if (result.permanent) {
          emit({ lastError: result.message });
        }
      }
    }

    const summary = await refreshDeliverySyncCounts();
    emit({
      online: true,
      syncing: false,
      pending: summary.pending,
      failed: summary.failed,
      message:
        summary.total === 0
          ? "All bills synced"
          : summary.failed > 0
            ? `${summary.failed} need attention`
            : `${summary.pending} waiting to sync`,
    });
  } catch (error) {
    await refreshDeliverySyncCounts();
    emit({
      syncing: false,
      lastError: error?.message || String(error),
      message: "Sync paused",
    });
  } finally {
    syncRunning = false;
  }

  return lastSyncState;
}

export function installDeliveryNetworkListeners(getCtx) {
  if (typeof window === "undefined") return () => {};

  const onOnline = () => {
    emit({ online: true });
    const ctx = typeof getCtx === "function" ? getCtx() : getCtx;
    if (ctx?.userUid) runDeliveryBillSync(ctx);
  };
  const onOffline = () => {
    emit({ online: false, syncing: false, message: "Offline" });
    refreshDeliverySyncCounts();
  };

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  emit({ online: isOnline() });

  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}

/**
 * beforeunload warning when unsynced bills exist.
 */
export function installUnsyncedNavigationGuard() {
  if (typeof window === "undefined") return () => {};

  const handler = (event) => {
    if (!lastSyncState.pending && !lastSyncState.failed) return;
    event.preventDefault();
    event.returnValue =
      "Unsynced bills are waiting to be sent. Please keep this app open until synchronization is complete.";
    return event.returnValue;
  };

  window.addEventListener("beforeunload", handler);
  return () => window.removeEventListener("beforeunload", handler);
}
