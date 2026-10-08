import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase";

const BATCH_LIMIT = 400;

// Shop reset helpers — super_admin only (enforced by caller + Firestore rules).

/** Transactional / day-activity collections scoped by clientId. */
export const SHOP_TRANSACTION_COLLECTIONS = [
  "transactions",
  "purchases",
  "payment_receipts",
  "internal_transfers",
  "sales_invoices",
  "daily_reports",
  "shifts",
  "z_reports",
  "inventory_movements",
  "external_sales_bills",
  "delivery_boy_collections",
  "delivery_bill_submissions",
  "external_terminal_bill_ranges",
];

/** Master / setup data (not date-scoped). */
export const SHOP_MASTER_COLLECTIONS = [
  "parties",
  "bank_accounts",
  "inventory",
  "billing_terminals",
  "delivery_boys",
];

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoDate(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  if (value?.toDate) {
    try {
      return value.toDate().toISOString().slice(0, 10);
    } catch {
      return "";
    }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return "";
}

/**
 * Resolve a document's business date for range filtering.
 */
export function documentBusinessDate(collectionName, data = {}) {
  if (!data || typeof data !== "object") return "";

  if (collectionName === "transactions") {
    if (data.dateMs) {
      const ms = num(data.dateMs);
      if (ms > 0) return new Date(ms).toISOString().slice(0, 10);
    }
    return toIsoDate(data.date) || toIsoDate(data.businessDate);
  }

  if (collectionName === "daily_reports") {
    return toIsoDate(data.date) || toIsoDate(data.businessDate);
  }

  return (
    toIsoDate(data.businessDate) ||
    toIsoDate(data.date) ||
    (data.dateMs ? new Date(num(data.dateMs)).toISOString().slice(0, 10) : "")
  );
}

function inDateRange(isoDate, fromDate, toDate) {
  if (!isoDate) return false;
  if (fromDate && isoDate < fromDate) return false;
  if (toDate && isoDate > toDate) return false;
  return true;
}

async function deleteDocs(refs = [], collectionName = "") {
  let deleted = 0;
  for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
    const slice = refs.slice(i, i + BATCH_LIMIT);
    try {
      const batch = writeBatch(db);
      slice.forEach((ref) => batch.delete(ref));
      await batch.commit();
      deleted += slice.length;
    } catch {
      // Fall back to one-by-one so permission issues are clear.
      for (const ref of slice) {
        try {
          await deleteDoc(ref);
          deleted += 1;
        } catch (oneError) {
          const code = oneError?.code || "";
          const message = oneError?.message || String(oneError);
          throw new Error(
            `Failed deleting ${collectionName || "docs"} (${ref.id}): ${code} ${message}. ` +
              "If this is permission-denied, deploy latest Firestore rules (firebase deploy --only firestore:rules)."
          );
        }
      }
    }
  }
  return deleted;
}

async function loadClientDocs(collectionName, clientId) {
  try {
    const snap = await getDocs(
      query(collection(db, collectionName), where("clientId", "==", clientId))
    );
    return snap.docs;
  } catch (error) {
    const code = error?.code || "";
    const message = error?.message || String(error);
    throw new Error(
      `Failed loading ${collectionName} for shop ${clientId}: ${code} ${message}`
    );
  }
}

export async function countShopRemaining(clientId, collections = []) {
  const id = String(clientId || "").trim();
  const list = collections.length
    ? collections
    : [...SHOP_TRANSACTION_COLLECTIONS, ...SHOP_MASTER_COLLECTIONS];
  const remaining = {};
  let total = 0;
  for (const collectionName of list) {
    const docs = await loadClientDocs(collectionName, id);
    remaining[collectionName] = docs.length;
    total += docs.length;
  }
  return { total, remaining };
}

/**
 * Delete transactional docs for a shop.
 * mode: "all" | "range"
 * fromDate/toDate: YYYY-MM-DD (inclusive) when mode === "range"
 */
