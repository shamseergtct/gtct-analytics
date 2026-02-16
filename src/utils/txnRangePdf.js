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
  return safeText(s)
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .toLowerCase();
}

function formatDateTime(d = new Date()) {
  try {
    return d.toLocaleString();
  } catch {
    return "";
  }
}

/**
 * Footer on every page:
 * - left: GTCT Daily Analytics
 * - center: Generated date/time
 * - right: Page X / Y
 */
function addProfessionalFooter(doc, brandText = "GTCT Daily Analytics") {
  const pageCount = doc.getNumberOfPages();
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  const marginX = 40;
  const footerY = h - 18;
  const lineY = h - 26;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);

  const generated = `Generated: ${formatDateTime(new Date())}`;

  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);

    doc.setDrawColor(200, 200, 200);
    doc.setLineWidth(0.6);
    doc.line(marginX, lineY, w - marginX, lineY);

    doc.setTextColor(90, 90, 90);
    doc.text(safeText(brandText), marginX, footerY);
    doc.text(generated, w / 2, footerY, { align: "center" });
    doc.text(`Page ${i} / ${pageCount}`, w - marginX, footerY, { align: "right" });
  }
}

function isCreditReportTitle(title) {
  const t = safeText(title || "").toLowerCase();
  return t.includes("receivable") || t.includes("payable");
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
  breakdown, // { totalCount, totalAmount, modeRows, categoryRows }
  rows,
  condensedRows,
}) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const CUR = safeText(currency || "BHD");
  const brand = "GTCT Daily Analytics";

  const pageW = doc.internal.pageSize.getWidth();
  const marginX = 40;

  const creditReport = isCreditReportTitle(title);
  const titleLower = safeText(title || "").toLowerCase();
  const isReceivable = titleLower.includes("receivable");
  const isPayable = titleLower.includes("payable");

  // ---- Header (professional) ----
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(20, 20, 20);
  doc.text(safeText(clientName || "GTCT Analytics"), marginX, 52);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  doc.setTextColor(60, 60, 60);
  doc.text(safeText(title || "Transaction Report"), marginX, 72);

  doc.setFontSize(10);
  doc.setTextColor(80, 80, 80);
  doc.text(`Range: ${safeText(fromDate)} to ${safeText(toDate)}`, marginX, 90);

  let y = 106;
  if (filtersText) {
    doc.text(safeText(filtersText), marginX, y);
    y += 14;
  }

  const totalCount = breakdown?.totalCount ?? summary?.count ?? 0;
  const totalAmount = breakdown?.totalAmount ?? summary?.total ?? 0;

  doc.setTextColor(30, 30, 30);
  doc.text(`Total Count: ${totalCount}`, marginX, y);
  y += 14;
  doc.text(`Total Amount (${CUR}): ${money(totalAmount)}`, marginX, y);
  y += 18;

  doc.setDrawColor(210, 210, 210);
  doc.setLineWidth(0.6);
  doc.line(marginX, y, pageW - marginX, y);
  y += 14;

  let currentY = Math.max(140, y);

  const wantSummary = viewMode === "summary" || viewMode === "both";
  const wantDetailed = viewMode === "detailed";
  const wantCondensed = viewMode === "both";

  // ---- shared table styling (fix header height + proper wrap) ----
  const baseTable = {
    theme: "grid",
    margin: { left: marginX, right: marginX },
    styles: {
      font: "helvetica",
      fontSize: 9,
      cellPadding: 6,
      textColor: [35, 35, 35],
      lineColor: [225, 225, 225],
      lineWidth: 0.6,
      overflow: "linebreak", // ✅ wrap text
      valign: "middle",
      minCellHeight: 16, // ✅ prevents huge header blocks
    },
    headStyles: {
      fillColor: [30, 64, 175],
      textColor: [255, 255, 255],
      fontStyle: "bold",
      fontSize: 9.5,
      cellPadding: 6,
      valign: "middle",
      minCellHeight: 20, // ✅ keeps header normal
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },

    // ✅ Right align LAST column (Amount) for ALL tables
    didParseCell: (data) => {
      const last = data.table?.columns?.length - 1;
      if (data.column.index === last) {
        data.cell.styles.halign = "right";
      }
    },
  };

  // ✅ Receivable/Payable: 2 columns only
  if (creditReport) {
    const body = (rows || []).map((r) => [
      safeText(r.partyName || "-"),
      money(r.amount),
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [[
        "Party",
        `${isReceivable ? "Receivable" : isPayable ? "Payable" : "Amount"} (${CUR})`,
      ]],
      body: body.length ? body : [["No data", ""]],
      ...baseTable,
      columnStyles: {
        0: { halign: "left", cellWidth: 340 },
        1: { halign: "right", cellWidth: 170 },
      },
    });

    addProfessionalFooter(doc, brand);
    doc.save(`${fileSafeName(title || "report")}_${fromDate}_to_${toDate}.pdf`);
    return;
  }

  // Summary by Mode + Category
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
      ...baseTable,
      columnStyles: {
        0: { cellWidth: 280 },
        1: { cellWidth: 90 },
        2: { cellWidth: 140 },
      },
    });

    currentY = (doc.lastAutoTable?.finalY || currentY) + 14;

    const catRows = (breakdown?.categoryRows || []).map((r) => [
      safeText(r.key || "Uncategorized"),
      String(r.count ?? 0),
      money(r.total ?? 0),
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [[`Summary by Category`, "Count", `Total (${CUR})`]],
      body: catRows.length ? catRows : [["No data", "", ""]],
      ...baseTable,
      columnStyles: {
        0: { cellWidth: 280 },
        1: { cellWidth: 90 },
        2: { cellWidth: 140 },
      },
    });

    currentY = (doc.lastAutoTable?.finalY || currentY) + 18;
  }

  // BOTH: Short Party List
  if (wantCondensed) {
    const body = (condensedRows || []).map((r) => [
      safeText(r.rangeText || `${fromDate} to ${toDate}`),
      safeText(r.partyName || "-"),
      safeText(r.mode || "-"),
      money(r.amount),
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [["Date Range", "Party", "Mode", `Total (${CUR})`]],
      body: body.length ? body : [["No data", "", "", ""]],
      ...baseTable,
      columnStyles: {
        0: { cellWidth: 140 },
        1: { cellWidth: 190 },
        2: { cellWidth: 90 },
        3: { cellWidth: 90 },
      },
    });

    currentY = (doc.lastAutoTable?.finalY || currentY) + 14;
  }

  // Detailed table
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
      head: [["Date", "Party", "Mode", "Category", "Description", `Amount (${CUR})`]],
      body: body.length ? body : [["No data", "", "", "", "", ""]],
      ...baseTable,
      columnStyles: {
        0: { cellWidth: 70 },  // Date
        1: { cellWidth: 140 }, // Party
        2: { cellWidth: 70 },  // Mode
        3: { cellWidth: 90 },  // Category
        4: { cellWidth: 220 }, // Description (wrap)
        5: { cellWidth: 90 },  // Amount (right)
      },
    });
  }

  addProfessionalFooter(doc, brand);
  doc.save(`${fileSafeName(title || "report")}_${fromDate}_to_${toDate}.pdf`);
}
