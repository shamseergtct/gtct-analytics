// src/pages/TxnReports.jsx
import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext.jsx";
import { fetchTxnRange } from "../utils/txnReportsApi.js";
import { generateTxnRangePDF } from "../utils/txnRangePdf.js";

const TABS = [
  { key: "sales", title: "Sales", pdfTitle: "Sales Report", side: "in" },
  { key: "purchase", title: "Purchase", pdfTitle: "Purchase Report", side: "out" },
  { key: "receipt", title: "Receipt", pdfTitle: "Receipt Report", side: "in" },
  { key: "payment", title: "Payment", pdfTitle: "Payment Report", side: "out" },
  { key: "expense", title: "Expense", pdfTitle: "Expense Report", side: "out" },
  { key: "income", title: "Income", pdfTitle: "Income Report", side: "in" },
];

// "" means ALL
const MODE_OPTIONS = [
  { value: "", label: "All" },
  { value: "Cash", label: "Cash" },
  { value: "Bank", label: "Bank" },
  { value: "Petti Cash", label: "Petti Cash" },
  { value: "Credit", label: "Credit" },
];

const VIEW_OPTIONS = [
  { value: "detailed", label: "Detailed" },
  { value: "summary", label: "Summary" },
  { value: "both", label: "Both" },
];

function num(v) {
  const x = Number(v || 0);
  return Number.isFinite(x) ? x : 0;
}
function money(v) {
  return num(v).toFixed(2);
}
function todayYYYYMMDD() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function fmtDate(d) {
  try {
    if (!d) return "-";
    if (d?.toDate) return d.toDate().toLocaleDateString();
    if (d instanceof Date) return d.toLocaleDateString();
    return new Date(d).toLocaleDateString();
  } catch {
    return "-";
  }
}
function normType(x) {
  return String(x || "").trim().toLowerCase();
}
function normCat(x) {
  return String(x || "").trim();
}
function normMode(x) {
  return String(x || "").trim();
}

// Party allowed mapping
function allowedPartyTypesForTab(tabKey) {
  switch (tabKey) {
    case "sales":
    case "receipt":
      return new Set(["customer", "both"]);
    case "purchase":
    case "payment":
      return new Set(["supplier", "both"]);
    case "expense":
      return new Set(["employee", "both"]);
    case "income":
      return new Set(["owner", "partner", "both"]);
    default:
      return new Set();
  }
}

/**
 * ✅ AMOUNT LOGIC (fixes purchase credit 0)
 * 1) Prefer totalAmount if >0
 * 2) else fallback:
 *    - purchase credit may be in amountIn
 *    - cash/bank/petti often in amountOut
 *    - otherwise use side mapping
 */
function getTxnAmount(tabKey, side, row) {
  const total = num(row?.totalAmount);
  if (total > 0) return total;

  const amtIn = num(row?.amountIn);
  const amtOut = num(row?.amountOut);

  if (tabKey === "purchase") {
    const m = String(row?.mode || "").trim().toLowerCase();
    if (m === "credit") return amtIn > 0 ? amtIn : amtOut;
    return amtOut > 0 ? amtOut : amtIn;
  }

  return side === "in"
    ? amtIn > 0
      ? amtIn
      : amtOut
    : amtOut > 0
    ? amtOut
    : amtIn;
}

function buildBreakdown(normalizedRows) {
  const byMode = {};
  const byCategory = {};
  let totalCount = 0;
  let totalAmount = 0;

  for (const r of normalizedRows) {
    totalCount += 1;
    totalAmount += num(r.amount);

    const m = normMode(r.mode) || "Unknown";
    const c = normCat(r.category) || "Uncategorized";

    byMode[m] = byMode[m] || { key: m, count: 0, total: 0 };
    byMode[m].count += 1;
    byMode[m].total += num(r.amount);

    byCategory[c] = byCategory[c] || { key: c, count: 0, total: 0 };
    byCategory[c].count += 1;
    byCategory[c].total += num(r.amount);
  }

  const modeRows = Object.values(byMode).sort((a, b) => b.total - a.total);
  const categoryRows = Object.values(byCategory).sort((a, b) => b.total - a.total);

  return { totalCount, totalAmount, modeRows, categoryRows };
}

