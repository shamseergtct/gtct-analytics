// src/utils/pdfGenerator.js
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

function money(v) {
  return Number(v || 0).toFixed(2);
}

// Avoid odd characters in PDF (safe for unicode issues)
function safeText(s) {
  return String(s ?? "")
    .replace(/\u2192/g, "to") // → becomes "to"
    .replace(/\s+/g, " ")
    .trim();
}

// ✅ Helpers to prevent section heading from being left at page bottom
function getBottom(doc) {
  return doc.internal.pageSize.getHeight() - 14; // bottom margin
}
function ensureSpace(doc, y, neededHeight) {
  if (y + neededHeight > getBottom(doc)) {
    doc.addPage();
    return 40; // top margin start
  }
  return y;
}

// ✅ Common table options (right align Amount col)
function tableCommon(currency) {
  return {
    theme: "plain",
    styles: { font: "helvetica", fontSize: 10, cellPadding: 6 },
    columnStyles: {
      0: { halign: "left" },
      1: { halign: "right" }, // ✅ amounts right aligned
    },
    headStyles: { fillColor: [0, 51, 102], textColor: 255, fontStyle: "bold" },
    head: [["Metric", `Amount (${currency})`]],
  };
}

// ✅ Special common for “Supplier” tables
function supplierTableCommon(currency) {
  return {
    theme: "plain",
    styles: { font: "helvetica", fontSize: 10, cellPadding: 6 },
    columnStyles: {
      0: { halign: "left" },
      1: { halign: "right" }, // ✅ amounts right aligned
    },
    headStyles: { fillColor: [120, 0, 0], textColor: 255, fontStyle: "bold" },
    head: [["Supplier", `Amount (${currency})`]],
  };
}

