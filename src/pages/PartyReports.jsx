// src/pages/PartyReports.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext";

import { generatePartyPDF } from "../utils/partyPdfGenerator";

function money(v) {
  return Number(v || 0).toFixed(2);
}
function toYYYYMMDD(d) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function startOfDay(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function endOfDay(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}
function asJSDate(v) {
  if (!v) return null;
  if (typeof v?.toDate === "function") return v.toDate();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function norm(s) {
  return String(s || "").trim().toLowerCase();
}

// ✅ safer: supports amountIn/amountOut/totalAmount
function txnTotal(t) {
  const inAmt = Number(t?.amountIn || 0);
  const outAmt = Number(t?.amountOut || 0);
  if (inAmt > 0) return inAmt;
  if (outAmt > 0) return outAmt;
  const total = Number(t?.totalAmount || 0);
  return total > 0 ? total : 0;
}

export default function PartyReports() {
  const { activeClientId, activeClientData } = useClient();
  const currency = activeClientData?.currency || "BHD";

  const [type, setType] = useState("Customer"); // Customer | Supplier
  const [parties, setParties] = useState([]);

  // Searchable party picker
  const [partyQuery, setPartyQuery] = useState("");
  const [selectedParty, setSelectedParty] = useState(null); // {id,name,type}
  const [showPartyList, setShowPartyList] = useState(false);
  const blurTimer = useRef(null);

  const [fromDate, setFromDate] = useState(() => toYYYYMMDD(new Date()));
  const [toDate, setToDate] = useState(() => toYYYYMMDD(new Date()));

  const [loadingParties, setLoadingParties] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // Ledger rows (raw txns)
  const [rows, setRows] = useState([]);

  // -------------------------
  // Load parties
  // -------------------------
  useEffect(() => {
    const run = async () => {
      setErr("");
      setRows([]);
      setSelectedParty(null);
      setPartyQuery("");
      setParties([]);

      if (!activeClientId) return;

      setLoadingParties(true);
      try {
        const qy = query(
          collection(db, "parties"),
          where("clientId", "==", activeClientId),
          orderBy("name", "asc")
        );
        const snap = await getDocs(qy);
        setParties(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      } catch (e) {
        console.error(e);
        setErr(e?.message || "Failed to load parties.");
      } finally {
        setLoadingParties(false);
      }
    };

    run();
  }, [activeClientId]);

  // ✅ Filter parties by type (include Both) — CASE INSENSITIVE
  const filteredParties = useMemo(() => {
    const want = norm(type);
    return parties.filter((p) => {
      const pt = norm(p?.type);
      return pt === want || pt === "both";
    });
  }, [parties, type]);

  // Search list
  const visibleParties = useMemo(() => {
    const q = partyQuery.trim().toLowerCase();
    const base = filteredParties;
    if (!q) return base.slice(0, 15);
    return base
      .filter((p) => String(p?.name || "").toLowerCase().includes(q))
      .slice(0, 25);
  }, [partyQuery, filteredParties]);

  function pickParty(p) {
    setSelectedParty(p);
    setPartyQuery(p?.name || "");
    setShowPartyList(false);
    setRows([]);
    setErr("");
  }

  // -------------------------
  // ✅ Load ledger (COMPLETE)
  // Fetch by clientId + date range, then filter by partyId OR partyName
  // -------------------------
  const load = async () => {
    setErr("");
    setRows([]);

    if (!activeClientId) return setErr("Please select an active client.");
    if (!selectedParty?.id && !selectedParty?.name)
      return setErr("Please select a party.");
    if (!fromDate || !toDate) return setErr("Please choose From and To dates.");

    const f = startOfDay(fromDate);
    const t = endOfDay(toDate);
    if (f > t) return setErr("From date must be before To date.");

    setLoading(true);
    try {
      // ✅ Uses your existing enabled index: transactions → clientId + date
      const qy = query(
        collection(db, "transactions"),
        where("clientId", "==", activeClientId),
        where("date", ">=", f),
        where("date", "<=", t),
        orderBy("date", "desc")
      );

      const snap = await getDocs(qy);
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      const pid = String(selectedParty?.id || "").trim();
      const pname = norm(selectedParty?.name);

      // ✅ local filter (partyId OR partyName)
      const txns = all.filter((x) => {
        if (pid && x?.partyId === pid) return true;
        if (pname && norm(x?.partyName) === pname) return true;
        return false;
      });

      const normalized = txns.map((x) => ({
        ...x,
        _dateObj: asJSDate(x.date),
        _total: txnTotal(x),
      }));

      setRows(normalized);
    } catch (e) {
      console.error(e);
      setErr(e?.message || "Failed to load party report.");
    } finally {
      setLoading(false);
    }
  };

  // -------------------------
  // Build summary (Customer/Supplier)
  // -------------------------
  const report = useMemo(() => {
    const txns = rows || [];
    const isCustomer = norm(type) === "customer";

    // CREDIT GIVEN:
    // Customer => Sales (Credit)
    // Supplier => Purchase (Credit)
    const creditGiven = txns
      .filter((t) => {
        const tt = norm(t?.type);
        const mm = norm(t?.mode);
        if (mm !== "credit") return false;
        if (isCustomer) return tt === "sales";
        return tt === "purchase";
      })
      .reduce((s, t) => s + Number(txnTotal(t) || 0), 0);

    // SETTLED:
    // Customer => Receipt
    // Supplier => Payment
    const settled = txns
      .filter((t) => {
        const tt = norm(t?.type);
        if (isCustomer) return tt === "receipt";
        return tt === "payment";
      })
      .reduce((s, t) => s + Number(txnTotal(t) || 0), 0);

    const pending = creditGiven - settled;

    return {
      count: txns.length,
      creditGiven,
      settled,
      pending,
      rows: txns,
    };
  }, [rows, type]);

  const canLoad = Boolean(activeClientId && selectedParty?.name && fromDate && toDate);
  const canDownload = Boolean(canLoad && report?.rows?.length);

  const downloadPDF = () => {
    if (!activeClientId) return alert("Select active client first.");
    if (!selectedParty?.name) return alert("Select party first.");

    const doc = generatePartyPDF({
      clientName: activeClientData?.name || "Client",
      currency,
      partyName: selectedParty?.name || "Party",
      partyType: type,
      fromDate,
      toDate,
      report,
    });

    doc.save(
      `${activeClientData?.name || "Client"}-${selectedParty?.name || "Party"}-${fromDate}-to-${toDate}.pdf`
    );
  };

  return (
    <div className="space-y-5">
      {/* Header + Download */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">Customer / Vendor Reports</h2>
          <p className="text-sm text-slate-400">
            Active Client:{" "}
            <span className="text-slate-200 font-semibold">
              {activeClientData?.name || "No client selected"}
            </span>
          </p>
        </div>

        <button
          onClick={downloadPDF}
          disabled={!canDownload}
          className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:opacity-90 disabled:opacity-60"
          title={!canDownload ? "Load report first, then download" : "Download PDF"}
        >
          Download PDF
        </button>
      </div>

      {/* Controls */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div>
            <label className="text-sm text-slate-300">Report Type</label>
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setSelectedParty(null);
                setPartyQuery("");
                setRows([]);
                setErr("");
              }}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
            >
              <option value="Customer">Customer (Receivable)</option>
              <option value="Supplier">Vendor/Supplier (Payable)</option>
            </select>
          </div>

          {/* Searchable Party Picker */}
          <div className="relative">
            <label className="text-sm text-slate-300">
              {type === "Customer" ? "Customer" : "Supplier"}
            </label>

            <input
              value={partyQuery}
              onChange={(e) => {
                setPartyQuery(e.target.value);
                setSelectedParty(null);
                setShowPartyList(true);
                setRows([]);
              }}
              onFocus={() => setShowPartyList(true)}
              onBlur={() => {
                if (blurTimer.current) clearTimeout(blurTimer.current);
                blurTimer.current = setTimeout(() => setShowPartyList(false), 150);
              }}
              disabled={!activeClientId || loadingParties}
              placeholder={loadingParties ? "Loading..." : "Search party..."}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500 disabled:opacity-60"
            />

            {showPartyList && activeClientId ? (
              <div className="absolute z-50 mt-2 w-full max-h-64 overflow-auto rounded-xl border border-slate-800 bg-slate-950 shadow-lg">
                {visibleParties.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-slate-400">No matches</div>
                ) : (
                  visibleParties.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickParty(p)}
                      className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-900"
                    >
                      <span className="font-medium">{p.name}</span>
                      <span className="ml-2 text-xs text-slate-500">({p.type})</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <div>
            <label className="text-sm text-slate-300">From</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setRows([]);
              }}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
            />
          </div>

          <div>
            <label className="text-sm text-slate-300">To</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setRows([]);
              }}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
            />
          </div>
        </div>

        <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
          <button
            onClick={load}
            disabled={!canLoad || loading}
            className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:opacity-90 disabled:opacity-60"
          >
            {loading ? "Loading..." : "Load Report"}
          </button>

          <div className="text-xs text-slate-500">
            Ledger filter:{" "}
            <span className="text-slate-300">clientId + date range + (partyId/partyName)</span>
          </div>
        </div>

        {err ? (
          <div className="mt-3 rounded-xl border border-red-900 bg-red-950/40 p-2 text-sm text-red-200">
            {err}
          </div>
        ) : null}
      </div>

      {/* Summary */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="flex items-center justify-between">
          <div className="text-white font-semibold">
            Summary — {selectedParty?.name || "-"}
          </div>
          <div className="text-xs text-slate-400">{report.count} records</div>
        </div>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Box
            label={
              type === "Customer"
                ? "Credit Sales (Credit only)"
                : "Credit Purchases (Credit only)"
            }
            value={`${money(report.creditGiven)} ${currency}`}
          />
          <Box
            label={type === "Customer" ? "Recovered (Receipts)" : "Paid (Payments)"}
            value={`${money(report.settled)} ${currency}`}
          />
          <Box
            label={type === "Customer" ? "Pending Receivable" : "Pending Payable"}
            value={`${money(report.pending)} ${currency}`}
          />
        </div>

        <div className="mt-2 text-xs text-slate-500">
          Customer: <span className="text-slate-300">Sales(Credit) − Receipts</span>. Supplier:{" "}
          <span className="text-slate-300">Purchase(Credit) − Payments</span>.
        </div>
      </div>

      {/* Details */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="text-white font-semibold">Transactions</div>

        <div className="mt-3 overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
          <div className="grid grid-cols-12 gap-2 px-4 py-3 text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
            <div className="col-span-2">Date</div>
            <div className="col-span-2">Type</div>
            <div className="col-span-2">Mode</div>
            <div className="col-span-4">Description</div>
            <div className="col-span-2 text-right">Amount</div>
          </div>

          {report.rows.length === 0 ? (
            <div className="px-4 py-6 text-slate-400">No records found.</div>
          ) : (
            report.rows.map((t) => (
              <div
                key={t.id}
                className="grid grid-cols-12 gap-2 px-4 py-3 border-b border-slate-900 hover:bg-slate-900/40"
              >
                <div className="col-span-2 text-slate-300">
                  {t._dateObj ? toYYYYMMDD(t._dateObj) : "-"}
                </div>
                <div className="col-span-2 text-slate-100 font-medium">{t.type || "-"}</div>
                <div className="col-span-2 text-slate-300">{t.mode || "-"}</div>
                <div className="col-span-4 text-slate-400 truncate">
                  {t.description || "-"}
                </div>
                <div className="col-span-2 text-right text-white font-semibold">
                  {money(t._total)} {currency}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Box({ label, value }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
      <div className="text-sm text-slate-400">{label}</div>
      <div className="mt-1 text-xl font-bold text-white">{value}</div>
    </div>
  );
}
