import {
  normalizeTransactionMode,
  normalizeTransactionType,
} from "./transactionContract.js";

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function salesAmount(transaction) {
  const direct = num(transaction?.amountIn);
  if (direct !== 0) return direct;
  return num(transaction?.totalAmount) || num(transaction?.amount);
}

function registeredBankTotal(zReport) {
  if (zReport?.bankTotal != null && zReport.bankTotal !== "") {
    return num(zReport.bankTotal);
  }
  return num(zReport?.cardTotal) + num(zReport?.qrTotal);
}

export function reconcileZReport(transactions = [], zReport = null) {
  if (!zReport) return null;

  const shiftId = String(zReport.shiftId || "").trim();
  const sales = transactions.filter(
    (transaction) =>
      normalizeTransactionType(transaction?.type) === "sales" &&
      transaction?.internalTransfer !== true &&
      (!shiftId || String(transaction?.shiftId || "").trim() === shiftId)
  );

  let systemGrossSales = 0;
  let systemNetSales = 0;
  let systemCashTotal = 0;
  let systemBankTotal = 0;
  let systemCreditSalesTotal = 0;

  for (const sale of sales) {
    const amount = salesAmount(sale);
    const mode = normalizeTransactionMode(sale?.mode || sale?.paymentMode);
    systemGrossSales += amount;
    if (mode === "credit") systemCreditSalesTotal += amount;
    else systemNetSales += amount;
    if (mode === "cash") systemCashTotal += amount;
    if (mode === "card" || mode === "qr" || mode === "bank_transfer") {
      systemBankTotal += amount;
    }
  }

  const registeredBank = registeredBankTotal(zReport);

  return {
    zReportId: zReport.id || "",
    reportNo: zReport.reportNo || "",
    terminalId: zReport.terminalId || "",
    businessDate: zReport.businessDate || "",
    registered: {
      grossSales: num(zReport.grossSales),
      netSales: num(zReport.netSales),
      cashTotal: num(zReport.cashTotal),
      bankTotal: registeredBank,
      creditSalesTotal: num(zReport.creditSalesTotal),
    },
    system: {
      grossSales: systemGrossSales,
      netSales: systemNetSales,
      cashTotal: systemCashTotal,
      bankTotal: systemBankTotal,
      creditSalesTotal: systemCreditSalesTotal,
    },
    variance: {
      grossSales: systemGrossSales - num(zReport.grossSales),
      netSales: systemNetSales - num(zReport.netSales),
      cashTotal: systemCashTotal - num(zReport.cashTotal),
      bankTotal: systemBankTotal - registeredBank,
      creditSalesTotal:
        systemCreditSalesTotal - num(zReport.creditSalesTotal),
    },
  };
}
