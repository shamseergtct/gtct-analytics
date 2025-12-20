// src/utils/partyPdfGenerator.js
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

function money(v) {
  const n = Number(v || 0);
  return n.toFixed(2);
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
 * Draw a metric card with guaranteed visible text (white on dark background)
 */
function metricCard(doc, { x, y, w, h, title, value, currency }) {
  // Card background
  doc.setFillColor(17, 24, 39); // slate-900-ish
  doc.roundedRect(x, y, w, h, 4, 4, "F");

  // Title
  doc.setTextColor(203, 213, 225); // slate-300
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(safeStr(title), x + 8, y + 14);

  // Value (INSIDE the card)
  doc.setTextColor(255, 255, 255); // white
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);

  const v = `${money(value)} ${safeStr(currency)}`;
  doc.text(v, x + 8, y + 26); // ✅ was y+36 (outside)
}

/**
 * Generate Party PDF (Customer/Vendor Statement)
 * Header should show CLIENT NAME (shop name) — not GTCT
 */
export function generatePartyPDF({
  clientName,
  currency,
  partyName,
  partyType, // "Customer" | "Supplier"
  fromDate,
  toDate,
  report, // from buildPartyReport()
}) {
  const doc = new jsPDF("p", "mm", "a4");

  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  // ---------- HEADER (Client/Shop name) ----------
  doc.setFillColor(0, 51, 102); // dark blue
  doc.rect(0, 0, pageW, 32, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(safeStr(clientName, "Client"), margin, 18);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(
    partyType === "Customer" ? "Customer Statement" : "Vendor Statement",
    margin,
    26
  );

  // Right side info
  doc.setFontSize(10);
  doc.text(`Party: ${safeStr(partyName)}`, pageW - margin, 14, { align: "right" });
  doc.text(
    `Period: ${safeStr(fromDate)} to ${safeStr(toDate)}`,
    pageW - margin,
    20,
    { align: "right" }
  );
  doc.text(`Currency: ${safeStr(currency)}`, pageW - margin, 26, { align: "right" });

  // ---------- METRIC CARDS ----------
  const cardY = 42;
  const gap = 6;
  const cardW = (pageW - margin * 2 - gap * 2) / 3;
  const cardH = 32;

  const creditLabel =
    partyType === "Customer" ? "Credit Sales" : "Credit Purchases";
  const settledLabel =
    partyType === "Customer" ? "Recovered" : "Paid";
  const pendingLabel =
    partyType === "Customer" ? "Pending Receivable" : "Pending Payable";

  // IMPORTANT: Ensure numbers exist
  const creditGiven = Number(report?.creditGiven || 0);
  const settled = Number(report?.settled || 0);
  const pending = Number(report?.pending || 0);

  metricCard(doc, {
    x: margin,
    y: cardY,
    w: cardW,
    h: cardH,
    title: creditLabel,
    value: creditGiven,
    currency,
  });

  metricCard(doc, {
    x: margin + cardW + gap,
    y: cardY,
    w: cardW,
    h: cardH,
    title: settledLabel,
    value: settled,
    currency,
  });

  metricCard(doc, {
    x: margin + (cardW + gap) * 2,
    y: cardY,
    w: cardW,
    h: cardH,
    title: pendingLabel,
    value: pending,
    currency,
  });

  // ---------- TABLE ----------
  const startY = cardY + cardH + 14;

  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Transactions", margin, startY);

  const bodyRows = (report?.rows || []).map((t) => {
    const d = t?._dateObj ? toYYYYMMDD(t._dateObj) : safeStr(t?.date);
    const amount = Number(t?._total || 0);
    return [
      d,
      safeStr(t?.type),
      safeStr(t?.mode),
      safeStr(t?.description, "-"),
      `${money(amount)} ${safeStr(currency)}`,
    ];
  });

  autoTable(doc, {
    startY: startY + 4,
    head: [["Date", "Type", "Mode", "Description", "Amount"]],
    body: bodyRows.length ? bodyRows : [["-", "-", "-", "No records found.", "-"]],
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
      4: { halign: "right" },
    },
    theme: "grid",
  });

  // ---------- FOOTER ----------
  const finalY = doc.lastAutoTable?.finalY || 260;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(120, 120, 120);

  // keep GTCT only as a small internal note, not the brand
  doc.text(
    "Generated for internal bookkeeping support",
    margin,
    finalY + 10
  );

  return doc;
}
