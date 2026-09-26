import {
  normalizeTransactionMode,
  normalizeTransactionType,
} from "./transactionContract.js";

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function transactionDate(transaction) {
  if (transaction?.date?.toDate) return transaction.date.toDate();
  if (transaction?.date instanceof Date) return transaction.date;
  if (transaction?.dateMs) return new Date(num(transaction.dateMs));
  if (typeof transaction?.date === "string") {
    return new Date(`${transaction.date.slice(0, 10)}T12:00:00`);
  }
  return null;
}

function dateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function isIncluded(transaction) {
  const status = String(transaction?.status || "POSTED").toUpperCase();
  return !["DRAFT", "VOID", "CANCELLED"].includes(status);
}

function isInternal(transaction) {
  return (
    transaction?.internalTransfer === true ||
    normalizeTransactionType(transaction?.type) === "transfer"
  );
}

function categoryKey(transaction) {
  return String(transaction?.category || "").trim().toLowerCase();
}

export function isLoanTransaction(transaction) {
  const category = categoryKey(transaction);
  if (category.includes("loan")) return true;
  return String(transaction?.liabilityType || "").toUpperCase() === "LOAN";
}

function transferTypeKey(transaction) {
  return String(
    transaction?.transferType || transaction?.category || ""
  )
    .trim()
    .toUpperCase();
}

function partyKind(transaction) {
  return String(transaction?.partyType || "").trim().toLowerCase();
}

