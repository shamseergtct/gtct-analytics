// src/pages/Transactions.jsx
import { useEffect, useState } from "react";
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

function toYYYYMMDD(d) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function startOfDay(yyyyMMdd) {
  const [y, m, d] = yyyyMMdd.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function endOfDay(yyyyMMdd) {
  const [y, m, d] = yyyyMMdd.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}
function money(v) {
  return Number(v || 0).toFixed(2);
}

export default function Transactions() {
  const { activeClientId, activeClientData } = useClient();

  const [selectedDate, setSelectedDate] = useState(toYYYYMMDD(new Date()));

  const [loading, setLoading] = useState(false);
  const [txns, setTxns] = useState([]);
  const [err, setErr] = useState("");

  const loadTxns = async () => {
    setErr("");
    setTxns([]);
    if (!activeClientId) return;

    setLoading(true);
    try {
      const from = startOfDay(selectedDate);
      const to = endOfDay(selectedDate);

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

      {/* New Transaction (date is ONLY here) */}
      <MasterEntryForm
        selectedDate={selectedDate}
        onChangeDate={setSelectedDate}
        onSaved={loadTxns}
      />

      {/* List */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="flex items-center justify-between">
          <div className="text-white font-semibold">Transactions</div>
          <div className="text-xs text-slate-400">{selectedDate}</div>
        </div>

        {err ? (
          <div className="mt-3 rounded-xl border border-red-900 bg-red-950/40 p-2 text-sm text-red-200">
            {err}
          </div>
        ) : null}

        {loading ? <div className="mt-3 text-slate-300">Loading…</div> : null}

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
                  {t.type || "-"}
                </div>

                <div className="col-span-2 text-slate-300">{t.mode || "-"}</div>

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
