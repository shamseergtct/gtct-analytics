// src/pages/PartyReports.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  getDocs,
  orderBy,
  query,
  where,
  Timestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext";

import { generatePartyPDF } from "../utils/partyPdfGenerator";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function money(v) {
  return num(v).toFixed(2);
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
function normalizeMode(m) {
  const x = norm(m);
  if (!x) return "";
  if (x.startsWith("cas")) return "cash";
  if (x.startsWith("ban")) return "bank";
  if (x.startsWith("car")) return "bank";
  if (x.startsWith("upi")) return "bank";
  if (x.startsWith("cre")) return "credit";
  if (x.startsWith("petti")) return "petti";
  if (x.startsWith("petty")) return "petti";
  if (x.includes("petti cash")) return "petti";
  if (x.includes("petty cash")) return "petti";
  return x;
}
function normalizeType(t) {
  const x = norm(t);
  if (!x) return "";
  if (x.startsWith("sal")) return "sales";
  if (x.startsWith("rec")) return "receipt";
  if (x.startsWith("inc")) return "income";
  if (x.startsWith("pur")) return "purchase";
  if (x.startsWith("pay")) return "payment";
  if (x.startsWith("exp")) return "expense";
  if (x.startsWith("tra")) return "transfer";
  if (x.startsWith("ref")) return "refill";
  return x;
}

// -------- Discount helpers (backward compatible) --------
function getDiscountAmount(t) {
  const a =
    num(t?.discountAmount) ||
    num(t?.discountAmt) ||
    num(t?.discount?.amount) ||
    num(t?.discount) ||
    0;
  return a > 0 ? a : 0;
}
function getDiscountEnabled(t) {
  const enabled =
    Boolean(t?.discountEnabled) ||
    Boolean(t?.enableDiscount) ||
    Boolean(t?.hasDiscount) ||
    Boolean(t?.isDiscountEnabled) ||
    false;
  return enabled || getDiscountAmount(t) > 0;
}
function getDiscountSide(t) {
  return (
    norm(t?.discountSide) ||
    norm(t?.discountPartySide) ||
    norm(t?.discountFor) ||
    norm(t?.discount?.side) ||
    ""
  );
}

// -------- Internal transfer (Petti refill) --------
function isInternalTransfer(t) {
  if (!t) return false;
  if (t?.internalTransfer === true) return true;

  const ty = normalizeType(t?.type);
  const m = normalizeMode(t?.mode);
  const src = norm(t?.sourceMode);
  if ((ty === "transfer" || ty === "refill") && m === "petti" && (src === "cash" || src === "bank"))
    return true;

  const cat = norm(t?.category);
  if (m === "petti" && (cat.includes("petti refill") || cat.includes("petty refill")))
    return true;

  return false;
}

// -------- Effective In/Out (discount netting) --------
function inValue(t) {
  return num(t?.amountIn);
}
function outValue(t) {
  const out = num(t?.amountOut);
  if (out > 0) return out;

  // legacy fallback for outflow types only
  const ty = normalizeType(t?.type);
  if (ty === "purchase" || ty === "payment" || ty === "expense") return num(t?.amountIn);
  return 0;
}

// Netting rules:
// - customer discount reduces inflow / receivable (Sales/Receipt/Income when customer-side)
// - supplier discount reduces outflow / payable (Purchase/Payment/Expense when supplier-side)
// - supplier discount also reduces CREDIT purchase liability (mode credit)
function effectiveIn(t) {
  const base = inValue(t);
  if (!(base > 0)) return base;

  if (!getDiscountEnabled(t)) return base;
  const disc = getDiscountAmount(t);
  if (!(disc > 0)) return base;

  const side = getDiscountSide(t);
  const ty = normalizeType(t?.type);

  if (side === "customer" && (ty === "sales" || ty === "receipt" || ty === "income")) {
    return Math.max(0, base - disc);
  }
  return base;
}

function effectiveOut(t) {
  const base = outValue(t);
  if (!(base > 0)) return base;

  if (!getDiscountEnabled(t)) return base;
  const disc = getDiscountAmount(t);
  if (!(disc > 0)) return base;

  const side = getDiscountSide(t);
  const ty = normalizeType(t?.type);

  if (side === "supplier" && (ty === "purchase" || ty === "payment" || ty === "expense")) {
    return Math.max(0, base - disc);
  }
  return base;
}

function effectiveCreditLiabilityCreated(t) {
  // For credit purchase/expense, some data stores value in amountIn
  const base = num(t?.amountIn) > 0 ? num(t?.amountIn) : num(t?.totalAmount);
  if (!(base > 0)) return 0;

  if (!getDiscountEnabled(t)) return base;
  const disc = getDiscountAmount(t);
  if (!(disc > 0)) return base;

  const side = getDiscountSide(t);
  if (side === "supplier") return Math.max(0, base - disc);

  return base;
}

function txnDirectionLabel(t) {
  const ty = normalizeType(t?.type);
  const m = normalizeMode(t?.mode);

  if (isInternalTransfer(t)) return "Internal";
  if (ty === "sales" || ty === "receipt" || ty === "income") return "In";
  if (ty === "purchase" || ty === "payment" || ty === "expense") {
    if (ty === "purchase" && m === "credit") return "Liability";
    return "Out";
  }
  return "—";
}

export default function PartyReports() {
  const { activeClientId, activeClientData } = useClient();
  const currency = activeClientData?.currency || "BHD";

  const [type, setType] = useState("Customer"); // Customer | Supplier | Both | Employee | Owner | Partner
  const [parties, setParties] = useState([]);

  // Searchable party picker
  const [partyQuery, setPartyQuery] = useState("");
  const [selectedParty, setSelectedParty] = useState(null);
  const [showPartyList, setShowPartyList] = useState(false);
  const blurTimer = useRef(null);

  const [fromDate, setFromDate] = useState(() => toYYYYMMDD(new Date()));
  const [toDate, setToDate] = useState(() => toYYYYMMDD(new Date()));

  const [loadingParties, setLoadingParties] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

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

  // ✅ Filter parties by type (include Both)
  const filteredParties = useMemo(() => {
    const want = norm(type);
    return parties.filter((p) => {
      const pt = norm(p?.type);

      if (want === "both") {
        // For "Both report", allow selecting ANY party; it will show both sides where applicable
        return true;
      }

      return pt === want || pt === "both";
    });
  }, [parties, type]);

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
  // Load ledger
  // -------------------------
  const load = async () => {
    setErr("");
    setRows([]);

    if (!activeClientId) return setErr("Please select an active client.");
    if (!selectedParty?.id && !selectedParty?.name) return setErr("Please select a party.");
    if (!fromDate || !toDate) return setErr("Please choose From and To dates.");

    const f = startOfDay(fromDate);
    const t = endOfDay(toDate);
    if (f > t) return setErr("From date must be before To date.");

    setLoading(true);
    try {
      const fromTs = Timestamp.fromDate(f);
      const toTs = Timestamp.fromDate(t);

      const qy = query(
        collection(db, "transactions"),
        where("clientId", "==", activeClientId),
        where("date", ">=", fromTs),
        where("date", "<=", toTs),
        orderBy("date", "desc")
      );

      const snap = await getDocs(qy);
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      const pid = String(selectedParty?.id || "").trim();
      const pname = norm(selectedParty?.name);

      // local filter (partyId OR partyName)
      const txns = all.filter((x) => {
        if (isInternalTransfer(x)) return false; // ✅ always skip internal transfers
        if (pid && x?.partyId === pid) return true;
        if (pname && norm(x?.partyName) === pname) return true;
        return false;
      });

      const normalized = txns.map((x) => {
        const d = asJSDate(x.date);
        const ty = normalizeType(x?.type);
        const mm = normalizeMode(x?.mode);

        // display amount based on txn nature
        let amount = 0;

        if (ty === "purchase" && mm === "credit") amount = effectiveCreditLiabilityCreated(x);
        else if (ty === "sales" || ty === "receipt" || ty === "income") amount = effectiveIn(x);
        else if (ty === "purchase" || ty === "payment" || ty === "expense") amount = effectiveOut(x);
        else amount = num(x?.totalAmount) || num(x?.amountIn) || num(x?.amountOut) || 0;

        return {
          ...x,
          _dateObj: d,
          _typeKey: ty,
          _modeKey: mm,
          _amount: amount,
          _dir: txnDirectionLabel(x),
        };
      });

      setRows(normalized);
    } catch (e) {
      console.error(e);
      setErr(e?.message || "Failed to load party report.");
    } finally {
      setLoading(false);
    }
  };

  // -------------------------
  // Summary (ALL types)
  // -------------------------
  const report = useMemo(() => {
    const txns = Array.isArray(rows) ? rows : [];
    const want = norm(type);

    // Common
    const count = txns.length;

    // For internal types: show In/Out/Net
    const totalIn = txns
      .filter((t) => t._dir === "In")
      .reduce((s, t) => s + num(t._amount), 0);

    const totalOut = txns
      .filter((t) => t._dir === "Out")
      .reduce((s, t) => s + num(t._amount), 0);

    const net = totalIn - totalOut;

    // Customer receivable: credit sales - receipts
    const customerCreditSales = txns
      .filter((t) => t._typeKey === "sales" && t._modeKey === "credit")
      .reduce((s, t) => s + num(t._amount), 0);

    const customerReceipts = txns
      .filter((t) => t._typeKey === "receipt")
      .reduce((s, t) => s + num(t._amount), 0);

    const receivable = customerCreditSales - customerReceipts;

    // Supplier payable: credit purchases/credit expense - payments
    const supplierCreditPurchases = txns
      .filter((t) => (t._typeKey === "purchase" || t._typeKey === "expense") && t._modeKey === "credit")
      .reduce((s, t) => s + num(t._typeKey === "purchase" || t._typeKey === "expense" ? t._amount : 0), 0);

    const supplierPayments = txns
      .filter((t) => t._typeKey === "payment")
      .reduce((s, t) => s + num(t._amount), 0);

    const payable = supplierCreditPurchases - supplierPayments;

    // Decide which summary to show
    const mode =
      want === "customer"
        ? "customer"
        : want === "supplier"
        ? "supplier"
        : want === "both"
        ? "both"
        : "internal";

    return {
      mode,
      count,
      rows: txns,

      // internal
      totalIn,
      totalOut,
      net,

      // customer
      customerCreditSales,
      customerReceipts,
      receivable,

      // supplier
      supplierCreditPurchases,
      supplierPayments,
      payable,
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

  const reportTitle = (() => {
    const t = norm(type);
    if (t === "customer") return "Customer Report (Receivable)";
    if (t === "supplier") return "Supplier/Vendor Report (Payable)";
    if (t === "both") return "Party Report (Both Sides)";
    if (t === "employee") return "Employee Ledger";
    if (t === "owner") return "Owner Ledger";
    if (t === "partner") return "Partner Ledger";
    return "Party Report";
  })();

  return (
    <div className="space-y-5">
      {/* Header + Download */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">{reportTitle}</h2>
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
              <option value="Supplier">Supplier/Vendor (Payable)</option>
              <option value="Both">Both (Receivable + Payable)</option>
              <option value="Employee">Employee</option>
              <option value="Owner">Owner</option>
              <option value="Partner">Partner</option>
            </select>
            <div className="mt-1 text-xs text-slate-500">
              Internal transfers (Petti refill) are excluded.
            </div>
          </div>

          {/* Searchable Party Picker */}
          <div className="relative">
            <label className="text-sm text-slate-300">Party</label>

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
            Filter: <span className="text-slate-300">clientId + date range + (partyId/partyName)</span>
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

        {report.mode === "customer" ? (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Box label="Credit Sales (NET, Credit only)" value={`${money(report.customerCreditSales)} ${currency}`} />
            <Box label="Recovered (Receipts, NET)" value={`${money(report.customerReceipts)} ${currency}`} />
            <Box label="Pending Receivable" value={`${money(report.receivable)} ${currency}`} />
          </div>
        ) : report.mode === "supplier" ? (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Box label="Credit Purchases/Expenses (NET, Credit only)" value={`${money(report.supplierCreditPurchases)} ${currency}`} />
            <Box label="Paid (Payments, NET)" value={`${money(report.supplierPayments)} ${currency}`} />
            <Box label="Pending Payable" value={`${money(report.payable)} ${currency}`} />
          </div>
        ) : report.mode === "both" ? (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Box label="Pending Receivable (Customer side)" value={`${money(report.receivable)} ${currency}`} />
            <Box label="Pending Payable (Supplier side)" value={`${money(report.payable)} ${currency}`} />
            <Box label="Net (In − Out)" value={`${money(report.net)} ${currency}`} />
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Box label="Total In" value={`${money(report.totalIn)} ${currency}`} />
            <Box label="Total Out" value={`${money(report.totalOut)} ${currency}`} />
            <Box label="Net (In − Out)" value={`${money(report.net)} ${currency}`} />
          </div>
        )}

        <div className="mt-2 text-xs text-slate-500">
          Note: Discounts are netted (customer discount reduces receivable; supplier discount reduces payable). Petti refill/internal transfers are excluded.
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
            <div className="col-span-1">Dir</div>
            <div className="col-span-3">Description</div>
            <div className="col-span-2 text-right">Amount (NET)</div>
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
                <div className="col-span-1 text-slate-400">{t._dir}</div>
                <div className="col-span-3 text-slate-400 truncate">
                  {t.description || t.category || "-"}
                </div>
                <div className="col-span-2 text-right text-white font-semibold tabular-nums">
                  {money(t._amount)} {currency}
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
