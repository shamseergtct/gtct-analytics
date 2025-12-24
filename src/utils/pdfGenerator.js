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

  // 1) Revenue & Inflow
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

  // 2) Expenses
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

  // 3) Liability
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("3. CREDIT PURCHASE / LIABILITY", 40, y);
  y += 10;

  const liabRows =
    report?.liabilities?.items?.length
      ? report.liabilities.items.map((x) => [safeText(x.key), money(x.amount)])
      : [["No liabilities", "0.00"]];

  autoTable(doc, {
    startY: y + 10,
    head: [["Supplier", `Amount (${currency})`]],
    body: [...liabRows, ["TOTAL NEW LIABILITY", money(report?.liabilities?.totalNewLiability)]],
    theme: "plain",
    styles: { font: "helvetica", fontSize: 10, cellPadding: 6 },
    headStyles: { fillColor: [120, 0, 0], textColor: 255, fontStyle: "bold" },
    didParseCell: (data) => {
      if (data.row.index === liabRows.length) {
        data.cell.styles.fillColor = [120, 0, 0];
        data.cell.styles.textColor = 255;
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  y = doc.lastAutoTable.finalY + 25;

  // Liquidity + Cash Check (compact)
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
    didParseCell: (data) => {
      if (data.row.index === 4) {
        data.cell.styles.fillColor = [0, 120, 0];
        data.cell.styles.textColor = 255;
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  y = doc.lastAutoTable.finalY + 25;

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
  });

  y = doc.lastAutoTable.finalY + 20;

  // Notes
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
    doc.text(split, 40, notesY);
    notesY += split.length * 12 + 8;
  }

  if (systemNotes.length) {
    doc.setFont("helvetica", "bold");
    doc.text("System Alerts:", 40, notesY);
    notesY += 14;

    doc.setFont("helvetica", "normal");
    for (const n of systemNotes) {
      const splitN = doc.splitTextToSize(`• ${safeText(n)}`, pageWidth - 80);
      doc.text(splitN, 40, notesY);
      notesY += splitN.length * 12;
    }
  } else if (!notesText) {
    doc.text("No alerts for today.", 40, notesY);
  }

  return doc;
}
