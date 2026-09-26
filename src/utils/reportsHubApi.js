import { fetchTxnRange, fetchPartyDueFromTransactions } from "./txnReportsApi.js";
import { fetchPartyLedger } from "./partyLedger.js";
import { formatIsoDate } from "./dateFormat.js";
import { isLoanTransaction } from "./eodCalculations.js";
import {
  collection,
  getDocs,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return num(value).toFixed(2);
}

function txnDateLabel(row) {
  const raw = row?.date;
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return formatIsoDate(raw.slice(0, 10)) || raw.slice(0, 10);
  }
  if (raw?.toDate) {
    const d = raw.toDate();
    return formatIsoDate(toIso(d)) || "";
  }
  if (row?.dateMs) {
    return formatIsoDate(toIso(new Date(num(row.dateMs)))) || "";
  }
  return "";
}

/** Firestore-style auto ids — never show these as Ref / Invoice. */
function isOpaqueDocId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9]{15,28}$/.test(text);
}

/**
 * Prefer a real reference / invoice number.
 * If none was entered, show "—" instead of document ids.
 */
function txnRefLabel(row) {
  const candidates = [
    row?.refNo,
    row?.invoiceNo,
    row?.invoiceNumber,
    row?.voucherNo,
    row?.receiptNo,
    row?.reportNo,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (text && !isOpaqueDocId(text)) return text.slice(0, 24);
  }
  const refId = String(row?.refId || "").trim();
  if (refId && !isOpaqueDocId(refId)) return refId.slice(0, 24);
  return "—";
}

function toIso(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

/**
 * Aggregate closed daily_reports in [fromDate, toDate] (string YYYY-MM-DD).
 */
export async function fetchQuickSnapshot({ clientId, fromDate, toDate }) {
  if (!clientId) throw new Error("Select an active shop first.");
  if (!fromDate || !toDate) throw new Error("Select a date range.");

  const reportsQuery = query(
    collection(db, "daily_reports"),
    where("clientId", "==", clientId),
    where("date", ">=", fromDate),
    where("date", "<=", toDate),
    orderBy("date", "desc")
  );
  const snap = await getDocs(reportsQuery);
  const reports = snap.docs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data(),
  }));

  const closed = reports.filter(
    (report) => String(report?.status || "").toLowerCase() === "closed"
  );
  const source = closed.length ? closed : reports;

  let totalSales = 0;
  let totalExpenses = 0;
  let netCashFlow = 0;

  source.forEach((report) => {
    totalSales += num(report.totalSales);
    totalExpenses += num(report.totalExpenses);
    netCashFlow += num(report.todayNetCashDelta);
  });

  // Latest report in range (desc) for standing balances.
  const latest = source[0] || null;

  return {
    reportCount: source.length,
    closedCount: closed.length,
    totalSales,
    totalExpenses,
    netCashFlow,
    cashInHand: num(latest?.closingCashInHand ?? latest?.actualCash),
    bankBalance: num(latest?.closingBankBalance ?? latest?.totalBank),
    lockerBalance: num(latest?.closingLockerBalance),
    totalReceivable: num(latest?.totalReceivable),
    totalPayable: num(latest?.totalPayable),
    latestDate: latest?.date || null,
    reports: source,
  };
}

function ledgerColumns() {
  return [
    { key: "date", label: "Date" },
    { key: "ref", label: "Ref / Invoice" },
    { key: "party", label: "Party" },
    { key: "description", label: "Description" },
    { key: "in", label: "In", align: "right" },
    { key: "out", label: "Out", align: "right" },
    { key: "balance", label: "Balance", align: "right" },
  ];
}

function partyLedgerColumns() {
  return [
    { key: "date", label: "Date" },
    { key: "ref", label: "Ref / Invoice" },
    { key: "party", label: "Party" },
    { key: "description", label: "Description" },
    { key: "debit", label: "Debit", align: "right" },
    { key: "credit", label: "Credit", align: "right" },
    { key: "balance", label: "Balance", align: "right" },
  ];
}

function loanLedgerColumns() {
  return [
    { key: "date", label: "Date" },
    { key: "ref", label: "Ref" },
    { key: "party", label: "Party / Lender" },
    { key: "description", label: "Description" },
    { key: "in", label: "Acquired", align: "right" },
    { key: "out", label: "Repaid", align: "right" },
    { key: "balance", label: "Outstanding", align: "right" },
  ];
}

function dayBeforeIso(yyyyMmDd) {
  const match = String(yyyyMmDd || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
    0,
    0
  );
  date.setDate(date.getDate() - 1);
  return toIso(date);
}

