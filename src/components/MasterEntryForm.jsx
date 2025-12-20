// src/components/MasterEntryForm.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext.jsx";

function normalizeNumber(v) {
  if (v === "" || v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

function partyMatchesTransaction(partyType, txnType) {
  if (txnType === "Sales") return partyType === "Customer" || partyType === "Both";
  if (txnType === "Purchase") return partyType === "Supplier" || partyType === "Both";
  if (txnType === "Receipt") return partyType === "Customer" || partyType === "Both"; // recovery
  if (txnType === "Payment") return partyType === "Supplier" || partyType === "Both";
  return true;
}

export default function MasterEntryForm({ onSaved }) {
  const { activeClientId } = useClient();

  // Fields
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [type, setType] = useState("Sales");
  const [category, setCategory] = useState("Commodity");
  const [mode, setMode] = useState("Cash");
  const [description, setDescription] = useState("");

  // Parties
  const [allParties, setAllParties] = useState([]);
  const [partyId, setPartyId] = useState("");
  const [partyName, setPartyName] = useState("");
  const [partyType, setPartyType] = useState(""); // ✅ saved into transaction

  // Dropdown UI
  const [partyQuery, setPartyQuery] = useState("");
  const [partyOpen, setPartyOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Tax
  const [amountBeforeTax, setAmountBeforeTax] = useState("");
  const [vatPercent, setVatPercent] = useState(5);

  const taxAmount = useMemo(() => {
    const base = normalizeNumber(amountBeforeTax);
    const vat = normalizeNumber(vatPercent);
    return round2(base * (vat / 100));
  }, [amountBeforeTax, vatPercent]);

  const totalAmount = useMemo(() => {
    const base = normalizeNumber(amountBeforeTax);
    return round2(base + taxAmount);
  }, [amountBeforeTax, taxAmount]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Fetch parties
  useEffect(() => {
    async function fetchParties() {
      if (!activeClientId) {
        setAllParties([]);
        return;
      }
      try {
        const ref = collection(db, "parties");
        const qy = query(ref, where("clientId", "==", activeClientId), orderBy("name", "asc"));
        const snap = await getDocs(qy);
        setAllParties(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      } catch (e) {
        console.error("❌ Fetch parties error:", e);
      }
    }
    fetchParties();
  }, [activeClientId]);

  // Close dropdown
  useEffect(() => {
    function onDocClick(e) {
      if (!dropdownRef.current) return;
      if (!dropdownRef.current.contains(e.target)) setPartyOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === "Escape") setPartyOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Clear invalid party on type change
  useEffect(() => {
    if (!partyId) return;
    const selected = allParties.find((p) => p.id === partyId);
    if (!selected) return;

    if (!partyMatchesTransaction(selected.type, type)) {
      setPartyId("");
      setPartyName("");
      setPartyType("");
      setPartyQuery("");
    }
  }, [type, partyId, allParties]);

  const partiesForTxn = useMemo(() => {
    const base = allParties.filter((p) => partyMatchesTransaction(p.type, type));
    const q = partyQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((p) => (p.name || "").toLowerCase().includes(q));
  }, [allParties, partyQuery, type]);

  function chooseParty(p) {
    setPartyId(p.id);
    setPartyName(p.name || "");
    setPartyType(p.type || ""); // ✅ store party type
    setPartyQuery(p.name || "");
    setPartyOpen(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!activeClientId) return setError("Please select a client first.");
    if (!date) return setError("Date is required.");
    if (!type) return setError("Transaction type is required.");

    const baseAmount = normalizeNumber(amountBeforeTax);
    if (!baseAmount || baseAmount <= 0) {
      return setError("Amount (Before Tax) must be greater than 0.");
    }

    // Party mandatory for key types
    const partyRequired = ["Sales", "Purchase", "Receipt", "Payment"].includes(type);
    if (partyRequired && !partyId) {
      return setError("Please select a party.");
    }

    // ✅ CORRECT CASHFLOW LOGIC (FIXED)
    let amountIn = 0;
    let amountOut = 0;

    // Money received
    if (type === "Sales" || type === "Receipt") {
      if (mode === "Cash" || mode === "Bank") amountIn = totalAmount;
      // Credit => no cash received now
    }

    // Money paid
    if (type === "Purchase" || type === "Expense" || type === "Payment" || type === "Drawing") {
      if (mode === "Cash" || mode === "Bank") amountOut = totalAmount;
      // Credit => no cash paid now (creates liability)
    }

    setSaving(true);

    try {
      await addDoc(collection(db, "transactions"), {
        clientId: activeClientId,
        date: new Date(`${date}T00:00:00`),

        type,
        category,
        mode,
        description: description || "",

        // Party fields
        partyId: partyId || "",
        partyName: partyName || "",
        partyType: partyType || "", // ✅ REQUIRED for credit recovery logic

        // Tax fields
        amountBeforeTax: round2(baseAmount),
        vatPercent: normalizeNumber(vatPercent),
        taxAmount: round2(taxAmount),
        totalAmount: round2(totalAmount),

        // Cashflow fields (used for drawer/variance/report)
        amountIn: round2(amountIn),
        amountOut: round2(amountOut),

        createdAt: serverTimestamp(),
      });

      // reset
      setDescription("");
      setAmountBeforeTax("");
      setVatPercent(5);

      // clear party for new entry (optional)
      setPartyId("");
      setPartyName("");
      setPartyType("");
      setPartyQuery("");

      if (typeof onSaved === "function") onSaved();
    } catch (e2) {
      console.error("❌ Save transaction error:", e2);
      setError(e2?.message || "Failed to save transaction");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4 md:p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-slate-100 font-semibold">New Transaction</h2>
        {saving ? <span className="text-sm text-slate-400">Saving…</span> : null}
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-12 gap-3">
        {/* Date */}
        <div className="md:col-span-3">
          <label className="text-sm text-slate-300">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-600"
          />
        </div>

        {/* Type */}
        <div className="md:col-span-3">
          <label className="text-sm text-slate-300">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-600"
          >
            <option>Sales</option>
            <option>Purchase</option>
            <option>Expense</option>
            <option>Payment</option>
            <option>Receipt</option>
            <option>Drawing</option>
          </select>
        </div>

        {/* Category */}
        <div className="md:col-span-3">
          <label className="text-sm text-slate-300">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-600"
          >
            <option>Commodity</option>
            <option>Asset</option>
            <option>Running</option>
            <option>Liability</option>
            <option>Loan</option>
          </select>
        </div>

        {/* Mode */}
        <div className="md:col-span-3">
          <label className="text-sm text-slate-300">Mode</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-600"
          >
            <option>Cash</option>
            <option>Bank</option>
            <option>Credit</option>
          </select>
        </div>

        {/* Party dropdown */}
        <div className="md:col-span-6" ref={dropdownRef}>
          <label className="text-sm text-slate-300">
            {type === "Sales" || type === "Receipt"
              ? "Customer"
              : type === "Purchase" || type === "Payment"
              ? "Supplier"
              : "Party"}{" "}
            {["Sales", "Purchase", "Receipt", "Payment"].includes(type) ? "*" : ""}
          </label>

          <div className="relative mt-1">
            <input
              value={partyQuery}
              onChange={(e) => {
                setPartyQuery(e.target.value);
                setPartyOpen(true);
                setPartyId("");
                setPartyName("");
                setPartyType("");
              }}
              onFocus={() => setPartyOpen(true)}
              placeholder="Search party…"
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-600"
            />

            {partyOpen ? (
              <div className="absolute z-20 mt-2 w-full rounded-xl border border-slate-800 bg-slate-950 shadow-xl max-h-60 overflow-auto">
                {partiesForTxn.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-slate-400">No matches. Add from Parties page.</div>
                ) : (
                  partiesForTxn.map((p) => (
                    <button
                      type="button"
                      key={p.id}
                      onClick={() => chooseParty(p)}
                      className="w-full text-left px-3 py-2 hover:bg-slate-900/60 border-b border-slate-900 last:border-b-0"
                    >
                      <div className="text-slate-100 text-sm font-medium">{p.name}</div>
                      <div className="text-slate-400 text-xs">
                        {p.type} {p.contact ? `• ${p.contact}` : ""}
                      </div>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>

          {partyId ? (
            <div className="mt-1 text-xs text-slate-400">
              Selected: <span className="text-slate-200">{partyName}</span>
            </div>
          ) : null}
        </div>

        {/* Tax fields */}
        <div className="md:col-span-3">
          <label className="text-sm text-slate-300">Amount (Before Tax)</label>
          <input
            type="number"
            inputMode="decimal"
            value={amountBeforeTax}
            onChange={(e) => setAmountBeforeTax(e.target.value)}
            placeholder="0.00"
            className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-600"
          />
        </div>

        <div className="md:col-span-3">
          <label className="text-sm text-slate-300">VAT %</label>
          <input
            type="number"
            inputMode="decimal"
            value={vatPercent}
            onChange={(e) => setVatPercent(e.target.value)}
            className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-600"
          />
        </div>

        <div className="md:col-span-3">
          <label className="text-sm text-slate-300">Tax Amount</label>
          <input
            type="number"
            value={taxAmount}
            readOnly
            className="mt-1 w-full rounded-lg bg-slate-900/60 border border-slate-800 px-3 py-2 text-slate-200"
          />
        </div>

        <div className="md:col-span-3">
          <label className="text-sm text-slate-300">Total Amount</label>
          <input
            type="number"
            value={totalAmount}
            readOnly
            className="mt-1 w-full rounded-lg bg-slate-900/60 border border-slate-800 px-3 py-2 text-slate-200"
          />
        </div>

        {/* Description */}
        <div className="md:col-span-12">
          <label className="text-sm text-slate-300">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional note…"
            className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-600"
          />
        </div>
      </div>

      {error ? (
        <div className="mt-4 rounded-lg border border-red-800 bg-red-950/40 text-red-200 px-3 py-2 text-sm">
          {error}
        </div>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 font-medium disabled:opacity-60"
        >
          Save Transaction
        </button>
      </div>
    </form>
  );
}
