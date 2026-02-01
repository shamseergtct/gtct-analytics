// src/pages/Transactions.jsx
import { useEffect, useMemo, useState } from "react";
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
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function tsToYYYYMMDD(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : null;
    if (!d) return "";
    return toYYYYMMDD(d);
  } catch {
    return "";
  }
}

function discountInfo(t) {
  const pct = num(t?.discountPct);
  const amt = num(t?.discountAmount);
  const type = String(t?.discountType || "").trim();
  const side = String(t?.discountSide || "").trim();

  const enabled =
    Boolean(t?.discountEnabled) || pct > 0 || amt > 0 || type || side;
  if (!enabled) return null;

  const bits = [];
  if (pct > 0) bits.push(`${pct}%`);
  if (amt > 0) bits.push(`Amt ${money(amt)}`);
  if (type) bits.push(type);
  if (side) bits.push(side);

  return {
    pct,
    amt,
    type,
    side,
    label: bits.join(" • ") || "Discount",
  };
}

// ✅ Date is stored per-client
function storageKey(clientId) {
  return `gtct_txn_selectedDate_${clientId || "no_client"}`;
}

export default function Transactions() {
  const { activeClientId, activeClientData } = useClient();

  // ✅ default today first (will be replaced by saved date once client is known)
  const [selectedDate, setSelectedDate] = useState(toYYYYMMDD(new Date()));

  const [loading, setLoading] = useState(false);
  const [txns, setTxns] = useState([]);
  const [err, setErr] = useState("");

  // ✅ edit state
  const [editingTxn, setEditingTxn] = useState(null);

  // ✅ When client changes, load saved date for that client (or keep today if none)
  useEffect(() => {
    if (!activeClientId) return;
    try {
      const saved = localStorage.getItem(storageKey(activeClientId));
      if (saved) setSelectedDate(saved);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClientId]);

  // ✅ Persist date ONLY from Transactions page
  useEffect(() => {
    if (!activeClientId) return;
    try {
      localStorage.setItem(storageKey(activeClientId), selectedDate);
    } catch {}
  }, [activeClientId, selectedDate]);

  const loadTxns = async () => {
    setErr("");
    setTxns([]);
    if (!activeClientId) return;

    setLoading(true);
    try {
      const from = startOfDay(selectedDate);
      const to = endOfDay(selectedDate);

      // NOTE:
      // In your Reports.jsx you use Timestamp.fromDate(),
      // here you already used plain Date and it's working for you.
      // So we keep the SAME behavior.
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

  // ✅ If user changes selectedDate while editing, cancel edit safely
  useEffect(() => {
    if (!editingTxn?.id) return;
    const ed = tsToYYYYMMDD(editingTxn?.date);
    if (ed && ed !== selectedDate) setEditingTxn(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  const deleteTxn = async (id) => {
    if (!window.confirm("Delete this transaction?")) return;
    try {
      await deleteDoc(doc(db, "transactions", id));
      if (editingTxn?.id === id) setEditingTxn(null);
      loadTxns();
    } catch (e) {
      console.error(e);
      alert(e?.message || "Failed to delete");
    }
  };

  const onClickEdit = (t) => {
    if (t?.internalTransfer === true) {
      alert("Internal transfer/refill cannot be edited from here.");
      return;
    }

    setEditingTxn(t);

    // ✅ Sync date picker to txn date
    const d = tsToYYYYMMDD(t?.date);
    if (d) setSelectedDate(d);

    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const activeTitle = useMemo(() => {
    if (!editingTxn?.id) return "";
    return `Editing: ${editingTxn.partyName || "Transaction"}`;
  }, [editingTxn?.id, editingTxn?.partyName]);

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

        {editingTxn?.id ? (
          <div className="mt-2 rounded-xl border border-amber-900 bg-amber-950/30 p-2 text-sm text-amber-200">
            {activeTitle}
          </div>
        ) : null}
      </div>

      {/* Form */}
      <MasterEntryForm
        selectedDate={selectedDate}
        onChangeDate={setSelectedDate}
        onSaved={loadTxns}
        editTxn={editingTxn}
        onCancelEdit={() => setEditingTxn(null)}
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
          {/* Header row */}
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
            txns.map((t) => {
              const disc = discountInfo(t);
              const isEditingThis = editingTxn?.id === t.id;

              return (
                <div
                  key={t.id}
                  className={[
                    "grid grid-cols-12 gap-2 px-4 py-3 border-b border-slate-900 hover:bg-slate-900/40",
                    isEditingThis ? "bg-amber-500/5" : "",
                  ].join(" ")}
                >
                  <div className="col-span-2 text-slate-100 font-medium">
                    {t.type || "-"}
                  </div>

                  <div className="col-span-2 text-slate-300">
                    {t.mode || "-"}
                    {disc ? (
                      <div className="mt-1 inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
                        DISCOUNT • {disc.label}
                      </div>
                    ) : null}
                  </div>

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

                  <div className="col-span-12 flex justify-end gap-3 pt-2">
                    <button
                      onClick={() => onClickEdit(t)}
                      className="text-xs text-sky-300 hover:text-sky-200 disabled:opacity-50"
                      disabled={t?.internalTransfer === true}
                      title={
                        t?.internalTransfer === true
                          ? "Internal transfers cannot be edited"
                          : "Edit"
                      }
                    >
                      Edit
                    </button>

                    <button
                      onClick={() => deleteTxn(t.id)}
                      className="text-xs text-red-300 hover:text-red-200"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
