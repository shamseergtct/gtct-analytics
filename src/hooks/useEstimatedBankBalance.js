import { useEffect, useState } from "react";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import {
  calculateEodSnapshot,
  readPreviousBankBalancesByAccount,
} from "../utils/eodCalculations.js";
import { loadPriorBankBalancesByAccount } from "../utils/priorBankBalances.js";
import { formatMoney } from "../utils/money.js";

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function businessDateRange(value) {
  const start = new Date(`${value}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

export function isBankTenderMode(mode) {
  const key = String(mode || "").trim().toUpperCase();
  return (
    key === "CARD" ||
    key === "QR" ||
    key === "BANK" ||
    key === "BANK_TRANSFER" ||
    key.startsWith("BANK:")
  );
}

export function isCashTenderMode(mode) {
  const key = String(mode || "").toUpperCase().replaceAll(" ", "_");
  return (
    key === "CASH" ||
    key === "PETTY_CASH" ||
    key === "PETTI" ||
    key.startsWith("PETTI")
  );
}

/**
 * Hard gate for money-out entries. Returns an error message or null if allowed.
 * Loan receipts and other money-in entries should not call this.
 */
export function getInsufficientFundsError({
  mode,
  amount,
  cashBalance,
  bankBalance,
  reservedCash = 0,
  reservedBank = 0,
}) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  if (isCashTenderMode(mode)) {
    if (cashBalance === null) {
      return "Cash balance is still loading. Try again in a moment.";
    }
    const available = num(cashBalance) - num(reservedCash);
    if (available < parsed) {
      return `Insufficient cash (available ${formatMoney(available)}, need ${formatMoney(parsed)}). Record a Loan Receipt or Bank → Cash transfer first.`;
    }
  }

  if (isBankTenderMode(mode)) {
    if (bankBalance === null) {
      return "Bank balance is still loading. Try again in a moment.";
    }
    const available = num(bankBalance) - num(reservedBank);
    if (available < parsed) {
      return `Insufficient bank funds (available ${formatMoney(available)}, need ${formatMoney(parsed)}). Record a Loan Receipt or Cash → Bank transfer first.`;
    }
  }

  return null;
}

export function sumReservedSpend(entries = [], excludeId = "") {
  return entries.reduce(
    (totals, entry) => {
      if (excludeId && entry?.id === excludeId) return totals;
      const value = num(entry?.amount);
      if (isCashTenderMode(entry?.paymentMode || entry?.mode)) {
        totals.cash += value;
      }
      if (isBankTenderMode(entry?.paymentMode || entry?.mode)) {
        totals.bank += value;
      }
      return totals;
    },
    { cash: 0, bank: 0 }
  );
}

/**
 * Live cash + bank standing balances for a business date.
 *
 * Formula:
 *   last closed day closing balance
 *   + current open-day / open-shift activity
 *     (POS sales, Z-report cash/bank, payments, receipts, purchases, transfers, …)
 *
 * Opening float (`floatingCash`) stays previous-day cash only (locker-adjusted).
 */
function buildBankBalancesByAccount(snapshot) {
  const rows = Array.isArray(snapshot?.closingBankBalancesByAccount)
    ? snapshot.closingBankBalancesByAccount
    : [];
  return rows
    .filter((row) => row?.isActive !== false)
    .map((row) => ({
      bankAccountId: row.bankAccountId,
      bankAccountName: row.bankAccountName || row.bankAccountId,
      accountType: String(row?.accountType || "OPERATIONAL").toUpperCase(),
      amount: Number(row.amount) || 0,
    }));
}

function buildOperationalBankBalances(snapshot) {
  const all = buildBankBalancesByAccount(snapshot);
  const operational = all.filter((row) => row.accountType !== "RESERVE");

  // Fallback when no per-account split exists yet.
  if (
    operational.length === 0 &&
    snapshot?.closingOperationalBankBalance != null
  ) {
    const amount = Number(snapshot.closingOperationalBankBalance) || 0;
    if (amount !== 0 || all.length === 0) {
      operational.push({
        bankAccountId: "_operational_total",
        bankAccountName: "Bank (Operational)",
        accountType: "OPERATIONAL",
        amount,
      });
    }
  }

  return operational;
}

export function useEstimatedLiquidity(clientId, businessDate) {
  const [cashBalance, setCashBalance] = useState(null);
  const [bankBalance, setBankBalance] = useState(null);
  const [operationalBankBalance, setOperationalBankBalance] = useState(null);
  const [operationalBankBalances, setOperationalBankBalances] = useState([]);
  const [bankBalancesByAccount, setBankBalancesByAccount] = useState([]);
  const [reserveBankBalance, setReserveBankBalance] = useState(null);
  const [floatingCash, setFloatingCash] = useState(null);
  const [lockerBalance, setLockerBalance] = useState(null);
  const [previousCashInHand, setPreviousCashInHand] = useState(null);
  const [hasPreviousClosing, setHasPreviousClosing] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!clientId || !businessDate) {
      setCashBalance(null);
      setBankBalance(null);
      setOperationalBankBalance(null);
      setOperationalBankBalances([]);
      setBankBalancesByAccount([]);
      setReserveBankBalance(null);
      setFloatingCash(null);
      setLockerBalance(null);
      setPreviousCashInHand(null);
      setHasPreviousClosing(false);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    let previousReport = null;
    let dayTransactions = [];
    let dayZReports = [];
    let dayExternalBills = [];
    let dayCollections = [];
    let bankAccounts = [];
    let priorBankBalancesByAccount = null;
    let priorLoadToken = 0;

    queueMicrotask(() => {
      if (!cancelled) setLoading(true);
    });

    function republish() {
      if (cancelled) return;
      const snapshot = calculateEodSnapshot({
        selectedDate: businessDate,
        transactions: dayTransactions,
        shifts: [],
        zReports: dayZReports,
        previousReport,
        externalBills: dayExternalBills,
        deliveryBoyCollections: dayCollections,
        bankAccounts,
        priorBankBalancesByAccount,
      });
      setCashBalance(num(snapshot.closingCashInHand));
      setBankBalance(num(snapshot.closingBankBalance));
      setOperationalBankBalance(num(snapshot.closingOperationalBankBalance));
      setOperationalBankBalances(buildOperationalBankBalances(snapshot));
      setBankBalancesByAccount(buildBankBalancesByAccount(snapshot));
      setReserveBankBalance(num(snapshot.closingReserveBankBalance));
      setFloatingCash(num(snapshot.floatingCash));
      setLockerBalance(num(snapshot.closingLockerBalance));
      setPreviousCashInHand(num(snapshot.previousCashInHand));
      setHasPreviousClosing(Boolean(previousReport));
      setLoading(false);
    }

    async function ensurePriorBankBalances(report) {
      const stored = readPreviousBankBalancesByAccount(report);
      if (stored.size > 0) {
        priorBankBalancesByAccount = null;
        republish();
        return;
      }
      const token = ++priorLoadToken;
      try {
        const rebuilt = await loadPriorBankBalancesByAccount({
          clientId,
          beforeDate: businessDate,
          previousReport: report,
        });
        if (cancelled || token !== priorLoadToken) return;
        priorBankBalancesByAccount = rebuilt;
        republish();
      } catch {
        if (cancelled || token !== priorLoadToken) return;
        priorBankBalancesByAccount = null;
        republish();
      }
    }

    const { startMs, endMs } = businessDateRange(businessDate);

    const previousQuery = query(
      collection(db, "daily_reports"),
      where("clientId", "==", clientId),
      where("date", "<", businessDate),
      orderBy("date", "desc"),
      limit(1)
    );

    const dayTxnQuery = query(
      collection(db, "transactions"),
      where("clientId", "==", clientId),
      where("dateMs", ">=", startMs),
      where("dateMs", "<", endMs)
    );

    const dayZReportQuery = query(
      collection(db, "z_reports"),
      where("clientId", "==", clientId),
      where("businessDate", "==", businessDate)
    );

    const externalBillsQuery = query(
      collection(db, "external_sales_bills"),
      where("clientId", "==", clientId),
      where("businessDate", "==", businessDate)
    );

    const collectionsQuery = query(
      collection(db, "delivery_boy_collections"),
      where("clientId", "==", clientId),
      where("businessDate", "==", businessDate)
    );

    const bankAccountsQuery = query(
      collection(db, "bank_accounts"),
      where("clientId", "==", clientId)
    );

    const unsubPrevious = onSnapshot(
      previousQuery,
      (snapshot) => {
        const docSnap = snapshot.docs[0];
        previousReport = docSnap
          ? { id: docSnap.id, ...docSnap.data() }
          : null;
        ensurePriorBankBalances(previousReport);
      },
      () => {
        previousReport = null;
        priorBankBalancesByAccount = null;
        republish();
      }
    );

    const unsubTxns = onSnapshot(
      dayTxnQuery,
      (snapshot) => {
        dayTransactions = snapshot.docs.map((item) => ({
          id: item.id,
          ...item.data(),
        }));
        republish();
      },
      () => {
        dayTransactions = [];
        republish();
      }
    );

    const unsubZReports = onSnapshot(
      dayZReportQuery,
      (snapshot) => {
        dayZReports = snapshot.docs.map((item) => ({
          id: item.id,
          ...item.data(),
        }));
        republish();
      },
      () => {
        dayZReports = [];
        republish();
      }
    );

    const unsubExternal = onSnapshot(
      externalBillsQuery,
      (snapshot) => {
        dayExternalBills = snapshot.docs.map((item) => ({
          id: item.id,
          ...item.data(),
        }));
        republish();
      },
      () => {
        dayExternalBills = [];
        republish();
      }
    );

    const unsubCollections = onSnapshot(
      collectionsQuery,
      (snapshot) => {
        dayCollections = snapshot.docs.map((item) => ({
          id: item.id,
          ...item.data(),
        }));
        republish();
      },
      () => {
        dayCollections = [];
        republish();
      }
    );

    const unsubBanks = onSnapshot(
      bankAccountsQuery,
      (snapshot) => {
        bankAccounts = snapshot.docs.map((item) => ({
          id: item.id,
          ...item.data(),
        }));
        republish();
      },
      () => {
        bankAccounts = [];
        republish();
      }
    );

    return () => {
      cancelled = true;
      unsubPrevious();
      unsubTxns();
      unsubZReports();
      unsubExternal();
      unsubCollections();
      unsubBanks();
    };
  }, [clientId, businessDate]);

  if (!clientId || !businessDate) {
    return {
      cashBalance: null,
      bankBalance: null,
      operationalBankBalance: null,
      operationalBankBalances: [],
      bankBalancesByAccount: [],
      reserveBankBalance: null,
      floatingCash: null,
      lockerBalance: null,
      previousCashInHand: null,
      hasPreviousClosing: false,
      loading: false,
    };
  }

  return {
    cashBalance,
    bankBalance,
    operationalBankBalance,
    operationalBankBalances,
    bankBalancesByAccount,
    reserveBankBalance,
    floatingCash,
    lockerBalance,
    previousCashInHand,
    hasPreviousClosing,
    loading,
  };
}

/** @deprecated Prefer useEstimatedLiquidity */
export function useEstimatedBankBalance(clientId, businessDate) {
  const {
    bankBalance,
    cashBalance,
    floatingCash,
    lockerBalance,
    previousCashInHand,
    loading,
  } = useEstimatedLiquidity(clientId, businessDate);
  return {
    bankBalance,
    cashBalance,
    floatingCash,
    lockerBalance,
    previousCashInHand,
    loading,
  };
}