export default function TxnReports() {
  const { activeClientId, activeClientData } = useClient();
  const clientId = activeClientId;
  const currency = activeClientData?.currency || "BHD";

  const [tab, setTab] = useState(TABS[0].key);
  const tabMeta = useMemo(() => TABS.find((t) => t.key === tab) || TABS[0], [tab]);

  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [mode, setMode] = useState("");
  const [partyId, setPartyId] = useState("");
  const [category, setCategory] = useState("");

  const [viewMode, setViewMode] = useState("detailed");

  const [allParties, setAllParties] = useState([]);
  const [categoryOptions, setCategoryOptions] = useState([]);

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]); // normalized rows
  const [error, setError] = useState("");

  // Default date range: current month
  useEffect(() => {
    const t = todayYYYYMMDD();
    const first = t.slice(0, 8) + "01";
    setFromDate((v) => v || first);
    setToDate((v) => v || t);
  }, []);

  // Load parties
  useEffect(() => {
    (async () => {
      try {
        if (!clientId) {
          setAllParties([]);
          return;
        }
        const qy = query(collection(db, "parties"), where("clientId", "==", clientId));
        const snap = await getDocs(qy);

        const list = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        list.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
        setAllParties(list);
      } catch (e) {
        console.error(e);
        setAllParties([]);
      }
    })();
  }, [clientId]);

  // Filter parties shown in dropdown based on tab
  const partyOptions = useMemo(() => {
    const allowed = allowedPartyTypesForTab(tabMeta.key);
    if (!allowed.size) return allParties;

    // support both partyType or type
    return allParties.filter((p) => {
      const pt = normType(p.partyType || p.type);
      return allowed.has(pt);
    });
  }, [allParties, tabMeta.key]);

  // If selected party becomes invalid after tab change, reset to ALL
  useEffect(() => {
    if (!partyId) return;
    const stillExists = partyOptions.some((p) => p.id === partyId);
    if (!stillExists) setPartyId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabMeta.key, clientId]);

  async function runFetch() {
    setError("");
    setLoading(true);

    try {
      if (!clientId) throw new Error("Please select an active client first.");
      if (!fromDate || !toDate) throw new Error("Select From and To dates.");
      if (fromDate > toDate) throw new Error("From date cannot be after To date.");

      // main data (with filters)
      const data = await fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: tabMeta.key,
        mode: mode || "",
        partyId: partyId || "",
        category: category || "",
      });

      // category options from same tab+range but without category filter
      const allNoCat = await fetchTxnRange({
        clientId,
        fromDate,
        toDate,
        typeKey: tabMeta.key,
        mode: mode || "",
        partyId: partyId || "",
        category: "",
      });

      const cats = new Set();
      for (const r of allNoCat) {
        const c = normCat(r.category);
        if (c) cats.add(c);
      }
      setCategoryOptions(Array.from(cats).sort((a, b) => a.localeCompare(b)));

      // normalize + amount fix + remove internal transfers
      const normalized = (data || [])
        .filter((r) => r?.internalTransfer !== true)
        .map((r) => {
          const amount = getTxnAmount(tabMeta.key, tabMeta.side, r);
          return {
            id: r.id,
            date: r.date,
            dateText: fmtDate(r.date),
            partyName: r.partyName || "-",
            mode: r.mode || "-",
            category: r.category || "-",
            description: r.description || "-",
            amount,
          };
        });

      setRows(normalized);
    } catch (e) {
      console.error(e);
      setRows([]);
      setCategoryOptions([]);
      setError(e?.message || "Failed to load report.");
    } finally {
      setLoading(false);
    }
  }

  // Auto fetch when tab changes
  useEffect(() => {
    if (!clientId || !fromDate || !toDate) return;
    setCategory("");
    runFetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, clientId]);

  const summary = useMemo(() => {
    const count = rows.length;
    const total = rows.reduce((s, r) => s + num(r.amount), 0);
    return { count, total };
  }, [rows]);

  const breakdown = useMemo(() => buildBreakdown(rows), [rows]);

  function filtersText() {
    const parts = [];
    if (mode) parts.push(`Mode: ${mode}`);
    if (partyId) {
      const p = allParties.find((x) => x.id === partyId);
      parts.push(`Party: ${p?.name || "Selected Party"}`);
    }
    if (category) parts.push(`Category: ${category}`);
    return parts.join(" | ");
  }

  function onDownloadPDF() {
    // allow summary-only export even if rows empty? (still needs something)
    if (!rows.length) return alert("No data to export.");

    generateTxnRangePDF({
      title: tabMeta.pdfTitle,
      clientName: activeClientData?.name || "Client",
      currency,
      fromDate,
      toDate,
      filtersText: filtersText(),
      summary,
      viewMode, // ✅ IMPORTANT: your pdf util needs this
      breakdown, // ✅ IMPORTANT: your pdf util needs this
      rows: rows.map((r) => ({
        dateText: r.dateText,
        partyName: r.partyName,
        mode: r.mode,
        category: r.category,
        description: r.description,
        amount: r.amount,
      })),
    });
  }

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Transaction Reports</h1>
          <p className="text-sm text-slate-400">
            Range-based reports for Sales / Purchase / Receipt / Payment / Expense / Income
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Active Client:{" "}
            <span className="text-slate-200 font-semibold">
              {activeClientData?.name || "No client selected"}
            </span>{" "}
            | Currency: <span className="text-slate-200 font-semibold">{currency}</span>
          </p>
        </div>

        <button
          onClick={onDownloadPDF}
          disabled={loading || rows.length === 0}
          className="rounded-xl bg-slate-100 px-4 py-2 text-slate-900 font-medium disabled:opacity-50"
        >
          Download PDF
        </button>
      </div>

      {/* Tabs */}
      <div className="mt-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={
              "rounded-xl px-3 py-2 text-sm border " +
              (tab === t.key
                ? "bg-slate-100 text-slate-900 border-slate-200"
                : "bg-slate-950/40 text-slate-200 border-slate-800 hover:bg-slate-900/60")
            }
          >
            {t.title}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-12 gap-3 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
        <div className="md:col-span-3">
          <label className="text-sm text-slate-300">From</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
          />
        </div>

        <div className="md:col-span-3">
          <label className="text-sm text-slate-300">To</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
          />
        </div>

        <div className="md:col-span-2">
          <label className="text-sm text-slate-300">Mode (optional)</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
          >
            {MODE_OPTIONS.map((m) => (
              <option key={m.label} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-2">
          <label className="text-sm text-slate-300">Party (optional)</label>
          <select
            value={partyId}
            onChange={(e) => setPartyId(e.target.value)}
            className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
          >
            <option value="">All</option>
            {partyOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || "(No name)"} {(p.partyType || p.type) ? `(${p.partyType || p.type})` : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-2">
          <label className="text-sm text-slate-300">Category (optional)</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
          >
            <option value="">All</option>
            {categoryOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {/* View mode */}
        <div className="md:col-span-3">
          <label className="text-sm text-slate-300">View</label>
          <select
            value={viewMode}
            onChange={(e) => setViewMode(e.target.value)}
            className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
          >
            {VIEW_OPTIONS.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-9 flex flex-wrap items-center gap-2 mt-6">
          <button
            onClick={runFetch}
            disabled={loading}
            className="rounded-xl bg-emerald-500 px-4 py-2 text-slate-950 font-semibold disabled:opacity-50"
          >
            {loading ? "Loading..." : "Apply"}
          </button>

          <button
            onClick={() => {
              setMode("");
              setPartyId("");
              setCategory("");
              runFetch();
            }}
            className="rounded-xl border border-slate-700 px-4 py-2 text-slate-100 hover:bg-slate-900/60"
          >
            Clear Filters
          </button>

          {error ? <span className="text-sm text-red-400">{error}</span> : null}
        </div>
      </div>

      {/* Top summary cards */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
          <div className="text-sm text-slate-400">Total Count</div>
          <div className="text-2xl font-semibold text-slate-100">{summary.count}</div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
          <div className="text-sm text-slate-400">Total Amount</div>
          <div className="text-2xl font-semibold text-slate-100">
            {money(summary.total)} <span className="text-sm text-slate-400">{currency}</span>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
          <div className="text-sm text-slate-400">Active Tab</div>
          <div className="text-2xl font-semibold text-slate-100">{tabMeta.title}</div>
        </div>
      </div>

      {/* SUMMARY VIEW */}
      {(viewMode === "summary" || viewMode === "both") && (
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 overflow-hidden">
            <div className="p-4">
              <div className="text-slate-100 font-semibold">Summary by Mode</div>
              <div className="text-sm text-slate-400">{filtersText() || "No extra filters"}</div>
            </div>
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-900/70">
                  <tr className="text-slate-200">
                    <th className="text-left px-4 py-3">Mode</th>
                    <th className="text-right px-4 py-3">Count</th>
                    <th className="text-right px-4 py-3">Total ({currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.modeRows.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-4 py-6 text-slate-400">
                        No data
                      </td>
                    </tr>
                  ) : (
                    breakdown.modeRows.map((r) => (
                      <tr key={r.key} className="border-t border-slate-800 text-slate-100">
                        <td className="px-4 py-3">{r.key}</td>
                        <td className="px-4 py-3 text-right">{r.count}</td>
                        <td className="px-4 py-3 text-right">{money(r.total)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 overflow-hidden">
            <div className="p-4">
              <div className="text-slate-100 font-semibold">Summary by Category</div>
              <div className="text-sm text-slate-400">{filtersText() || "No extra filters"}</div>
            </div>
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-900/70">
                  <tr className="text-slate-200">
                    <th className="text-left px-4 py-3">Category</th>
                    <th className="text-right px-4 py-3">Count</th>
                    <th className="text-right px-4 py-3">Total ({currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.categoryRows.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-4 py-6 text-slate-400">
                        No data
                      </td>
                    </tr>
                  ) : (
                    breakdown.categoryRows.map((r) => (
                      <tr key={r.key} className="border-t border-slate-800 text-slate-100">
                        <td className="px-4 py-3">{r.key}</td>
                        <td className="px-4 py-3 text-right">{r.count}</td>
                        <td className="px-4 py-3 text-right">{money(r.total)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* DETAILED VIEW */}
      {(viewMode === "detailed" || viewMode === "both") && (
        <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/40 overflow-hidden">
          <div className="p-4 flex items-center justify-between">
            <div>
              <div className="text-slate-100 font-semibold">{tabMeta.title} List</div>
              <div className="text-sm text-slate-400">
                {filtersText() ? filtersText() : "No extra filters"}
              </div>
            </div>
          </div>

          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/70">
                <tr className="text-slate-200">
                  <th className="text-left px-4 py-3 whitespace-nowrap">Date</th>
                  <th className="text-left px-4 py-3 whitespace-nowrap">Party</th>
                  <th className="text-left px-4 py-3 whitespace-nowrap">Mode</th>
                  <th className="text-left px-4 py-3 whitespace-nowrap">Category</th>
                  <th className="text-left px-4 py-3 whitespace-nowrap">Description</th>
                  <th className="text-right px-4 py-3 whitespace-nowrap">
                    Amount ({currency})
                  </th>
                </tr>
              </thead>

              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-slate-400">
                      {loading ? "Loading..." : "No transactions found for this range."}
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.id} className="border-t border-slate-800 text-slate-100">
                      <td className="px-4 py-3 whitespace-nowrap">{r.dateText}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{r.partyName || "-"}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{r.mode || "-"}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{r.category || "-"}</td>
                      <td className="px-4 py-3">{r.description || "-"}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">{money(r.amount)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
