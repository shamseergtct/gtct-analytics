import {
  collection,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import {
  buildBankDeltasByAccount,
  readPreviousBankBalancesByAccount,
} from "./eodCalculations.js";

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dayStartMs(isoDate) {
  return new Date(`${isoDate}T00:00:00`).getTime();
}

/**
 * Reconstruct per-account bank openings from activity before `beforeDate`.
 * Uses transactions + external bills + collections (account-tagged sources).
 * Any gap vs official previous operational total is handled by calculateEodSnapshot.
 */
export function reconstructBankBalancesFromActivity({
  transactions = [],
  externalBills = [],
  deliveryBoyCollections = [],
}) {
  return buildBankDeltasByAccount({
    transactions,
    externalBills,
    deliveryBoyCollections,
    uncoveredZReportBank: 0,
  });
}

/**
 * Load activity before a business date and return a Map(accountId → amount).
 * Returns null when previous report already has closingBankBalancesByAccount.
 */
export async function loadPriorBankBalancesByAccount({
  clientId,
  beforeDate,
  previousReport = null,
}) {
  if (!clientId || !beforeDate) return new Map();

  const stored = readPreviousBankBalancesByAccount(previousReport);
  if (stored.size > 0) return stored;

  const cutoffMs = dayStartMs(beforeDate);
  if (!Number.isFinite(cutoffMs)) return new Map();

  const [txnSnap, billSnap, collectionSnap] = await Promise.all([
    getDocs(
      query(collection(db, "transactions"), where("clientId", "==", clientId))
    ),
    getDocs(
      query(
        collection(db, "external_sales_bills"),
        where("clientId", "==", clientId)
      )
    ),
    getDocs(
      query(
        collection(db, "delivery_boy_collections"),
        where("clientId", "==", clientId)
      )
    ),
  ]);

  const transactions = txnSnap.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter((row) => {
      const ms = num(row.dateMs);
      if (ms > 0) return ms < cutoffMs;
      const date = String(row.date || "").slice(0, 10);
      if (date) return date < beforeDate;
      if (row.date?.toDate) {
        return row.date.toDate().getTime() < cutoffMs;
      }
      return false;
    });

  const externalBills = billSnap.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter((bill) => String(bill?.businessDate || "").slice(0, 10) < beforeDate);

  const deliveryBoyCollections = collectionSnap.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter(
      (row) => String(row?.businessDate || "").slice(0, 10) < beforeDate
    );

  return reconstructBankBalancesFromActivity({
    transactions,
    externalBills,
    deliveryBoyCollections,
  });
}

/**
 * Opening amount for one bank account as of fromDate (day before range start).
 */
export function openingBankBalanceForAccount({
  openingReport,
  bankAccountId,
  reconstructedByAccount = null,
}) {
  const id = String(bankAccountId || "").trim();
  if (!id) return 0;

  const stored = readPreviousBankBalancesByAccount(openingReport);
  if (stored.has(id)) return num(stored.get(id));

  if (reconstructedByAccount instanceof Map && reconstructedByAccount.has(id)) {
    return num(reconstructedByAccount.get(id));
  }
  if (
    reconstructedByAccount &&
    typeof reconstructedByAccount === "object" &&
    !Array.isArray(reconstructedByAccount)
  ) {
    if (Object.prototype.hasOwnProperty.call(reconstructedByAccount, id)) {
      return num(reconstructedByAccount[id]);
    }
  }

  return 0;
}
