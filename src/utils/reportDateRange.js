import { formatIsoDate } from "./dateFormat.js";

function pad(n) {
  return String(n).padStart(2, "0");
}

export function toYYYYMMDD(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 Sun
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export const REPORT_RANGE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
  { key: "all", label: "Full Period" },
  { key: "custom", label: "Custom Range" },
];

/** Earliest From date used for Full Period statements. */
export const FULL_PERIOD_START = "2020-01-01";

export function resolveReportDateRange(preset, customFrom, customTo, now = new Date()) {
  const today = toYYYYMMDD(now);
  switch (preset) {
    case "week": {
      const from = toYYYYMMDD(startOfWeek(now));
      return { fromDate: from, toDate: today };
    }
    case "month": {
      const from = toYYYYMMDD(startOfMonth(now));
      return { fromDate: from, toDate: today };
    }
    case "all":
      return { fromDate: FULL_PERIOD_START, toDate: today };
    case "custom": {
      let fromDate = String(customFrom || today).slice(0, 10);
      let toDate = String(customTo || today).slice(0, 10);
      if (fromDate > toDate) {
        const swap = fromDate;
        fromDate = toDate;
        toDate = swap;
      }
      return { fromDate, toDate };
    }
    case "today":
    default:
      return { fromDate: today, toDate: today };
  }
}

export function formatReportRangeLabel(fromDate, toDate) {
  if (!fromDate || !toDate) return "";
  if (fromDate === FULL_PERIOD_START) {
    return `Full period through ${formatIsoDate(toDate) || toDate}`;
  }
  if (fromDate === toDate) return formatIsoDate(fromDate) || fromDate;
  return `${formatIsoDate(fromDate) || fromDate} – ${formatIsoDate(toDate) || toDate}`;
}
