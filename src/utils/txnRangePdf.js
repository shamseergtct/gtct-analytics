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

function formatDateTime(d = new Date()) {
  try {
    return d.toLocaleString();
  } catch {
    return "";
  }
}

/**
 * Footer on every page:
 * left: GTCT Daily Analytics
 * center: Generated datetime
 * right: Page X / Y
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

    // separator line
    doc.setDrawColor(200, 200, 200);
    doc.setLineWidth(0.6);
    doc.line(marginX, lineY, w - marginX, lineY);

    doc.setTextColor(90, 90, 90);

    // left
    doc.text(safeText(brandText), marginX, footerY);

    // center
    doc.text(generated, w / 2, footerY, { align: "center" });

    // right
    doc.text(`Page ${i} / ${pageCount}`, w - marginX, footerY, { align: "right" });
  }
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
  rows, // detailed rows
  condensedRows, // [{ rangeText, partyName, mode, amount }]
}) {
  // Use PT + A4 so widths are predictable
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  const CUR = safeText(currency || "BHD");
  const brand = "GTCT Daily Analytics";

  const pageW = doc.internal.pageSize.getWidth(); // A4 ~595pt
  const marginX = 40;

  // Detect credit reports by title (keep your current behavior)
  const titleLower = safeText(title || "").toLowerCase();
  const isReceivable = titleLower.includes("receivable");
  const isPayable = titleLower.includes("payable");
  const isCreditReport = isReceivable || isPayable;

  // ---------- Header ----------
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

  // ---------- Shared table style ----------
  const baseTableStyles = {
    styles: {
      font: "helvetica",
      fontSize: 9,
      cellPadding: 6,
      textColor: [35, 35, 35],
      lineColor: [220, 220, 220],
      lineWidth: 0.5,
      overflow: "linebreak",
      valign: "middle",
    },
    headStyles: {
      fillColor: [30, 64, 175],
      textColor: [255, 255, 255],
      fontStyle: "bold",
      fontSize: 9.5,
      halign: "left",
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    tableLineColor: [220, 220, 220],
    tableLineWidth: 0.5,
    margin: { left: marginX, right: marginX },
  };

  // ---------- Credit report (Receivable/Payable) ----------
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
      ...baseTableStyles,
      columnStyles: {
        0: { halign: "left" },
        1: { halign: "right" }, // amount values right
      },
      didParseCell: (data) => {
        // ✅ make header of amount column right aligned too
        if (data.section === "head" && data.column.index === 1) {
          data.cell.styles.halign = "right";
        }
      },
    });

    addProfessionalFooter(doc, brand);
    const baseName = fileSafeName(title || "transaction_report");
    doc.save(`${baseName}_${fromDate}_to_${toDate}.pdf`);
    return;
  }

  // ---------- Summary tables ----------
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
      ...baseTableStyles,
      columnStyles: {
        1: { halign: "right" },
        2: { halign: "right" },
      },
      didParseCell: (data) => {
        if (data.section === "head" && (data.column.index === 1 || data.column.index === 2)) {
          data.cell.styles.halign = "right";
        }
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
      ...baseTableStyles,
      columnStyles: {
        1: { halign: "right" },
        2: { halign: "right" },
      },
      didParseCell: (data) => {
        if (data.section === "head" && (data.column.index === 1 || data.column.index === 2)) {
          data.cell.styles.halign = "right";
        }
      },
    });

    currentY = (doc.lastAutoTable?.finalY || currentY) + 18;
  }

  // ---------- BOTH condensed list ----------
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
      ...baseTableStyles,
      columnStyles: {
        3: { halign: "right" },
      },
      didParseCell: (data) => {
        if (data.section === "head" && data.column.index === 3) {
          data.cell.styles.halign = "right";
        }
      },
    });

    currentY = (doc.lastAutoTable?.finalY || currentY) + 14;
  }

  // ---------- Detailed table (THIS is the fix) ----------
  if (wantDetailed) {
    const body = (rows || []).map((r) => [
      safeText(r.dateText || "-"),
      safeText(r.partyName || "-"),
      safeText(r.mode || "-"),
      safeText(r.category || "-"),
      safeText(r.description || "-"),
      money(r.amount),
    ]);

    /**
     * ✅ IMPORTANT:
     * Fixed widths that ALWAYS fit A4:
     * A4 width ~595pt, margins 40+40 => usable ~515pt
     * Total below = 60 + 120 + 60 + 80 + 155 + 40 = 515
     * So Amount column will NEVER disappear.
     */
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
      ...baseTableStyles,
      columnStyles: {
  0: { cellWidth: 60 },   // Date
  1: { cellWidth: 110 },  // Party
  2: { cellWidth: 55 },   // Mode
  3: { cellWidth: 75 },   // Category

  // Description gets flexible big space
  4: { cellWidth: 165, overflow: "linebreak" },

  // Amount fixed single-line column
  5: {
    cellWidth: 50,
    halign: "right",
    overflow: "hidden",   // prevent wrap
    minCellHeight: 14
  }
},
    });
  }

  // Footer
  addProfessionalFooter(doc, brand);

  const baseName = fileSafeName(title || "transaction_report");
  doc.save(`${baseName}_${fromDate}_to_${toDate}.pdf`);
}
