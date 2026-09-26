import { fetchTxnRange } from "./txnReportsApi.js";
import {
  collection,
  getDocs,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { toYYYYMMDD } from "./reportDateRange.js";
import { formatIsoDate } from "./dateFormat.js";

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function titleCaseCategory(value) {
  const raw = String(value || "Uncategorized").trim();
  if (!raw) return "Uncategorized";
  return raw
    .toLowerCase()
    .split(/[\s_]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Recurring / fixed-cost category keywords (case-insensitive). */
const RECURRING_KEYWORDS = [
  "rent",
  "wage",
  "wages",
  "salary",
  "salaries",
  "payroll",
  "maintenance",
  "utility",
  "utilities",
  "electric",
  "electricity",
  "water",
  "internet",
  "insurance",
  "subscription",
  "lease",
];

function isRecurringCategory(category) {
  const key = String(category || "")
    .trim()
    .toLowerCase();
  if (!key) return false;
  return RECURRING_KEYWORDS.some(
    (word) => key === word || key.includes(word)
  );
}

function shiftYearIso(yyyyMmDd, deltaYears = -1) {
  const match = String(yyyyMmDd || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  const year = Number(match[1]) + deltaYears;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12, 0, 0);
  // Clamp invalid dates (e.g. Feb 29 → Feb 28).
  if (date.getMonth() !== month - 1) {
    return toYYYYMMDD(new Date(year, month, 0, 12, 0, 0));
  }
  return toYYYYMMDD(date);
}

function dayDiff(fromDate, toDate) {
  const a = new Date(`${fromDate}T12:00:00`);
  const b = new Date(`${toDate}T12:00:00`);
  return Math.max(0, Math.round((b - a) / 86400000));
}

function pnlOutflowAmount(row) {
  const total = num(row?.totalAmount);
  const amountIn = num(row?.amountIn);
  const amountOut = num(row?.amountOut);
  const mode = String(row?.mode || row?.paymentMode || "")
    .trim()
    .toLowerCase();
  if (mode === "credit" || mode.startsWith("cre")) {
    return total || amountOut || amountIn;
  }
  return total || amountOut || amountIn;
}

function txnBusinessDate(row) {
  if (typeof row?.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(row.date)) {
    return row.date.slice(0, 10);
  }
  if (row?.date?.toDate) return toYYYYMMDD(row.date.toDate());
  if (row?.dateMs) return toYYYYMMDD(new Date(num(row.dateMs)));
  return "";
}

async function fetchZReportsInRange(clientId, fromDate, toDate) {
  const zQuery = query(
    collection(db, "z_reports"),
    where("clientId", "==", clientId),
    where("businessDate", ">=", fromDate),
    where("businessDate", "<=", toDate),
    orderBy("businessDate", "asc")
  );
  const snap = await getDocs(zQuery);
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

function bucketKeyForDate(isoDate, granularity) {
  if (!isoDate) return "";
  if (granularity === "month") return isoDate.slice(0, 7); // YYYY-MM
  return isoDate; // daily
}

function bucketLabel(key, granularity) {
  if (!key) return "";
  if (granularity === "month") {
    const [y, m] = key.split("-").map(Number);
    const date = new Date(y, m - 1, 1);
    return date.toLocaleString(undefined, { month: "short", year: "numeric" });
  }
  return formatIsoDate(key) || key;
}

function emptySeriesMap(fromDate, toDate, granularity) {
  const map = new Map();
  const start = new Date(`${fromDate}T12:00:00`);
  const end = new Date(`${toDate}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return map;

  if (granularity === "month") {
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    const last = new Date(end.getFullYear(), end.getMonth(), 1);
    while (cursor <= last) {
      const key = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}`;
      map.set(key, { key, label: bucketLabel(key, "month"), revenue: 0, expenses: 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return map;
  }

  const cursor = new Date(start);
  while (cursor <= end) {
    const key = toYYYYMMDD(cursor);
    map.set(key, { key, label: bucketLabel(key, "day"), revenue: 0, expenses: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return map;
}

async function buildPeriodAnalytics({ clientId, fromDate, toDate }) {
  const granularity = dayDiff(fromDate, toDate) > 45 ? "month" : "day";
  const [zReports, purchaseRows, expenseRows] = await Promise.all([
    fetchZReportsInRange(clientId, fromDate, toDate),
    fetchTxnRange({ clientId, fromDate, toDate, typeKey: "purchase" }),
    fetchTxnRange({ clientId, fromDate, toDate, typeKey: "expense" }),
  ]);

  const seriesMap = emptySeriesMap(fromDate, toDate, granularity);
  let totalRevenue = 0;

  zReports.forEach((report) => {
    const amount = num(report.netSales);
    if (amount === 0) return;
    totalRevenue += amount;
    const dateKey = String(report.businessDate || "").slice(0, 10);
    const bucket = bucketKeyForDate(dateKey, granularity);
    if (!seriesMap.has(bucket)) {
      seriesMap.set(bucket, {
        key: bucket,
        label: bucketLabel(bucket, granularity),
        revenue: 0,
        expenses: 0,
      });
    }
    seriesMap.get(bucket).revenue += amount;
  });

  const categoryTotals = new Map();
  let totalExpenses = 0;
  let recurringExpenses = 0;
  let variableExpenses = 0;

  [...purchaseRows, ...expenseRows].forEach((row) => {
    const amount = pnlOutflowAmount(row);
    if (amount <= 0) return;
    totalExpenses += amount;

    const raw =
      String(row.category || "Uncategorized").trim() || "Uncategorized";
    const catKey = raw.toUpperCase();
    categoryTotals.set(catKey, (categoryTotals.get(catKey) || 0) + amount);

    if (isRecurringCategory(raw)) recurringExpenses += amount;
    else variableExpenses += amount;

    const dateKey = txnBusinessDate(row);
    const bucket = bucketKeyForDate(dateKey, granularity);
    if (!bucket) return;
    if (!seriesMap.has(bucket)) {
      seriesMap.set(bucket, {
        key: bucket,
        label: bucketLabel(bucket, granularity),
        revenue: 0,
        expenses: 0,
      });
    }
    seriesMap.get(bucket).expenses += amount;
  });

  const expenseCategories = Array.from(categoryTotals.entries())
    .map(([category, amount]) => ({
      category,
      label: titleCaseCategory(category),
      amount,
      percent: totalExpenses > 0 ? (amount / totalExpenses) * 100 : 0,
      recurring: isRecurringCategory(category),
    }))
    .sort((a, b) => b.amount - a.amount);

  const series = Array.from(seriesMap.values())
    .sort((a, b) => String(a.key).localeCompare(String(b.key)))
    .map((row) => ({
      ...row,
      net: row.revenue - row.expenses,
    }));

  return {
    fromDate,
    toDate,
    granularity,
    totalRevenue,
    totalExpenses,
    netProfit: totalRevenue - totalExpenses,
    expenseCategories,
    recurringExpenses,
    variableExpenses,
    series,
    zReportCount: zReports.length,
  };
}

function variancePct(current, previous) {
  if (!Number.isFinite(previous) || previous === 0) {
    if (!Number.isFinite(current) || current === 0) return 0;
    return current > 0 ? 100 : current < 0 ? -100 : 0;
  }
  return ((current - previous) / Math.abs(previous)) * 100;
}

/**
 * Build Advanced Analytics payload for a date range, optionally with YoY compare.
 */
export async function fetchAdvancedAnalytics({
  clientId,
  fromDate,
  toDate,
  compareYoY = false,
}) {
  if (!clientId) throw new Error("Select an active shop first.");
  if (!fromDate || !toDate) throw new Error("Select a date range.");

  const current = await buildPeriodAnalytics({ clientId, fromDate, toDate });

  if (!compareYoY) {
    return {
      current,
      previous: null,
      compareYoY: false,
      kpis: {
        revenue: {
          current: current.totalRevenue,
          previous: null,
          variancePct: null,
        },
        expenses: {
          current: current.totalExpenses,
          previous: null,
          variancePct: null,
        },
        netProfit: {
          current: current.netProfit,
          previous: null,
          variancePct: null,
        },
      },
      comparisonSeries: current.series.map((row) => ({
        label: row.label,
        key: row.key,
        revenue: row.revenue,
        expenses: row.expenses,
        net: row.net,
        priorRevenue: null,
        priorExpenses: null,
        priorNet: null,
      })),
    };
  }

  const priorFrom = shiftYearIso(fromDate, -1);
  const priorTo = shiftYearIso(toDate, -1);
  const previous = await buildPeriodAnalytics({
    clientId,
    fromDate: priorFrom,
    toDate: priorTo,
  });

  // Align series by month/day-of-year position using shifted keys.
  const priorByShiftedKey = new Map();
  previous.series.forEach((row) => {
    // Shift prior key forward one year to align with current axis labels.
    let alignedKey = row.key;
    if (previous.granularity === "month" && /^\d{4}-\d{2}$/.test(row.key)) {
      const [y, m] = row.key.split("-").map(Number);
      alignedKey = `${y + 1}-${pad(m)}`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(row.key)) {
      alignedKey = shiftYearIso(row.key, 1);
    }
    priorByShiftedKey.set(alignedKey, row);
  });

  const allKeys = new Set([
    ...current.series.map((row) => row.key),
    ...priorByShiftedKey.keys(),
  ]);
  const comparisonSeries = Array.from(allKeys)
    .sort((a, b) => String(a).localeCompare(String(b)))
    .map((key) => {
      const cur =
        current.series.find((row) => row.key === key) || {
          key,
          label: bucketLabel(key, current.granularity),
          revenue: 0,
          expenses: 0,
          net: 0,
        };
      const prior = priorByShiftedKey.get(key) || {
        revenue: 0,
        expenses: 0,
        net: 0,
        label: "",
      };
      return {
        label: cur.label,
        key,
        revenue: cur.revenue,
        expenses: cur.expenses,
        net: cur.net,
        priorRevenue: prior.revenue,
        priorExpenses: prior.expenses,
        priorNet: prior.net,
        priorLabel: prior.label || "",
      };
    });

  return {
    current,
    previous,
    compareYoY: true,
    priorRange: { fromDate: priorFrom, toDate: priorTo },
    kpis: {
      revenue: {
        current: current.totalRevenue,
        previous: previous.totalRevenue,
        variancePct: variancePct(current.totalRevenue, previous.totalRevenue),
      },
      expenses: {
        current: current.totalExpenses,
        previous: previous.totalExpenses,
        variancePct: variancePct(
          current.totalExpenses,
          previous.totalExpenses
        ),
      },
      netProfit: {
        current: current.netProfit,
        previous: previous.netProfit,
        variancePct: variancePct(current.netProfit, previous.netProfit),
      },
    },
    comparisonSeries,
  };
}

export { shiftYearIso, isRecurringCategory };
