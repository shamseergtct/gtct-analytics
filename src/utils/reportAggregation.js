import { formatIsoDate } from "./dateFormat.js";
import { formatMoney } from "./money.js";

export const REPORT_VIEW_TYPES = [
  { key: "invoice", label: "Invoice wise" },
  { key: "customer", label: "Party wise" },
  { key: "daily", label: "Daily total" },
  { key: "weekly", label: "Weekly total" },
  { key: "monthly", label: "Monthly total" },
  { key: "quarterly", label: "Quarterly total" },
  { key: "annually", label: "Annually" },
];

export const PAYMENT_FILTER_OPTIONS = [
  { key: "all", label: "All payments" },
  { key: "cash", label: "Cash" },
  { key: "bank", label: "Bank" },
  { key: "credit", label: "Credit" },
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

function customerBucket(row) {
  const raw = String(row?.party || "").trim() || "Walk-in";
  const key = raw.toLowerCase();
  // Don't treat payment tenders as customer names when rolling up.
  const tenderLike =
    key === "cash" ||
    key === "bank" ||
    key === "credit" ||
    key === "card" ||
    key === "qr" ||
    key === "bank transfer" ||
    key === "bank_transfer" ||
    key.startsWith("bank:") ||
    key === "petti" ||
    key === "petty";
  const party = tenderLike ? "Walk-in" : raw;
  return {
    key: party.toLowerCase(),
    label: party,
    sortKey: party.toLowerCase(),
  };
}

function parseAmount(value) {
  if (value == null || value === "") return 0;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return formatMoney(value);
}

function hasDebitCredit(columns = []) {
  return columns.some((col) => col.key === "debit" || col.key === "credit");
}

/** Normalize a payment / description cell into cash | bank | credit | other. */
export function normalizePaymentFilterKey(description) {
  const text = String(description || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ");
  if (!text) return "other";
  if (text.includes("credit") || text.startsWith("cre")) return "credit";
  if (
    text.includes("bank") ||
    text.startsWith("car") ||
    text.startsWith("qr") ||
    text.startsWith("upi")
  ) {
    return "bank";
  }
  if (
    text.startsWith("cas") ||
    text.includes("petti") ||
    text.includes("petty")
  ) {
    return "cash";
  }
  // Aggregated labels like "Cash 10.00 · Bank 5.00"
  const parts = text.split("·").map((part) => part.trim());
  if (parts.length > 1) {
    const keys = new Set(parts.map((part) => normalizePaymentFilterKey(part)));
    if (keys.size === 1) return [...keys][0];
    return "mixed";
  }
  return "other";
}

function paymentTypeLabel(key) {
  if (key === "cash") return "Cash";
  if (key === "bank") return "Bank";
  if (key === "credit") return "Credit";
  return "Other";
}

function formatPaymentSummary(paymentMap) {
  const order = ["cash", "bank", "credit", "other"];
  const parts = [];
  for (const key of order) {
    const amount = paymentMap.get(key) || 0;
    if (amount <= 0) continue;
    parts.push(`${paymentTypeLabel(key)} ${money(amount)}`);
  }
  if (parts.length === 0) return "—";
  if (parts.length === 1) {
    // Single tender: show type only (amount is already in Amount column)
    const onlyKey = order.find((key) => (paymentMap.get(key) || 0) > 0);
    return paymentTypeLabel(onlyKey);
  }
  return parts.join(" · ");
}

/** Filter ledger rows by payment tender before aggregation. */
export function filterRowsByPayment(rows = [], paymentFilter = "all") {
  const want = String(paymentFilter || "all").toLowerCase();
  if (!want || want === "all") return rows;
  return rows.filter((row) => {
    if (row?.id === "__grand_total__" || row?._isTotal) return false;
    return normalizePaymentFilterKey(row.description) === want;
  });
}

/** Filter ledger rows by party name (case-insensitive). */
export function filterRowsByParty(rows = [], partyFilter = "all") {
  const want = String(partyFilter || "all").trim().toLowerCase();
  if (!want || want === "all") return rows;
  return rows.filter((row) => {
    if (row?.id === "__grand_total__" || row?._isTotal) return false;
    return String(row?.party || "").trim().toLowerCase() === want;
  });
}

/** @deprecated Use filterRowsByParty */
export function filterRowsByCustomer(rows = [], customerFilter = "all") {
  return filterRowsByParty(rows, customerFilter);
}

/** Unique party names from report rows, sorted for the filter dropdown. */
export function listPartiesFromRows(rows = []) {
  const names = new Set();
  rows.forEach((row) => {
    if (row?.id === "__grand_total__" || row?._isTotal) return;
    const name = String(row?.party || "").trim();
    if (name && name !== "—") names.add(name);
  });
  return Array.from(names).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

/** @deprecated Use listPartiesFromRows */
export function listCustomersFromRows(rows = []) {
  return listPartiesFromRows(rows);
}

/**
 * Aggregate invoice-level ledger rows into period or customer totals.
 * Preserves invoice-wise rows when viewType is "invoice".
 *
 * For non-invoice views:
 *  - Ref / Invoice shows the selected report type name
 *  - Description / Payment shows rolled-up payment tenders
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
  const isCustomerWise = viewType === "customer";

  rows.forEach((row) => {
    if (row?.id === "__grand_total__" || row?._isTotal) return;

    let bucket;
    if (isCustomerWise) {
      bucket = customerBucket(row);
    } else {
      const date = parseRowDate(row.date);
      if (!date) return;
      bucket = periodBucket(date, viewType);
    }
    if (!bucket) return;

    if (!buckets.has(bucket.key)) {
      buckets.set(bucket.key, {
        id: isCustomerWise
          ? `customer-${bucket.key}`
          : `period-${bucket.key}`,
        date: isCustomerWise ? "—" : bucket.label,
        ref: viewLabel,
        party: isCustomerWise ? bucket.label : partyLabel || "—",
        sortKey: bucket.sortKey,
        _in: 0,
        _out: 0,
        _debit: 0,
        _credit: 0,
        _count: 0,
        _partySet: new Set(),
        _payments: new Map(),
      });
    }

    const entry = buckets.get(bucket.key);
    entry._count += 1;
    const rowParty = String(row.party || "").trim();
    if (rowParty && rowParty !== "—") {
      entry._partySet.add(rowParty);
    }

    const rowIn = useDebitCredit
      ? parseAmount(row.debit)
      : parseAmount(row.in);
    const rowOut = useDebitCredit
      ? parseAmount(row.credit)
      : parseAmount(row.out);
    const paymentAmount = Math.max(rowIn, rowOut);
    const payKey = normalizePaymentFilterKey(row.description);
    if (paymentAmount > 0) {
      entry._payments.set(
        payKey === "mixed" ? "other" : payKey,
        (entry._payments.get(payKey === "mixed" ? "other" : payKey) || 0) +
          paymentAmount
      );
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
    const party = isCustomerWise
      ? entry.party
      : partyLabel ||
        (parties.length === 1
          ? parties[0]
          : parties.length > 1
            ? "Multiple"
            : "—");
    const paymentSummary = formatPaymentSummary(entry._payments);

    if (useDebitCredit) {
      // Match party-ledger sign: AR uses debit−credit, AP uses credit−debit.
      running +=
        balanceMode === "ap"
          ? entry._credit - entry._debit
          : entry._debit - entry._credit;
      return {
        id: entry.id,
        date: entry.date,
        ref: viewLabel,
        party,
        description: paymentSummary,
        debit: entry._debit ? money(entry._debit) : "",
        credit: entry._credit ? money(entry._credit) : "",
        balance: money(running),
      };
    }

    running += entry._in - entry._out;
    return {
      id: entry.id,
      date: entry.date,
      ref: viewLabel,
      party,
      description: paymentSummary,
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
  return ["ledger", "sales", "customers", "vendors", "expense", "z_audit", "loans"].includes(
    reportType
  );
}

/** Detect which payment tenders appear in rows (for showing the filter). */
export function detectPaymentFiltersPresent(rows = []) {
  const found = new Set();
  rows.forEach((row) => {
    if (row?.id === "__grand_total__" || row?._isTotal) return;
    const key = normalizePaymentFilterKey(row.description);
    if (key === "mixed") {
      found.add("cash");
      found.add("bank");
      found.add("credit");
      return;
    }
    if (key === "cash" || key === "bank" || key === "credit") found.add(key);
  });
  return found;
}