export function generateDailyPDF({ clientName, reportDate, currency, report }) {
  const doc = new jsPDF("p", "pt", "a4");
  const pageWidth = doc.internal.pageSize.getWidth();

  // Header bar
  doc.setFillColor(0, 51, 102); // #003366
  doc.rect(0, 0, pageWidth, 70, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("GTCT - THE DAILY PULSE", 40, 42);

  // Right side client + date
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`Client: ${safeText(clientName)}`, pageWidth - 40, 28, { align: "right" });
  doc.text(`Date: ${safeText(reportDate)}`, pageWidth - 40, 45, { align: "right" });

  // Status chip
  const healthy = Boolean(report?.status?.healthy);
  const chipText = safeText(report?.status?.statusText || "STATUS");

  const chipW = 110;
  const chipH = 20;
  const chipX = pageWidth - 40 - chipW;
  const chipY = 78;

  doc.setFillColor(healthy ? 0 : 160, healthy ? 150 : 0, 0);
  doc.roundedRect(chipX, chipY, chipW, chipH, 8, 8, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text(chipText, chipX + chipW / 2, chipY + 14, { align: "center" });

  // Subtitle
  doc.setTextColor(50, 50, 50);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(safeText(report?.status?.statusSub || ""), 40, 115);

  let y = 140;

  // -------------------------
  // 1) Revenue & Inflow
  // -------------------------
  // heading + table min space
  y = ensureSpace(doc, y, 80);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("1. REVENUE & INFLOW", 40, y);
  y += 10;

  autoTable(doc, {
    startY: y + 10,
    head: [["Metric", `Amount (${currency})`]],
    body: [
      ["Total Gross Sales (Z-Report)", money(report?.revenue?.totalGrossSales)],
      ["  - Cash Sales", money(report?.revenue?.cashSales)],
      ["  - Bank Sales", money(report?.revenue?.bankSales)],
      ["  - Credit Sales (Pending)", money(report?.revenue?.creditSales)],
      ["Add: Credit Recovery (Old Debts)", money(report?.revenue?.creditRecoveryTotal)],
      ["  - By Cash", money(report?.revenue?.creditRecoveryCash)],
      ["  - By Bank/Card", money(report?.revenue?.creditRecoveryBank)],
      ["TOTAL REVENUE GENERATED", money(report?.revenue?.totalRevenueGenerated)],
    ],
    theme: "plain",
    styles: { font: "helvetica", fontSize: 10, cellPadding: 6 },
    columnStyles: { 0: { halign: "left" }, 1: { halign: "right" } }, // ✅
    headStyles: { fillColor: [0, 51, 102], textColor: 255, fontStyle: "bold" },
    didParseCell: (data) => {
      if (data.row.index === 7) {
        data.cell.styles.fillColor = [0, 51, 102];
        data.cell.styles.textColor = 255;
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  y = doc.lastAutoTable.finalY + 25;

  // -------------------------
  // 2) Expenses
  // -------------------------
  y = ensureSpace(doc, y, 80);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("2. EXPENSES (VERIFIED)", 40, y);
  y += 10;

  const expenseRows =
    report?.expenses?.items?.length
      ? report.expenses.items.map((x) => [safeText(x.key), money(x.amount)])
      : [["No verified expenses", "0.00"]];

  autoTable(doc, {
    startY: y + 10,
    head: [["Expense Item", `Amount (${currency})`]],
    body: [...expenseRows, ["TOTAL EXPENSE INCURRED", money(report?.expenses?.totalExpenseIncurred)]],
    theme: "plain",
    styles: { font: "helvetica", fontSize: 10, cellPadding: 6 },
    columnStyles: { 0: { halign: "left" }, 1: { halign: "right" } }, // ✅
    headStyles: { fillColor: [0, 51, 102], textColor: 255, fontStyle: "bold" },
    didParseCell: (data) => {
      if (data.row.index === expenseRows.length) {
        data.cell.styles.fillColor = [0, 51, 102];
        data.cell.styles.textColor = 255;
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  y = doc.lastAutoTable.finalY + 25;

  // -------------------------
  // 3) Liability
  // (Your Reports.jsx/reportCalculations uses report.liabilities.itemsNet now)
  // We'll render itemsNet if available, else fallback.
  // -------------------------
  y = ensureSpace(doc, y, 80);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("3. CREDIT PURCHASE / LIABILITY", 40, y);
  y += 10;

  const itemsNet = Array.isArray(report?.liabilities?.itemsNet) ? report.liabilities.itemsNet : [];
  const liabRows =
    itemsNet.length
      ? itemsNet.map((x) => [safeText(`${x.key} (Created - Paid)`), money(x.balance)])
      : [["No liabilities", "0.00"]];

  autoTable(doc, {
    startY: y + 10,
    head: [["Supplier", `Amount (${currency})`]],
    body: [
      ...liabRows,
      ["Supplier Paid (Range)", money(report?.liabilities?.totalSupplierPaid)],
      ["TOTAL NEW LIABILITY", money(report?.liabilities?.totalNewLiability)],
    ],
    theme: "plain",
    styles: { font: "helvetica", fontSize: 10, cellPadding: 6 },
    columnStyles: { 0: { halign: "left" }, 1: { halign: "right" } }, // ✅
    headStyles: { fillColor: [120, 0, 0], textColor: 255, fontStyle: "bold" },
    didParseCell: (data) => {
      // last row = TOTAL NEW LIABILITY
      const lastRowIndex = liabRows.length + 1;
      if (data.row.index === lastRowIndex) {
        data.cell.styles.fillColor = [120, 0, 0];
        data.cell.styles.textColor = 255;
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  y = doc.lastAutoTable.finalY + 25;

  // -------------------------
  // Liquidity & Balance
  // -------------------------
  y = ensureSpace(doc, y, 80);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("LIQUIDITY & BALANCE", 40, y);
  y += 10;

  autoTable(doc, {
    startY: y + 10,
    head: [["Metric", `Amount (${currency})`]],
    body: [
      ["Total Cash Balance", money(report?.liquidity?.totalCashBalance)],
      ["Total Bank Balance", money(report?.liquidity?.totalBankBalance)],
      ["TOTAL RECEIVABLE (ASSET)", money(report?.liquidity?.totalReceivable)],
      ["Total Payable (Liability)", money(report?.liquidity?.totalPayable)],
      ["TOTAL LIQUID FUNDS", money(report?.liquidity?.totalLiquidFunds)],
    ],
    theme: "plain",
    styles: { font: "helvetica", fontSize: 10, cellPadding: 6 },
    columnStyles: { 0: { halign: "left" }, 1: { halign: "right" } }, // ✅
    headStyles: { fillColor: [0, 51, 102], textColor: 255, fontStyle: "bold" },
    didParseCell: (data) => {
      if (data.row.index === 4) {
        data.cell.styles.fillColor = [0, 120, 0];
        data.cell.styles.textColor = 255;
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  y = doc.lastAutoTable.finalY + 25;

  // -------------------------
  // DAILY CASH CHECK
  // ✅ MUST stay with metrics table (never leave heading alone at bottom)
  // -------------------------
  // Estimate required height: heading + gap + header + 5 rows
  const dailyCashRequired = 10 + 10 + 60; // safe
  y = ensureSpace(doc, y, dailyCashRequired);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("DAILY CASH CHECK", 40, y);
  y += 10;

  autoTable(doc, {
    startY: y + 10,
    head: [["Metric", `Amount (${currency})`]],
    body: [
      ["Opening Cash (From)", money(report?.cashCheck?.openingCash)],
      ["Net Cash Position (Range)", money(report?.cashCheck?.netCashPosition)],
      ["Expected Drawer (To)", money(report?.cashCheck?.expectedDrawer)],
      ["Actual Count (To)", money(report?.cashCheck?.actualCount)],
      ["VARIANCE", money(report?.cashCheck?.variance)],
    ],
    theme: "plain",
    styles: { font: "helvetica", fontSize: 10, cellPadding: 6 },
    columnStyles: { 0: { halign: "left" }, 1: { halign: "right" } }, // ✅
    headStyles: { fillColor: [0, 51, 102], textColor: 255, fontStyle: "bold" },
  });

  y = doc.lastAutoTable.finalY + 20;

  // -------------------------
  // Notes
  // -------------------------
  // ensure space for heading + a couple lines
  y = ensureSpace(doc, y, 80);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("ANALYST NOTES & ALERTS", 40, y);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);

  const notesText = safeText(report?.analystNotesText || "");
  const systemNotes = Array.isArray(report?.notes) ? report.notes : [];

  let notesY = y + 16;

  if (notesText) {
    const split = doc.splitTextToSize(notesText, pageWidth - 80);
    // if notes block doesn't fit, move to next page
    notesY = ensureSpace(doc, notesY, split.length * 12 + 24);
    doc.text(split, 40, notesY);
    notesY += split.length * 12 + 8;
  }

  if (systemNotes.length) {
    notesY = ensureSpace(doc, notesY, 40);

    doc.setFont("helvetica", "bold");
    doc.text("System Alerts:", 40, notesY);
    notesY += 14;

    doc.setFont("helvetica", "normal");
    for (const n of systemNotes) {
      const splitN = doc.splitTextToSize(`• ${safeText(n)}`, pageWidth - 80);
      notesY = ensureSpace(doc, notesY, splitN.length * 12 + 10);
      doc.text(splitN, 40, notesY);
      notesY += splitN.length * 12;
    }
  } else if (!notesText) {
    notesY = ensureSpace(doc, notesY, 20);
    doc.text("No alerts for today.", 40, notesY);
  }

  return doc;
}
