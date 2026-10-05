import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { formatDateTimeValue } from "./dateFormat.js";
import { formatMoney } from "./money.js";
import { openHtmlPrintWindow } from "./openPrintWindow.js";

function safeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function fileSafeName(value) {
  return safeText(value)
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .toLowerCase();
}

/**
 * Download a CSV from column + row objects.
 */
export function exportReportCsv({
  filename,
  columns,
  rows,
  title = "",
  rangeLabel = "",
}) {
  const headers = columns.map((col) => col.label || col.key);
  const lines = [];
  if (title) lines.push(csvEscape(title));
  if (rangeLabel) lines.push(csvEscape(rangeLabel));
  if (title || rangeLabel) lines.push("");
  lines.push(headers.map(csvEscape).join(","));
  rows.forEach((row) => {
    lines.push(
      columns
        .map((col) => csvEscape(row[col.key] ?? ""))
        .join(",")
    );
  });
  const blob = new Blob([`${lines.join("\n")}\n`], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${fileSafeName(filename || title || "report")}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Print/save a ledger-style PDF.
 */
export function exportReportPdf({
  shopName,
  title,
  rangeLabel,
  columns,
  rows,
}) {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const marginX = 36;
  let y = 40;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(safeText(shopName || "GTCT Analytics"), marginX, y);
  y += 18;
  doc.setFontSize(12);
  doc.text(safeText(title || "Report"), marginX, y);
  y += 14;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(safeText(rangeLabel || ""), marginX, y);
  doc.text(`Generated ${formatDateTimeValue(new Date())}`, marginX, y + 12);
  doc.setTextColor(20);
  y += 28;

  const columnStyles = {};
  columns.forEach((col, index) => {
    const key = String(col?.key || "").toLowerCase();
    const isAmount =
      col?.align === "right" ||
      ["in", "out", "balance", "debit", "credit", "amount"].includes(key);
    if (isAmount) {
      columnStyles[index] = { halign: "right", cellWidth: "wrap" };
    }
  });

  autoTable(doc, {
    startY: y,
    head: [columns.map((col) => col.label || col.key)],
    body: rows.map((row) =>
      columns.map((col) => String(row[col.key] ?? ""))
    ),
    styles: {
      fontSize: 8,
      cellPadding: 4,
      overflow: "linebreak",
      halign: "left",
    },
    headStyles: {
      fillColor: [30, 41, 59],
      textColor: 255,
      fontStyle: "bold",
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles,
    margin: { left: marginX, right: marginX },
  });

  doc.save(
    `${fileSafeName(title || "report")}_${fileSafeName(rangeLabel || "range")}.pdf`
  );
}

function money(value) {
  return formatMoney(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const AMOUNT_KEYS = new Set([
  "in",
  "out",
  "balance",
  "debit",
  "credit",
  "amount",
]);

function isAmountCol(col) {
  if (col?.align === "right") return true;
  return AMOUNT_KEYS.has(String(col?.key || "").toLowerCase());
}

function withPeriodTitle(title, rangeLabel) {
  const base = safeText(title || "Report");
  const period = safeText(rangeLabel || "");
  if (!period) return base;
  if (base.includes(period)) return base;
  return `${base} (${period})`;
}

function printShell({ shopName, title, rangeLabel, bodyHtml, landscape = true }) {
  const reportTitle = safeText(title || "Report");
  const period = safeText(rangeLabel || "");
  // Document title includes period once — used by Save as PDF filename.
  const docTitle = withPeriodTitle(reportTitle, period);
  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(docTitle)}</title>
    <style>
      @page { size: ${landscape ? "A4 landscape" : "A4"}; margin: 14mm; }
      * { box-sizing: border-box; }
      body {
        font-family: "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
        color: #0f172a;
        margin: 0;
        padding: 0;
        font-size: 12px;
        line-height: 1.45;
        background: #fff;
      }
      .sheet { max-width: 100%; }
      .brand-bar {
        height: 4px;
        background: linear-gradient(90deg, #2563eb 0%, #0ea5e9 55%, #14b8a6 100%);
        margin-bottom: 18px;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        gap: 16px;
        padding-bottom: 14px;
        margin-bottom: 18px;
        border-bottom: 1px solid #e2e8f0;
      }
      .header-left { min-width: 0; }
      .shop {
        margin: 0 0 4px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #64748b;
      }
      .report-title {
        margin: 0;
        font-size: 20px;
        font-weight: 700;
        letter-spacing: -0.02em;
        color: #0f172a;
      }
      .period {
        flex-shrink: 0;
        padding: 6px 10px;
        border-radius: 8px;
        background: #f1f5f9;
        color: #334155;
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        overflow: hidden;
      }
      th, td {
        border-bottom: 1px solid #e2e8f0;
        padding: 8px 10px;
        vertical-align: top;
        text-align: left;
      }
      th {
        background: #0f172a;
        color: #f8fafc;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      tbody tr:nth-child(even) td { background: #f8fafc; }
      tbody tr:last-child td { border-bottom: none; }
      td.num, th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .section {
        margin-top: 16px;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        overflow: hidden;
        background: #fff;
      }
      .section:first-child { margin-top: 0; }
      .section h3 {
        margin: 0;
        padding: 9px 12px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #475569;
        background: #f8fafc;
        border-bottom: 1px solid #e2e8f0;
      }
      .section-body { padding: 4px 12px 8px; }
      .line {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 16px;
        padding: 7px 0;
        border-bottom: 1px solid #f1f5f9;
      }
      .line:last-child { border-bottom: none; }
      .line.bold {
        font-weight: 700;
        margin-top: 2px;
        padding-top: 10px;
        border-top: 1px solid #e2e8f0;
        border-bottom: none;
      }
      .line .amt {
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        font-weight: 600;
      }
      .line.bold .amt { font-size: 13px; }
      .net-box {
        margin-top: 16px;
        padding: 12px 14px;
        border-radius: 10px;
        background: #0f172a;
        color: #fff;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
      }
      .net-box .label { font-size: 13px; font-weight: 700; }
      .net-box .amt {
        font-size: 18px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      @media print {
        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      }
    </style>
  </head>
  <body>
    <div class="sheet">
      <div class="brand-bar"></div>
      <header class="header">
        <div class="header-left">
          <p class="shop">${escapeHtml(shopName || "GTCT Analytics")}</p>
          <h1 class="report-title">${escapeHtml(reportTitle)}</h1>
        </div>
        ${
          period
            ? `<div class="period">${escapeHtml(period)}</div>`
            : ""
        }
      </header>
      ${bodyHtml}
    </div>
    <script>
      window.onload = function () {
        setTimeout(function () {
          window.focus();
          window.print();
        }, 200);
      };
    </script>
  </body>
</html>`;

  try {
    openHtmlPrintWindow(html, { width: 1100, height: 800, autoPrint: true });
    return true;
  } catch {
    alert("Popup blocked. Allow popups for this site to print or save as PDF.");
    return false;
  }
}

/**
 * Open browser print dialog for a ledger-style report (no auto-download).
 */
export function printReportDocument({
  shopName,
  title,
  rangeLabel,
  columns = [],
  rows = [],
}) {
  const head = columns
    .map((col) => {
      const right = isAmountCol(col);
      return `<th class="${right ? "num" : ""}">${escapeHtml(
        col.label || col.key
      )}</th>`;
    })
    .join("");
  const body = rows
    .map((row) => {
      const cells = columns
        .map((col) => {
          const right = isAmountCol(col);
          return `<td class="${right ? "num" : ""}">${escapeHtml(
            row[col.key] ?? ""
          )}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return printShell({
    shopName,
    title,
    rangeLabel,
    landscape: columns.length > 4,
    bodyHtml: `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
  });
}

/**
 * Open browser print dialog for P&L statement.
 */
export function printPnLDocument({ shopName, rangeLabel, pnl }) {
  const categories = pnl?.expenseCategories || [];
  const expenseLines = categories
    .map(
      (row) =>
        `<div class="line"><span>${escapeHtml(row.label)}</span><span class="amt">${escapeHtml(
          money(row.amount)
        )}</span></div>`
    )
    .join("");

  const revenueLinesHtml = (pnl?.revenueLines || []).length
    ? pnl.revenueLines
        .map(
          (line) =>
            `<div class="line"><span>${escapeHtml(line.label)}</span><span class="amt">${escapeHtml(
              money(line.amount)
            )}</span></div>`
        )
        .join("")
    : `<div class="line"><span>Sales Revenue</span><span class="amt">${escapeHtml(
        money(pnl?.totalRevenue)
      )}</span></div>`;

  const bodyHtml = `
    <div class="section">
      <h3>Revenue</h3>
      <div class="section-body">
        ${revenueLinesHtml}
        <div class="line bold"><span>Total Revenue</span><span class="amt">${escapeHtml(
          money(pnl?.totalRevenue)
        )}</span></div>
      </div>
    </div>
    <div class="section">
      <h3>Operating Expenses</h3>
      <div class="section-body">
        ${
          expenseLines ||
          `<div class="line"><span>No expenses</span><span class="amt">0.00</span></div>`
        }
        <div class="line bold"><span>Total Expenses</span><span class="amt">${escapeHtml(
          money(pnl?.totalExpenses)
        )}</span></div>
      </div>
    </div>
    <div class="net-box">
      <span class="label">Net Profit</span>
      <span class="amt">${escapeHtml(money(pnl?.netProfit))}</span>
    </div>
  `;

  return printShell({
    shopName,
    title: "Profit & Loss Statement",
    rangeLabel,
    landscape: false,
    bodyHtml,
  });
}

/**
 * Open browser print dialog for Cash Flow statement.
 */
export function printCashFlowDocument({ shopName, rangeLabel, cashflow }) {
  const sectionsHtml = (cashflow?.sections || [])
    .map((section) => {
      const lines = (section.lines || [])
        .map(
          (line) =>
            `<div class="line"><span>${escapeHtml(
              line.label
            )}</span><span class="amt">${escapeHtml(money(line.amount))}</span></div>`
        )
        .join("");
      return `
        <div class="section">
          <h3>${escapeHtml(section.title)}</h3>
          <div class="section-body">
            ${lines}
            <div class="line bold"><span>${escapeHtml(
              section.totalLabel
            )}</span><span class="amt">${escapeHtml(money(section.total))}</span></div>
          </div>
        </div>
      `;
    })
    .join("");

  return printShell({
    shopName,
    title: "Cash Flow Statement",
    rangeLabel,
    landscape: false,
    bodyHtml: sectionsHtml || "<p>No cash flow data.</p>",
  });
}

/**
 * CSV export for categorical Profit & Loss statement.
 */
export function exportPnLCsv({
  filename,
  shopName,
  rangeLabel,
  pnl,
}) {
  const lines = [
    csvEscape(`${shopName || "Shop"} — Profit & Loss Statement`),
    csvEscape(rangeLabel || ""),
    "",
    "Section,Line Item,Amount",
  ];
  if ((pnl?.revenueLines || []).length) {
    pnl.revenueLines.forEach((line) => {
      lines.push(`Revenue,${csvEscape(line.label)},${money(line.amount)}`);
    });
  } else {
    lines.push(`Revenue,Sales Revenue,${money(pnl?.totalRevenue)}`);
  }
  lines.push(`Revenue,Total Revenue,${money(pnl?.totalRevenue)}`);
  (pnl?.expenseCategories || []).forEach((row) => {
    lines.push(
      `Operating Expenses,${csvEscape(row.label)},${money(row.amount)}`
    );
  });
  lines.push(
    `Operating Expenses,Total Expenses,${money(pnl?.totalExpenses)}`,
    `Net Profit,Net Profit,${money(pnl?.netProfit)}`
  );

  const blob = new Blob([`${lines.join("\n")}\n`], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${fileSafeName(filename || "profit_loss")}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * PDF export for categorical Profit & Loss statement.
 */
export function exportPnLPdf({ shopName, rangeLabel, pnl }) {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const marginX = 48;
  let y = 48;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(safeText(shopName || "GTCT Analytics"), marginX, y);
  y += 18;
  doc.setFontSize(12);
  doc.text("Profit & Loss Statement", marginX, y);
  y += 14;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(safeText(rangeLabel || ""), marginX, y);
  doc.text(`Generated ${formatDateTimeValue(new Date())}`, marginX, y + 12);
  doc.setTextColor(20);
  y += 32;

  const revenueBody = (pnl?.revenueLines || []).length
    ? pnl.revenueLines.map((line) => [
        "Revenue",
        line.label,
        money(line.amount),
      ])
    : [["Revenue", "Sales Revenue", money(pnl?.totalRevenue)]];
  const body = [
    ...revenueBody,
    ["Revenue", "Total Revenue", money(pnl?.totalRevenue)],
    ...(pnl?.expenseCategories || []).map((row) => [
      "Operating Expenses",
      row.label,
      money(row.amount),
    ]),
    ["Operating Expenses", "Total Expenses", money(pnl?.totalExpenses)],
    ["Net Profit", "Net Profit", money(pnl?.netProfit)],
  ];

  autoTable(doc, {
    startY: y,
    head: [["Section", "Line Item", "Amount"]],
    body,
    styles: { fontSize: 9, cellPadding: 5 },
    headStyles: {
      fillColor: [30, 41, 59],
      textColor: 255,
      fontStyle: "bold",
    },
    columnStyles: {
      2: { halign: "right" },
    },
    margin: { left: marginX, right: marginX },
  });

  doc.save(
    `${fileSafeName("profit_loss")}_${fileSafeName(rangeLabel || "range")}.pdf`
  );
}

/**
 * CSV export for Cash Flow Statement.
 */
export function exportCashFlowCsv({
  filename,
  shopName,
  rangeLabel,
  cashflow,
}) {
  const lines = [
    csvEscape(`${shopName || "Shop"} — Cash Flow Statement`),
    csvEscape(rangeLabel || ""),
    "",
    "Section,Line Item,Amount",
  ];
  (cashflow?.sections || []).forEach((section) => {
    (section.lines || []).forEach((line) => {
      lines.push(
        `${csvEscape(section.title)},${csvEscape(line.label)},${money(line.amount)}`
      );
    });
    lines.push(
      `${csvEscape(section.title)},${csvEscape(section.totalLabel)},${money(section.total)}`
    );
  });

  const blob = new Blob([`${lines.join("\n")}\n`], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${fileSafeName(filename || "cash_flow")}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * PDF export for Cash Flow Statement.
 */
export function exportCashFlowPdf({ shopName, rangeLabel, cashflow }) {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const marginX = 48;
  let y = 48;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(safeText(shopName || "GTCT Analytics"), marginX, y);
  y += 18;
  doc.setFontSize(12);
  doc.text("Cash Flow Statement", marginX, y);
  y += 14;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(safeText(rangeLabel || ""), marginX, y);
  doc.text(`Generated ${formatDateTimeValue(new Date())}`, marginX, y + 12);
  doc.setTextColor(20);
  y += 32;

  const body = [];
  (cashflow?.sections || []).forEach((section) => {
    (section.lines || []).forEach((line) => {
      body.push([section.title, line.label, money(line.amount)]);
    });
    body.push([section.title, section.totalLabel, money(section.total)]);
  });

  autoTable(doc, {
    startY: y,
    head: [["Section", "Line Item", "Amount"]],
    body,
    styles: { fontSize: 9, cellPadding: 5 },
    headStyles: {
      fillColor: [30, 41, 59],
      textColor: 255,
      fontStyle: "bold",
    },
    columnStyles: { 2: { halign: "right" } },
    margin: { left: marginX, right: marginX },
  });

  doc.save(
    `${fileSafeName("cash_flow")}_${fileSafeName(rangeLabel || "range")}.pdf`
  );
}
