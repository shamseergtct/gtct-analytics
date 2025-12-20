// src/utils/pdfGenerator.js
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

function money(v) {
  const n = Number(v || 0);
  return n.toFixed(2);
}

export function generateDailyPDF({ clientName, reportDate, currency = "BHD", report }) {
  const doc = new jsPDF("p", "mm", "a4");

  // Colors
  const DARK_BLUE = [0, 51, 102]; // #003366
  const LIGHT_BG = [245, 246, 248];
  const GREEN_BG = [224, 247, 238];
  const GREEN_BORDER = [33, 150, 83];
  const RED_BG = [255, 235, 238];
  const RED_BORDER = [211, 47, 47];
  const TEXT_GRAY = [90, 90, 90];

  // ---------------- Header ----------------
  doc.setFillColor(...LIGHT_BG);
  doc.rect(0, 0, 210, 28, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(0, 0, 0);
  doc.text("GTCT", 14, 18);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...TEXT_GRAY);
  doc.text("THE DAILY PULSE", 14, 23);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(0, 0, 0);
  doc.text("Financial Position Report", 196, 14, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(`Client: ${clientName || "Client Name"}`, 196, 20, { align: "right" });
  doc.text(`Date: ${reportDate || "YYYY-MM-DD"}`, 196, 25, { align: "right" });

  // Divider
  doc.setDrawColor(...DARK_BLUE);
  doc.setLineWidth(1);
  doc.line(14, 32, 196, 32);

  // ---------------- Status Box ----------------
  const healthy = !!report?.status?.healthy;
  const statusBg = healthy ? GREEN_BG : RED_BG;
  const statusBorder = healthy ? GREEN_BORDER : RED_BORDER;

  const statusY = 36;
  doc.setFillColor(...statusBg);
  doc.setDrawColor(...statusBorder);
  doc.setLineWidth(1);
  doc.roundedRect(14, statusY, 182, 18, 2, 2, "FD");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(...statusBorder);
  doc.text(report?.status?.statusText || (healthy ? "HEALTHY" : "ACTION REQUIRED"), 105, statusY + 7, {
    align: "center",
  });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...TEXT_GRAY);
  doc.text(report?.status?.statusSub || "", 105, statusY + 13, { align: "center" });

  // Section bar helper
  function sectionTitle(text, y, color = DARK_BLUE) {
    doc.setFillColor(...color);
    doc.rect(14, y, 182, 8, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(text, 18, y + 5.5);
  }

  // ---------------- 1. Revenue & Inflow ----------------
  let y = 58;
  sectionTitle("1. REVENUE & INFLOW", y);
  y += 10;

  autoTable(doc, {
    startY: y,
    head: [["Metric", `Amount (${currency})`]],
    body: [
      ["Total Gross Sales (Z-Report)", money(report?.revenue?.totalGrossSales)],
      ["  - Cash Sales", money(report?.revenue?.cashSales)],
      ["  - Bank Sales", money(report?.revenue?.bankSales)],
      ["  - Credit Sales (Pending)", money(report?.revenue?.creditSales)],
      ["Add: Credit Recovery (Old Debts)", money(report?.revenue?.creditRecoveryTotal)],
      ["  - By Cash", money(report?.revenue?.creditRecoveryCash)],
      ["  - By Bank/Card", money(report?.revenue?.creditRecoveryBank)],
    ],
    theme: "grid",
    styles: { font: "helvetica", fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: [235, 236, 238], textColor: 20, fontStyle: "bold" },
    columnStyles: { 0: { cellWidth: 120 }, 1: { cellWidth: 62, halign: "right" } },
  });

  y = doc.lastAutoTable.finalY + 2;
  autoTable(doc, {
    startY: y,
    body: [["TOTAL REVENUE GENERATED", money(report?.revenue?.totalRevenueGenerated)]],
    theme: "grid",
    styles: { font: "helvetica", fontSize: 9, cellPadding: 2.5, fontStyle: "bold" },
    bodyStyles: { fillColor: [230, 238, 255] },
    columnStyles: { 0: { cellWidth: 120 }, 1: { cellWidth: 62, halign: "right" } },
  });

  // ---------------- 2. Expenses (Verified) ----------------
  y = doc.lastAutoTable.finalY + 6;
  sectionTitle("2. EXPENSES (VERIFIED)", y);
  y += 10;

  const expItems =
    report?.expenses?.items?.length
      ? report.expenses.items.map((r) => [String(r.key || "Expense"), money(r.amount)])
      : [["No verified expenses", ""]];

  autoTable(doc, {
    startY: y,
    head: [["Expense Item", `Amount (${currency})`]],
    body: expItems,
    theme: "grid",
    styles: { font: "helvetica", fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: [235, 236, 238], textColor: 20, fontStyle: "bold" },
    columnStyles: { 0: { cellWidth: 120 }, 1: { cellWidth: 62, halign: "right" } },
  });

  y = doc.lastAutoTable.finalY + 2;
  autoTable(doc, {
    startY: y,
    body: [["TOTAL EXPENSE INCURRED", money(report?.expenses?.totalExpenseIncurred)]],
    theme: "grid",
    styles: { font: "helvetica", fontSize: 9, cellPadding: 2.5, fontStyle: "bold" },
    bodyStyles: { fillColor: [235, 236, 238] },
    columnStyles: { 0: { cellWidth: 120 }, 1: { cellWidth: 62, halign: "right" } },
  });

  // ---------------- 3. Credit Purchase / Liability ----------------
  y = doc.lastAutoTable.finalY + 6;
  sectionTitle("3. CREDIT PURCHASE / LIABILITY", y, [178, 34, 34]);
  y += 10;

  const liabItems =
    report?.liabilities?.items?.length
      ? report.liabilities.items.map((r) => [String(r.key || "Liability"), money(r.amount)])
      : [["No liabilities", ""]];

  autoTable(doc, {
    startY: y,
    head: [["Liability Item (Unpaid Bills)", `Amount (${currency})`]],
    body: liabItems,
    theme: "grid",
    styles: { font: "helvetica", fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: [255, 235, 238], textColor: 120, fontStyle: "bold" },
    columnStyles: { 0: { cellWidth: 120 }, 1: { cellWidth: 62, halign: "right" } },
  });

  y = doc.lastAutoTable.finalY + 2;
  autoTable(doc, {
    startY: y,
    body: [["TOTAL NEW LIABILITY", money(report?.liabilities?.totalNewLiability)]],
    theme: "grid",
    styles: { font: "helvetica", fontSize: 9, cellPadding: 2.5, fontStyle: "bold" },
    bodyStyles: { fillColor: [255, 235, 238], textColor: 120 },
    columnStyles: { 0: { cellWidth: 120 }, 1: { cellWidth: 62, halign: "right" } },
  });

  // ---------------- Bottom Cards ----------------
  y = doc.lastAutoTable.finalY + 8;

  if (y > 230) {
    doc.addPage();
    y = 20;
  }

  const boxW = 88;
  const boxH = 42;
  const leftX = 14;
  const rightX = 108;

  doc.setDrawColor(210);
  doc.setFillColor(255, 255, 255);

  // Liquidity & Balance
  doc.roundedRect(leftX, y, boxW, boxH, 2, 2, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(40);
  doc.text("LIQUIDITY & BALANCE (TILL DATE)", leftX + 3, y + 7);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text("Total Cash Balance:", leftX + 3, y + 16);
  doc.text(money(report?.liquidity?.totalCashBalance), leftX + boxW - 3, y + 16, { align: "right" });

  doc.text("Total Bank Balance:", leftX + 3, y + 23);
  doc.text(money(report?.liquidity?.totalBankBalance), leftX + boxW - 3, y + 23, { align: "right" });

  doc.setFillColor(230, 238, 255);
  doc.roundedRect(leftX + 2, y + 28, boxW - 4, 10, 2, 2, "F");
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20);
  doc.text("TOTAL RECEIVABLE (ASSET)", leftX + 5, y + 35);
  doc.text(money(report?.liquidity?.totalReceivable), leftX + boxW - 5, y + 35, { align: "right" });

  // Daily Cash Check
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(rightX, y, boxW, boxH, 2, 2, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(40);
  doc.text("DAILY CASH CHECK", rightX + 3, y + 7);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text("Opening Cash:", rightX + 3, y + 16);
  doc.text(money(report?.cashCheck?.openingCash), rightX + boxW - 3, y + 16, { align: "right" });

  doc.text("Net Cash Position:", rightX + 3, y + 23);
  doc.text(money(report?.cashCheck?.netCashPosition), rightX + boxW - 3, y + 23, { align: "right" });

  doc.setFont("helvetica", "bold");
  doc.text("Expected Drawer:", rightX + 3, y + 30);
  doc.text(money(report?.cashCheck?.expectedDrawer), rightX + boxW - 3, y + 30, { align: "right" });

  doc.setTextColor(30, 80, 200);
  doc.text("Actual Count:", rightX + 3, y + 37);
  doc.text(money(report?.cashCheck?.actualCount), rightX + boxW - 3, y + 37, { align: "right" });

  // Variance
  const varianceY = y + boxH + 6;

  doc.setFillColor(245, 246, 248);
  doc.roundedRect(rightX, varianceY, boxW, 22, 2, 2, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(80, 80, 80);
  doc.text("VARIANCE", rightX + boxW / 2, varianceY + 7, { align: "center" });
  doc.setFontSize(14);
  doc.setTextColor(20);
  doc.text(money(report?.cashCheck?.variance), rightX + boxW / 2, varianceY + 16, { align: "center" });

  // Total Liquid Funds + Payable
  doc.setFillColor(224, 247, 238);
  doc.roundedRect(leftX, varianceY, boxW, 22, 2, 2, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(20, 100, 60);
  doc.text("TOTAL LIQUID FUNDS", leftX + 4, varianceY + 8);
  doc.setFontSize(12);
  doc.text(money(report?.liquidity?.totalLiquidFunds), leftX + boxW - 4, varianceY + 16, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(150, 50, 50);
  doc.text("Total Payable (Liability):", leftX + 4, varianceY + 30);
  doc.text(money(report?.liquidity?.totalPayable), leftX + boxW - 4, varianceY + 30, { align: "right" });

  // Notes
  const notesY = varianceY + 36;
  doc.setDrawColor(...DARK_BLUE);
  doc.setLineWidth(1);
  doc.line(14, notesY, 196, notesY);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text("ANALYST NOTES & ALERTS", 14, notesY + 10);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(120);

  const notesText = (report?.notes || []).join(" • ");
  doc.text(notesText || "No alerts for today.", 14, notesY + 17);

  // Footer
  doc.setFontSize(8);
  doc.setTextColor(160);
  doc.text("Generated by GTCT Systems • Confidential", 105, 290, { align: "center" });

  return doc;
}
