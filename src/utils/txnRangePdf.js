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
function fileSafeName(s) {
  return safeText(s).replace(/[^\w\s-]/g, "").replace(/\s+/g, "_").toLowerCase();
}

function addFooter(doc) {
  const pages = doc.getNumberOfPages();
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();

  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(9);
    doc.setTextColor(110);

    doc.text("GTCT Daily Analytics", 14, h - 10);
    doc.text(`Page ${i}/${pages}`, w - 14, h - 10, { align: "right" });
  }
}

export function generateTxnRangePDF({
  title,
  clientName,
  currency,
  fromDate,
  toDate,
  filtersText,
  summary,
  viewMode = "detailed",
  breakdown,
  rows,
  condensedRows,
}) {
  const doc = new jsPDF();
  const CUR = safeText(currency || "BHD");

  const titleLower = safeText(title || "").toLowerCase();
  const isReceivable = titleLower.includes("receivable");
  const isPayable = titleLower.includes("payable");
  const isCreditReport = isReceivable || isPayable;

  // HEADER
  doc.setFontSize(14);
  doc.text(safeText(clientName || "GTCT Analytics"), 14, 14);

  doc.setFontSize(12);
  doc.text(safeText(title || "Transaction Report"), 14, 22);

  doc.setFontSize(10);
  doc.text(`Range: ${safeText(fromDate)} to ${safeText(toDate)}`, 14, 29);

  let y = 35;
  if (filtersText) {
    doc.text(safeText(filtersText), 14, y);
    y += 6;
  }

  const totalCount = breakdown?.totalCount ?? summary?.count ?? 0;
  const totalAmount = breakdown?.totalAmount ?? summary?.total ?? 0;

  doc.text(`Total Count: ${totalCount}`, 14, y);
  y += 6;
  doc.text(`Total Amount (${CUR}): ${money(totalAmount)}`, 14, y);
  y += 8;

  let currentY = Math.max(58, y);

  // =========================
  // RECEIVABLE / PAYABLE TABLE
  // =========================
  if (isCreditReport) {
    const body = (rows || []).map((r) => [
      safeText(r.partyName || "-"),
      money(r.amount),
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [[
        "Party",
        `${isReceivable ? "Receivable" : "Payable"} (${CUR})`,
      ]],
      body: body.length ? body : [["No data", ""]],
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: {
        fillColor: [30, 64, 175],
        textColor: 255,
        fontStyle: "bold",
      },
      columnStyles: {
        0: { halign: "left" },
        1: { halign: "right" }, // HEADER + AMOUNT RIGHT
      },
    });

    addFooter(doc);
    const baseName = fileSafeName(title || "credit_report");
    doc.save(`${baseName}_${fromDate}_to_${toDate}.pdf`);
    return;
  }

  // =========================
  // SUMMARY TABLES
  // =========================
  const wantSummary = viewMode === "summary" || viewMode === "both";
  const wantDetailed = viewMode === "detailed";
  const wantCondensed = viewMode === "both";

  if (wantSummary) {
    const modeRows = (breakdown?.modeRows || []).map((r) => [
      safeText(r.key || "Unknown"),
      String(r.count ?? 0),
      money(r.total ?? 0),
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [[`Summary by Mode`, "Count", `Total (${CUR})`]],
      body: modeRows.length ? modeRows : [["No data", "", ""]],
    });

    currentY = (doc.lastAutoTable?.finalY || currentY) + 10;
  }

  if (wantCondensed) {
    const body = (condensedRows || []).map((r) => [
      safeText(r.rangeText || ""),
      safeText(r.partyName || "-"),
      money(r.amount),
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [["Date Range", "Party", `Total (${CUR})`]],
      body,
    });

    currentY = (doc.lastAutoTable?.finalY || currentY) + 10;
  }

  if (wantDetailed) {
    const body = (rows || []).map((r) => [
      safeText(r.dateText || "-"),
      safeText(r.partyName || "-"),
      money(r.amount),
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [["Date", "Party", `Amount (${CUR})`]],
      body,
    });
  }

  addFooter(doc);
  const baseName = fileSafeName(title || "transaction_report");
  doc.save(`${baseName}_${fromDate}_to_${toDate}.pdf`);
}