function loanMatchesParty(row, partyId, partyName) {
  const wantId = String(partyId || "").trim();
  const wantName = String(partyName || "")
    .trim()
    .toLowerCase();
  if (!wantId && !wantName) return true;
  // Synthetic picker ids (name:…) only match by party name.
  const realPartyId = wantId.startsWith("name:") ? "" : wantId;
  if (realPartyId && String(row?.partyId || "").trim() === realPartyId) {
    return true;
  }
  if (
    wantName &&
    String(row?.partyName || "")
      .trim()
      .toLowerCase() === wantName
  ) {
    return true;
  }
  return false;
}

function loanMovement(row) {
  const type = String(row?.type || "")
    .trim()
    .toLowerCase();
  if (type === "receipt" || type === "income") {
    const amount = num(row.amountIn) || num(row.totalAmount) || num(row.amountOut);
    return { acquired: amount > 0 ? amount : 0, repaid: 0 };
  }
  if (type === "payment") {
    const amount = num(row.amountOut) || num(row.totalAmount) || num(row.amountIn);
    return { acquired: 0, repaid: amount > 0 ? amount : 0 };
  }
  return { acquired: 0, repaid: 0 };
}

/** Incurred P&L outflow — includes credit purchases (amount may live in amountIn). */
function pnlOutflowAmount(row) {
  const total = num(row?.totalAmount);
  const amountIn = num(row?.amountIn);
  const amountOut = num(row?.amountOut);
  const mode = String(row?.mode || row?.paymentMode || "")
    .trim()
    .toLowerCase();
  if (mode === "credit" || mode.startsWith("cre")) {
    return total || amountOut || amountIn;
  }
  return total || amountOut || amountIn;
}

