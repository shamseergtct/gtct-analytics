// src/utils/txnRangePdf.js
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

function num(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}
function money(v) {
  return num(v).toFixed(2);
}
function safeText(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

export function generateTxnRangePDF({
  title,
  clientName,
  currency,
  fromDate,
  toDate,
  filtersText,
  summary, // { count, total }
  rows, // [{ dateText, partyName, mode, description, amount }]
}) {
  const doc = new jsPDF();

  // Header
  doc.setFontSize(14);
  doc.text(safeText(clientName || "GTCT Analytics"), 14, 14);

  doc.setFontSize(12);
  doc.text(safeText(title || "Transaction Report"), 14, 22);

  doc.setFontSize(10);
  doc.text(`Range: ${fromDate} to ${toDate}`, 14, 29);
  if (filtersText) doc.text(safeText(filtersText), 14, 35);

  // Summary
  doc.setFontSize(10);
  doc.text(`Total Count: ${summary?.count ?? 0}`, 14, 45);
  doc.text(
    `Total Amount (${safeText(currency)}): ${money(summary?.total ?? 0)}`,
    14,
    51
  );

  // Table
  const body = (rows || []).map((r) => [
    safeText(r.dateText || "-"),
    safeText(r.partyName || "-"),
    safeText(r.mode || "-"),
    safeText(r.description || "-"),
    money(r.amount),
  ]);

  autoTable(doc, {
    startY: 58,
    head: [[
      "Date",
      "Party",
      "Mode",
      "Description",
      `Amount (${safeText(currency)})`,
    ]],
    body,
    styles: { fontSize: 9, cellPadding: 2 },
    headStyles: { fontSize: 9 },
    columnStyles: {
      4: { halign: "right" },
    },
  });

  const fileSafe = safeText(title).replace(/\s+/g, "_").toLowerCase();
  doc.save(`${fileSafe}_${fromDate}_to_${toDate}.pdf`);
}
