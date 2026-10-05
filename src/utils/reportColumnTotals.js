import { formatMoney } from "./money.js";

const SKIP_TOTAL_KEYS = new Set([
  "balance",
  "date",
  "ref",
  "party",
  "partyname",
  "description",
  "deliveryboy",
  "notes",
  "contact",
  "type",
  "payment",
  "bankaccount",
  "bankaccountname",
  "terminal",
  "customer",
  "location",
]);

const AMOUNT_KEYS = new Set([
  "in",
  "out",
  "debit",
  "credit",
  "amount",
  "bills",
  "totalamount",
  "shoppaid",
  "credit",
  "commission",
  "payable",
  "cash",
  "bank",
  "remaining",
  "sales",
  "expenses",
  "acquired",
  "repaid",
  "outstanding",
  "opening",
  "closing",
  "totalin",
  "totalout",
]);

export function isReportAmountColumn(col) {
  if (col?.align === "right") return true;
  return AMOUNT_KEYS.has(String(col?.key || "").toLowerCase());
}

export function isReportDataRow(row) {
  if (!row) return false;
  if (row._isTotal || row._isOpening) return false;
  const id = String(row.id || "");
  if (id === "__grand_total__" || id === "__opening__") return false;
  return true;
}

export function parseReportNumericCell(value) {
  if (value == null || value === "") return null;
  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "")
    .trim();
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === "-.") {
    return null;
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldSumColumn(col) {
  const key = String(col?.key || "").toLowerCase();
  if (!key || SKIP_TOTAL_KEYS.has(key)) return false;
  return isReportAmountColumn(col);
}

function formatTotalValue(sum, sampleValues) {
  if (!Number.isFinite(sum)) return "";
  const allIntegers = sampleValues.every(
    (value) => Number.isInteger(value) || Math.abs(value - Math.round(value)) < 1e-9
  );
  if (allIntegers) return String(Math.round(sum));
  return formatMoney(sum);
}

/**
 * Build a footer total row for report tables.
 * Sums right-aligned numeric columns; skips running-balance / label columns.
 */
export function buildReportColumnTotalRow(columns = [], rows = []) {
  const dataRows = (rows || []).filter(isReportDataRow);
  if (!dataRows.length || !columns.length) return null;

  const totalRow = {
    id: "__column_total__",
    _isTotal: true,
  };

  let hasAnyTotal = false;
  let labeled = false;

  columns.forEach((col, index) => {
    const key = col?.key;
    if (!key) return;

    if (!shouldSumColumn(col)) {
      if (!labeled && index === 0) {
        totalRow[key] = "Total";
        labeled = true;
      } else if (!labeled && !isReportAmountColumn(col)) {
        totalRow[key] = "Total";
        labeled = true;
      } else {
        totalRow[key] = "";
      }
      return;
    }

    const values = [];
    let sum = 0;
    dataRows.forEach((row) => {
      const parsed = parseReportNumericCell(row[key]);
      if (parsed == null) return;
      values.push(parsed);
      sum += parsed;
    });

    if (!values.length) {
      totalRow[key] = "";
      return;
    }

    hasAnyTotal = true;
    totalRow[key] = formatTotalValue(sum, values);
  });

  if (!hasAnyTotal) return null;
  if (!labeled) {
    const firstKey = columns[0]?.key;
    if (firstKey && totalRow[firstKey] === "") totalRow[firstKey] = "Total";
  }
  return totalRow;
}