function titleCaseCategory(value) {
  const raw = String(value || "Uncategorized").trim();
  if (!raw) return "Uncategorized";
  return raw
    .toLowerCase()
    .split(/[\s_]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function businessDateSortMs(yyyyMmDd) {
  const match = String(yyyyMmDd || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return 0;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
    0,
    0
  ).getTime();
}

/**
 * Combine income + expense entries, sort oldest→newest by date then createdAt,
 * then compute rolling balance.
 */
function buildRollingBalanceRows(entries) {
  const sorted = [...entries].sort((a, b) => {
    const dateDiff = num(a._sortDateMs) - num(b._sortDateMs);
    if (dateDiff !== 0) return dateDiff;
    const createdDiff = num(a._sortCreatedAtMs) - num(b._sortCreatedAtMs);
    if (createdDiff !== 0) return createdDiff;
    return String(a.ref || "").localeCompare(String(b.ref || ""));
  });
  let balance = 0;
  return sorted.map((entry) => {
    const amountIn = num(entry._in);
    const amountOut = num(entry._out);
    balance += amountIn - amountOut;
    return {
      id: entry.id,
      date: entry.date,
      ref: entry.ref,
      party: entry.party,
      description: entry.description,
      in: amountIn ? money(amountIn) : "",
      out: amountOut ? money(amountOut) : "",
      balance: money(balance),
    };
  });
}

async function fetchZReportsInRange(clientId, fromDate, toDate) {
  const zQuery = query(
    collection(db, "z_reports"),
    where("clientId", "==", clientId),
    where("businessDate", ">=", fromDate),
    where("businessDate", "<=", toDate),
    orderBy("businessDate", "asc")
  );
  const snap = await getDocs(zQuery);
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

export async function fetchDetailedLedger({
  clientId,
  fromDate,
  toDate,
  reportType,
  partyId = "",
  partyName = "",
}) {
  if (!clientId) throw new Error("Select an active shop first.");
  if (!fromDate || !toDate) throw new Error("Select a date range.");

  const columns = ledgerColumns();

  if (reportType === "pnl") {
    const [zReports, purchaseRows, expenseRows] = await Promise.all([
      fetchZReportsInRange(clientId, fromDate, toDate),
      fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: "purchase",
      }),
      fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: "expense",
      }),
    ]);

    const totalRevenue = zReports.reduce(
      (sum, report) => sum + num(report.netSales),
      0
    );

    const categoryTotals = new Map();
    [...purchaseRows, ...expenseRows].forEach((row) => {
      const amount = pnlOutflowAmount(row);
      if (amount <= 0) return;
      const raw = String(row.category || "Uncategorized").trim() || "Uncategorized";
      const key = raw.toUpperCase();
      categoryTotals.set(key, (categoryTotals.get(key) || 0) + amount);
    });

    const expenseCategories = Array.from(categoryTotals.entries())
      .map(([category, amount]) => ({
        category,
        label: titleCaseCategory(category),
        amount,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const totalExpenses = expenseCategories.reduce(
      (sum, row) => sum + num(row.amount),
      0
    );
    const netProfit = totalRevenue - totalExpenses;

    // Flat rows for CSV/PDF export compatibility.
    const exportRows = [
      {
        id: "revenue",
        section: "Revenue",
        label: "Sales Revenue",
        amount: money(totalRevenue),
      },
      ...expenseCategories.map((row) => ({
        id: `exp-${row.category}`,
        section: "Operating Expenses",
        label: row.label,
        amount: money(row.amount),
      })),
      {
        id: "total-expenses",
        section: "Operating Expenses",
        label: "Total Expenses",
        amount: money(totalExpenses),
      },
      {
        id: "net-profit",
        section: "Net Profit",
        label: "Net Profit",
        amount: money(netProfit),
      },
    ];

    return {
      title: "Profit & Loss Statement",
      layout: "pnl",
      columns: [
        { key: "section", label: "Section" },
        { key: "label", label: "Line Item" },
        { key: "amount", label: "Amount", align: "right" },
      ],
      rows: exportRows,
      pnl: {
        totalRevenue,
        totalExpenses,
        netProfit,
        expenseCategories,
        zReportCount: zReports.length,
      },
    };
  }

  if (reportType === "ledger") {
    const [
      zReports,
      purchaseRows,
      expenseRows,
      incomeRows,
      receiptRows,
      paymentRows,
    ] = await Promise.all([
      fetchZReportsInRange(clientId, fromDate, toDate),
      fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: "purchase",
      }),
      fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: "expense",
      }),
      fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: "income",
      }),
      fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: "receipt",
      }),
      fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: "payment",
      }),
    ]);

    function mapTxnEntry(row, { inflow = 0, outflow = 0, fallbackDescription }) {
      if (inflow <= 0 && outflow <= 0) return null;
      const businessDate =
        typeof row.date === "string"
          ? row.date.slice(0, 10)
          : row.date?.toDate
            ? toIso(row.date.toDate())
            : row.dateMs
              ? toIso(new Date(num(row.dateMs)))
              : "";
      const createdAtMs =
        num(row.createdAtMs) ||
        (row.createdAt?.toMillis?.() ?? 0) ||
        num(row.dateMs) ||
        (row.date?.toMillis?.() ?? 0);
      const loan = isLoanTransaction(row);
      const category = String(row.category || "").trim();
      let description = String(
        row.description || category || fallbackDescription || row.type || "—"
      );
      if (loan && !String(row.description || "").trim()) {
        description =
          inflow > 0 ? "Loan acquired" : "Loan repayment";
      } else if (loan && category) {
        description = `${description}`.toLowerCase().includes("loan")
          ? description
          : `${description} (Loan)`;
      }
      return {
        id: row.id,
        date: txnDateLabel(row) || formatIsoDate(businessDate) || businessDate,
        ref: txnRefLabel(row),
        party: String(row.partyName || "—"),
        description,
        _in: inflow,
        _out: outflow,
        _sortDateMs:
          businessDateSortMs(businessDate) ||
          num(row.dateMs) ||
          (row.date?.toMillis?.() ?? 0),
        _sortCreatedAtMs: createdAtMs,
      };
    }

    // Revenue: Z-Report Net Sales (skip empty / zero net sales rows).
    const revenueEntries = zReports
      .map((report) => {
        const netSales = num(report.netSales);
        if (!Number.isFinite(netSales) || netSales === 0) return null;
        const businessDate = String(report.businessDate || "").slice(0, 10);
        return {
          id: `z-rev-${report.id}`,
          date: formatIsoDate(businessDate) || businessDate,
          ref: String(report.reportNo || "").trim() || "—",
          party: "Daily Sales",
          description: "Z-Report Revenue",
          _in: netSales,
          _out: 0,
          _sortDateMs: businessDateSortMs(businessDate),
          _sortCreatedAtMs: num(report.createdAtMs),
        };
      })
      .filter(Boolean);

    // Outflows: all purchases/expenses regardless of payment mode (credit included).
    const outflowEntries = [...purchaseRows, ...expenseRows]
      .map((row) =>
        mapTxnEntry(row, {
          outflow: pnlOutflowAmount(row),
          fallbackDescription: "Purchase/Expense",
        })
      )
      .filter(Boolean);

    // Legacy income postings (non-receipt).
    const otherIncomeEntries = incomeRows
      .map((row) =>
        mapTxnEntry(row, {
          inflow:
            num(row.totalAmount) || num(row.amountIn) || num(row.amountOut),
          fallbackDescription: "Other income",
        })
      )
      .filter(Boolean);

    // Receipts: customer settlements, advances, loans acquired, etc.
    const receiptEntries = receiptRows
      .map((row) =>
        mapTxnEntry(row, {
          inflow:
            num(row.amountIn) || num(row.totalAmount) || num(row.amountOut),
          fallbackDescription: "Receipt",
        })
      )
      .filter(Boolean);

    // Payments: vendor settlements, loan repayments, etc.
    const paymentEntries = paymentRows
      .map((row) =>
        mapTxnEntry(row, {
          outflow:
            num(row.amountOut) || num(row.totalAmount) || num(row.amountIn),
          fallbackDescription: "Payment",
        })
      )
      .filter(Boolean);

    // Combine first, then sort chronologically, then rolling balance.
    const combinedEntries = [
      ...revenueEntries,
      ...otherIncomeEntries,
      ...receiptEntries,
      ...outflowEntries,
      ...paymentEntries,
    ];
    const tableRows = buildRollingBalanceRows(combinedEntries);

    const totalIn = combinedEntries.reduce(
      (sum, row) => sum + num(row._in),
      0
    );
    const totalOut = combinedEntries.reduce(
      (sum, row) => sum + num(row._out),
      0
    );

    return {
      title: "Transaction Ledger",
      columns,
      rows: tableRows,
      summary: {
        sales: money(totalIn),
        expenses: money(totalOut),
      },
    };
  }

  if (reportType === "expense") {
    const rows = await fetchTxnRange({
      clientId,
      fromDate,
      toDate,
      typeKey: "expense",
    });
    const purchases = await fetchTxnRange({
      clientId,
      fromDate,
      toDate,
      typeKey: "purchase",
    });
    const combined = [...rows, ...purchases].sort(
      (a, b) => num(a.dateMs) - num(b.dateMs)
    );
    let balance = 0;
    const tableRows = combined.map((row) => {
      const amountOut = pnlOutflowAmount(row);
      const nextBalance = balance - amountOut;
      const mapped = {
        id: row.id,
        date: txnDateLabel(row),
        ref: txnRefLabel(row),
        party: String(row.partyName || "—"),
        description: String(
          row.description || row.category || row.type || "—"
        ),
        in: "",
        out: amountOut ? money(amountOut) : "",
        balance: money(nextBalance),
      };
      balance = nextBalance;
      return mapped;
    });
    return {
      title: "Expense Breakdown",
      columns,
      rows: tableRows,
      summary: {
        totalOut: money(
          combined.reduce((s, r) => s + pnlOutflowAmount(r), 0)
        ),
      },
    };
  }

  if (reportType === "customers" || reportType === "vendors") {
    const isCustomer = reportType === "customers";
    if (!String(partyId || "").trim() && !String(partyName || "").trim()) {
      return {
        title: isCustomer ? "Customer Ledgers" : "Vendor Ledgers",
        layout: "party_ledger",
        requiresParty: true,
        columns: partyLedgerColumns(),
        rows: [],
        summary: { outstanding: money(0) },
      };
    }

    const txns = await fetchPartyLedger({
      clientId,
      partyId,
      partyName,
      fromYYYYMMDD: fromDate,
      toYYYYMMDD: toDate,
    });

    const entries = [];
    txns.forEach((row) => {
      const type = String(row?.type || "").trim().toLowerCase();
      const mode = String(row?.mode || row?.paymentMode || "")
        .trim()
        .toLowerCase();
      const businessDate =
        typeof row.date === "string"
          ? row.date.slice(0, 10)
          : row.date?.toDate
            ? toIso(row.date.toDate())
            : row.dateMs
              ? toIso(new Date(num(row.dateMs)))
              : "";
      const createdAtMs =
        num(row.createdAtMs) ||
        (row.createdAt?.toMillis?.() ?? 0) ||
        num(row.dateMs) ||
        (row.date?.toMillis?.() ?? 0);
      const base = {
        id: row.id,
        date: txnDateLabel(row) || formatIsoDate(businessDate) || businessDate,
        ref: txnRefLabel(row),
        party: String(row.partyName || partyName || "—"),
        description: String(
          row.description || row.category || row.type || "—"
        ),
        _sortDateMs:
          businessDateSortMs(businessDate) ||
          num(row.dateMs) ||
          (row.date?.toMillis?.() ?? 0),
        _sortCreatedAtMs: createdAtMs,
      };

      if (isCustomer) {
        if (type === "sales" && (mode === "credit" || mode.startsWith("cre"))) {
          const amount =
            num(row.totalAmount) || num(row.amountIn) || num(row.amountOut);
          if (amount > 0) {
            entries.push({ ...base, _debit: amount, _credit: 0 });
          }
        } else if (type === "receipt" && !isLoanTransaction(row)) {
          const amount =
            num(row.amountIn) || num(row.totalAmount) || num(row.amountOut);
          if (amount > 0) {
            entries.push({ ...base, _debit: 0, _credit: amount });
          }
        }
      } else if (type === "purchase" && (mode === "credit" || mode.startsWith("cre"))) {
        const amount = pnlOutflowAmount(row);
        if (amount > 0) {
          entries.push({ ...base, _debit: 0, _credit: amount });
        }
      } else if (type === "payment" && !isLoanTransaction(row)) {
        const amount =
          num(row.amountOut) || num(row.totalAmount) || num(row.amountIn);
        if (amount > 0) {
          entries.push({ ...base, _debit: amount, _credit: 0 });
        }
      }
    });

    const sorted = [...entries].sort((a, b) => {
      const dateDiff = num(a._sortDateMs) - num(b._sortDateMs);
      if (dateDiff !== 0) return dateDiff;
      return num(a._sortCreatedAtMs) - num(b._sortCreatedAtMs);
    });

    let balance = 0;
    const tableRows = sorted.map((entry) => {
      const debit = num(entry._debit);
      const credit = num(entry._credit);
      // Customer AR: debits increase; Vendor AP: credits increase.
      balance += isCustomer ? debit - credit : credit - debit;
      return {
        id: entry.id,
        date: entry.date,
        ref: entry.ref,
        party: entry.party,
        description: entry.description,
        debit: debit ? money(debit) : "",
        credit: credit ? money(credit) : "",
        balance: money(balance),
      };
    });

    return {
      title: isCustomer ? "Customer Ledgers" : "Vendor Ledgers",
      layout: "party_ledger",
      requiresParty: true,
      columns: partyLedgerColumns(),
      rows: tableRows,
      summary: {
        outstanding: money(balance),
        partyName: partyName || "—",
      },
    };
  }

  if (reportType === "cashflow") {
    const [zReports, allTxns] = await Promise.all([
      fetchZReportsInRange(clientId, fromDate, toDate),
      fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: "",
      }),
    ]);

    let cashSales = 0;
    let bankSales = 0;
    zReports.forEach((report) => {
      cashSales += num(report.cashTotal);
      bankSales +=
        report.bankTotal != null && report.bankTotal !== ""
          ? num(report.bankTotal)
          : num(report.cardTotal) + num(report.qrTotal);
    });

    let receipts = 0;
    let payments = 0;
    let loansIn = 0;
    let loansOut = 0;
    let cashExpenses = 0;
    let bankExpenses = 0;
    let bankToCash = 0;
    let cashToBank = 0;
    let cashToLocker = 0;
    let lockerToCash = 0;

    allTxns.forEach((row) => {
      const type = String(row?.type || "").trim().toLowerCase();
      const mode = String(row?.mode || row?.paymentMode || "")
        .trim()
        .toLowerCase();
      const transferType = String(
        row?.transferType || row?.category || ""
      )
        .trim()
        .toUpperCase();
      const isTransfer =
        row?.internalTransfer === true || type === "transfer";
      const amount =
        num(row.totalAmount) ||
        Math.max(num(row.amountIn), num(row.amountOut));
      const isLoan =
        String(row?.category || "")
          .toLowerCase()
          .includes("loan") ||
        String(row?.liabilityType || "").toUpperCase() === "LOAN";

      if (isTransfer) {
        if (transferType === "BANK_TO_CASH") bankToCash += amount;
        if (transferType === "CASH_TO_BANK") cashToBank += amount;
        if (transferType === "CASH_TO_LOCKER") cashToLocker += amount;
        if (transferType === "LOCKER_TO_CASH") lockerToCash += amount;
        return;
      }

      if (isLoan) {
        if (type === "receipt" || type === "income") {
          loansIn += num(row.amountIn) || amount;
        } else if (type === "payment") {
          loansOut += num(row.amountOut) || amount;
        }
        return;
      }

      if (type === "receipt") {
        receipts += num(row.amountIn) || amount;
        return;
      }
      if (type === "payment") {
        payments += num(row.amountOut) || amount;
        return;
      }

      // Settled (non-credit) purchases/expenses move cash or bank.
      if (
        (type === "purchase" || type === "expense") &&
        mode !== "credit" &&
        !mode.startsWith("cre")
      ) {
        const outflow = pnlOutflowAmount(row);
        if (mode === "cash" || mode.startsWith("cas")) {
          cashExpenses += outflow;
        } else if (
          mode === "card" ||
          mode === "qr" ||
          mode === "bank_transfer" ||
          mode.startsWith("ban") ||
          mode.startsWith("bank")
        ) {
          bankExpenses += outflow;
        } else {
          cashExpenses += outflow;
        }
      }
    });

    const totalCashIn =
      cashSales + receipts + loansIn + bankToCash + lockerToCash;
    const totalCashOut =
      cashExpenses + payments + loansOut + cashToBank + cashToLocker;
    // Payments/receipts may be bank-mode too; attribute loosely:
    // Keep bank movement from sales, bank expenses, and cash↔bank transfers.
    const totalBankIn = bankSales + cashToBank;
    const totalBankOut = bankExpenses + bankToCash;
    const netCashChange = totalCashIn - totalCashOut;
    const netBankChange = totalBankIn - totalBankOut;
    const netLiquidityChange = netCashChange + netBankChange;

    const sections = [
      {
        key: "inflows",
        title: "Cash & Bank Inflows",
        lines: [
          { label: "Cash Sales (Z-Report)", amount: cashSales },
          { label: "Bank Sales (Z-Report)", amount: bankSales },
          { label: "Receipts", amount: receipts },
          { label: "Loans Received", amount: loansIn },
          { label: "Bank → Cash Transfers", amount: bankToCash },
          { label: "Locker → Cash Transfers", amount: lockerToCash },
        ],
        totalLabel: "Total Inflows",
        total: totalCashIn + bankSales,
      },
      {
        key: "outflows",
        title: "Cash & Bank Outflows",
        lines: [
          { label: "Cash Purchases & Expenses", amount: cashExpenses },
          { label: "Bank Purchases & Expenses", amount: bankExpenses },
          { label: "Payments", amount: payments },
          { label: "Loan Repayments", amount: loansOut },
          { label: "Cash → Bank Transfers", amount: cashToBank },
          { label: "Cash → Locker Transfers", amount: cashToLocker },
        ],
        totalLabel: "Total Outflows",
        total:
          cashExpenses +
          bankExpenses +
          payments +
          loansOut +
          cashToBank +
          cashToLocker,
      },
      {
        key: "net",
        title: "Net Liquidity Change",
        lines: [
          { label: "Net Change in Cash", amount: netCashChange },
          { label: "Net Change in Bank", amount: netBankChange },
        ],
        totalLabel: "Net Liquidity Change",
        total: netLiquidityChange,
      },
    ];

    const exportRows = sections.flatMap((section) => [
      ...section.lines.map((line) => ({
        id: `${section.key}-${line.label}`,
        section: section.title,
        label: line.label,
        amount: money(line.amount),
      })),
      {
        id: `${section.key}-total`,
        section: section.title,
        label: section.totalLabel,
        amount: money(section.total),
      },
    ]);

    return {
      title: "Cash Flow Statement",
      layout: "cashflow",
      columns: [
        { key: "section", label: "Section" },
        { key: "label", label: "Line Item" },
        { key: "amount", label: "Amount", align: "right" },
      ],
      rows: exportRows,
      cashflow: {
        sections,
        netCashChange,
        netBankChange,
        netLiquidityChange,
      },
    };
  }

  if (reportType === "receivables" || reportType === "payables") {
    const isReceivable = reportType === "receivables";
    const kind = isReceivable ? "receivable" : "payable";
    const partyKind = isReceivable ? "customers" : "vendors";

    const [parties, dues] = await Promise.all([
      fetchPartiesForLedger({ clientId, kind: partyKind }),
      fetchPartyDueFromTransactions({
        clientId,
        toDate,
        kind,
      }),
    ]);

    const partyById = new Map(parties.map((party) => [party.id, party]));
    // Also index by normalized name for legacy rows missing partyId matches.
    const partyByName = new Map(
      parties.map((party) => [
        String(party.name || "")
          .trim()
          .toLowerCase(),
        party,
      ])
    );

    const rows = dues
      .map((due) => {
        const party =
          partyById.get(String(due.partyId || "")) ||
          partyByName.get(String(due.partyName || "").trim().toLowerCase()) ||
          null;
        // Prefer matching typed parties; still show due if party type is unknown.
        if (party) {
          const type = String(party.type || "").trim().toLowerCase();
          if (isReceivable) {
            if (!(type === "customer" || type === "both" || type === "credit_customer")) {
              return null;
            }
          } else if (
            !(
              type === "supplier" ||
              type === "vendor" ||
              type === "both"
            )
          ) {
            return null;
          }
        }
        const amount = num(due.amount);
        if (amount === 0) return null;
        return {
          id: due.partyId || due.partyName,
          partyName: party?.name || due.partyName || "—",
          contact: String(party?.contact || party?.phone || "—"),
          balance: money(amount),
          _balance: amount,
        };
      })
      .filter(Boolean)
      .sort((a, b) => num(b._balance) - num(a._balance));

    const grandTotal = rows.reduce((sum, row) => sum + num(row._balance), 0);
    const tableRows = [
      ...rows.map(({ id, partyName, contact, balance }) => ({
        id,
        partyName,
        contact,
        balance,
      })),
      ...(rows.length
        ? [
            {
              id: "__grand_total__",
              partyName: "Grand Total",
              contact: "",
              balance: money(grandTotal),
              _isTotal: true,
            },
          ]
        : []),
    ];

    return {
      title: isReceivable ? "Receivables List" : "Payables List",
      layout: "due_list",
      asOfDate: toDate,
      columns: [
        { key: "partyName", label: "Party Name" },
        { key: "contact", label: "Contact / Phone" },
        { key: "balance", label: "Outstanding Balance", align: "right" },
      ],
      rows: tableRows,
      summary: {
        count: String(rows.length),
        grandTotal: money(grandTotal),
      },
    };
  }

  if (reportType === "z_audit") {
    const reports = await fetchZReportsInRange(clientId, fromDate, toDate);
    const tableRows = reports.map((report) => {
      const cash = num(report.cashTotal);
      const bank =
        report.bankTotal != null
          ? num(report.bankTotal)
          : num(report.cardTotal) + num(report.qrTotal);
      const credit = num(report.creditSalesTotal);
      const gross =
        report.grossSales != null
          ? num(report.grossSales)
          : num(report.netSales) + credit;
      return {
        id: report.id,
        date: formatIsoDate(report.businessDate) || report.businessDate,
        ref: String(report.reportNo || "").trim() || "—",
        party: String(report.terminalId || "—"),
        description: `Gross ${money(gross)} · Cash ${money(cash)} · Bank ${money(bank)} · Credit ${money(credit)}`,
        in: money(gross),
        out: "",
        balance: money(num(report.closingCashCounted)),
      };
    });
    return {
      title: "Z-Report Audit",
      columns: [
        { key: "date", label: "Date" },
        { key: "ref", label: "Z-Report No" },
        { key: "party", label: "Terminal" },
        { key: "description", label: "Breakdown" },
        { key: "in", label: "Gross", align: "right" },
        { key: "out", label: "", align: "right" },
        { key: "balance", label: "Closing Cash", align: "right" },
      ],
      rows: tableRows,
      summary: {
        count: String(reports.length),
        gross: money(reports.reduce((s, r) => s + num(r.grossSales ?? r.netSales), 0)),
      },
    };
  }

  if (reportType === "loans") {
    const priorTo = dayBeforeIso(fromDate);
    const [rangeTxns, priorTxns] = await Promise.all([
      fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: "",
      }),
      priorTo
        ? fetchTxnRange({
            clientId,
            fromDate: "2020-01-01",
            toDate: priorTo,
            typeKey: "",
          })
        : Promise.resolve([]),
    ]);

    let openingOutstanding = 0;
    priorTxns.forEach((row) => {
      if (!isLoanTransaction(row)) return;
      if (!loanMatchesParty(row, partyId, partyName)) return;
      const { acquired, repaid } = loanMovement(row);
      openingOutstanding += acquired - repaid;
    });

    const entries = [];
    let acquiredRange = 0;
    let repaidRange = 0;

    rangeTxns.forEach((row) => {
      if (!isLoanTransaction(row)) return;
      if (!loanMatchesParty(row, partyId, partyName)) return;
      const { acquired, repaid } = loanMovement(row);
      if (acquired <= 0 && repaid <= 0) return;

      acquiredRange += acquired;
      repaidRange += repaid;

      const businessDate =
        typeof row.date === "string"
          ? row.date.slice(0, 10)
          : row.date?.toDate
            ? toIso(row.date.toDate())
            : row.dateMs
              ? toIso(new Date(num(row.dateMs)))
              : "";
      const createdAtMs =
        num(row.createdAtMs) ||
        (row.createdAt?.toMillis?.() ?? 0) ||
        num(row.dateMs) ||
        (row.date?.toMillis?.() ?? 0);

      entries.push({
        id: row.id,
        date: txnDateLabel(row) || formatIsoDate(businessDate) || businessDate,
        ref: txnRefLabel(row),
        party: String(row.partyName || partyName || "—"),
        description: String(
          row.description ||
            (acquired > 0 ? "Loan acquired" : "Loan repayment")
        ),
        _in: acquired,
        _out: repaid,
        _sortDateMs:
          businessDateSortMs(businessDate) ||
          num(row.dateMs) ||
          (row.date?.toMillis?.() ?? 0),
        _sortCreatedAtMs: createdAtMs,
      });
    });

    const sorted = [...entries].sort((a, b) => {
      const dateDiff = num(a._sortDateMs) - num(b._sortDateMs);
      if (dateDiff !== 0) return dateDiff;
      return num(a._sortCreatedAtMs) - num(b._sortCreatedAtMs);
    });

    let balance = openingOutstanding;
    const tableRows = [];
    if (openingOutstanding !== 0 || sorted.length) {
      tableRows.push({
        id: "__opening__",
        date: formatIsoDate(fromDate) || fromDate,
        ref: "—",
        party: partyName || "—",
        description: "Opening outstanding",
        in: "",
        out: "",
        balance: money(openingOutstanding),
        _isTotal: true,
      });
    }

    sorted.forEach((entry) => {
      balance += num(entry._in) - num(entry._out);
      tableRows.push({
        id: entry.id,
        date: entry.date,
        ref: entry.ref,
        party: entry.party,
        description: entry.description,
        in: entry._in ? money(entry._in) : "",
        out: entry._out ? money(entry._out) : "",
        balance: money(balance),
      });
    });

    const filteredTitle = partyName
      ? `Loan Report — ${partyName}`
      : "Loan Report";

    return {
      title: filteredTitle,
      layout: "loan_ledger",
      columns: loanLedgerColumns(),
      rows: tableRows,
      summary: {
        opening: money(openingOutstanding),
        acquired: money(acquiredRange),
        repaid: money(repaidRange),
        outstanding: money(balance),
        partyName: partyName || "",
      },
    };
  }

  throw new Error("Unknown report type.");
}

