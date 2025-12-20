// src/pages/PartyReports.jsx
import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext";

import { fetchPartyLedger, buildPartyReport } from "../utils/partyLedger";
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

export default function PartyReports() {
  const { activeClientId, activeClientData } = useClient();
  const currency = activeClientData?.currency || "BHD";

  const [type, setType] = useState("Customer"); // Customer | Supplier
  const [parties, setParties] = useState([]);
  const [partyId, setPartyId] = useState("");

  const [fromDate, setFromDate] = useState(() => toYYYYMMDD(new Date()));
  const [toDate, setToDate] = useState(() => toYYYYMMDD(new Date()));

  const [loadingParties, setLoadingParties] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [rows, setRows] = useState([]);

  // Load parties for dropdown
  useEffect(() => {
    const run = async () => {
      setErr("");
      setRows([]);
      setPartyId("");
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

  const filteredParties = useMemo(() => {
    if (!type) return parties;
    return parties.filter((p) => p.type === type || p.type === "Both");
  }, [parties, type]);

  const selectedParty = useMemo(
    () => parties.find((p) => p.id === partyId),
    [parties, partyId]
  );

  const load = async () => {
    setErr("");
    setRows([]);

    if (!activeClientId) return setErr("Please select an active client.");
    if (!partyId) return setErr("Please select a party.");
    if (!fromDate || !toDate) return setErr("Please choose From and To dates.");

    setLoading(true);
    try {
      const txns = await fetchPartyLedger({
        clientId: activeClientId,
        partyId,
        fromYYYYMMDD: fromDate,
        toYYYYMMDD: toDate,
      });
      setRows(txns);
    } catch (e) {
      console.error(e);
      setErr(e?.message || "Failed to load party report.");
    } finally {
      setLoading(false);
    }
  };

  // Build summary from loaded rows
  const report = useMemo(() => {
    return buildPartyReport({
      txns: rows,
      partyType: type,
    });
  }, [rows, type]);

  const canLoad = Boolean(activeClientId && partyId && fromDate && toDate);
  const canDownload = Boolean(canLoad && report?.rows?.length);

  const downloadPDF = () => {
    if (!activeClientId) return alert("Select active client first.");
    if (!partyId) return alert("Select party first.");

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
          <h2 className="text-xl font-bold text-white">
            Customer / Vendor Reports
          </h2>
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
                setPartyId("");
                setRows([]);
                setErr("");
              }}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
            >
              <option value="Customer">Customer (Receivable)</option>
              <option value="Supplier">Vendor/Supplier (Payable)</option>
            </select>
          </div>

          <div>
            <label className="text-sm text-slate-300">
              {type === "Customer" ? "Customer" : "Supplier"}
            </label>
            <select
              value={partyId}
              onChange={(e) => {
                setPartyId(e.target.value);
                setRows([]);
                setErr("");
              }}
              disabled={!activeClientId || loadingParties}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500 disabled:opacity-60"
            >
              <option value="" disabled>
                {loadingParties ? "Loading…" : "Select…"}
              </option>
              {filteredParties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
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
            Uses index: <span className="text-slate-300">transactions → clientId + partyId + date</span>
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
          Customer logic: <span className="text-slate-300">Credit Sales − Receipts</span>. Supplier logic:{" "}
          <span className="text-slate-300">Credit Purchases − Payments</span>.
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
                <div className="col-span-2 text-slate-100 font-medium">{t.type}</div>
                <div className="col-span-2 text-slate-300">{t.mode}</div>
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
