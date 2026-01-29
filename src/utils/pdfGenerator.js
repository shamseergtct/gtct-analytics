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

function fmtDateStr(s) {
  return safeText(s);
}

// ✅ Helpers: keep section title with its table
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

// ✅ Apply right-align to Amount header + values
function applyRightAlignAmountHeader(data) {
  if (data.section === "head" && data.column.index === 1) {
    data.cell.styles.halign = "right";
  }
  if (data.section === "body" && data.column.index === 1) {
    data.cell.styles.halign = "right";
  }
}

export function generateDailyPDF({ clientName, reportDate, currency, report }) {
  const doc = new jsPDF("p", "pt", "a4");
  const pageWidth = doc.internal.pageSize.getWidth();

  // Header bar
  doc.setFillColor(0, 51, 102);
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
  y = ensureSpace(doc, y, 100);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("1. REVENUE & INFLOW", 40, y);
  y += 10;

  const otherIncomeDetails = Array.isArray(report?.revenue?.otherIncomeDetails)
    ? report.revenue.otherIncomeDetails
    : [];

  const revenueRows = [
    ["Total Gross Sales (Z-Report)", money(report?.revenue?.totalGrossSales)],
    ["  - Cash Sales", money(report?.revenue?.cashSales)],
    ["  - Bank Sales", money(report?.revenue?.bankSales)],
    ["  - Credit Sales (Pending)", money(report?.revenue?.creditSales)],
    ["Add: Credit Recovery (Old Debts)", money(report?.revenue?.creditRecoveryTotal)],
    ["  - By Cash", money(report?.revenue?.creditRecoveryCash)],
    ["  - By Bank/Card", money(report?.revenue?.creditRecoveryBank)],
  ];

  // ✅ Insert other income rows (Collected from MD etc.) without losing totals
  for (const r of otherIncomeDetails) {
    revenueRows.push([safeText(r?.label || "Other Income"), money(r?.amount)]);
  }

  revenueRows.push(["TOTAL REVENUE GENERATED", money(report?.revenue?.totalRevenueGenerated)]);

  autoTable(doc, {
    startY: y + 10,
    head: [["Metric", `Amount (${currency})`]],
    body: revenueRows,
    theme: "plain",
    styles: { font: "helvetica", fontSize: 10, cellPadding: 6 },
    headStyles: { fillColor: [0, 51, 102], textColor: 255, fontStyle: "bold" },
    columnStyles: { 0: { halign: "left" }, 1: { halign: "right" } },
    didParseCell: (data) => {
      applyRightAlignAmountHeader(data);
      // last row highlight
      if (data.section === "body" && data.row.index === revenueRows.length - 1) {
        data.cell.styles.fillColor = [0, 51, 102];
        data.cell.styles.textColor = 255;
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  y = doc.lastAutoTable.finalY + 25;

  // -------------------------
  // 2) Expense Summary (Detailed) ✅
  // -------------------------
  y = ensureSpace(doc, y, 90);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("2. EXPENSE SUMMARY (DETAILED)", 40, y);
  y += 10;

  const summaryRowsRaw = Array.isArray(report?.expenseSummaryDetailed?.rows)
    ? report.expenseSummaryDetailed.rows
    : [];

  const summaryRows = summaryRowsRaw
    .filter((x) => Number(x?.amount || 0) !== 0)
    .map((x) => [safeText(x.label), money(x.amount)]);

  // only print if something exists; else skip table entirely
  if (summaryRows.length) {
    autoTable(doc, {
      startY: y + 10,
      head: [[`Expense Summary (Type + Category + Mode)`, `Amount (${currency})`]],
      body: [...summaryRows, ["TOTAL EXPENSE INCURRED", money(report?.expenses?.totalExpenseIncurred)]],
      theme: "plain",
      styles: { font: "helvetica", fontSize: 10, cellPadding: 6 },
      headStyles: { fillColor: [0, 51, 102], textColor: 255, fontStyle: "bold" },
      columnStyles: { 0: { halign: "left" }, 1: { halign: "right" } },
      didParseCell: (data) => {
        applyRightAlignAmountHeader(data);
        if (data.section === "body" && data.row.index === summaryRows.length) {
          data.cell.styles.fillColor = [0, 51, 102];
          data.cell.styles.textColor = 255;
          data.cell.styles.fontStyle = "bold";
        }
      },
    });

    y = doc.lastAutoTable.finalY + 25;
  } else {
    y += 10; // small gap if no summary rows
  }

  // -------------------------
  // 3) Expenses Verified (List) ✅ party + ascending order
  // -------------------------
  y = ensureSpace(doc, y, 90);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("3. EXPENSES (VERIFIED)", 40, y);
  y += 10;

  const expenseDetails = Array.isArray(report?.expenses?.details) ? report.expenses.details : [];

  const expenseRows = expenseDetails
    .filter((x) => Number(x?.amount || 0) !== 0)
    .map((x) => [safeText(x.label), money(x.amount)]);

  if (expenseRows.length) {
    autoTable(doc, {
      startY: y + 10,
      head: [["Expense (Type + Category + Party + Date)", `Amount (${currency})`]],
      body: [...expenseRows, ["TOTAL EXPENSE INCURRED", money(report?.expenses?.totalExpenseIncurred)]],
      theme: "plain",
      styles: { font: "helvetica", fontSize: 10, cellPadding: 6 },
      headStyles: { fillColor: [0, 51, 102], textColor: 255, fontStyle: "bold" },
      columnStyles: { 0: { halign: "left" }, 1: { halign: "right" } },
      didParseCell: (data) => {
        applyRightAlignAmountHeader(data);
        if (data.section === "body" && data.row.index === expenseRows.length) {
          data.cell.styles.fillColor = [0, 51, 102];
          data.cell.styles.textColor = 255;
          data.cell.styles.fontStyle = "bold";
        }
      },
    });

    y = doc.lastAutoTable.finalY + 25;
  } else {
    y += 10;
  }

  // -------------------------
  // 4) Credit Purchase / Liability (ONLY credit purchases with date)
  // -------------------------
  y = ensureSpace(doc, y, 90);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("4. CREDIT PURCHASE / LIABILITY", 40, y);
  y += 10;

  const creditPurchases = Array.isArray(report?.liabilities?.creditPurchases)
    ? report.liabilities.creditPurchases
    : [];

  const liabRows = creditPurchases.length
    ? creditPurchases.map((x) => [
        safeText(`${x.supplier}${x.date ? ` (${fmtDateStr(x.date)})` : ""}`),
        money(x.amount),
      ])
    : [];

  if (liabRows.length) {
    autoTable(doc, {
      startY: y + 10,
      head: [["Credit Purchase (Supplier + Date)", `Amount (${currency})`]],
      body: [
        ...liabRows,
        ["Supplier Paid (Range)", money(report?.liabilities?.totalSupplierPaid)],
        ["TOTAL NEW LIABILITY (Created - Paid)", money(report?.liabilities?.totalNewLiability)],
      ],
      theme: "plain",
      styles: { font: "helvetica", fontSize: 10, cellPadding: 6 },
      headStyles: { fillColor: [120, 0, 0], textColor: 255, fontStyle: "bold" },
      columnStyles: { 0: { halign: "left" }, 1: { halign: "right" } },
      didParseCell: (data) => {
        applyRightAlignAmountHeader(data);
        const lastRowIndex = liabRows.length + 1;
        if (data.section === "body" && data.row.index === lastRowIndex) {
          data.cell.styles.fillColor = [120, 0, 0];
          data.cell.styles.textColor = 255;
          data.cell.styles.fontStyle = "bold";
        }
      },
    });

    y = doc.lastAutoTable.finalY + 25;
  } else {
    y += 10;
  }

  // -------------------------
  // Liquidity & Balance
  // -------------------------
  y = ensureSpace(doc, y, 90);

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
    headStyles: { fillColor: [0, 51, 102], textColor: 255, fontStyle: "bold" },
    columnStyles: { 0: { halign: "left" }, 1: { halign: "right" } },
    didParseCell: (data) => {
      applyRightAlignAmountHeader(data);
      if (data.section === "body" && data.row.index === 5) {
  const neg = Number(quick?.totalBalance || 0) < -0.009;
  data.cell.styles.fillColor = neg ? [120, 0, 0] : [0, 120, 0];
  data.cell.styles.textColor = 255;
  data.cell.styles.fontStyle = "bold";
}

    },
  });

  y = doc.lastAutoTable.finalY + 25;

  // -------------------------
  // DAILY CASH CHECK
  // -------------------------
  const dailyCashRequired = 10 + 10 + 70;
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
    headStyles: { fillColor: [0, 51, 102], textColor: 255, fontStyle: "bold" },
    columnStyles: { 0: { halign: "left" }, 1: { halign: "right" } },
    didParseCell: (data) => {
      applyRightAlignAmountHeader(data);
    },
  });

  y = doc.lastAutoTable.finalY + 20;

  // -------------------------
  // Notes
  // -------------------------
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

// ========================================
// ✅ QUICK REPORT PDF (Client-share friendly)
// ========================================
export function generateQuickPDF({ clientName, reportDate, currency, quick }) {
  const doc = new jsPDF("p", "pt", "a4");
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  const isNeg = Boolean(quick?.isNegative);

  // Header bar
  doc.setFillColor(0, 51, 102);
  doc.rect(0, 0, pageWidth, 70, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("GTCT - QUICK REPORT", 40, 42);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(`Client: ${safeText(clientName)}`, pageWidth - 40, 28, { align: "right" });
  doc.text(`Range: ${safeText(reportDate)}`, pageWidth - 40, 45, { align: "right" });

  // Status chip (avoid emoji)
  const chipText =
    safeText(quick?.pdfStatusText) ||
    (isNeg ? "ALERT: NEGATIVE" : "HEALTHY: POSITIVE");

  const chipW = 170;
  const chipH = 22;
  const chipX = pageWidth - 40 - chipW;
  const chipY = 78;

  doc.setFillColor(isNeg ? 160 : 0, isNeg ? 0 : 150, 0);
  doc.roundedRect(chipX, chipY, chipW, chipH, 10, 10, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text(chipText, chipX + chipW / 2, chipY + 15, { align: "center" });

  // Subtitle
  doc.setTextColor(50, 50, 50);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text("Snapshot for quick understanding & sharing.", 40, 115);

  let y = 135;

  const rows = [
  ["Total Sales (NET)", money(quick?.totalSales)],
  ["Total Expense", money(quick?.totalExpense)],
  ["Balance (Range)", money(quick?.rangeBalance)],

  ["Cash Balance (Till Date)", money(quick?.cashBalance)],
  ["Bank Balance (Till Date)", money(quick?.bankBalance)],
  ["Total Balance (Cash + Bank)", money(quick?.totalBalance)],

  ["Total Receivable", money(quick?.receivable)],
  ["Total Payable", money(quick?.payable)],
  ["Net Position (Bal + Rec - Pay)", money(quick?.netPosition)],
];


  autoTable(doc, {
    startY: y,
    head: [["Metric", `Amount (${currency})`]],
    body: rows,
    theme: "plain",
    styles: { font: "helvetica", fontSize: 11, cellPadding: 7 },
    headStyles: { fillColor: [0, 51, 102], textColor: 255, fontStyle: "bold" },
    columnStyles: { 0: { halign: "left" }, 1: { halign: "right" } },
    didParseCell: (data) => {
      applyRightAlignAmountHeader(data);

      // highlight Total Balance row
      if (data.section === "body" && data.row.index === 5) {
        const neg = Number(quick?.totalBalance || 0) < -0.009;
        data.cell.styles.fillColor = neg ? [120, 0, 0] : [0, 120, 0];
        data.cell.styles.textColor = 255;
        data.cell.styles.fontStyle = "bold";
      }

      // highlight Net Position row
      if (data.section === "body" && data.row.index === 8) {
        const neg = Number(quick?.netPosition || 0) < -0.009;
        data.cell.styles.fillColor = neg ? [120, 0, 0] : [0, 120, 0];
        data.cell.styles.textColor = 255;
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  y = doc.lastAutoTable.finalY + 20;

  // Message box (avoid emoji + sanitize)
  const msg =
    safeText(quick?.pdfAdviceText) ||
    safeText(
      isNeg
        ? "Balance is negative. Please review payments, discounts, and cash drawer count."
        : "Balance is positive. Keep monitoring receivables/payables to maintain liquidity."
    );

  doc.setDrawColor(isNeg ? 160 : 0, isNeg ? 0 : 150, 0);
  doc.setFillColor(isNeg ? 255 : 235, isNeg ? 235 : 255, 235);
  doc.roundedRect(40, y, pageWidth - 80, 55, 12, 12, "FD");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(30, 30, 30);

  const split = doc.splitTextToSize(msg, pageWidth - 120);
  doc.text(split, 60, y + 24);

  // Footer
  doc.setTextColor(120, 120, 120);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text("Generated by GTCT Analytics", 40, pageHeight - 18);

  return doc;
}

