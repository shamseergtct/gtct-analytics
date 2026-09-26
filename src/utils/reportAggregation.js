import { formatIsoDate } from "./dateFormat.js";

export const REPORT_VIEW_TYPES = [
  { key: "invoice", label: "Invoice wise" },
  { key: "daily", label: "Daily total" },
  { key: "weekly", label: "Weekly total" },
  { key: "monthly", label: "Monthly total" },
  { key: "quarterly", label: "Quarterly total" },
  { key: "annually", label: "Annually" },
];

function pad(n) {
  return String(n).padStart(2, "0");
}

function parseRowDate(value) {
  const text = String(value || "").trim();
  // dd/mm/yyyy
  const dmy = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) {
    return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]), 12, 0, 0);
  }
  // yyyy-mm-dd
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12, 0, 0);
  }
  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function toIso(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isoWeekKey(date) {
  const tmp = new Date(date.getTime());
  tmp.setHours(12, 0, 0, 0);
  // Thursday in current week decides the year.
  tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
  const weekYear = tmp.getFullYear();
  const week1 = new Date(weekYear, 0, 4);
  const weekNo =
    1 +
    Math.round(
      ((tmp.getTime() - week1.getTime()) / 86400000 -
        3 +
        ((week1.getDay() + 6) % 7)) /
        7
    );
  return {
    key: `${weekYear}-W${pad(weekNo)}`,
    label: `Week ${weekNo}, ${weekYear}`,
    sortKey: `${weekYear}-${pad(weekNo)}`,
  };
}

function periodBucket(date, viewType) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  switch (viewType) {
    case "daily": {
      const iso = toIso(date);
      return {
        key: iso,
        label: formatIsoDate(iso) || iso,
        sortKey: iso,
      };
    }
    case "weekly":
      return isoWeekKey(date);
    case "monthly":
      return {
        key: `${year}-${pad(month)}`,
        label: date.toLocaleString(undefined, {
          month: "short",
          year: "numeric",
        }),
        sortKey: `${year}-${pad(month)}`,
      };
    case "quarterly": {
      const q = Math.floor((month - 1) / 3) + 1;
      return {
        key: `${year}-Q${q}`,
        label: `Q${q} ${year}`,
        sortKey: `${year}-Q${q}`,
      };
    }
    case "annually":
      return {
        key: String(year),
        label: String(year),
        sortKey: String(year),
      };
    default:
      return null;
  }
}

function parseAmount(value) {
  if (value == null || value === "") return 0;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  const amount = Number(value) || 0;
  return amount.toFixed(2);
}

function hasDebitCredit(columns = []) {
  return columns.some((col) => col.key === "debit" || col.key === "credit");
}

/**
 * Aggregate invoice-level ledger rows into period totals.
 * Preserves invoice-wise rows when viewType is "invoice".
 *
 * balanceMode:
 *  - "ar"   customer receivable: debit − credit
 *  - "ap"   vendor payable: credit − debit
 *  - "cash" in/out ledgers: in − out
 */
export function aggregateLedgerRows({
  rows = [],
  columns = [],
  viewType = "invoice",
  partyLabel = "",
  balanceMode = "cash",
}) {
  if (!viewType || viewType === "invoice") {
    return { columns, rows };
  }

  const useDebitCredit = hasDebitCredit(columns);
  const buckets = new Map();
  const viewLabel =
    REPORT_VIEW_TYPES.find((item) => item.key === viewType)?.label || "Period";

  rows.forEach((row) => {
    if (row?.id === "__grand_total__" || row?._isTotal) return;
    const date = parseRowDate(row.date);
    if (!date) return;
    const bucket = periodBucket(date, viewType);
    if (!bucket) return;

    if (!buckets.has(bucket.key)) {
      buckets.set(bucket.key, {
        id: `period-${bucket.key}`,
        date: bucket.label,
        ref: "—",
        party: partyLabel || "—",
        description: viewLabel,
        sortKey: bucket.sortKey,
        _in: 0,
        _out: 0,
        _debit: 0,
        _credit: 0,
        _partySet: new Set(),
      });
    }

    const entry = buckets.get(bucket.key);
    const rowParty = String(row.party || "").trim();
    if (rowParty && rowParty !== "—") {
      entry._partySet.add(rowParty);
    }
    if (useDebitCredit) {
      entry._debit += parseAmount(row.debit);
      entry._credit += parseAmount(row.credit);
    } else {
      entry._in += parseAmount(row.in);
      entry._out += parseAmount(row.out);
    }
  });

  const sorted = Array.from(buckets.values()).sort((a, b) =>
    String(a.sortKey).localeCompare(String(b.sortKey))
  );

  let running = 0;
  const aggregatedRows = sorted.map((entry) => {
    const parties = Array.from(entry._partySet || []);
    const party =
      partyLabel ||
      (parties.length === 1 ? parties[0] : parties.length > 1 ? "Multiple" : "—");
    if (useDebitCredit) {
      // Match party-ledger sign: AR uses debit−credit, AP uses credit−debit.
      running +=
        balanceMode === "ap"
          ? entry._credit - entry._debit
          : entry._debit - entry._credit;
      return {
        id: entry.id,
        date: entry.date,
        ref: entry.ref,
        party,
        description: entry.description,
        debit: entry._debit ? money(entry._debit) : "",
        credit: entry._credit ? money(entry._credit) : "",
        balance: money(running),
      };
    }

    running += entry._in - entry._out;
    return {
      id: entry.id,
      date: entry.date,
      ref: entry.ref,
      party,
      description: entry.description,
      in: entry._in ? money(entry._in) : "",
      out: entry._out ? money(entry._out) : "",
      balance: money(running),
    };
  });

  return { columns, rows: aggregatedRows };
}

export function reportViewSupportsAggregation(layout, reportType) {
  if (layout === "pnl" || layout === "cashflow" || layout === "due_list") {
    return false;
  }
  return ["ledger", "customers", "vendors", "expense", "z_audit", "loans"].includes(
    reportType
  );
}
