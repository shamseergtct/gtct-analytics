import { fetchTxnRange, fetchPartyDueFromTransactions } from "./txnReportsApi.js";
import { fetchPartyLedger } from "./partyLedger.js";
import { formatIsoDate } from "./dateFormat.js";
import { isLoanTransaction } from "./eodCalculations.js";
import { FULL_PERIOD_START } from "./reportDateRange.js";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { formatMoney } from "./money.js";
import {
  summarizeDeliveryBoyCollections,
  summarizeExternalBillTenders,
} from "./externalSales.js";

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return formatMoney(value);
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
function buildRollingBalanceRows(entries, openingBalance = 0) {
  const sorted = [...entries].sort((a, b) => {
    const dateDiff = num(a._sortDateMs) - num(b._sortDateMs);
    if (dateDiff !== 0) return dateDiff;
    const createdDiff = num(a._sortCreatedAtMs) - num(b._sortCreatedAtMs);
    if (createdDiff !== 0) return createdDiff;
    return String(a.ref || "").localeCompare(String(b.ref || ""));
  });
  let balance = num(openingBalance);
  return sorted.map((entry) => {
    const amountIn = num(entry._in);
    const amountOut = num(entry._out);
    balance += amountIn - amountOut;
    return {
      id: entry.id,
      date: entry.date,
      ref: entry.ref,
      party: entry.party,
      account: entry.account || "",
      type: entry.type || "",
      description: entry.description,
      in: amountIn ? money(amountIn) : "",
      out: amountOut ? money(amountOut) : "",
      balance: money(balance),
      _in: amountIn,
      _out: amountOut,
      _balance: balance,
      _accountId: entry._accountId || "",
      _movement: entry._movement || "",
      _direction: entry._direction || "",
    };
  });
}

function transferTypeOf(row) {
  return String(row?.transferType || row?.category || "")
    .trim()
    .toUpperCase();
}

function isTransferRow(row) {
  return (
    row?.internalTransfer === true ||
    String(row?.type || "")
      .trim()
      .toLowerCase() === "transfer"
  );
}

function isCashTender(row) {
  const mode = String(row?.mode || row?.paymentMode || "")
    .trim()
    .toLowerCase();
  return mode === "cash" || mode.startsWith("cas");
}

function isBankTender(row) {
  const mode = String(row?.mode || row?.paymentMode || "")
    .trim()
    .toLowerCase();
  return (
    mode === "card" ||
    mode === "qr" ||
    mode === "bank_transfer" ||
    mode.startsWith("ban") ||
    /^bank/.test(mode)
  );
}

function isCreditTender(row) {
  const mode = String(row?.mode || row?.paymentMode || "")
    .trim()
    .toLowerCase();
  return mode === "credit" || mode.startsWith("cre");
}

function txnAmount(row) {
  return (
    num(row?.totalAmount) ||
    Math.max(num(row?.amountIn), num(row?.amountOut))
  );
}

function liquidityEntryBase(row, overrides = {}) {
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
  return {
    id: row.id,
    date: txnDateLabel(row) || formatIsoDate(businessDate) || businessDate,
    ref: txnRefLabel(row),
    party: String(row.partyName || "—"),
    account: "",
    type: "",
    description: String(row.description || row.category || row.type || "—"),
    _in: 0,
    _out: 0,
    _sortDateMs:
      businessDateSortMs(businessDate) ||
      num(row.dateMs) ||
      (row.date?.toMillis?.() ?? 0),
    _sortCreatedAtMs: createdAtMs,
    _accountId: String(row.bankAccountId || ""),
    _movement: "",
    _direction: "",
    ...overrides,
  };
}