export function calculateEodSnapshot({
  transactions = [],
  shifts: _shifts = [],
  zReports = [],
  previousReport = null,
  selectedDate,
}) {
  const validTransactions = transactions.filter(isIncluded);
  const dayTransactions = validTransactions.filter(
    (transaction) => dateKey(transactionDate(transaction)) === selectedDate
  );
  const openTransactions = transactions.filter((transaction) => {
    if (dateKey(transactionDate(transaction)) !== selectedDate) return false;
    const status = String(transaction?.status || "POSTED").toUpperCase();
    return status === "DRAFT" || status === "OPEN";
  });
  // Include every Z-report for the selected date (shift open/closed no longer matters).
  const selectedZReports = zReports.filter(
    (report) => String(report?.businessDate || "") === selectedDate
  );
  const zReportShiftIds = new Set(
    selectedZReports
      .map((report) => String(report?.shiftId || ""))
      .filter(Boolean)
  );

  // Sales exclude internals and never include loans/transfers.
  const salesTransactions = dayTransactions.filter(
    (transaction) =>
      !isInternal(transaction) &&
      !isLoanTransaction(transaction) &&
      normalizeTransactionType(transaction?.type) === "sales"
  );
  const systemSales = salesTransactions.reduce(
    (total, transaction) => total + num(transaction.amountIn),
    0
  );
  const uncoveredSystemSales = salesTransactions
    .filter(
      (transaction) =>
        !zReportShiftIds.has(String(transaction?.shiftId || ""))
    )
    .reduce((total, transaction) => total + num(transaction.amountIn), 0);
  const zReportSales = selectedZReports.reduce((total, report) => {
    const grossSales =
      report?.grossSales === undefined || report?.grossSales === null
        ? num(report?.netSales) + num(report?.creditSalesTotal)
        : num(report.grossSales);
    return total + grossSales;
  }, 0);
  const totalSales = zReportSales + uncoveredSystemSales;

  // Expenses are operational purchase/expense only — never loans or transfers.
  const totalExpenses = dayTransactions
    .filter((transaction) => {
      if (isInternal(transaction) || isLoanTransaction(transaction)) {
        return false;
      }
      const type = normalizeTransactionType(transaction?.type);
      return type === "purchase" || type === "expense";
    })
    .reduce((total, transaction) => total + num(transaction.amountOut), 0);

  // All same-day cash activity: sales, receipts, payments, loans,
  // purchases/expenses, and cash-side transfers.
  // Locker transfers are excluded — they move previous/floating cash only.
  const drawerTransactions = dayTransactions.filter((transaction) => {
    const kind = transferTypeKey(transaction);
    if (kind === "CASH_TO_LOCKER" || kind === "LOCKER_TO_CASH") return false;
    return (
      normalizeTransactionMode(transaction?.mode || transaction?.paymentMode) ===
      "cash"
    );
  });
  const zReportCashSales = selectedZReports.reduce(
    (total, report) => total + num(report?.cashTotal),
    0
  );
  const totalCashIn =
    zReportCashSales +
    drawerTransactions
      .filter((transaction) => {
        const isSale =
          normalizeTransactionType(transaction?.type) === "sales";
        return (
          !isSale ||
          !zReportShiftIds.has(String(transaction?.shiftId || ""))
        );
      })
      .reduce((total, transaction) => total + num(transaction.amountIn), 0);
  const totalCashOut = drawerTransactions.reduce(
    (total, transaction) => total + num(transaction.amountOut),
    0
  );
  const previousCashInHand = num(
    previousReport?.closingCashInHand ?? previousReport?.actualCash
  );
  const todayNetCashDelta = totalCashIn - totalCashOut;

  let todayCashToLocker = 0;
  let todayLockerToCash = 0;
  dayTransactions
    .filter((transaction) => isInternal(transaction))
    .forEach((transaction) => {
      const kind = transferTypeKey(transaction);
      const amount =
        num(transaction.totalAmount) ||
        Math.max(num(transaction.amountIn), num(transaction.amountOut));
      if (kind === "CASH_TO_LOCKER") todayCashToLocker += amount;
      if (kind === "LOCKER_TO_CASH") todayLockerToCash += amount;
    });

  const previousLockerBalance = num(
    previousReport?.closingLockerBalance ?? previousReport?.lockerBalance
  );
  const closingLockerBalance =
    previousLockerBalance + todayCashToLocker - todayLockerToCash;
  // Previous balanced cash remaining after locker moves (matches Z-Report Opening Float).
  const floatingCash =
    previousCashInHand - todayCashToLocker + todayLockerToCash;

  // One opening float per shift from Z-reports (do not sum every historical
  // shift open on the same date — that double-counts the same drawer).
  const openingFloatByShift = new Map();
  selectedZReports.forEach((report) => {
    const key = String(report?.shiftId || report?.id || "");
    if (!key || openingFloatByShift.has(key)) return;
    openingFloatByShift.set(key, num(report.openingFloat));
  });
  const openingFloats = openingFloatByShift.size
    ? Array.from(openingFloatByShift.values()).reduce(
        (total, value) => total + value,
        0
      )
    : floatingCash;

  // Opening float is already locker-adjusted (same as Z-Report). Do not subtract
  // locker transfers again or expected cash drifts from the Z-Report hint.
  const expectedCash = openingFloats + totalCashIn - totalCashOut;
  const hasZReportCashCount = selectedZReports.length > 0;
  const actualCash = hasZReportCashCount
    ? selectedZReports.reduce(
        (total, report) => total + num(report.closingCashCounted),
        0
      )
    : null;
  const cashVariance = hasZReportCashCount ? actualCash - expectedCash : 0;
  const closingCashInHand =
    previousCashInHand + todayNetCashDelta - todayCashToLocker + todayLockerToCash;

  const zReportBank = selectedZReports.reduce((total, report) => {
    if (report?.bankTotal != null && report.bankTotal !== "") {
      return total + num(report.bankTotal);
    }
    return total + num(report?.cardTotal) + num(report?.qrTotal);
  }, 0);

  // Non-transfer bank tender activity (POS card/QR + Bank / Bank:<account> /
  // bank_transfer receipts, payments, loans, purchases, sales).
  const todayNetBankFromTenders = dayTransactions
    .filter((transaction) => {
      if (isInternal(transaction)) return false;
      const rawMode = String(
        transaction?.mode || transaction?.paymentMode || ""
      );
      const mode = normalizeTransactionMode(rawMode);
      const isBankFamily =
        mode === "card" ||
        mode === "qr" ||
        mode === "bank_transfer" ||
        /^bank/i.test(rawMode.trim());
      if (!isBankFamily) return false;
      const coveredPosTender =
        normalizeTransactionType(transaction?.type) === "sales" &&
        (mode === "card" || mode === "qr") &&
        zReportShiftIds.has(String(transaction?.shiftId || ""));
      return !coveredPosTender;
    })
    .reduce(
      (total, transaction) =>
        total + num(transaction.amountIn) - num(transaction.amountOut),
      0
    );

  // Internal cash↔bank transfers move bank balance without counting as sales/expenses.
  const todayNetBankFromTransfers = dayTransactions
    .filter((transaction) => isInternal(transaction))
    .reduce((total, transaction) => {
      const kind = transferTypeKey(transaction);
      const amount =
        num(transaction.totalAmount) ||
        Math.max(num(transaction.amountIn), num(transaction.amountOut));
      if (kind === "CASH_TO_BANK") return total + amount;
      if (kind === "BANK_TO_CASH") return total - amount;
      // BANK_TO_BANK stays inside aggregate bank balance.
      if (kind === "BANK_TO_BANK") return total;
      if (kind === "BANK_TO_PETTI") return total - amount;
      if (kind === "PETTI_TO_BANK") return total + amount;
      // Cash↔Petti / Cash↔Locker do not move bank.
      if (
        kind === "CASH_TO_PETTI" ||
        kind === "PETTI_TO_CASH" ||
        kind === "CASH_TO_LOCKER" ||
        kind === "LOCKER_TO_CASH"
      ) {
        return total;
      }

      const destination = normalizeTransactionMode(
        transaction?.destinationMode
      );
      const source = normalizeTransactionMode(transaction?.sourceMode);
      if (destination === "bank_transfer" || destination === "card" || destination === "qr") {
        return total + amount;
      }
      if (source === "bank_transfer" || source === "card" || source === "qr") {
        return total - amount;
      }
      return total;
    }, 0);

  const todayNetBankDelta =
    zReportBank + todayNetBankFromTenders + todayNetBankFromTransfers;
  const previousBankBalance = num(
    previousReport?.closingBankBalance ?? previousReport?.totalBank
  );
  const closingBankBalance = previousBankBalance + todayNetBankDelta;

  let todayNetReceivableDelta = 0;
  let todayNetPayableDelta = 0;
  dayTransactions.forEach((transaction) => {
    if (isInternal(transaction)) return;

    const type = normalizeTransactionType(transaction?.type);
    const mode = normalizeTransactionMode(
      transaction?.mode || transaction?.paymentMode
    );
    const kind = partyKind(transaction);

    // Loans received increase Payable; loan repayments reduce it.
    // They never count as sales/expenses (handled above) but must show in AR/AP.
    if (isLoanTransaction(transaction)) {
      if (type === "receipt") {
        todayNetPayableDelta += num(transaction.amountIn);
      } else if (type === "payment") {
        todayNetPayableDelta -= num(transaction.amountOut);
      }
      return;
    }

    if (type === "sales" && mode === "credit" && kind.includes("customer")) {
      todayNetReceivableDelta += num(transaction.amountIn);
    } else if (type === "receipt" && kind.includes("customer")) {
      todayNetReceivableDelta -= num(transaction.amountIn);
    }

    if (
      (type === "purchase" || type === "expense") &&
      mode === "credit" &&
      (kind.includes("supplier") || kind.includes("vendor"))
    ) {
      todayNetPayableDelta += num(transaction.amountOut);
    } else if (
      type === "payment" &&
      (kind.includes("supplier") || kind.includes("vendor"))
    ) {
      todayNetPayableDelta -= num(transaction.amountOut);
    }
  });

  const totalReceivable = Math.max(
    0,
    num(previousReport?.totalReceivable) + todayNetReceivableDelta
  );
  const totalPayable = Math.max(
    0,
    num(previousReport?.totalPayable) + todayNetPayableDelta
  );
  const revenueExpenseRatio =
    totalSales > 0
      ? (totalExpenses / totalSales) * 100
      : totalExpenses > 0
        ? 100
        : 0;

  return {
    date: selectedDate,
    totalSales,
    totalExpenses,
    expectedCash,
    actualCash,
    cashVariance,
    totalBank: closingBankBalance,
    previousCashInHand,
    previousBankBalance,
    previousLockerBalance,
    todayNetCashDelta,
    todayNetBankDelta,
    todayCashToLocker,
    todayLockerToCash,
    closingCashInHand,
    closingBankBalance,
    closingLockerBalance,
    floatingCash,
    totalReceivable,
    totalPayable,
    revenueExpenseRatio,
    openingFloats,
    totalCashIn,
    totalCashOut,
    zReportCount: selectedZReports.length,
    openTransactionCount: openTransactions.length,
    dayTransactionCount: dayTransactions.length,
    zReportSales,
    systemSales,
  };
}
