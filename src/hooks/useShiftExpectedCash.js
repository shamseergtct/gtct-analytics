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

function isCashMode(transaction) {
  return (
    normalizeTransactionMode(transaction?.mode || transaction?.paymentMode) ===
    "cash"
  );
}

function salesAmount(transaction) {
  const direct = num(transaction?.amountIn);
  if (direct !== 0) return direct;
  return num(transaction?.totalAmount) || num(transaction?.amount);
}

/**
 * Expected drawer cash for Z-report:
 *   Last closed day cash (opening float)
 *   + today's cash sales (POS and/or Z-report cash)
 *   + other cash in/out (receipts, payments, purchases, transfers)
 *   + loan net
 *
 * Form `cashTotal` replaces POS/Z cash for the current shift when declared,
 * so the hint matches what the cashier is entering.
 */
export function useShiftExpectedCash({
  clientId,
  businessDate,
  openingFloat,
  shiftId,
  cashTotal = 0,
  shiftOpeningFloat = null,
}) {
  const [dayTransactions, setDayTransactions] = useState([]);
  const [dayZReports, setDayZReports] = useState([]);
  const [previousReport, setPreviousReport] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!clientId || !businessDate) {
      setDayTransactions([]);
      setDayZReports([]);
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

    const dayZReportQuery = query(
      collection(db, "z_reports"),
      where("clientId", "==", clientId),
      where("businessDate", "==", businessDate)
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

    const unsubZReports = onSnapshot(
      dayZReportQuery,
      (snapshot) => {
        if (cancelled) return;
        setDayZReports(
          snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        );
        setLoading(false);
      },
      () => {
        if (cancelled) return;
        setDayZReports([]);
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
      unsubPrevious();
      unsubTxns();
      unsubZReports();
    };
  }, [clientId, businessDate]);

  return useMemo(() => {
    const shiftKey = String(shiftId || "");
    const declaredCashSales = num(cashTotal);
    const previousDayCash = num(
      previousReport?.closingCashInHand ?? previousReport?.actualCash
    );

    // Opening float = last closed day cash (passed in), with fallback to the
    // float stored on the open shift when no EOD closing exists yet.
    const openingFloatAmount = roundMoney(
      openingFloat != null && String(openingFloat).trim() !== ""
        ? num(openingFloat)
        : num(shiftOpeningFloat ?? previousDayCash)
    );

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
      zReports: dayZReports,
      previousReport,
    });

    const shiftsWithSystemCashSales = new Set(
      dayTransactions
        .filter(
          (transaction) =>
            normalizeTransactionType(transaction?.type) === "sales" &&
            !transaction?.internalTransfer &&
            isCashMode(transaction)
        )
        .map((transaction) => String(transaction?.shiftId || ""))
        .filter(Boolean)
    );

    let posCashSales = 0;
    let loanNet = 0;
    let otherNet = 0;

    dayTransactions.forEach((transaction) => {
      if (!isCashMode(transaction)) return;
      if (transaction?.internalTransfer === true) {
        // Cash↔bank / petti moves affect drawer; locker is in opening float.
        const kind = String(
          transaction?.transferType || transaction?.category || ""
        )
          .trim()
          .toUpperCase();
        if (kind === "CASH_TO_LOCKER" || kind === "LOCKER_TO_CASH") return;
      }

      const type = normalizeTransactionType(transaction?.type);
      const inAmt = num(transaction.amountIn);
      const outAmt = num(transaction.amountOut);
      const net = inAmt - outAmt;

      if (isLoanTransaction(transaction)) {
        loanNet += net;
        return;
      }

      if (type === "sales") {
        const txnShift = String(transaction?.shiftId || "");
        // Form cash total is the reconciliation figure for this shift.
        if (declaredCashSales > 0 && shiftKey && txnShift === shiftKey) {
          return;
        }
        posCashSales += salesAmount(transaction);
        return;
      }

      otherNet += net;
    });

    const savedZCash = dayZReports
      .filter((report) => {
        const reportShiftId = String(report?.shiftId || "");
        if (!reportShiftId) {
          return shiftsWithSystemCashSales.size === 0 && declaredCashSales <= 0;
        }
        // Current form cash replaces this shift's Z cash while entering.
        if (declaredCashSales > 0 && shiftKey && reportShiftId === shiftKey) {
          return false;
        }
        // POS cash for the shift already covers sales — Z is reconciliation only.
        if (shiftsWithSystemCashSales.has(reportShiftId)) return false;
        return true;
      })
      .reduce((total, report) => total + num(report?.cashTotal), 0);

    const todaySales = roundMoney(
      declaredCashSales + posCashSales + savedZCash
    );
    loanNet = roundMoney(loanNet);
    otherNet = roundMoney(otherNet);

    const expectedCash = roundMoney(
      openingFloatAmount + todaySales + loanNet + otherNet
    );

    return {
      loading,
      openingFloat: openingFloatAmount,
      previousBalance: openingFloatAmount,
      previousDayCash,
      todaySales,
      loanNet,
      otherNet,
      expectedCash,
      // EOD engine (same day) — useful cross-check.
      eodExpectedCash: roundMoney(
        openingFloatAmount +
          num(snapshot.totalCashIn) -
          num(snapshot.totalCashOut)
      ),
      standingCash: num(snapshot.closingCashInHand),
      standingBank: num(snapshot.closingBankBalance),
    };
  }, [
    businessDate,
    cashTotal,
    dayTransactions,
    dayZReports,
    loading,
    openingFloat,
    previousReport,
    shiftId,
    shiftOpeningFloat,
  ]);
}
