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

export function generateTxnRangePDF({
  title,
  clientName,
  currency,
  fromDate,
  toDate,
  filtersText,
  summary, // { count, total }
  viewMode = "detailed", // "detailed" | "summary" | "both"
  breakdown, // { totalCount, totalAmount, modeRows:[{key,count,total}], categoryRows:[{key,count,total}] }
  rows, // [{ dateText, partyName, mode, category, description, amount }]
}) {
  const doc = new jsPDF();
  const CUR = safeText(currency || "BHD");

  // ----------------------------
  // Header
  // ----------------------------
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

  // Keep y reasonable if header is small
  const startAfterHeader = Math.max(58, y);

  // ----------------------------
  // Summary tables (Mode + Category)
  // ----------------------------
  const wantSummary = viewMode === "summary" || viewMode === "both";
  const wantDetailed = viewMode === "detailed" || viewMode === "both";

  let currentY = startAfterHeader;

  if (wantSummary) {
    // ✅ Summary by Mode
    const modeRows = (breakdown?.modeRows || []).map((r) => [
      safeText(r.key || "Unknown"),
      String(r.count ?? 0),
      money(r.total ?? 0),
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [[`Summary by Mode`, "Count", `Total (${CUR})`]],
      body: modeRows.length ? modeRows : [["No data", "", ""]],
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fontSize: 9 },
      columnStyles: {
        1: { halign: "right" },
        2: { halign: "right" },
      },
    });

    currentY = (doc.lastAutoTable?.finalY || currentY) + 8;

    // ✅ Summary by Category
    const catRows = (breakdown?.categoryRows || []).map((r) => [
      safeText(r.key || "Uncategorized"),
      String(r.count ?? 0),
      money(r.total ?? 0),
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [[`Summary by Category`, "Count", `Total (${CUR})`]],
      body: catRows.length ? catRows : [["No data", "", ""]],
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fontSize: 9 },
      columnStyles: {
        1: { halign: "right" },
        2: { halign: "right" },
      },
    });

    currentY = (doc.lastAutoTable?.finalY || currentY) + 10;
  }

  // ----------------------------
  // Detailed table
  // ----------------------------
  if (wantDetailed) {
    const body = (rows || []).map((r) => [
      safeText(r.dateText || "-"),
      safeText(r.partyName || "-"),
      safeText(r.mode || "-"),
      safeText(r.category || "-"),
      safeText(r.description || "-"),
      money(r.amount),
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [[
        "Date",
        "Party",
        "Mode",
        "Category",
        "Description",
        `Amount (${CUR})`,
      ]],
      body: body.length ? body : [["No data", "", "", "", "", ""]],
      styles: { fontSize: 8.5, cellPadding: 2 },
      headStyles: { fontSize: 9 },
      columnStyles: {
        5: { halign: "right" },
        0: { cellWidth: 22 },
        1: { cellWidth: 34 },
        2: { cellWidth: 18 },
        3: { cellWidth: 26 },
        4: { cellWidth: 70 },
      },
    });
  }

  // ----------------------------
  // Save
  // ----------------------------
  const baseName = fileSafeName(title || "transaction_report");
  doc.save(`${baseName}_${fromDate}_to_${toDate}.pdf`);
}
