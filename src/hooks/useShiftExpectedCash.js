import { useEffect, useMemo, useState } from "react";
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
  isLoanTransaction,
} from "../utils/eodCalculations.js";
import {
  normalizeTransactionMode,
  normalizeTransactionType,
} from "../utils/transactionContract.js";

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

/**
 * Live expected drawer cash for shift close, with a simple breakdown:
 * Previous Balance (opening float) + Today's Sales (cash) + Loan (net) + Other.
 */
export function useShiftExpectedCash({
  clientId,
  businessDate,
  openingFloat,
  shiftId,
  cashTotal = 0,
}) {
  const [dayTransactions, setDayTransactions] = useState([]);
  const [previousReport, setPreviousReport] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!clientId || !businessDate) {
      setDayTransactions([]);
      setPreviousReport(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setLoading(true);
    });

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

    const unsubPrevious = onSnapshot(
      previousQuery,
      (snapshot) => {
        if (cancelled) return;
        const docSnap = snapshot.docs[0];
        setPreviousReport(
          docSnap ? { id: docSnap.id, ...docSnap.data() } : null
        );
        setLoading(false);
      },
      () => {
        if (cancelled) return;
        setPreviousReport(null);
        setLoading(false);
      }
    );

    const unsubTxns = onSnapshot(
      dayTxnQuery,
      (snapshot) => {
        if (cancelled) return;
        setDayTransactions(
          snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        );
        setLoading(false);
      },
      () => {
        if (cancelled) return;
        setDayTransactions([]);
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
      unsubPrevious();
      unsubTxns();
    };
  }, [clientId, businessDate]);

  return useMemo(() => {
    const openingFloatAmount = num(openingFloat);
    const declaredCashSales = num(cashTotal);
    const shiftKey = String(shiftId || "");

    const cashTxns = dayTransactions.filter(
      (transaction) =>
        normalizeTransactionMode(
          transaction?.mode || transaction?.paymentMode
        ) === "cash"
    );

    let todaySalesFromTxns = 0;
    let loanNet = 0;
    let otherNet = 0;

    cashTxns.forEach((transaction) => {
      const type = normalizeTransactionType(transaction?.type);
      const inAmt = num(transaction.amountIn);
      const outAmt = num(transaction.amountOut);
      const net = inAmt - outAmt;

      if (isLoanTransaction(transaction)) {
        loanNet += net;
        return;
      }

      if (type === "sales") {
        // When Cash Total is declared on the Z-report for this shift, those
        // POS sales are represented by cashTotal — skip matching shift sales.
        if (
          declaredCashSales > 0 &&
          shiftKey &&
          String(transaction?.shiftId || "") === shiftKey
        ) {
          return;
        }
        todaySalesFromTxns += inAmt;
        return;
      }

      otherNet += net;
    });

    const todaySales = declaredCashSales + todaySalesFromTxns;
    const expectedCash =
      openingFloatAmount + todaySales + loanNet + otherNet;

    const snapshot = calculateEodSnapshot({
      selectedDate: businessDate,
      transactions: dayTransactions,
      shifts: shiftId
        ? [
            {
              id: shiftId,
              businessDate,
              status: "OPEN",
              openingFloat: openingFloatAmount,
            },
          ]
        : [],
      zReports: [],
      previousReport,
    });

    return {
      loading,
      openingFloat: openingFloatAmount,
      previousBalance: openingFloatAmount,
      todaySales,
      loanNet,
      otherNet,
      expectedCash,
      // Standing cash after prior day (shown separately from opening float).
      previousDayCash: num(
        previousReport?.closingCashInHand ?? previousReport?.actualCash
      ),
      eodExpectedCash: num(snapshot.expectedCash),
    };
  }, [
    businessDate,
    cashTotal,
    dayTransactions,
    loading,
    openingFloat,
    previousReport,
    shiftId,
  ]);
}
