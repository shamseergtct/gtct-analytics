// src/utils/partyPdfGenerator.js
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function money(v) {
  return num(v).toFixed(2);
}

function safeStr(v, fallback = "-") {
  if (v === null || v === undefined) return fallback;
  const s = String(v);
  return s.trim() ? s : fallback;
}

function toYYYYMMDD(d) {
  const x = d instanceof Date ? d : new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Metric card (dark background, white text)
 */
function metricCard(doc, { x, y, w, h, title, value, currency }) {
  doc.setFillColor(17, 24, 39); // slate-900
  doc.roundedRect(x, y, w, h, 4, 4, "F");

  doc.setTextColor(203, 213, 225); // slate-300
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(safeStr(title), x + 8, y + 14);

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);

  const v = `${money(value)} ${safeStr(currency)}`;
  doc.text(v, x + 8, y + 26);
}

function titleByPartyType(partyType) {
  const t = String(partyType || "").trim().toLowerCase();
  if (t === "customer") return "Customer Statement";
  if (t === "supplier") return "Supplier / Vendor Statement";
  if (t === "both") return "Party Statement (Both)";
  if (t === "employee") return "Employee Ledger";
  if (t === "owner") return "Owner Ledger";
  if (t === "partner") return "Partner Ledger";
  return "Party Statement";
}

/**
 * Generate Party PDF (ALL types)
 * Uses report.mode:
 *  - customer: credit sales - receipts = receivable
 *  - supplier: credit purchases/expense - payments = payable
 *  - both: show receivable + payable + net
 *  - internal: show total in/out/net
 */
export function generatePartyPDF({
  clientName,
  currency,
  partyName,
  partyType,
  fromDate,
  toDate,
  report,
}) {
  const doc = new jsPDF("p", "mm", "a4");

  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  // ---------- HEADER ----------
  doc.setFillColor(0, 51, 102); // dark blue
  doc.rect(0, 0, pageW, 32, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(safeStr(clientName, "Client"), margin, 18);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(titleByPartyType(partyType), margin, 26);

  doc.setFontSize(10);
  doc.text(`Party: ${safeStr(partyName)}`, pageW - margin, 14, { align: "right" });
  doc.text(`Period: ${safeStr(fromDate)} to ${safeStr(toDate)}`, pageW - margin, 20, {
    align: "right",
  });
  doc.text(`Currency: ${safeStr(currency)}`, pageW - margin, 26, { align: "right" });

  // ---------- METRIC CARDS ----------
  const cardY = 42;
  const gap = 6;
  const cardW = (pageW - margin * 2 - gap * 2) / 3;
  const cardH = 32;

  const mode = String(report?.mode || "").trim().toLowerCase();

  // Defaults (internal style)
  let card1 = { title: "Total In", value: num(report?.totalIn || 0) };
  let card2 = { title: "Total Out", value: num(report?.totalOut || 0) };
  let card3 = { title: "Net (In − Out)", value: num(report?.net || 0) };

  if (mode === "customer") {
    card1 = { title: "Credit Sales (NET)", value: num(report?.customerCreditSales || 0) };
    card2 = { title: "Recovered (Receipts, NET)", value: num(report?.customerReceipts || 0) };
    card3 = { title: "Pending Receivable", value: num(report?.receivable || 0) };
  } else if (mode === "supplier") {
    card1 = {
      title: "Credit Purchases/Expense (NET)",
      value: num(report?.supplierCreditPurchases || 0),
    };
    card2 = { title: "Paid (Payments, NET)", value: num(report?.supplierPayments || 0) };
    card3 = { title: "Pending Payable", value: num(report?.payable || 0) };
  } else if (mode === "both") {
    card1 = { title: "Pending Receivable", value: num(report?.receivable || 0) };
    card2 = { title: "Pending Payable", value: num(report?.payable || 0) };
    card3 = { title: "Net (In − Out)", value: num(report?.net || 0) };
  } else if (mode === "employee") {
    card1 = { title: "Total To Pay (Credit)", value: num(report?.totalToPay || 0) };
    card2 = { title: "Total Paid (Cash/Bank/Petti)", value: num(report?.totalPaid || 0) };
    card3 = { title: "Total Balance", value: num(report?.balance || 0) };
  }

  metricCard(doc, { x: margin, y: cardY, w: cardW, h: cardH, ...card1, currency });
  metricCard(doc, { x: margin + cardW + gap, y: cardY, w: cardW, h: cardH, ...card2, currency });
  metricCard(doc, {
    x: margin + (cardW + gap) * 2,
    y: cardY,
    w: cardW,
    h: cardH,
    ...card3,
    currency,
  });

  // ---------- TABLE ----------
  const startY = cardY + cardH + 14;

  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Transactions", margin, startY);

  const rows = Array.isArray(report?.rows) ? report.rows : [];

  const bodyRows = rows.map((t) => {
    const d = t?._dateObj ? toYYYYMMDD(t._dateObj) : safeStr(t?.date);
    const amount = num(t?._amount ?? t?._total ?? t?.totalAmount ?? 0);
    const dir = safeStr(t?._dir, "-");
    return [
      d,
      safeStr(t?.type),
      safeStr(t?.mode || t?.paymentMode),
      dir,
      safeStr(t?.description || t?.category, "-"),
      `${money(amount)} ${safeStr(currency)}`,
    ];
  });

  autoTable(doc, {
    startY: startY + 4,
    head: [["Date", "Type", "Mode", "Dir", "Description", "Amount (NET)"]],
    body: bodyRows.length ? bodyRows : [["-", "-", "-", "-", "No records found.", "-"]],
    styles: {
      font: "helvetica",
      fontSize: 9,
      textColor: [60, 60, 60],
      cellPadding: 3,
    },
    headStyles: {
      fillColor: [0, 51, 102],
      textColor: [255, 255, 255],
      fontStyle: "bold",
    },
    columnStyles: {
      5: { halign: "right" },
    },
    theme: "grid",
  });

  // ---------- FOOTER ----------
  const finalY = doc.lastAutoTable?.finalY || 260;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(120, 120, 120);

  doc.text("Generated for internal bookkeeping support", margin, finalY + 10);

  return doc;
}