async function fetchOpeningDailyReport(clientId, fromDate) {
  const before = dayBeforeIso(fromDate);
  if (!before) return null;
  const reportsQuery = query(
    collection(db, "daily_reports"),
    where("clientId", "==", clientId),
    where("date", "<=", before),
    orderBy("date", "desc"),
    limit(1)
  );
  const snap = await getDocs(reportsQuery);
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function fetchExternalBillsInRange(clientId, fromDate, toDate) {
  // Equality-only query avoids optional composite indexes; filter range in JS.
  const billsQuery = query(
    collection(db, "external_sales_bills"),
    where("clientId", "==", clientId)
  );
  const snap = await getDocs(billsQuery);
  return snap.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter((bill) => {
      const date = String(bill?.businessDate || "").slice(0, 10);
      return date >= fromDate && date <= toDate;
    });
}

async function fetchCollectionsInRange(clientId, fromDate, toDate) {
  const collectionsQuery = query(
    collection(db, "delivery_boy_collections"),
    where("clientId", "==", clientId)
  );
  const snap = await getDocs(collectionsQuery);
  return snap.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter((row) => {
      const date = String(row?.businessDate || "").slice(0, 10);
      return date >= fromDate && date <= toDate;
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

function txnBusinessDate(row) {
  if (typeof row?.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(row.date)) {
    return row.date.slice(0, 10);
  }
  if (row?.date?.toDate) return toIso(row.date.toDate());
  if (row?.dateMs) return toIso(new Date(num(row.dateMs)));
  return "";
}

function salesTxnAmount(row) {
  const direct = num(row?.amountIn);
  if (direct !== 0) return direct;
  return num(row?.totalAmount) || num(row?.amount);
}

function salesTenderLabel(row) {
  const mode = String(row?.mode || row?.paymentMode || "")
    .trim()
    .toLowerCase();
  if (mode.startsWith("cre")) return "Credit";
  if (mode.startsWith("cas") || mode.includes("petti") || mode.includes("petty")) {
    return "Cash";
  }
  if (
    mode.startsWith("ban") ||
    mode.startsWith("car") ||
    mode.startsWith("qr") ||
    mode.startsWith("upi")
  ) {
    const account = String(row?.bankAccountName || "").trim();
    return account ? `Bank (${account})` : "Bank";
  }
  return mode ? mode.replace(/_/g, " ") : "Other";
}

/** True when partyName is a payment tender placeholder, not a real customer. */
function isTenderPartyName(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ");
  if (!key) return true;
  if (
    key === "cash" ||
    key === "bank" ||
    key === "credit" ||
    key === "card" ||
    key === "qr" ||
    key === "upi" ||
    key === "bank transfer" ||
    key === "petti" ||
    key === "petty" ||
    key === "petti cash" ||
    key === "petty cash" ||
    key === "walk-in" ||
    key === "walk-in customer" ||
    key === "walkin" ||
    key.startsWith("bank:")
  ) {
    return true;
  }
  return false;
}

/**
 * Prefer a real customer name. Ignore tender placeholders like Cash / bank
 * that were historically stored as partyName on walk-in POS sales.
 */
function salesCustomerLabel(row, invoice = null) {
  const fromInvoice = String(invoice?.customerName || "").trim();
  if (fromInvoice && !isTenderPartyName(fromInvoice)) return fromInvoice;

  const fromTxn = String(row?.partyName || "").trim();
  if (fromTxn && !isTenderPartyName(fromTxn)) return fromTxn;

  return "Walk-in";
}

async function fetchSalesInvoicesByClient(clientId) {
  const snap = await getDocs(
    query(collection(db, "sales_invoices"), where("clientId", "==", clientId))
  );
  const byId = new Map();
  snap.docs.forEach((docSnap) => {
    byId.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
  });
  return byId;
}

function zReportGrossSales(report) {
  if (report?.grossSales != null && report.grossSales !== "") {
    return num(report.grossSales);
  }
  return num(report?.netSales) + num(report?.creditSalesTotal);
}

function zReportBankAmount(report) {
  if (report?.bankTotal != null && report.bankTotal !== "") {
    return num(report.bankTotal);
  }
  return num(report?.cardTotal) + num(report?.qrTotal);
}

/**
 * External bill tenders as Sales-report style rows (Cash / Bank / Credit).
 * Delivery-boy account bills count as credit-like day sales.
 */
function buildExternalSalesEntries(bills = []) {
  const byDate = new Map();
  for (const bill of bills) {
    if (bill?.voided === true) continue;
    const date = String(bill?.businessDate || "").slice(0, 10);
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(bill);
  }

  const entries = [];
  for (const [businessDate, dayBills] of byDate) {
    const tenders = summarizeExternalBillTenders(dayBills);
    const push = ({ tender, amount, idSuffix, party }) => {
      if (amount <= 0) return;
      entries.push({
        id: `ext-${idSuffix}-${businessDate}`,
        date: formatIsoDate(businessDate) || businessDate,
        ref: "—",
        party,
        description: tender,
        _in: amount,
        _out: 0,
        _sortDateMs: businessDateSortMs(businessDate),
        _sortCreatedAtMs: 0,
      });
    };
    push({
      tender: "Cash",
      amount: num(tenders.cashTotal),
      idSuffix: "cash",
      party: "External Sales",
    });
    push({
      tender: "Bank",
      amount: num(tenders.bankTotal),
      idSuffix: "bank",
      party: "External Sales",
    });
    push({
      tender: "Credit",
      amount: num(tenders.creditTotal),
      idSuffix: "credit",
      party: "External Sales",
    });
    push({
      tender: "Credit",
      amount: num(tenders.deliveryAccountTotal),
      idSuffix: "delivery",
      party: "Delivery Boy Account",
    });
  }
  return entries;
}

/**
 * Sales-module (POS) revenue first; Z-report gross only for dates with no POS sales.
 */
function combinePosAndZReportRevenue(salesRows = [], zReports = []) {
  const posByDate = new Map();
  let posTotal = 0;
  salesRows.forEach((row) => {
    if (isLoanTransaction(row) || row?.internalTransfer === true) return;
    const amount = salesTxnAmount(row);
    if (amount <= 0) return;
    const date = txnBusinessDate(row);
    if (!date) return;
    posByDate.set(date, (posByDate.get(date) || 0) + amount);
    posTotal += amount;
  });

  let zFallback = 0;
  zReports.forEach((report) => {
    const date = String(report?.businessDate || "").slice(0, 10);
    if (!date || posByDate.has(date)) return;
    zFallback += zReportGrossSales(report);
  });

  return {
    totalRevenue: posTotal + zFallback,
    posTotal,
    zFallback,
    datesWithPosSales: posByDate,
  };
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
    const [
      zReports,
      purchaseRows,
      expenseRows,
      salesRows,
      externalBills,
      collections,
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
        typeKey: "sales",
      }),
      fetchExternalBillsInRange(clientId, fromDate, toDate),
      fetchCollectionsInRange(clientId, fromDate, toDate),
    ]);

    const { posTotal, zFallback, datesWithPosSales } =
      combinePosAndZReportRevenue(salesRows, zReports);

    // External shop tenders + delivery-account bills (Collect is settlement, not new sale).
    const externalTenders = summarizeExternalBillTenders(externalBills);
    const externalRevenue =
      num(externalTenders.cashTotal) +
      num(externalTenders.bankTotal) +
      num(externalTenders.creditTotal) +
      num(externalTenders.deliveryAccountTotal);
    // Z entry is additive with External. When POS exists on a date, Z is gap-fill only.
    const zRevenue = zFallback;
    const totalRevenue = posTotal + externalRevenue + zRevenue;

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

    const revenueLines = [
      { key: "pos", label: "Sales module (POS)", amount: posTotal },
      { key: "external", label: "External sales", amount: externalRevenue },
      { key: "z", label: "Z-report sales", amount: zRevenue },
    ].filter((line) => line.amount > 0);

    // Flat rows for CSV/PDF export compatibility.
    const exportRows = [
      ...(revenueLines.length
        ? revenueLines.map((line) => ({
            id: `rev-${line.key}`,
            section: "Revenue",
            label: line.label,
            amount: money(line.amount),
          }))
        : [
            {
              id: "revenue",
              section: "Revenue",
              label: "Sales Revenue",
              amount: money(0),
            },
          ]),
      {
        id: "total-revenue",
        section: "Revenue",
        label: "Total Revenue",
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
        revenueLines,
        posRevenue: posTotal,
        externalRevenue,
        zRevenue,
        collectionCount: collections.length,
        datesWithPosSales: datesWithPosSales.size,
        zReportCount: zReports.length,
      },
    };
  }

  if (reportType === "sales") {
    const [salesRows, zReports, invoiceById, externalBills] = await Promise.all([
      fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: "sales",
      }),
      fetchZReportsInRange(clientId, fromDate, toDate),
      fetchSalesInvoicesByClient(clientId),
      fetchExternalBillsInRange(clientId, fromDate, toDate),
    ]);

    const { datesWithPosSales } = combinePosAndZReportRevenue(
      salesRows,
      zReports
    );

    const entries = [];
    let cashTotal = 0;
    let bankTotal = 0;
    let creditTotal = 0;

    salesRows.forEach((row) => {
      if (isLoanTransaction(row) || row?.internalTransfer === true) return;
      const status = String(row?.status || "POSTED").toUpperCase();
      if (status === "CANCELLED" || status === "REVERSED") return;
      if (String(row?.source || "").toLowerCase() === "pos_cancel") return;

      const amount = salesTxnAmount(row);
      if (amount === 0) return;

      const tender = salesTenderLabel(row);
      if (tender === "Credit") creditTotal += amount;
      else if (tender.startsWith("Bank")) bankTotal += amount;
      else if (tender === "Cash") cashTotal += amount;

      const businessDate = txnBusinessDate(row);
      const createdAtMs =
        num(row.createdAtMs) ||
        (row.createdAt?.toMillis?.() ?? 0) ||
        num(row.dateMs) ||
        (row.date?.toMillis?.() ?? 0);
      const invoice =
        invoiceById.get(String(row.refId || "").trim()) ||
        null;

      entries.push({
        id: row.id,
        date: txnDateLabel(row) || formatIsoDate(businessDate) || businessDate,
        ref: txnRefLabel(row),
        party: salesCustomerLabel(row, invoice),
        description: tender,
        _in: amount,
        _out: 0,
        _sortDateMs:
          businessDateSortMs(businessDate) ||
          num(row.dateMs) ||
          (row.date?.toMillis?.() ?? 0),
        _sortCreatedAtMs: createdAtMs,
      });
    });

    // External bills are always additive with POS / Z.
    buildExternalSalesEntries(externalBills).forEach((entry) => {
      const tender = String(entry.description || "");
      if (tender === "Credit") creditTotal += entry._in;
      else if (tender.startsWith("Bank")) bankTotal += entry._in;
      else if (tender === "Cash") cashTotal += entry._in;
      entries.push(entry);
    });

    zReports.forEach((report) => {
      const businessDate = String(report.businessDate || "").slice(0, 10);
      if (!businessDate || datesWithPosSales.has(businessDate)) return;
      const cash = num(report.cashTotal);
      const bank = zReportBankAmount(report);
      const credit = num(report.creditSalesTotal);
      const gross = zReportGrossSales(report);
      if (gross <= 0 && cash + bank + credit <= 0) return;
      cashTotal += cash;
      bankTotal += bank;
      creditTotal += credit;
      const pushZ = (tender, amount, suffix) => {
        if (amount <= 0) return;
        entries.push({
          id: `z-sales-${suffix}-${report.id}`,
          date: formatIsoDate(businessDate) || businessDate,
          ref: String(report.reportNo || "").trim() || "Z-Report",
          party: "Z-Report",
          description: tender,
          _in: amount,
          _out: 0,
          _sortDateMs: businessDateSortMs(businessDate),
          _sortCreatedAtMs: num(report.createdAtMs),
        });
      };
      pushZ("Cash", cash, "cash");
      pushZ("Bank", bank, "bank");
      pushZ("Credit", credit, "credit");
    });

    entries.sort((a, b) => {
      if (a._sortDateMs !== b._sortDateMs) return a._sortDateMs - b._sortDateMs;
      return a._sortCreatedAtMs - b._sortCreatedAtMs;
    });

    let running = 0;
    const tableRows = entries.map((entry) => {
      running += entry._in - entry._out;
      return {
        id: entry.id,
        date: entry.date,
        ref: entry.ref,
        party: entry.party,
        description: entry.description,
        in: entry._in ? money(entry._in) : "",
        out: "",
        balance: money(running),
      };
    });

    return {
      title: "Sales Report",
      layout: "ledger",
      columns: [
        { key: "date", label: "Date" },
        { key: "ref", label: "Ref / Invoice" },
        { key: "party", label: "Party" },
        { key: "description", label: "Payment" },
        { key: "in", label: "Amount", align: "right" },
        { key: "out", label: "", align: "right" },
        { key: "balance", label: "Balance", align: "right" },
      ],
      rows: tableRows,
      summary: {
        sales: money(running),
        cash: money(cashTotal),
        bank: money(bankTotal),
        credit: money(creditTotal),
        count: String(tableRows.length),
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
      salesRows,
      externalBills,
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
      fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: "sales",
      }),
      fetchExternalBillsInRange(clientId, fromDate, toDate),
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

    // Revenue: Sales-module (POS) invoices first; Z-report net only for dates
    // that have no POS sales (avoids double-counting).
    const { datesWithPosSales } = combinePosAndZReportRevenue(
      salesRows,
      zReports
    );
    const posRevenueEntries = salesRows
      .map((row) => {
        if (isLoanTransaction(row) || row?.internalTransfer === true) return null;
        const mapped = mapTxnEntry(row, {
          inflow: salesTxnAmount(row),
          fallbackDescription: "POS Sale",
        });
        if (!mapped) return null;
        return {
          ...mapped,
          party: salesCustomerLabel(row),
        };
      })
      .filter(Boolean);
    const externalRevenueEntries = buildExternalSalesEntries(externalBills).map(
      (entry) => ({
        ...entry,
        description:
          entry.party === "Delivery Boy Account"
            ? "External delivery account sale"
            : `External ${String(entry.description || "sale").toLowerCase()} sale`,
      })
    );
    const zRevenueEntries = zReports
      .map((report) => {
        const businessDate = String(report.businessDate || "").slice(0, 10);
        if (!businessDate || datesWithPosSales.has(businessDate)) return null;
        const gross = zReportGrossSales(report);
        if (!Number.isFinite(gross) || gross <= 0) return null;
        return {
          id: `z-rev-${report.id}`,
          date: formatIsoDate(businessDate) || businessDate,
          ref: String(report.reportNo || "").trim() || "—",
          party: "Daily Sales",
          description: "Z-Report Revenue",
          _in: gross,
          _out: 0,
          _sortDateMs: businessDateSortMs(businessDate),
          _sortCreatedAtMs: num(report.createdAtMs),
        };
      })
      .filter(Boolean);
    const revenueEntries = [
      ...posRevenueEntries,
      ...externalRevenueEntries,
      ...zRevenueEntries,
    ];

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
    const [expenseRows, purchaseRows] = await Promise.all([
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
        typeKey: "purchase",
      }),
    ]);

    const combined = [...expenseRows, ...purchaseRows];
    const entries = [];
    let cashTotal = 0;
    let bankTotal = 0;
    let creditTotal = 0;

    combined.forEach((row) => {
      if (isLoanTransaction(row) || row?.internalTransfer === true) return;
      const status = String(row?.status || "POSTED").toUpperCase();
      if (status === "CANCELLED" || status === "REVERSED") return;

      const amount = pnlOutflowAmount(row);
      if (amount <= 0) return;

      const tender = salesTenderLabel(row);
      if (tender === "Credit") creditTotal += amount;
      else if (tender.startsWith("Bank")) bankTotal += amount;
      else if (tender === "Cash") cashTotal += amount;

      const businessDate = txnBusinessDate(row);
      const createdAtMs =
        num(row.createdAtMs) ||
        (row.createdAt?.toMillis?.() ?? 0) ||
        num(row.dateMs) ||
        (row.date?.toMillis?.() ?? 0);

      const partyName = String(row.partyName || "").trim();
      const party =
        partyName && !isTenderPartyName(partyName) ? partyName : "—";
      const ref = txnRefLabel(row);
      const category = String(row.category || row.type || "").trim();

      entries.push({
        id: row.id,
        date: txnDateLabel(row) || formatIsoDate(businessDate) || businessDate,
        ref: ref !== "—" ? ref : category || "—",
        party,
        description: tender,
        _in: amount,
        _out: 0,
        _sortDateMs:
          businessDateSortMs(businessDate) ||
          num(row.dateMs) ||
          (row.date?.toMillis?.() ?? 0),
        _sortCreatedAtMs: createdAtMs,
      });
    });

    entries.sort((a, b) => {
      if (a._sortDateMs !== b._sortDateMs) return a._sortDateMs - b._sortDateMs;
      return a._sortCreatedAtMs - b._sortCreatedAtMs;
    });

    let running = 0;
    const tableRows = entries.map((entry) => {
      running += entry._in - entry._out;
      return {
        id: entry.id,
        date: entry.date,
        ref: entry.ref,
        party: entry.party,
        description: entry.description,
        in: entry._in ? money(entry._in) : "",
        out: "",
        balance: money(running),
      };
    });

    return {
      title: "Expense Breakdown",
      layout: "ledger",
      columns: [
        { key: "date", label: "Date" },
        { key: "ref", label: "Ref / Invoice" },
        { key: "party", label: "Party" },
        { key: "description", label: "Payment" },
        { key: "in", label: "Amount", align: "right" },
        { key: "out", label: "", align: "right" },
        { key: "balance", label: "Balance", align: "right" },
      ],
      rows: tableRows,
      summary: {
        expenses: money(running),
        cash: money(cashTotal),
        bank: money(bankTotal),
        credit: money(creditTotal),
        count: String(tableRows.length),
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
    const [zReports, allTxns, externalBills, collections] = await Promise.all([
      fetchZReportsInRange(clientId, fromDate, toDate),
      fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: "",
        includeTransfers: true,
      }),
      fetchExternalBillsInRange(clientId, fromDate, toDate),
      fetchCollectionsInRange(clientId, fromDate, toDate),
    ]);

    let cashSales = 0;
    let bankSales = 0;
    const posSalesDates = new Set();

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

      if (type === "sales") {
        const date =
          typeof row.date === "string"
            ? row.date.slice(0, 10)
            : row.date?.toDate
              ? toIso(row.date.toDate())
              : "";
        if (date) posSalesDates.add(date);
        const saleAmount = salesTxnAmount(row) || amount;
        if (isCashTender(row)) cashSales += saleAmount;
        else if (isBankTender(row)) bankSales += saleAmount;
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

    // Z fills sales gaps when a day has no POS sales; External/Collect always add.
    zReports.forEach((report) => {
      const date = String(report.businessDate || "").slice(0, 10);
      if (!date || posSalesDates.has(date)) return;
      cashSales += num(report.cashTotal);
      bankSales += zReportBankAmount(report);
    });
    const externalTenders = summarizeExternalBillTenders(externalBills);
    const collectionTenders = summarizeDeliveryBoyCollections(collections);
    cashSales +=
      num(externalTenders.cashTotal) + num(collectionTenders.cashTotal);
    bankSales +=
      num(externalTenders.bankTotal) + num(collectionTenders.bankTotal);

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
          {
            label: "Cash Sales (POS + Z + External)",
            amount: cashSales,
          },
          {
            label: "Bank Sales (POS + Z + External)",
            amount: bankSales,
          },
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

  if (
    reportType === "cash" ||
    reportType === "bank" ||
    reportType === "locker"
  ) {
    const [openingReport, zReports, allTxns, externalBills, collections] =
      await Promise.all([
        fetchOpeningDailyReport(clientId, fromDate),
        fetchZReportsInRange(clientId, fromDate, toDate),
        fetchTxnRange({
          clientId,
          fromDate,
          toDate,
          typeKey: "",
          includeTransfers: true,
        }),
        fetchExternalBillsInRange(clientId, fromDate, toDate),
        fetchCollectionsInRange(clientId, fromDate, toDate),
      ]);

    const openingCash = num(
      openingReport?.closingCashInHand ?? openingReport?.actualCash
    );
    const openingBank = num(
      openingReport?.closingBankBalance ?? openingReport?.totalBank
    );
    const openingLocker = num(
      openingReport?.closingLockerBalance ?? openingReport?.lockerBalance
    );

    const externalByDate = new Map();
    for (const bill of externalBills) {
      const date = String(bill?.businessDate || "").slice(0, 10);
      if (!date) continue;
      if (!externalByDate.has(date)) externalByDate.set(date, []);
      externalByDate.get(date).push(bill);
    }
    const collectionsByDate = new Map();
    for (const row of collections) {
      const date = String(row?.businessDate || "").slice(0, 10);
      if (!date) continue;
      if (!collectionsByDate.has(date)) collectionsByDate.set(date, []);
      collectionsByDate.get(date).push(row);
    }

    const posCashDates = new Set();
    const posBankDates = new Set();
    allTxns.forEach((row) => {
      if (isTransferRow(row) || isLoanTransaction(row)) return;
      if (
        String(row?.type || "")
          .trim()
          .toLowerCase() !== "sales"
      ) {
        return;
      }
      if (isCreditTender(row)) return;
      const date =
        typeof row.date === "string"
          ? row.date.slice(0, 10)
          : row.date?.toDate
            ? toIso(row.date.toDate())
            : "";
      if (!date) return;
      if (isCashTender(row)) posCashDates.add(date);
      if (isBankTender(row)) posBankDates.add(date);
    });

    const entries = [];

    if (reportType === "cash" || reportType === "bank") {
      // Z-report sales fill days without POS tender of that rail.
      zReports.forEach((report) => {
        const businessDate = String(report.businessDate || "").slice(0, 10);
        if (!businessDate) return;
        if (reportType === "cash") {
          const cash = num(report.cashTotal);
          if (cash <= 0 || posCashDates.has(businessDate)) return;
          entries.push({
            id: `z-cash-${report.id}`,
            date: formatIsoDate(businessDate) || businessDate,
            ref: String(report.reportNo || "").trim() || "—",
            party: "Z-Report",
            account: "",
            type: "Sales",
            description: "Z-Report cash sales",
            _in: cash,
            _out: 0,
            _sortDateMs: businessDateSortMs(businessDate),
            _sortCreatedAtMs: num(report.createdAtMs),
            _accountId: "",
            _movement: "sales",
            _direction: "",
          });
        } else {
          const bank =
            report.bankTotal != null && report.bankTotal !== ""
              ? num(report.bankTotal)
              : num(report.cardTotal) + num(report.qrTotal);
          if (bank <= 0 || posBankDates.has(businessDate)) return;
          const bankRows =
            Array.isArray(report.bankEntries) && report.bankEntries.length
              ? report.bankEntries
              : [
                  {
                    bankAccountId: "",
                    bankAccountName: "Bank",
                    amount: bank,
                  },
                ];
          bankRows.forEach((entry, index) => {
            const amount = num(entry.amount);
            if (amount <= 0) return;
            entries.push({
              id: `z-bank-${report.id}-${index}`,
              date: formatIsoDate(businessDate) || businessDate,
              ref: String(report.reportNo || "").trim() || "—",
              party: "Z-Report",
              account: String(entry.bankAccountName || "Bank"),
              type: "Sales",
              description: "Z-Report bank sales",
              _in: amount,
              _out: 0,
              _sortDateMs: businessDateSortMs(businessDate),
              _sortCreatedAtMs: num(report.createdAtMs),
              _accountId: String(entry.bankAccountId || ""),
              _movement: "sales",
              _direction: "",
            });
          });
        }
      });

      // External shop cash/bank + delivery Collect (additive with Z/POS).
      const allDates = new Set([
        ...externalByDate.keys(),
        ...collectionsByDate.keys(),
      ]);
      allDates.forEach((businessDate) => {
        const dayBills = externalByDate.get(businessDate) || [];
        const dayCollections = collectionsByDate.get(businessDate) || [];
        const billTenders = summarizeExternalBillTenders(dayBills);
        const collectTenders = summarizeDeliveryBoyCollections(dayCollections);
        if (reportType === "cash") {
          const cash = num(billTenders.cashTotal) + num(collectTenders.cashTotal);
          if (cash > 0) {
            entries.push({
              id: `ext-cash-${businessDate}`,
              date: formatIsoDate(businessDate) || businessDate,
              ref: "—",
              party: "External Sales",
              account: "",
              type: "Sales",
              description:
                collectTenders.cashTotal > 0
                  ? "External cash + delivery collect"
                  : "External cash sales",
              _in: cash,
              _out: 0,
              _sortDateMs: businessDateSortMs(businessDate),
              _sortCreatedAtMs: 0,
              _accountId: "",
              _movement: "sales",
              _direction: "",
            });
          }
        } else {
          const bankMap = new Map();
          for (const row of [
            ...billTenders.bankByAccount,
            ...collectTenders.bankByAccount,
          ]) {
            const key = row.bankAccountId || "_unassigned";
            const existing = bankMap.get(key);
            if (existing) {
              existing.amount += num(row.amount);
            } else {
              bankMap.set(key, {
                bankAccountId: row.bankAccountId || "",
                bankAccountName: row.bankAccountName || "Bank",
                amount: num(row.amount),
              });
            }
          }
          if (!bankMap.size && billTenders.bankTotal + collectTenders.bankTotal > 0) {
            bankMap.set("_unassigned", {
              bankAccountId: "",
              bankAccountName: "Bank",
              amount: billTenders.bankTotal + collectTenders.bankTotal,
            });
          }
          Array.from(bankMap.values()).forEach((row, index) => {
            const amount = num(row.amount);
            if (amount <= 0) return;
            entries.push({
              id: `ext-bank-${businessDate}-${index}`,
              date: formatIsoDate(businessDate) || businessDate,
              ref: "—",
              party: "External Sales",
              account: String(row.bankAccountName || "Bank"),
              type: "Sales",
              description:
                collectTenders.bankTotal > 0
                  ? "External bank + delivery collect"
                  : "External bank sales",
              _in: amount,
              _out: 0,
              _sortDateMs: businessDateSortMs(businessDate),
              _sortCreatedAtMs: 0,
              _accountId: String(row.bankAccountId || ""),
              _movement: "sales",
              _direction: "",
            });
          });
        }
      });
    }

    allTxns.forEach((row) => {
      const type = String(row?.type || "")
        .trim()
        .toLowerCase();
      const amount = txnAmount(row);
      if (amount <= 0 && !isTransferRow(row)) return;

      if (reportType === "locker") {
        if (!isTransferRow(row)) return;
        const transferType = transferTypeOf(row);
        if (
          transferType !== "CASH_TO_LOCKER" &&
          transferType !== "LOCKER_TO_CASH"
        ) {
          return;
        }
        const inflow = transferType === "LOCKER_TO_CASH" ? 0 : amount;
        const outflow = transferType === "CASH_TO_LOCKER" ? 0 : amount;
        // Locker balance: Cash→Locker increases locker; Locker→Cash decreases.
        entries.push(
          liquidityEntryBase(row, {
            party: "Internal",
            account: "Locker",
            type:
              transferType === "CASH_TO_LOCKER"
                ? "Cash → Locker"
                : "Locker → Cash",
            description:
              String(row.description || "").trim() ||
              (transferType === "CASH_TO_LOCKER"
                ? "Cash to Locker"
                : "Locker to Cash"),
            _in: transferType === "CASH_TO_LOCKER" ? amount : 0,
            _out: transferType === "LOCKER_TO_CASH" ? amount : 0,
            _movement: "transfer",
            _direction:
              transferType === "CASH_TO_LOCKER"
                ? "cash_to_locker"
                : "locker_to_cash",
            _accountId: "",
          })
        );
        void inflow;
        void outflow;
        return;
      }

      if (isTransferRow(row)) {
        const transferType = transferTypeOf(row);
        if (reportType === "cash") {
          const cashInTypes = new Set([
            "BANK_TO_CASH",
            "PETTI_TO_CASH",
            "LOCKER_TO_CASH",
          ]);
          const cashOutTypes = new Set([
            "CASH_TO_BANK",
            "CASH_TO_PETTI",
            "CASH_TO_LOCKER",
          ]);
          if (!cashInTypes.has(transferType) && !cashOutTypes.has(transferType)) {
            return;
          }
          entries.push(
            liquidityEntryBase(row, {
              party: "Internal",
              type: "Transfer",
              description:
                String(row.description || "").trim() || transferType,
              _in: cashInTypes.has(transferType) ? amount : 0,
              _out: cashOutTypes.has(transferType) ? amount : 0,
              _movement: "transfer",
              _accountId: String(row.bankAccountId || ""),
              account: String(row.bankAccountName || ""),
            })
          );
          return;
        }

        // bank report transfers
        const bankInTypes = new Set([
          "CASH_TO_BANK",
          "PETTI_TO_BANK",
          "BANK_TO_BANK",
        ]);
        const bankOutTypes = new Set([
          "BANK_TO_CASH",
          "BANK_TO_PETTI",
          "BANK_TO_BANK",
        ]);
        if (!bankInTypes.has(transferType) && !bankOutTypes.has(transferType)) {
          return;
        }
        // BANK_TO_BANK: out from source account, in to destination.
        if (transferType === "BANK_TO_BANK") {
          entries.push(
            liquidityEntryBase(row, {
              id: `${row.id}-out`,
              party: "Internal",
              account: String(row.bankAccountName || "Bank"),
              type: "Transfer",
              description:
                String(row.description || "").trim() || "Bank → Bank (out)",
              _in: 0,
              _out: amount,
              _movement: "transfer",
              _accountId: String(row.bankAccountId || ""),
            })
          );
          entries.push(
            liquidityEntryBase(row, {
              id: `${row.id}-in`,
              party: "Internal",
              account: String(
                row.destinationBankAccountName ||
                  row.destinationBankAccountId ||
                  "Bank"
              ),
              type: "Transfer",
              description:
                String(row.description || "").trim() || "Bank → Bank (in)",
              _in: amount,
              _out: 0,
              _movement: "transfer",
              _accountId: String(row.destinationBankAccountId || ""),
            })
          );
          return;
        }
        entries.push(
          liquidityEntryBase(row, {
            party: "Internal",
            account: String(row.bankAccountName || "Bank"),
            type: "Transfer",
            description:
              String(row.description || "").trim() || transferType,
            _in: bankInTypes.has(transferType) ? amount : 0,
            _out: bankOutTypes.has(transferType) ? amount : 0,
            _movement: "transfer",
            _accountId: String(row.bankAccountId || ""),
          })
        );
        return;
      }

      if (reportType === "cash") {
        if (!isCashTender(row) || isCreditTender(row)) return;
        if (type === "sales") {
          entries.push(
            liquidityEntryBase(row, {
              type: "Sales",
              description:
                String(row.description || "").trim() || "Cash sale",
              _in: salesTxnAmount(row) || amount,
              _movement: "sales",
            })
          );
          return;
        }
        if (type === "receipt" || type === "income") {
          entries.push(
            liquidityEntryBase(row, {
              type: isLoanTransaction(row) ? "Loan" : "Receipt",
              _in: num(row.amountIn) || amount,
              _movement: isLoanTransaction(row) ? "loan" : "receipt",
            })
          );
          return;
        }
        if (type === "payment") {
          entries.push(
            liquidityEntryBase(row, {
              type: isLoanTransaction(row) ? "Loan" : "Payment",
              _out: num(row.amountOut) || amount,
              _movement: isLoanTransaction(row) ? "loan" : "payment",
            })
          );
          return;
        }
        if (type === "purchase" || type === "expense") {
          entries.push(
            liquidityEntryBase(row, {
              type: type === "purchase" ? "Purchase" : "Expense",
              _out: pnlOutflowAmount(row) || amount,
              _movement: "expense",
            })
          );
        }
        return;
      }

      // bank report non-transfer
      if (!isBankTender(row) || isCreditTender(row)) return;
      const accountName = String(row.bankAccountName || "Bank");
      const accountId = String(row.bankAccountId || "");
      if (type === "sales") {
        entries.push(
          liquidityEntryBase(row, {
            account: accountName,
            type: "Sales",
            description:
              String(row.description || "").trim() || "Bank sale",
            _in: salesTxnAmount(row) || amount,
            _movement: "sales",
            _accountId: accountId,
          })
        );
        return;
      }
      if (type === "receipt" || type === "income") {
        entries.push(
          liquidityEntryBase(row, {
            account: accountName,
            type: isLoanTransaction(row) ? "Loan" : "Receipt",
            _in: num(row.amountIn) || amount,
            _movement: isLoanTransaction(row) ? "loan" : "receipt",
            _accountId: accountId,
          })
        );
        return;
      }
      if (type === "payment") {
        entries.push(
          liquidityEntryBase(row, {
            account: accountName,
            type: isLoanTransaction(row) ? "Loan" : "Payment",
            _out: num(row.amountOut) || amount,
            _movement: isLoanTransaction(row) ? "loan" : "payment",
            _accountId: accountId,
          })
        );
        return;
      }
      if (type === "purchase" || type === "expense") {
        entries.push(
          liquidityEntryBase(row, {
            account: accountName,
            type: type === "purchase" ? "Purchase" : "Expense",
            _out: pnlOutflowAmount(row) || amount,
            _movement: "expense",
            _accountId: accountId,
          })
        );
      }
    });

    const opening =
      reportType === "cash"
        ? openingCash
        : reportType === "bank"
          ? openingBank
          : openingLocker;

    const movementRows = buildRollingBalanceRows(entries, opening);
    const totalIn = entries.reduce((sum, row) => sum + num(row._in), 0);
    const totalOut = entries.reduce((sum, row) => sum + num(row._out), 0);
    const closing = opening + totalIn - totalOut;

    const openingRow = {
      id: "__opening__",
      date: formatIsoDate(fromDate) || fromDate,
      ref: "—",
      party: "—",
      account: reportType === "bank" ? "All accounts" : "",
      type: "Opening",
      description: "Opening balance",
      in: "",
      out: "",
      balance: money(opening),
      _in: 0,
      _out: 0,
      _balance: opening,
      _accountId: "",
      _movement: "opening",
      _direction: "",
      _isOpening: true,
    };

    const title =
      reportType === "cash"
        ? "Cash Report"
        : reportType === "bank"
          ? "Bank Report"
          : "Locker Report";

    const columns =
      reportType === "bank"
        ? [
            { key: "date", label: "Date" },
            { key: "ref", label: "Ref" },
            { key: "account", label: "Bank Account" },
            { key: "type", label: "Type" },
            { key: "party", label: "Party" },
            { key: "description", label: "Description" },
            { key: "in", label: "In", align: "right" },
            { key: "out", label: "Out", align: "right" },
            { key: "balance", label: "Balance", align: "right" },
          ]
        : reportType === "locker"
          ? [
              { key: "date", label: "Date" },
              { key: "ref", label: "Ref" },
              { key: "type", label: "Direction" },
              { key: "description", label: "Description" },
              { key: "in", label: "In", align: "right" },
              { key: "out", label: "Out", align: "right" },
              { key: "balance", label: "Balance", align: "right" },
            ]
          : [
              { key: "date", label: "Date" },
              { key: "ref", label: "Ref" },
              { key: "type", label: "Type" },
              { key: "party", label: "Party" },
              { key: "description", label: "Description" },
              { key: "in", label: "In", align: "right" },
              { key: "out", label: "Out", align: "right" },
              { key: "balance", label: "Balance", align: "right" },
            ];

    return {
      title,
      layout: "liquidity",
      columns,
      rows: [openingRow, ...movementRows],
      summary: {
        opening: money(opening),
        totalIn: money(totalIn),
        totalOut: money(totalOut),
        closing: money(closing),
        count: String(entries.length),
      },
      liquidity: {
        rail: reportType,
        opening,
        totalIn,
        totalOut,
        closing,
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
    // Full Period already starts at epoch — nothing exists before it.
    const canFetchPrior =
      Boolean(priorTo) && priorTo >= FULL_PERIOD_START && priorTo < fromDate;
    const [rangeTxns, priorTxns] = await Promise.all([
      fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: "",
      }),
      canFetchPrior
        ? fetchTxnRange({
            clientId,
            fromDate: FULL_PERIOD_START,
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
      fromDate: FULL_PERIOD_START,
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