export async function resetShopTransactions({
  clientId,
  mode = "all",
  fromDate = "",
  toDate = "",
  onProgress,
} = {}) {
  const id = String(clientId || "").trim();
  if (!id) throw new Error("Shop id is required.");

  const rangeMode = mode === "range";
  const from = String(fromDate || "").slice(0, 10);
  const to = String(toDate || from).slice(0, 10);
  if (rangeMode) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new Error("Select a valid from/to date.");
    }
    if (from > to) throw new Error("From date cannot be after To date.");
  }

  const summary = {};
  let total = 0;

  for (const collectionName of SHOP_TRANSACTION_COLLECTIONS) {
    onProgress?.(`Loading ${collectionName}…`);
    const docs = await loadClientDocs(collectionName, id);
    const refs = docs
      .filter((item) => {
        if (!rangeMode) return true;
        const date = documentBusinessDate(collectionName, item.data());
        return inDateRange(date, from, to);
      })
      .map((item) => item.ref);

    // sales_invoices may have items subcollection
    if (collectionName === "sales_invoices") {
      for (const invoiceRef of refs) {
        const itemsSnap = await getDocs(collection(invoiceRef, "items"));
        if (itemsSnap.size) {
          await deleteDocs(itemsSnap.docs.map((d) => d.ref));
        }
      }
    }

    onProgress?.(`Deleting ${refs.length} from ${collectionName}…`);
    const deleted = await deleteDocs(refs, collectionName);
    summary[collectionName] = deleted;
    total += deleted;
  }

  // Clear dailyClosings keys for range / all from client_settings
  try {
    const settingsRef = doc(db, "client_settings", id);
    const direct = await getDoc(settingsRef);
    if (direct.exists()) {
      const data = direct.data() || {};
      const closings = data.dailyClosings;
      if (closings && typeof closings === "object") {
        const patch = {};
        let cleared = 0;
        for (const key of Object.keys(closings)) {
          if (!rangeMode || inDateRange(key, from, to)) {
            patch[`dailyClosings.${key}`] = deleteField();
            cleared += 1;
          }
        }
        if (cleared) {
          await updateDoc(settingsRef, patch);
          summary.client_settings_dailyClosings = cleared;
        }
      }
    }
  } catch {
    // non-fatal — settings may not exist
  }

  // Also clear clients/{id}/dailySessions subcollection when in range/all
  try {
    const sessionsSnap = await getDocs(
      collection(db, "clients", id, "dailySessions")
    );
    const sessionRefs = sessionsSnap.docs
      .filter((item) => {
        if (!rangeMode) return true;
        const key = item.id.slice(0, 10);
        return inDateRange(key, from, to);
      })
      .map((item) => item.ref);
    if (sessionRefs.length) {
      summary.dailySessions = await deleteDocs(sessionRefs);
      total += summary.dailySessions;
    }
  } catch {
    // optional subcollection
  }

  onProgress?.("Verifying remaining transactional documents…");
  const leftover = rangeMode
    ? null
    : await countShopRemaining(id, SHOP_TRANSACTION_COLLECTIONS);

  return {
    total,
    summary,
    mode,
    fromDate: from,
    toDate: to,
    remainingTotal: leftover?.total ?? null,
    remaining: leftover?.remaining ?? null,
  };
}

/**
 * Master reset: transactional data (all) + master lists for the shop.
 * Does not delete the clients/{shopId} document itself.
 */
export async function resetShopMaster({ clientId, onProgress } = {}) {
  const id = String(clientId || "").trim();
  if (!id) throw new Error("Shop id is required.");

  const txnResult = await resetShopTransactions({
    clientId: id,
    mode: "all",
    onProgress,
  });

  const masterSummary = {};
  let masterTotal = 0;

  for (const collectionName of SHOP_MASTER_COLLECTIONS) {
    onProgress?.(`Loading masters ${collectionName}…`);
    const docs = await loadClientDocs(collectionName, id);

    if (collectionName === "inventory") {
      for (const itemRef of docs.map((d) => d.ref)) {
        try {
          const audits = await getDocs(collection(itemRef, "stock_audits"));
          if (audits.size) await deleteDocs(audits.docs.map((d) => d.ref));
        } catch {
          // ignore
        }
      }
    }

    onProgress?.(`Deleting ${docs.length} from ${collectionName}…`);
    const deleted = await deleteDocs(
      docs.map((d) => d.ref),
      collectionName
    );
    masterSummary[collectionName] = deleted;
    masterTotal += deleted;
  }

  onProgress?.("Verifying remaining documents…");
  const leftover = await countShopRemaining(id);

  return {
    total: txnResult.total + masterTotal,
    summary: { ...txnResult.summary, ...masterSummary },
    remainingTotal: leftover.total,
    remaining: leftover.remaining,
  };
}

export function shopResetConfirmPhrase(shopId) {
  return `RESET ${String(shopId || "").trim()}`;
}
