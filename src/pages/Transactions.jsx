// src/pages/Transactions.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext";
import MasterEntryForm from "../components/MasterEntryForm";

import { fetchDailySession, upsertDailySession } from "../utils/dailySessionStore";

function toYYYYMMDD(dateObj) {
  const d = new Date(dateObj);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function startOfDay(dateStrYYYYMMDD) {
  const [y, m, d] = dateStrYYYYMMDD.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function endOfDay(dateStrYYYYMMDD) {
  const [y, m, d] = dateStrYYYYMMDD.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}
function money(v) {
  const n = Number(v || 0);
  return n.toFixed(2);
}

export default function Transactions() {
  const { activeClientId, activeClientData } = useClient();
  const currency = activeClientData?.currency || "BHD";

  const [selectedDate, setSelectedDate] = useState(toYYYYMMDD(new Date()));

  // ✅ Firestore-backed daily inputs (matches report page)
  const [openingCash, setOpeningCash] = useState("0");
  const [openingBank, setOpeningBank] = useState("0");
  const [actualCashDrawer, setActualCashDrawer] = useState("0");
  const [analystNotes, setAnalystNotes] = useState("");

  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionErr, setSessionErr] = useState("");

  const [loading, setLoading] = useState(false);
  const [txns, setTxns] = useState([]);
  const [err, setErr] = useState("");

  // ---- Load daily session from Firestore when client/date changes
  useEffect(() => {
    const run = async () => {
      setSessionErr("");
      if (!activeClientId) return;

      setSessionLoading(true);
      try {
        const session = await fetchDailySession(activeClientId, selectedDate);

        setOpeningCash(String(session?.openingCash ?? "0"));
        setOpeningBank(String(session?.openingBank ?? "0"));
        setActualCashDrawer(String(session?.actualCashDrawer ?? "0"));
        setAnalystNotes(String(session?.analystNotes ?? ""));
      } catch (e) {
        console.error(e);
        setSessionErr(e?.message || "Failed to load daily session.");
      } finally {
        setSessionLoading(false);
      }
    };

    run();
  }, [activeClientId, selectedDate]);

  // ---- Debounced save to Firestore
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!activeClientId) return;

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      upsertDailySession(activeClientId, selectedDate, {
        openingCash: Number(openingCash || 0),
        openingBank: Number(openingBank || 0),
        actualCashDrawer: Number(actualCashDrawer || 0),
        analystNotes: String(analystNotes || ""),
      }).catch((e) => {
        console.error(e);
        setSessionErr(e?.message || "Auto-save failed.");
      });
    }, 700);

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [
    activeClientId,
    selectedDate,
    openingCash,
    openingBank,
    actualCashDrawer,
    analystNotes,
  ]);

  // ---- Transactions load (daily)
  const loadTxns = async () => {
    setErr("");
    setTxns([]);
    if (!activeClientId) return;

    setLoading(true);
    try {
      const from = startOfDay(selectedDate);
      const to = endOfDay(selectedDate);

      // ✅ Uses enabled index: clientId + date (+ __name__)
      const qy = query(
        collection(db, "transactions"),
        where("clientId", "==", activeClientId),
        where("date", ">=", from),
        where("date", "<=", to),
        orderBy("date", "desc")
      );

      const snap = await getDocs(qy);
      setTxns(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error(e);
      setErr(e?.message || "Failed to load transactions.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTxns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClientId, selectedDate]);

  // ---- KPI / Drawer calculation (matches report cash check)
  const totals = useMemo(() => {
    const cashIn = txns
      .filter((t) => t.mode === "Cash")
      .reduce((s, t) => s + Number(t.amountIn || 0), 0);

    const cashOut = txns
      .filter((t) => t.mode === "Cash")
      .reduce((s, t) => s + Number(t.amountOut || 0), 0);

    const expectedDrawer = Number(openingCash || 0) + (cashIn - cashOut);
    const variance = Number(actualCashDrawer || 0) - expectedDrawer;

    // Helpful quick buckets (optional)
    const salesCash = txns
      .filter((t) => t.type === "Sales" && t.mode === "Cash")
      .reduce((s, t) => s + Number(t.amountIn || 0), 0);

    const receiptCash = txns
      .filter(
        (t) =>
          t.type === "Receipt" &&
          t.mode === "Cash" &&
          (t.partyType === "Customer" || t.partyType === "Both")
      )
      .reduce((s, t) => s + Number(t.amountIn || 0), 0);

    return {
      count: txns.length,
      cashIn,
      cashOut,
      expectedDrawer,
      variance,
      salesCash,
      receiptCash,
    };
  }, [txns, openingCash, actualCashDrawer]);

  const varianceOk = Math.abs(totals.variance) < 0.01;

  const deleteTxn = async (id) => {
    if (!window.confirm("Delete this transaction?")) return;
    try {
      await deleteDoc(doc(db, "transactions", id));
      loadTxns();
    } catch (e) {
      console.error(e);
      alert(e?.message || "Failed to delete");
    }
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">Transactions</h2>
          <p className="text-sm text-slate-400">
            Daily entries (Active Client:{" "}
            <span className="text-slate-200 font-semibold">
              {activeClientData?.name || "No client selected"}
            </span>
            )
          </p>
        </div>

        <div
          className={[
            "rounded-full px-3 py-1 text-xs font-semibold border",
            varianceOk
              ? "bg-emerald-500/15 text-emerald-200 border-emerald-500/30"
              : "bg-red-500/15 text-red-200 border-red-500/30",
          ].join(" ")}
        >
          {varianceOk ? "HEALTHY" : "ACTION REQUIRED"}
        </div>
      </div>

      {/* Controls (same as report inputs) */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div>
            <label className="text-sm text-slate-300">Select Date</label>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
            />
            <div className="mt-2 text-xs text-slate-500">
              Loaded transactions:{" "}
              <span className="text-slate-200 font-semibold">
                {totals.count}
              </span>
            </div>
          </div>

          <div>
            <label className="text-sm text-slate-300">Opening Cash</label>
            <input
              type="number"
              inputMode="decimal"
              value={openingCash}
              onChange={(e) => setOpeningCash(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
            />
          </div>

          <div>
            <label className="text-sm text-slate-300">Opening Bank</label>
            <input
              type="number"
              inputMode="decimal"
              value={openingBank}
              onChange={(e) => setOpeningBank(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
            />
          </div>

          <div>
            <label className="text-sm text-slate-300">Actual Cash in Drawer</label>
            <input
              type="number"
              inputMode="decimal"
              value={actualCashDrawer}
              onChange={(e) => setActualCashDrawer(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
            />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <InfoBox label="Cash In (today)" value={`${money(totals.cashIn)} ${currency}`} />
          <InfoBox label="Cash Out (today)" value={`${money(totals.cashOut)} ${currency}`} />
          <InfoBox label="Expected Drawer" value={`${money(totals.expectedDrawer)} ${currency}`} />
        </div>

        <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950 p-3 flex items-center justify-between">
          <div className="text-slate-300 font-semibold">VARIANCE</div>
          <div className={varianceOk ? "text-emerald-200 font-bold" : "text-red-200 font-bold"}>
            {money(totals.variance)} {currency}
          </div>
        </div>

        {/* Analyst Notes */}
        <div className="mt-4">
          <label className="text-sm text-slate-300">ANALYST NOTES & ALERTS</label>
          <textarea
            value={analystNotes}
            onChange={(e) => setAnalystNotes(e.target.value)}
            placeholder="Write notes for this date & client…"
            className="mt-1 w-full min-h-[90px] rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
          />
          <div className="mt-1 text-xs text-slate-500">
            Auto-saved to Firestore (dailySessions).
          </div>
        </div>

        {sessionLoading ? (
          <div className="mt-3 text-slate-300">Loading daily session…</div>
        ) : null}

        {sessionErr ? (
          <div className="mt-3 rounded-xl border border-red-900 bg-red-950/40 p-2 text-sm text-red-200">
            {sessionErr}
          </div>
        ) : null}

        {err ? (
          <div className="mt-3 rounded-xl border border-red-900 bg-red-950/40 p-2 text-sm text-red-200">
            {err}
          </div>
        ) : null}

        {loading ? <div className="mt-3 text-slate-300">Loading transactions…</div> : null}
      </div>

      {/* New Transaction Form */}
      <MasterEntryForm onSaved={loadTxns} />

      {/* List */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="flex items-center justify-between">
          <div className="text-white font-semibold">Transactions (Selected Day)</div>
          <div className="text-xs text-slate-400">{selectedDate}</div>
        </div>

        <div className="mt-3 overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
          <div className="grid grid-cols-12 gap-2 px-4 py-3 text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
            <div className="col-span-2">Type</div>
            <div className="col-span-2">Mode</div>
            <div className="col-span-3">Party</div>
            <div className="col-span-3">Description</div>
            <div className="col-span-1 text-right">In</div>
            <div className="col-span-1 text-right">Out</div>
          </div>

          {txns.length === 0 ? (
            <div className="px-4 py-6 text-slate-400">No transactions found.</div>
          ) : (
            txns.map((t) => (
              <div
                key={t.id}
                className="grid grid-cols-12 gap-2 px-4 py-3 border-b border-slate-900 hover:bg-slate-900/40"
              >
                <div className="col-span-2 text-slate-100 font-medium">
                  {t.type}
                  {t.type === "Receipt" &&
                  (t.partyType === "Customer" || t.partyType === "Both") ? (
                    <div className="text-[11px] text-emerald-300 mt-0.5">
                      Credit Recovery
                    </div>
                  ) : null}
                </div>

                <div className="col-span-2 text-slate-300">{t.mode}</div>

                <div className="col-span-3 text-slate-300">
                  {t.partyName || "-"}
                  {t.partyType ? (
                    <div className="text-[11px] text-slate-500">{t.partyType}</div>
                  ) : null}
                </div>

                <div className="col-span-3 text-slate-400 truncate">
                  {t.description || "-"}
                </div>

                <div className="col-span-1 text-right text-emerald-200">
                  {money(t.amountIn)}
                </div>

                <div className="col-span-1 text-right text-red-200">
                  {money(t.amountOut)}
                </div>

                <div className="col-span-12 flex justify-end pt-2">
                  <button
                    onClick={() => deleteTxn(t.id)}
                    className="text-xs text-red-300 hover:text-red-200"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function InfoBox({ label, value }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
      <div className="text-sm text-slate-400">{label}</div>
      <div className="mt-1 text-xl font-bold text-white">{value}</div>
    </div>
  );
}
