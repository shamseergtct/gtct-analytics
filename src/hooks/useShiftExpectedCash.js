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
import { summarizeExternalBillTenders } from "../utils/externalSales.js";
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
 * Expected drawer cash sales for the day:
 *   Z-report cash (terminal entry only, when declared)
 *   + live POS cash (when Z cash not declared for the shift)
 *   + External cash bills + delivery Collect cash
 *   + other shifts' uncovered Z cash
 *
 * Z cash is never assumed to already include External/Collect.
 */
export function resolveExpectedCashSales({
  declaredCash = 0,
  posCash = 0,
  externalCash = 0,
  collectionCash = 0,
  savedZCash = 0,
} = {}) {
  const declared = Math.max(0, num(declaredCash));
  const pos = Math.max(0, num(posCash));
  const external = Math.max(0, num(externalCash));
  const collected = Math.max(0, num(collectionCash));
  const appCash = roundMoney(external + collected);
  const savedZ = Math.max(0, num(savedZCash));
  const zOrPos = declared > 0 ? declared : pos;

  return {
    todaySales: roundMoney(zOrPos + appCash + savedZ),
    usedDeclared: declared > 0,
    includedExternal: appCash,
    includedPos: declared > 0 ? 0 : pos,
  };
}

/**
 * Expected drawer cash for Z-report:
 *   Last closed day cash (opening float)
 *   + today's cash sales (Z + live POS/External/Collect)
 *   + other cash in/out (receipts, payments, purchases, transfers)
 *   + loan net
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
  const [dayExternalBills, setDayExternalBills] = useState([]);
  const [dayCollections, setDayCollections] = useState([]);
  const [previousReport, setPreviousReport] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!clientId || !businessDate) {
      queueMicrotask(() => {
        if (cancelled) return;
        setDayTransactions([]);
        setDayZReports([]);
        setDayExternalBills([]);
        setDayCollections([]);
        setPreviousReport(null);
        setLoading(false);
      });
      return () => {
        cancelled = true;
      };
    }

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

    const dayExternalQuery = query(
      collection(db, "external_sales_bills"),
      where("clientId", "==", clientId),
      where("businessDate", "==", businessDate)
    );

    const dayCollectionQuery = query(
      collection(db, "delivery_boy_collections"),
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

    const unsubExternal = onSnapshot(
      dayExternalQuery,
      (snapshot) => {
        if (cancelled) return;
        setDayExternalBills(
          snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        );
        setLoading(false);
      },
      () => {
        if (cancelled) return;
        setDayExternalBills([]);
        setLoading(false);
      }
    );

    const unsubCollections = onSnapshot(
      dayCollectionQuery,
      (snapshot) => {
        if (cancelled) return;
        setDayCollections(
          snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        );
        setLoading(false);
      },
      () => {
        if (cancelled) return;
        setDayCollections([]);
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
      unsubPrevious();
      unsubTxns();
      unsubZReports();
      unsubExternal();
      unsubCollections();
    };
  }, [clientId, businessDate]);

  return useMemo(() => {
    const shiftKey = String(shiftId || "");
    const declaredCashSales = num(cashTotal);
    const previousDayCash = num(
      previousReport?.closingCashInHand ?? previousReport?.actualCash
    );
    const externalTenders = summarizeExternalBillTenders(dayExternalBills);
    const collectionCashTotal = dayCollections.reduce(
      (total, row) => total + Math.max(0, num(row?.paidCash)),
      0
    );

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
      externalBills: dayExternalBills,
      deliveryBoyCollections: dayCollections,
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
        if (declaredCashSales > 0 && shiftKey && reportShiftId === shiftKey) {
          return false;
        }
        if (shiftsWithSystemCashSales.has(reportShiftId)) return false;
        return true;
      })
      .reduce((total, report) => total + num(report?.cashTotal), 0);

    const resolved = resolveExpectedCashSales({
      declaredCash: declaredCashSales,
      posCash: posCashSales,
      externalCash: externalTenders.cashTotal,
      collectionCash: collectionCashTotal,
      savedZCash,
    });
    const todaySales = resolved.todaySales;
    loanNet = roundMoney(loanNet);
    const expenseNet = roundMoney(otherNet);

    const expectedCash = roundMoney(
      openingFloatAmount + todaySales + loanNet + expenseNet
    );

    return {
      loading,
      openingFloat: openingFloatAmount,
      previousBalance: openingFloatAmount,
      previousDayCash,
      todaySales,
      posCashSales: roundMoney(posCashSales),
      externalCashSales: roundMoney(externalTenders.cashTotal),
      collectionCash: roundMoney(collectionCashTotal),
      expenseNet,
      zCashEntered: roundMoney(declaredCashSales),
      loanNet,
      otherNet: expenseNet,
      expectedCash,
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
    dayCollections,
    dayExternalBills,
    dayTransactions,
    dayZReports,
    loading,
    openingFloat,
    previousReport,
    shiftId,
    shiftOpeningFloat,
  ]);
}
