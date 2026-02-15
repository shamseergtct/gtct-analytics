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

function addFooter(doc, brandText = "GTCT Daily Analytics") {
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
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const CUR = safeText(currency || "BHD");
  const brand = "GTCT Daily Analytics";

  const pageW = doc.internal.pageSize.getWidth();
  const marginX = 40;

  const titleLower = safeText(title || "").toLowerCase();
  const isReceivable = titleLower.includes("receivable");
  const isPayable = titleLower.includes("payable");
  const isCreditReport = isReceivable || isPayable;

  // Header
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

  const baseTableStyles = {
    styles: {
      font: "helvetica",
      fontSize: 9,
      cellPadding: 6,
      textColor: [35, 35, 35],
      lineColor: [220, 220, 220],
      lineWidth: 0.5,
    },
    headStyles: {
      fillColor: [30, 64, 175],
      textColor: [255, 255, 255],
      fontStyle: "bold",
      fontSize: 9.5,
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    tableLineColor: [220, 220, 220],
    tableLineWidth: 0.5,
    margin: { left: marginX, right: marginX },
  };

  // ✅ Receivable/Payable PDF: ONLY 2 columns + header amount right aligned
  if (isCreditReport) {
    const body = (rows || []).map((r) => [safeText(r.partyName || "-"), money(r.amount)]);

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
        1: { halign: "right" },
      },
      didParseCell: (data) => {
        if (data.section === "head") {
          if (data.column.index === 1) data.cell.styles.halign = "right"; // ✅ header right
          if (data.column.index === 0) data.cell.styles.halign = "left";
        }
      },
    });

    addFooter(doc, brand);
    const baseName = fileSafeName(title || "transaction_report");
    doc.save(`${baseName}_${fromDate}_to_${toDate}.pdf`);
    return;
  }

  // Summary (normal reports)
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
      columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
    });

    currentY = (doc.lastAutoTable?.finalY || currentY) + 8;

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
      columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
    });

    currentY = (doc.lastAutoTable?.finalY || currentY) + 10;
  }

  // Both condensed (normal only)
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
      columnStyles: { 3: { halign: "right" } },
    });

    currentY = (doc.lastAutoTable?.finalY || currentY) + 8;
  }

  // Detailed (normal only)
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
      ...baseTableStyles,
      styles: { ...baseTableStyles.styles, fontSize: 8.5 },
      columnStyles: {
        5: { halign: "right" },
        0: { cellWidth: 70 },
        1: { cellWidth: 120 },
        2: { cellWidth: 70 },
        3: { cellWidth: 90 },
        4: { cellWidth: 220 },
      },
    });
  }

  addFooter(doc, brand);
  const baseName = fileSafeName(title || "transaction_report");
  doc.save(`${baseName}_${fromDate}_to_${toDate}.pdf`);
}
