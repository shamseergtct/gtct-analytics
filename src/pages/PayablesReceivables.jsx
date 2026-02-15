// src/pages/PayablesReceivables.jsx
import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext.jsx";
import { fetchTxnRange } from "../utils/txnReportsApi.js";
import { generateTxnRangePDF } from "../utils/txnRangePdf.js";

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
function normType(x) {
  return String(x || "").trim().toLowerCase();
}
function normKey(x) {
  return String(x || "").trim().toLowerCase();
}
function rangeText(fromDate, toDate) {
  return `${fromDate} to ${toDate}`;
}

/**
 * Amount picker (same safe logic)
 * - Prefer totalAmount if present
 * - else use amountIn/amountOut fallback
 */
function getSafeAmount(row, side /* "in"|"out" */) {
  const total = num(row?.totalAmount);
  if (total > 0) return total;

  const amtIn = num(row?.amountIn);
  const amtOut = num(row?.amountOut);

  // fallback
  return side === "in" ? (amtIn > 0 ? amtIn : amtOut) : (amtOut > 0 ? amtOut : amtIn);
}

export default function PayablesReceivables() {
  const { activeClientId, activeClientData } = useClient();
  const clientId = activeClientId;
  const currency = activeClientData?.currency || "BHD";

  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [partyId, setPartyId] = useState(""); // "" = ALL
  const [reportType, setReportType] = useState("payable"); // payable | receivable | both

  const [allParties, setAllParties] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [payableRows, setPayableRows] = useState([]); // [{id, partyId, partyName, amount}]
  const [receivableRows, setReceivableRows] = useState([]); // same

  // Default date range: current month
  useEffect(() => {
    const t = todayYYYYMMDD();
    const first = t.slice(0, 8) + "01";
    setFromDate((v) => v || first);
    setToDate((v) => v || t);
  }, []);

  // Load parties for dropdown
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

  // Party filter dropdown split (optional: show customers+suppliers only)
  const partyOptions = useMemo(() => {
    // keep all, but you can restrict if you want:
    // payable uses suppliers; receivable uses customers
    return allParties;
  }, [allParties]);

  async function run() {
    setError("");
    setLoading(true);

    try {
      if (!clientId) throw new Error("Please select an active client first.");
      if (!fromDate || !toDate) throw new Error("Select From and To dates.");
      if (fromDate > toDate) throw new Error("From date cannot be after To date.");

      // We compute:
      // Payable = Purchase(Credit) - Payment(any mode) per supplier
      // Receivable = Sales(Credit) - Receipt(any mode) per customer

      const [purchaseCredit, payments, salesCredit, receipts] = await Promise.all([
        fetchTxnRange({
          clientId,
          fromDate,
          toDate,
          typeKey: "purchase",
          mode: "Credit", // only credit purchases create payable
          partyId: partyId || "",
          category: "",
        }),
        fetchTxnRange({
          clientId,
          fromDate,
          toDate,
          typeKey: "payment",
          mode: "", // all payment modes reduce payable
          partyId: partyId || "",
          category: "",
        }),
        fetchTxnRange({
          clientId,
          fromDate,
          toDate,
          typeKey: "sales",
          mode: "Credit", // only credit sales create receivable
          partyId: partyId || "",
          category: "",
        }),
        fetchTxnRange({
          clientId,
          fromDate,
          toDate,
          typeKey: "receipt",
          mode: "", // all receipt modes reduce receivable
          partyId: partyId || "",
          category: "",
        }),
      ]);

      // Aggregate helpers
      const payableMap = new Map(); // partyIdKey -> {partyId, partyName, amount}
      const receivableMap = new Map();

      // add Payables from credit purchases (outgoing side)
      for (const r of purchaseCredit || []) {
        if (r?.internalTransfer === true) continue;
        const pId = r?.partyId || ""; // can be null sometimes
        const pName = r?.partyName || "-";
        const key = pId ? `id:${pId}` : `name:${normKey(pName)}`;

        const amt = getSafeAmount(r, "out");
        const prev = payableMap.get(key) || { partyId: pId || "", partyName: pName, amount: 0 };
        prev.amount += num(amt);
        payableMap.set(key, prev);
      }

      // subtract Payments (reduce payable) (outgoing side)
      for (const r of payments || []) {
        if (r?.internalTransfer === true) continue;
        const pId = r?.partyId || "";
        const pName = r?.partyName || "-";
        const key = pId ? `id:${pId}` : `name:${normKey(pName)}`;

        const amt = getSafeAmount(r, "out");
        const prev = payableMap.get(key) || { partyId: pId || "", partyName: pName, amount: 0 };
        prev.amount -= num(amt);
        payableMap.set(key, prev);
      }

      // add Receivables from credit sales (incoming side)
      for (const r of salesCredit || []) {
        if (r?.internalTransfer === true) continue;
        const pId = r?.partyId || "";
        const pName = r?.partyName || "-";
        const key = pId ? `id:${pId}` : `name:${normKey(pName)}`;

        const amt = getSafeAmount(r, "in");
        const prev = receivableMap.get(key) || { partyId: pId || "", partyName: pName, amount: 0 };
        prev.amount += num(amt);
        receivableMap.set(key, prev);
      }

      // subtract Receipts (reduce receivable) (incoming side)
      for (const r of receipts || []) {
        if (r?.internalTransfer === true) continue;
        const pId = r?.partyId || "";
        const pName = r?.partyName || "-";
        const key = pId ? `id:${pId}` : `name:${normKey(pName)}`;

        const amt = getSafeAmount(r, "in");
        const prev = receivableMap.get(key) || { partyId: pId || "", partyName: pName, amount: 0 };
        prev.amount -= num(amt);
        receivableMap.set(key, prev);
      }

      const payList = Array.from(payableMap.values())
        .filter((x) => num(x.amount) > 0.000001) // only due
        .sort((a, b) => num(b.amount) - num(a.amount))
        .map((x, idx) => ({ id: `pay_${idx}`, ...x }));

      const recvList = Array.from(receivableMap.values())
        .filter((x) => num(x.amount) > 0.000001)
        .sort((a, b) => num(b.amount) - num(a.amount))
        .map((x, idx) => ({ id: `rec_${idx}`, ...x }));

      setPayableRows(payList);
      setReceivableRows(recvList);
    } catch (e) {
      console.error(e);
      setPayableRows([]);
      setReceivableRows([]);
      setError(e?.message || "Failed to generate payable/receivable report.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!clientId || !fromDate || !toDate) return;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const payableTotal = useMemo(() => payableRows.reduce((s, r) => s + num(r.amount), 0), [payableRows]);
  const receivableTotal = useMemo(
    () => receivableRows.reduce((s, r) => s + num(r.amount), 0),
    [receivableRows]
  );

  function onDownloadPDF() {
    const rText = rangeText(fromDate, toDate);

    const condensedRows = [];
    if (reportType === "payable" || reportType === "both") {
      for (const r of payableRows) {
        condensedRows.push({
          rangeText: rText,
          partyName: r.partyName,
          mode: "PAYABLE",
          amount: r.amount,
        });
      }
    }
    if (reportType === "receivable" || reportType === "both") {
      for (const r of receivableRows) {
        condensedRows.push({
          rangeText: rText,
          partyName: r.partyName,
          mode: "RECEIVABLE",
          amount: r.amount,
        });
      }
    }

    if (!condensedRows.length) return alert("No data to export.");

    const title =
      reportType === "payable"
        ? "Payables Report"
        : reportType === "receivable"
          ? "Receivables Report"
          : "Payables & Receivables Report";

    const total =
      reportType === "payable"
        ? payableTotal
        : reportType === "receivable"
          ? receivableTotal
          : payableTotal + receivableTotal;

    generateTxnRangePDF({
      title,
      clientName: activeClientData?.name || "Client",
      currency,
      fromDate,
      toDate,
      filtersText: partyId
        ? `Party: ${allParties.find((p) => p.id === partyId)?.name || "Selected Party"}`
        : "Party: All",
      summary: { count: condensedRows.length, total },
      viewMode: "both", // uses condensed table
      breakdown: null,
      rows: [],
      condensedRows,
    });
  }

  const showPayable = reportType === "payable" || reportType === "both";
  const showReceivable = reportType === "receivable" || reportType === "both";

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Payables & Receivables</h1>
          <p className="text-sm text-slate-400">
            Payable = Credit Purchases − Payments • Receivable = Credit Sales − Receipts
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
          disabled={loading || (!payableRows.length && !receivableRows.length)}
          className="rounded-xl bg-slate-100 px-4 py-2 text-slate-900 font-medium disabled:opacity-50"
        >
          Download PDF
        </button>
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

        <div className="md:col-span-3">
          <label className="text-sm text-slate-300">Party</label>
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

        <div className="md:col-span-3">
          <label className="text-sm text-slate-300">Report</label>
          <select
            value={reportType}
            onChange={(e) => setReportType(e.target.value)}
            className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
          >
            <option value="payable">Payables</option>
            <option value="receivable">Receivables</option>
            <option value="both">Both</option>
          </select>
        </div>

        <div className="md:col-span-12 flex items-center gap-2 mt-2">
          <button
            onClick={run}
            disabled={loading}
            className="rounded-xl bg-emerald-500 px-4 py-2 text-slate-950 font-semibold disabled:opacity-50"
          >
            {loading ? "Loading..." : "Generate"}
          </button>

          {error ? <span className="text-sm text-red-400">{error}</span> : null}
        </div>
      </div>

      {/* Totals */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
          <div className="text-sm text-slate-400">Total Payables</div>
          <div className="text-2xl font-semibold text-slate-100">
            {money(payableTotal)} <span className="text-sm text-slate-400">{currency}</span>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
          <div className="text-sm text-slate-400">Total Receivables</div>
          <div className="text-2xl font-semibold text-slate-100">
            {money(receivableTotal)} <span className="text-sm text-slate-400">{currency}</span>
          </div>
        </div>
      </div>

      {/* Payables Table */}
      {showPayable && (
        <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/40 overflow-hidden">
          <div className="p-4">
            <div className="text-slate-100 font-semibold">
              Payables (Grouped by Party) • Range: {rangeText(fromDate, toDate)}
            </div>
          </div>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/70">
                <tr className="text-slate-200">
                  <th className="text-left px-4 py-3">Party</th>
                  <th className="text-right px-4 py-3">Payable ({currency})</th>
                </tr>
              </thead>
              <tbody>
                {payableRows.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-6 text-slate-400">
                      {loading ? "Loading..." : "No payables found."}
                    </td>
                  </tr>
                ) : (
                  payableRows.map((r) => (
                    <tr key={r.id} className="border-t border-slate-800 text-slate-100">
                      <td className="px-4 py-3">{r.partyName}</td>
                      <td className="px-4 py-3 text-right">{money(r.amount)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Receivables Table */}
      {showReceivable && (
        <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/40 overflow-hidden">
          <div className="p-4">
            <div className="text-slate-100 font-semibold">
              Receivables (Grouped by Party) • Range: {rangeText(fromDate, toDate)}
            </div>
          </div>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/70">
                <tr className="text-slate-200">
                  <th className="text-left px-4 py-3">Party</th>
                  <th className="text-right px-4 py-3">Receivable ({currency})</th>
                </tr>
              </thead>
              <tbody>
                {receivableRows.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-6 text-slate-400">
                      {loading ? "Loading..." : "No receivables found."}
                    </td>
                  </tr>
                ) : (
                  receivableRows.map((r) => (
                    <tr key={r.id} className="border-t border-slate-800 text-slate-100">
                      <td className="px-4 py-3">{r.partyName}</td>
                      <td className="px-4 py-3 text-right">{money(r.amount)}</td>
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
