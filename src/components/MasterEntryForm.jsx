// src/components/MasterEntryForm.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  addDoc,
  getDocs,
  orderBy,
  query,
  where,
  Timestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function clampPct(v) {
  const n = num(v);
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
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

  // --------------------------
  // ✅ Discount system (optional)
  // --------------------------
  const [discountEnabled, setDiscountEnabled] = useState(false);

  // Both fields optional. If both given, amount wins (no assumptions).
  const [discountPct, setDiscountPct] = useState("0");
  const [discountAmount, setDiscountAmount] = useState("0");

  // invoice / settlement
  const [discountType, setDiscountType] = useState("invoice");

  // customer / supplier
  const [discountSide, setDiscountSide] = useState("customer");

  // --------------------------
  // ✅ Petti Cash Refill UI
  // --------------------------
  const [showPettiRefill, setShowPettiRefill] = useState(false);
  const [pettiRefillSource, setPettiRefillSource] = useState("Cash"); // Cash|Bank
  const [pettiRefillAmount, setPettiRefillAmount] = useState("0");

  // Auto suggest side based on party type, but do NOT force (no assumptions)
  useEffect(() => {
    if (!discountEnabled) return;
    const pt = String(partyType || "").toLowerCase();
    if (pt === "customer") setDiscountSide("customer");
    else if (pt === "supplier") setDiscountSide("supplier");
    // Both -> keep current user choice
  }, [partyType, discountEnabled]);

  const taxAmount = useMemo(() => {
    const base = num(amountBeforeTax);
    const p = num(vatPercent);
    return (base * p) / 100;
  }, [amountBeforeTax, vatPercent]);

  const grossTotal = useMemo(() => {
    return num(amountBeforeTax) + num(taxAmount);
  }, [amountBeforeTax, taxAmount]);

  const computedDiscountAmount = useMemo(() => {
    if (!discountEnabled) return 0;

    const amt = num(discountAmount);
    if (amt > 0) return amt;

    const pct = clampPct(discountPct);
    if (pct > 0) return (grossTotal * pct) / 100;

    return 0;
  }, [discountEnabled, discountAmount, discountPct, grossTotal]);

  const totalAmount = useMemo(() => {
    // IMPORTANT:
    // - We do NOT reduce the transaction amount automatically (no assumption).
    // - Discount accounting will be handled via virtual posting in Phase-2 ledger.
    // - So Total Amount here remains the invoice/payment amount as entered.
    //
    // If later you decide to store net amounts, we'll do that in a controlled rollout.
    return grossTotal;
  }, [grossTotal]);

  const discountWarning = useMemo(() => {
    if (!discountEnabled) return "";
    if (computedDiscountAmount <= 0) return "Discount enabled but amount is 0.";
    if (computedDiscountAmount > totalAmount)
      return "Discount amount cannot exceed total amount.";
    return "";
  }, [discountEnabled, computedDiscountAmount, totalAmount]);

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

  // --------------------------
  // ✅ Save Normal Transaction
  // --------------------------
  async function save() {
    if (!activeClientId) return alert("Select active client first.");

    if (!selectedDate) return alert("Select date.");
    if (!type) return alert("Select type.");
    if (!mode) return alert("Select mode.");
    if (!partyQuery.trim()) return alert("Select party.");

    // Discount validation only if enabled
    if (discountEnabled) {
      if (computedDiscountAmount <= 0)
        return alert("Enter Discount % or Discount Amount.");
      if (computedDiscountAmount > totalAmount)
        return alert("Discount cannot exceed Total Amount.");
      if (!discountType) return alert("Select Discount Type.");
      if (!discountSide) return alert("Select Discount Side.");
    }

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
      selectedParty?.id === "__cash__"
        ? "Cash"
        : selectedParty?.name || partyQuery.trim();

    // Optional discount payload (only if enabled)
    const discountPayload = discountEnabled
      ? {
          discountPct: clampPct(discountPct),
          discountAmount: num(computedDiscountAmount),
          discountType: String(discountType || "").trim().toLowerCase(), // invoice/settlement
          discountSide: String(discountSide || "").trim().toLowerCase(), // customer/supplier
        }
      : {
          // Keep clean: do not write fields if not enabled
        };

    const payload = {
      clientId: activeClientId,
      date: dateTs,

      type,
      category,
      mode,

      partyType,
      partyId:
        selectedParty?.id === "__cash__"
          ? null
          : selectedParty?.id || null,
      partyName,

      description: String(description || "").trim(),

      amountBeforeTax: num(amountBeforeTax),
      vatPercent: num(vatPercent),
      taxAmount: num(taxAmount),
      totalAmount: num(totalAmount),

      amountIn: num(amountIn),
      amountOut: num(amountOut),

      ...discountPayload,

      createdAt: Timestamp.now(),
    };

    await addDoc(collection(db, "transactions"), payload);

    // reset small fields (keep date)
    setDescription("");
    setAmountBeforeTax("0");
    setVatPercent("0");

    // reset discount
    setDiscountEnabled(false);
    setDiscountPct("0");
    setDiscountAmount("0");
    setDiscountType("invoice");
    setDiscountSide("customer");

    setSelectedParty(null);
    setPartyQuery("");
    setShowPartyList(false);

    onSaved?.();
  }

  // --------------------------
  // ✅ Save Petti Refill Transaction (single txn)
  // --------------------------
  async function savePettiRefill() {
    if (!activeClientId) return alert("Select active client first.");
    if (!selectedDate) return alert("Select date.");
    const amt = num(pettiRefillAmount);
    if (amt <= 0) return alert("Enter refill amount.");

    const dateObj = new Date(selectedDate);
    const dateTs = Timestamp.fromDate(dateObj);

    const payload = {
      clientId: activeClientId,
      date: dateTs,

      // ✅ internal transfer flags
      type: "Transfer", // can also be "Refill" if you want, but reportCalculations will treat both
      category: "Petti Refill",
      mode: "Petti",
      sourceMode: pettiRefillSource, // "Cash"|"Bank"
      internalTransfer: true,

      // ✅ Must NOT be counted as revenue/expense/liability/receivable
      amountBeforeTax: 0,
      vatPercent: 0,
      taxAmount: 0,
      totalAmount: amt,

      amountIn: 0,
      amountOut: 0,

      // keep party clean & not affecting reports
      partyType: "Both",
      partyId: null,
      partyName: "Internal Transfer",

      description: "Refill Petti Cash",

      createdAt: Timestamp.now(),
    };

    await addDoc(collection(db, "transactions"), payload);

    setShowPettiRefill(false);
    setPettiRefillSource("Cash");
    setPettiRefillAmount("0");

    onSaved?.();
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-white font-semibold">New Transaction</div>

        {/* ✅ New Action */}
        <button
          type="button"
          onClick={() => setShowPettiRefill(true)}
          className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-900"
        >
          Refill Petti Cash
        </button>
      </div>

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
            {String(type || "").toLowerCase() === "income" ? (
              <>
                <option value="">Select</option>
                <option>Loan</option>
                <option>Other</option>
              </>
            ) : (
              <>
                <option>Commodity</option>
                <option>Service</option>
                <option>Salary</option>
                <option>Rent</option>
                <option>Utility</option>
                <option>Transport</option>
                <option>Other</option>

                {/* Phase-2 categories */}
                <option>Ingredients</option>
                <option>Short-term Asset</option>
                <option>Long-term Asset</option>
                <option>Short-term Investment</option>
                <option>Long-term Investment</option>
                <option>Loan</option>
                <option>Depreciation</option>
              </>
            )}
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

            {/* ✅ New */}
            <option>Petti Cash</option>
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

            {/* Phase-2 Party Types */}
            <option value="Employee">Employee</option>
            <option value="Owner">Owner</option>
            <option value="Partner">Partner</option>
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
              partyBlurTimer.current = setTimeout(
                () => setShowPartyList(false),
                150
              );
            }}
            placeholder="Search party..."
            className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
          />

          {showPartyList && (
            <div className="absolute z-50 mt-2 w-full max-h-60 overflow-auto rounded-xl border border-slate-800 bg-slate-950 shadow-lg">
              {filteredParties.length === 0 ? (
                <div className="px-3 py-2 text-sm text-slate-400">
                  No matches
                </div>
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

      {/* ✅ Discount block (optional) */}
      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-slate-200 font-semibold text-sm">Discount</div>

          <label className="flex items-center gap-2 text-xs text-slate-300 select-none">
            <input
              type="checkbox"
              checked={discountEnabled}
              onChange={(e) => setDiscountEnabled(e.target.checked)}
            />
            Enable Discount
          </label>
        </div>

        {!discountEnabled ? (
          <div className="mt-2 text-xs text-slate-500">
            Optional: Use for invoice / settlement discounts. (Accounting will
            post as Discount Allowed / Discount Received.)
          </div>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3">
              <div>
                <label className="text-sm text-slate-300">Discount %</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={discountPct}
                  onChange={(e) => setDiscountPct(e.target.value)}
                  className="mt-1 w-full rounded-xl bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
                  placeholder="0"
                />
                <div className="mt-1 text-xs text-slate-500">0–100</div>
              </div>

              <div>
                <label className="text-sm text-slate-300">Discount Amount</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={discountAmount}
                  onChange={(e) => setDiscountAmount(e.target.value)}
                  className="mt-1 w-full rounded-xl bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
                  placeholder="0"
                />
                <div className="mt-1 text-xs text-slate-500">
                  If amount is entered, it will be used. Else % applies.
                </div>
              </div>

              <div>
                <label className="text-sm text-slate-300">Discount Type</label>
                <select
                  value={discountType}
                  onChange={(e) => setDiscountType(e.target.value)}
                  className="mt-1 w-full rounded-xl bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
                >
                  <option value="invoice">invoice</option>
                  <option value="settlement">settlement</option>
                </select>
              </div>

              <div>
                <label className="text-sm text-slate-300">Discount Side</label>
                <select
                  value={discountSide}
                  onChange={(e) => setDiscountSide(e.target.value)}
                  className="mt-1 w-full rounded-xl bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
                >
                  <option value="customer">customer</option>
                  <option value="supplier">supplier</option>
                </select>
                <div className="mt-1 text-xs text-slate-500">
                  customer → Discount Allowed (Expense) • supplier → Discount
                  Received (Income)
                </div>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2">
              <div className="text-sm text-slate-300">
                Computed Discount Amount
              </div>
              <div className="text-sm font-semibold text-amber-200 tabular-nums">
                {computedDiscountAmount.toFixed(2)}
              </div>
            </div>

            {discountWarning ? (
              <div className="mt-2 rounded-xl border border-amber-900 bg-amber-950/30 p-2 text-xs text-amber-200">
                {discountWarning}
              </div>
            ) : null}
          </>
        )}
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

      {/* ✅ Petti Refill Modal */}
      {showPettiRefill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-950 p-4">
            <div className="flex items-center justify-between">
              <div className="text-slate-100 font-semibold">Refill Petti Cash</div>
              <button
                type="button"
                onClick={() => setShowPettiRefill(false)}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100 hover:bg-slate-800"
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-6">
                <label className="text-sm text-slate-300">Source</label>
                <select
                  value={pettiRefillSource}
                  onChange={(e) => setPettiRefillSource(e.target.value)}
                  className="mt-1 w-full rounded-xl bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
                >
                  <option>Cash</option>
                  <option>Bank</option>
                </select>
              </div>

              <div className="md:col-span-6">
                <label className="text-sm text-slate-300">Amount</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={pettiRefillAmount}
                  onChange={(e) => setPettiRefillAmount(e.target.value)}
                  className="mt-1 w-full rounded-xl bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
                  placeholder="0"
                />
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowPettiRefill(false)}
                className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-slate-100 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={savePettiRefill}
                className="rounded-xl bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-500"
              >
                Save Refill
              </button>
            </div>

            <div className="mt-3 text-xs text-slate-400">
              This saves a single internal transfer transaction and will not be counted in
              revenue/expense/liability/receivable reports.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