export async function fetchPartiesForLedger({ clientId, kind }) {
  if (!clientId) return [];
  const partiesQuery = query(
    collection(db, "parties"),
    where("clientId", "==", clientId),
    orderBy("name", "asc")
  );
  const snap = await getDocs(partiesQuery);
  const all = snap.docs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data(),
  }));
  const want = String(kind || "").toLowerCase();

  if (want === "loans") {
    const today = toIso(new Date()) || "2099-12-31";
    const txns = await fetchTxnRange({
      clientId,
      fromDate: "2020-01-01",
      toDate: today,
      typeKey: "",
    });

    const loanPartyIds = new Set();
    const nameByPartyId = new Map();
    const loanNames = new Map(); // lowerName -> displayName
    txns.forEach((row) => {
      if (!isLoanTransaction(row)) return;
      const pid = String(row.partyId || "").trim();
      const pname = String(row.partyName || "").trim();
      if (pid) {
        loanPartyIds.add(pid);
        if (pname && !nameByPartyId.has(pid)) nameByPartyId.set(pid, pname);
      }
      if (pname) loanNames.set(pname.toLowerCase(), pname);
    });

    const matched = all.filter((party) => {
      const id = String(party.id || "").trim();
      const nameKey = String(party.name || "")
        .trim()
        .toLowerCase();
      return loanPartyIds.has(id) || (nameKey && loanNames.has(nameKey));
    });

    const matchedIds = new Set(matched.map((party) => party.id));
    const matchedNames = new Set(
      matched.map((party) =>
        String(party.name || "")
          .trim()
          .toLowerCase()
      )
    );

    loanPartyIds.forEach((id) => {
      if (matchedIds.has(id)) return;
      const name = nameByPartyId.get(id) || id;
      matched.push({
        id,
        name,
        type: "loan",
        contact: "",
      });
      matchedIds.add(id);
      matchedNames.add(String(name).toLowerCase());
    });

    loanNames.forEach((name, nameKey) => {
      if (matchedNames.has(nameKey)) return;
      matched.push({
        id: `name:${nameKey}`,
        name,
        type: "loan",
        contact: "",
      });
      matchedNames.add(nameKey);
    });

    return matched.sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""))
    );
  }

  return all.filter((party) => {
    const type = String(party?.type || "").trim().toLowerCase();
    if (want === "customers") {
      return type === "customer" || type === "both";
    }
    if (want === "vendors") {
      return (
        type === "supplier" ||
        type === "vendor" ||
        type === "both"
      );
    }
    return true;
  });
}

export { money as formatMoney };
