// src/components/MasterEntryForm.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { collection, addDoc, getDocs, orderBy, query, where, Timestamp } from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext";

function num(v) {
  return Number(v || 0);
}

export default function MasterEntryForm({ selectedDate, onChangeDate, onSaved }) {
  const { activeClientId } = useClient();

  const [type, setType] = useState("Sales");
  const [category, setCategory] = useState("Commodity");
  const [mode, setMode] = useState("Cash");

  const [partyType, setPartyType] = useState("Customer"); // Customer / Supplier / Both
  const [parties, setParties] = useState([]);

  // Party picker (search)
  const [partyQuery, setPartyQuery] = useState("");
  const [selectedParty, setSelectedParty] = useState(null); // {id,name,type}
  const [showPartyList, setShowPartyList] = useState(false);
  const partyBlurTimer = useRef(null);

  const [description, setDescription] = useState("");

  const [amountBeforeTax, setAmountBeforeTax] = useState("0");
  const [vatPercent, setVatPercent] = useState("0"); // ✅ default 0

  const taxAmount = useMemo(() => {
    const base = num(amountBeforeTax);
    const p = num(vatPercent);
    return (base * p) / 100;
  }, [amountBeforeTax, vatPercent]);

  const totalAmount = useMemo(() => {
    return num(amountBeforeTax) + num(taxAmount);
  }, [amountBeforeTax, taxAmount]);

  // Load parties for this client
  useEffect(() => {
    const run = async () => {
      setParties([]);
      setSelectedParty(null);
      setPartyQuery("");
      if (!activeClientId) return;

      const qy = query(
        collection(db, "parties"),
        where("clientId", "==", activeClientId),
        orderBy("name", "asc")
      );

      const snap = await getDocs(qy);
      setParties(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    };

    run().catch(console.error);
  }, [activeClientId]);

  const filteredParties = useMemo(() => {
    const q = partyQuery.trim().toLowerCase();

    // Always include a "Cash" quick option (no DB needed)
    const virtual = [{ id: "__cash__", name: "Cash", type: "Both" }];

    const base = parties.filter((p) => {
      if (!partyType) return true;
      return p.type === partyType || p.type === "Both";
    });

    const list = q
      ? base.filter((p) => String(p.name || "").toLowerCase().includes(q))
      : base;

    return [...virtual, ...list].slice(0, 12);
  }, [partyQuery, parties, partyType]);

  function pickParty(p) {
    setSelectedParty(p);
    setPartyQuery(p.name);
    setShowPartyList(false); // ✅ closes dropdown (fixes stuck/duplicate)
  }

  async function save() {
    if (!activeClientId) return alert("Select active client first.");

    if (!selectedDate) return alert("Select date.");
    if (!type) return alert("Select type.");
    if (!mode) return alert("Select mode.");
    if (!partyQuery.trim()) return alert("Select party.");

    const dateObj = new Date(selectedDate);
    const dateTs = Timestamp.fromDate(dateObj);

    // Decide In/Out
    const t = String(type || "").toLowerCase();
    const m = String(mode || "").toLowerCase();

    let amountIn = 0;
    let amountOut = 0;

    // ✅ Sales always amountIn (even Credit) — used for Z-report + receivable
    if (t === "sales") amountIn = totalAmount;

    // ✅ Receipt is inflow
    else if (t === "receipt" || t === "income") amountIn = totalAmount;

    // ✅ Purchase:
    // - Credit purchase creates liability (no cash out now) => keep as amountIn for liability tracking
    // - Cash/Bank purchase is expense out
    else if (t === "purchase") {
      if (m === "credit") amountIn = totalAmount;
      else amountOut = totalAmount;
    }

    // ✅ Payment/Expense is outflow
    else if (t === "payment" || t === "expense") amountOut = totalAmount;

    // fallback: if user uses random types, decide by partyType
    else {
      if (partyType === "Supplier") amountOut = totalAmount;
      else amountIn = totalAmount;
    }

    const partyName =
      selectedParty?.id === "__cash__" ? "Cash" : (selectedParty?.name || partyQuery.trim());

    const payload = {
      clientId: activeClientId,
      date: dateTs,

      type,
      category,
      mode,

      partyType,
      partyId: selectedParty?.id === "__cash__" ? null : (selectedParty?.id || null),
      partyName,

      description: String(description || "").trim(),

      amountBeforeTax: num(amountBeforeTax),
      vatPercent: num(vatPercent),
      taxAmount: num(taxAmount),
      totalAmount: num(totalAmount),

      amountIn: num(amountIn),
      amountOut: num(amountOut),

      createdAt: Timestamp.now(),
    };

    await addDoc(collection(db, "transactions"), payload);

    // reset small fields (keep date)
    setDescription("");
    setAmountBeforeTax("0");
    setVatPercent("0");
    setSelectedParty(null);
    setPartyQuery("");
    setShowPartyList(false);

    onSaved?.();
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="text-white font-semibold">New Transaction</div>

      {/* Row 1 */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <div>
          <label className="text-sm text-slate-300">Date</label>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => onChangeDate?.(e.target.value)}
            className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
          />
        </div>

        <div>
          <label className="text-sm text-slate-300">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
          >
            <option>Sales</option>
            <option>Purchase</option>
            <option>Receipt</option>
            <option>Payment</option>
            <option>Expense</option>
            <option>Income</option>
          </select>
        </div>

        <div>
          <label className="text-sm text-slate-300">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
          >
            <option>Commodity</option>
            <option>Service</option>
            <option>Salary</option>
            <option>Rent</option>
            <option>Utility</option>
            <option>Transport</option>
            <option>Other</option>
          </select>
        </div>

        <div>
          <label className="text-sm text-slate-300">Mode</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
          >
            <option>Cash</option>
            <option>Bank</option>
            <option>Credit</option>
          </select>
        </div>
      </div>

      {/* Row 2 */}
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="text-sm text-slate-300">Party Type</label>
          <select
            value={partyType}
            onChange={(e) => {
              setPartyType(e.target.value);
              setSelectedParty(null);
              setPartyQuery("");
            }}
            className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
          >
            <option value="Customer">Customer</option>
            <option value="Supplier">Supplier</option>
            <option value="Both">Both</option>
          </select>
        </div>

        <div className="relative">
          <label className="text-sm text-slate-300">Party *</label>
          <input
            value={partyQuery}
            onChange={(e) => {
              const v = e.target.value;
              setPartyQuery(v);
              setSelectedParty(null);
              setShowPartyList(true);
            }}
            onFocus={() => setShowPartyList(true)}
            onBlur={() => {
              if (partyBlurTimer.current) clearTimeout(partyBlurTimer.current);
              partyBlurTimer.current = setTimeout(() => setShowPartyList(false), 150);
            }}
            placeholder="Search party..."
            className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
          />

          {showPartyList && (
            <div className="absolute z-50 mt-2 w-full max-h-60 overflow-auto rounded-xl border border-slate-800 bg-slate-950 shadow-lg">
              {filteredParties.length === 0 ? (
                <div className="px-3 py-2 text-sm text-slate-400">No matches</div>
              ) : (
                filteredParties.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    onMouseDown={(e) => e.preventDefault()} // ✅ prevents blur before click
                    onClick={() => pickParty(p)}
                    className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-900"
                  >
                    <span className="font-medium">{p.name}</span>
                    <span className="ml-2 text-xs text-slate-500">{p.type}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Row 3 */}
      <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="text-sm text-slate-300">Amount (Before Tax)</label>
          <input
            type="number"
            inputMode="decimal"
            value={amountBeforeTax}
            onChange={(e) => setAmountBeforeTax(e.target.value)}
            className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
          />
        </div>

        <div>
          <label className="text-sm text-slate-300">VAT %</label>
          <input
            type="number"
            inputMode="decimal"
            value={vatPercent}
            onChange={(e) => setVatPercent(e.target.value)}
            className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
          />
          <div className="mt-1 text-xs text-slate-500">Default is 0</div>
        </div>

        <div>
          <label className="text-sm text-slate-300">Total Amount</label>
          <input
            value={totalAmount.toFixed(2)}
            readOnly
            className="mt-1 w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-slate-200 outline-none"
          />
        </div>
      </div>

      {/* Description */}
      <div className="mt-3">
        <label className="text-sm text-slate-300">Description</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional note..."
          className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
        />
      </div>

      {/* Save */}
      <div className="mt-4 flex justify-end">
        <button
          onClick={save}
          disabled={!activeClientId}
          className="rounded-xl bg-white px-5 py-2 text-sm font-semibold text-slate-950 hover:opacity-90 disabled:opacity-60"
        >
          Save Transaction
        </button>
      </div>
    </div>
  );
}
