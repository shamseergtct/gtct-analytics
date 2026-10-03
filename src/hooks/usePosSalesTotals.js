import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import {
  normalizeTransactionMode,
  normalizeTransactionType,
} from "../utils/transactionContract.js";
import { roundMoney } from "../utils/money.js";

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

function salesAmount(transaction) {
  const direct = num(transaction?.amountIn);
  if (direct !== 0) return direct;
  return num(transaction?.totalAmount) || num(transaction?.amount);
}

function isBankMode(rawMode) {
  const mode = normalizeTransactionMode(rawMode);
  return (
    mode === "card" ||
    mode === "qr" ||
    mode === "bank_transfer" ||
    /^bank/i.test(String(rawMode || "").trim())
  );
}

/**
 * Live Sales-module (POS) totals for a business date / optional shift.
 */
export function usePosSalesTotals({ clientId, businessDate, shiftId }) {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!clientId || !businessDate) {
      setTransactions([]);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setLoading(true);
    });

    const { startMs, endMs } = businessDateRange(businessDate);
    const dayTxnQuery = query(
      collection(db, "transactions"),
      where("clientId", "==", clientId),
      where("dateMs", ">=", startMs),
      where("dateMs", "<", endMs)
    );

    const unsub = onSnapshot(
      dayTxnQuery,
      (snapshot) => {
        if (cancelled) return;
        setTransactions(
          snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        );
        setLoading(false);
      },
      () => {
        if (cancelled) return;
        setTransactions([]);
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, [clientId, businessDate]);

  return useMemo(() => {
    const shiftKey = String(shiftId || "").trim();
    const sales = transactions.filter((transaction) => {
      if (normalizeTransactionType(transaction?.type) !== "sales") return false;
      if (transaction?.internalTransfer === true) return false;
      if (String(transaction?.status || "POSTED").toUpperCase() === "CANCELLED") {
        return false;
      }
      if (String(transaction?.status || "").toUpperCase() === "REVERSED") {
        return false;
      }
      if (String(transaction?.source || "").toLowerCase() === "pos_cancel") {
        return false;
      }
      if (
        shiftKey &&
        String(transaction?.shiftId || "").trim() &&
        String(transaction?.shiftId || "").trim() !== shiftKey
      ) {
        return false;
      }
      return true;
    });

    const items = sales
      .map((transaction) => {
        const amount = salesAmount(transaction);
        const rawMode = transaction?.mode || transaction?.paymentMode || "";
        const mode = normalizeTransactionMode(rawMode);
        let tender = "Other";
        if (mode === "cash") tender = "Cash";
        else if (mode === "credit") tender = "Credit";
        else if (isBankMode(rawMode)) tender = "Bank";

        return {
          id: transaction.id,
          invoiceNo:
            String(transaction?.invoiceNo || "").trim() ||
            String(transaction?.description || "")
              .replace(/^Sales invoice\s+/i, "")
              .trim() ||
            "—",
          partyName: (() => {
            const name = String(transaction?.partyName || "").trim();
            const key = name.toLowerCase();
            if (
              !name ||
              key === "cash" ||
              key === "bank" ||
              key === "credit" ||
              key === "walk-in" ||
              key === "walk-in customer"
            ) {
              return "Walk-in";
            }
            return name;
          })(),
          tender,
          amount,
          createdAtMs: num(transaction?.createdAtMs) || num(transaction?.dateMs),
        };
      })
      .sort((a, b) => b.createdAtMs - a.createdAtMs);

    let cashTotal = 0;
    let bankTotal = 0;
    let creditTotal = 0;
    let grossTotal = 0;

    items.forEach((item) => {
      grossTotal += item.amount;
      if (item.tender === "Cash") cashTotal += item.amount;
      else if (item.tender === "Credit") creditTotal += item.amount;
      else if (item.tender === "Bank") bankTotal += item.amount;
    });

    const invoiceKeys = new Set(
      items.map((item) => String(item.invoiceNo || item.id || "").trim())
    );

    return {
      loading,
      cashTotal: roundMoney(cashTotal),
      bankTotal: roundMoney(bankTotal),
      creditTotal: roundMoney(creditTotal),
      grossTotal: roundMoney(grossTotal),
      invoiceCount: invoiceKeys.size,
      items,
    };
  }, [loading, shiftId, transactions]);
}
