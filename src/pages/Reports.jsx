// src/pages/Reports.jsx
import { useMemo, useState } from "react";
import { collection, getDocs, orderBy, query, where, Timestamp } from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext";

import { generateDailyPulseReport } from "../utils/reportCalculations";
import { generateDailyPDF, generateQuickPDF } from "../utils/pdfGenerator";
import { fetchDailySession, upsertDailySession } from "../utils/dailySessionStore";

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
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function normalizeMode(m) {
  const x = String(m || "").trim().toLowerCase();
  if (!x) return "";
  if (x.startsWith("cas")) return "cash";
  if (x.startsWith("ban")) return "bank";
  if (x.startsWith("car")) return "bank"; // card -> bank bucket
  if (x.startsWith("upi")) return "bank";
  if (x.startsWith("cre")) return "credit";
  return x;
}
function normalizeType(t) {
  const x = String(t || "").trim().toLowerCase();
  if (!x) return "";
  if (x.startsWith("sal")) return "sales";
  if (x.startsWith("rec")) return "receipt";
  if (x.startsWith("inc")) return "income";
  if (x.startsWith("pur")) return "purchase";
  if (x.startsWith("pay")) return "payment";
  if (x.startsWith("exp")) return "expense";
  return x;
}
function safeSide(v) {
  return String(v || "").trim().toLowerCase();
}
function getDiscountAmount(t) {
  // Backward compatible: support multiple possible field names
  const a =
    num(t?.discountAmount) ||
    num(t?.discountAmt) ||
    num(t?.discount) ||
    0;
  return a > 0 ? a : 0;
}
function getDiscountEnabled(t) {
  // Some records may not have "enabled" flag; if amount exists => enabled
  const enabled =
    Boolean(t?.discountEnabled) ||
    Boolean(t?.enableDiscount) ||
    Boolean(t?.hasDiscount) ||
    false;
  return enabled || getDiscountAmount(t) > 0;
}
function getDiscountSide(t) {
  // customer / supplier
  const side =
    safeSide(t?.discountSide) ||
    safeSide(t?.discountFor) ||
    safeSide(t?.discountPartySide) ||
    "";
  return side;
}
function getDiscountType(t) {
  // invoice / settlement (not used in totals; kept for future)
  return safeSide(t?.discountType) || "";
}

function inValue(t) {
  return num(t?.amountIn);
}
function outValue(t) {
  const out = num(t?.amountOut);
  if (out > 0) return out;

  // ✅ Only allow fallback to amountIn for OUT-flow types (legacy records)
  const ty = normalizeType(t?.type);
  if (ty === "purchase" || ty === "payment" || ty === "expense" || ty === "loan") {
    return num(t?.amountIn);
  }

  // sales/receipt/income should NOT be treated as outflow
  return 0;
}


function Section({ title, children, danger = false }) {
  return (
    <div
      className={[
        "rounded-2xl border bg-slate-900/40 p-4",
        danger ? "border-red-900/40" : "border-slate-800",
      ].join(" ")}
    >
      <div className="text-white font-semibold">{title}</div>
      <div className="mt-3 space-y-2">{children}</div>
    </div>
  );
}

function TwoColRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2">
      <div className="text-sm text-slate-300 flex-1 pr-3">{label}</div>
      <div className="text-sm font-semibold text-white text-right tabular-nums whitespace-nowrap min-w-[160px]">
        {value}
      </div>
    </div>
  );
}

function QuickCard({ title, value, currency, emphasis = "normal" }) {
  const box =
    emphasis === "bad"
      ? "border-red-900/40 bg-red-950/10"
      : emphasis === "good"
      ? "border-emerald-500/20 bg-emerald-500/10"
      : "border-slate-800 bg-slate-950/40";

  const titleColor =
    emphasis === "bad"
      ? "text-red-200"
      : emphasis === "good"
      ? "text-emerald-200"
      : "text-slate-300";

  return (
    <div className={["rounded-2xl border p-4", box].join(" ")}>
      <div className={["text-xs uppercase tracking-wider", titleColor].join(" ")}>
        {title}
      </div>
      <div className="mt-2 text-2xl font-bold text-white tabular-nums">
        {money(value)} {currency}
      </div>
    </div>
  );
}

function safeText(s) {
  return String(s ?? "")
    .replace(/\u2192/g, "to")
    .replace(/[\u26A0\uFE0F]/g, "")   // ⚠️ remove (26A0 + FE0F)
    .replace(/[\u0000-\u001F]/g, " ") // remove control chars
    .replace(/\s+/g, " ")
    .trim();
}


export default function Reports() {
  const { activeClientId, activeClientData } = useClient();
  const currency = activeClientData?.currency || "BHD";

  const [fromDate, setFromDate] = useState(toYYYYMMDD(new Date()));
  const [toDate, setToDate] = useState(toYYYYMMDD(new Date()));

  const [openingCashFrom, setOpeningCashFrom] = useState("0");
  const [openingBankFrom, setOpeningBankFrom] = useState("0");
  const [actualCountTo, setActualCountTo] = useState("0");
  const [analystNotesText, setAnalystNotesText] = useState("");

  const [loading, setLoading] = useState(false);
  const [txnsRange, setTxnsRange] = useState([]);
  const [txnsTill, setTxnsTill] = useState([]);

  const [err, setErr] = useState("");
  const [sessionErr, setSessionErr] = useState("");

  // Detailed report generation flag (data loaded)
  const [generated, setGenerated] = useState(false);

  // Quick report flag (uses same loaded data; just UI)
  const [quickGenerated, setQuickGenerated] = useState(false);

  const isSingleDay = fromDate === toDate;

  async function loadSessions() {
    setSessionErr("");
    if (!activeClientId) return;

    try {
      const sFrom = await fetchDailySession(activeClientId, fromDate);
      const sTo = await fetchDailySession(activeClientId, toDate);

      setOpeningCashFrom(String(sFrom?.openingCash ?? "0"));
      setOpeningBankFrom(String(sFrom?.openingBank ?? "0"));

      setActualCountTo(String(sTo?.actualCashDrawer ?? "0"));
      setAnalystNotesText(String(sTo?.analystNotes ?? ""));
    } catch (e) {
      console.error(e);
      setSessionErr(e?.message || "Failed to load daily sessions.");
    }
  }

  async function generateReport() {
    setErr("");
    setSessionErr("");
    setGenerated(false);
    setQuickGenerated(false);

    if (!activeClientId) return setErr("Please select an active client first.");
    if (!fromDate || !toDate) return setErr("Please select From and To dates.");
    if (fromDate > toDate) return setErr("From date cannot be after To date.");

    setLoading(true);
    try {
      const from = Timestamp.fromDate(startOfDay(fromDate));
const to = Timestamp.fromDate(endOfDay(toDate));

      // ✅ RANGE
      const qRange = query(
        collection(db, "transactions"),
        where("clientId", "==", activeClientId),
        where("date", ">=", from),
        where("date", "<=", to),
        orderBy("date", "desc")
      );

      // ✅ TILL DATE (beginning -> To)
      const veryOld = Timestamp.fromDate(new Date(1970, 0, 1, 0, 0, 0, 0));
      const qTill = query(
        collection(db, "transactions"),
        where("clientId", "==", activeClientId),
        where("date", ">=", veryOld),
        where("date", "<=", to),
        orderBy("date", "desc")
      );

      const [snapRange, snapTill] = await Promise.all([getDocs(qRange), getDocs(qTill)]);

      setTxnsRange(snapRange.docs.map((d) => ({ id: d.id, ...d.data() })));
      setTxnsTill(snapTill.docs.map((d) => ({ id: d.id, ...d.data() })));

      setGenerated(true);
    } catch (e) {
      console.error(e);
      setErr(e?.message || "Failed to load transactions for report.");
    } finally {
      setLoading(false);
    }
  }

  async function generateQuickReport() {
    // Quick report uses SAME dataset. If not generated, load first.
    if (!generated) {
      await generateReport();
    }
    setQuickGenerated(true);
  }

  async function saveNotesToToDate() {
    setSessionErr("");
    if (!activeClientId) return;

    try {
      await upsertDailySession(activeClientId, fromDate, {
        openingCash: Number(openingCashFrom || 0),
        openingBank: Number(openingBankFrom || 0),
      });

      await upsertDailySession(activeClientId, toDate, {
        actualCashDrawer: Number(actualCountTo || 0),
        analystNotes: String(analystNotesText || ""),
        reportFrom: fromDate,
        reportTo: toDate,
      });
    } catch (e) {
      console.error(e);
      setSessionErr(e?.message || "Failed to save notes/inputs.");
    }
  }

  // -------------------------
  // Detailed report (existing engine)
  // -------------------------
  const report = useMemo(() => {
    return generateDailyPulseReport(txnsRange, {
      selectedDate: `${fromDate} → ${toDate}`,
      openingCash: Number(openingCashFrom || 0),
      openingBank: Number(openingBankFrom || 0),
      actualCount: Number(actualCountTo || 0),
      analystNotesText: String(analystNotesText || ""),
      isSingleDay,
      txnsTillDate: txnsTill,
    });
  }, [
    txnsRange,
    txnsTill,
    fromDate,
    toDate,
    openingCashFrom,
    openingBankFrom,
    actualCountTo,
    analystNotesText,
    isSingleDay,
  ]);

  // -------------------------
  // Quick report (LIVE SAFE)
  // - Uses txnsTill for balances
  // - Applies discount to inflow/outflow safely:
  //   customer-side discount reduces inflow (sales/receipt)
  //   supplier-side discount reduces outflow (purchase/payment/expense)
  // - Sales shown as NET (avoids client confusion)
  // -------------------------
  const quick = useMemo(() => {
    const openingCash = num(openingCashFrom);
    const openingBank = num(openingBankFrom);

    const till = Array.isArray(txnsTill) ? txnsTill : [];
    const range = Array.isArray(txnsRange) ? txnsRange : [];

    // Discount splits
    let discCustomerSales = 0; // sales invoice discount (customer)
    let discCustomerReceipt = 0; // settlement discount on receipt (customer)
    let discSupplierOut = 0; // supplier discount reduces outflow

    for (const t of till) {
      if (!getDiscountEnabled(t)) continue;
      const amt = getDiscountAmount(t);
      if (!(amt > 0)) continue;

      const side = getDiscountSide(t); // customer / supplier
      const ty = normalizeType(t?.type);

      if (side === "customer") {
        if (ty === "sales") discCustomerSales += amt;
        else if (ty === "receipt") discCustomerReceipt += amt;
      } else if (side === "supplier") {
        // purchase/payment/expense typically
        discSupplierOut += amt;
      }
    }

    // Cash/Bank balances till-date (discount-adjusted)
    let cashIn = 0,
      cashOut = 0,
      bankIn = 0,
      bankOut = 0;

    for (const t of till) {
      const m = normalizeMode(t?.mode);
      const side = getDiscountSide(t);
      const amtDisc = getDiscountEnabled(t) ? getDiscountAmount(t) : 0;

      const _in = inValue(t);
      const _out = num(t?.amountOut);

      // inflow discount (customer) reduces actual inflow
      const inAdj = side === "customer" ? Math.max(0, _in - amtDisc) : _in;

      // outflow discount (supplier) reduces actual outflow
      const outAdj = side === "supplier" ? Math.max(0, _out - amtDisc) : _out;

      if (m === "cash") {
        cashIn += inAdj;
        cashOut += outAdj;
      } else if (m === "bank") {
        bankIn += inAdj;
        bankOut += outAdj;
      }
    }

    const cashBalance = openingCash + (cashIn - cashOut);
    const bankBalance = openingBank + (bankIn - bankOut);
    const totalBalance = cashBalance + bankBalance;
        // ✅ Selected RANGE balance (All modes combined)
    // (mode missing/credit also included)
    let rangeIn = 0;
    let rangeOut = 0;

    for (const t of range) {
      const side = getDiscountSide(t);
      const amtDisc = getDiscountEnabled(t) ? getDiscountAmount(t) : 0;

      const _in = inValue(t);
      const _out = outValue(t); // supports legacy cases

      const inAdj = side === "customer" ? Math.max(0, _in - amtDisc) : _in;
      const outAdj = side === "supplier" ? Math.max(0, _out - amtDisc) : _out;

      rangeIn += inAdj;
      rangeOut += outAdj;
    }

    const rangeBalance = rangeIn - rangeOut;


    // Net Sales in selected RANGE (discount-adjusted for customer-side sales)
    let grossSalesRange = 0;
    let discSalesRange = 0;

    for (const t of range) {
      const ty = normalizeType(t?.type);
      if (ty !== "sales") continue;
      grossSalesRange += inValue(t);

      if (getDiscountEnabled(t) && getDiscountSide(t) === "customer") {
        discSalesRange += getDiscountAmount(t);
      }
    }

    const totalSalesNet = Math.max(0, grossSalesRange - discSalesRange);

    // Expense in selected RANGE (use report engine total, then adjust supplier discount on outflow txns in range)
    // This keeps backward compatibility with your verified expense rules.
    let supplierDiscRange = 0;
    for (const t of range) {
      if (!getDiscountEnabled(t)) continue;
      if (getDiscountSide(t) !== "supplier") continue;
      const ty = normalizeType(t?.type);
      if (ty !== "purchase" && ty !== "payment" && ty !== "expense") continue;
      supplierDiscRange += getDiscountAmount(t);
    }
    const totalExpenseNet = Math.max(0, num(report?.expenses?.totalExpenseIncurred) - supplierDiscRange);

    // Receivable / Payable (from stabilized engine)
    const receivable = num(report?.liquidity?.totalReceivable);
    const payable = num(report?.liquidity?.totalPayable);

    const netPosition = totalBalance + receivable - payable;

    const isNegative = totalBalance < -0.009;

    return {
      totalSales: totalSalesNet,
      totalExpense: totalExpenseNet,
      rangeBalance,
      cashBalance,
      bankBalance,
      totalBalance,
      receivable,
      payable,
      netPosition,
      isNegative,
      // for future debugging (not shown)
      _debug: {
        discCustomerSales,
        discCustomerReceipt,
        discSupplierOut,
        discSalesRange,
        supplierDiscRange,
      },
    };
  }, [txnsTill, txnsRange, openingCashFrom, openingBankFrom, report]);

  // -------------------------
  // PDFs
  // -------------------------
  const downloadPDF = () => {
    if (!generated) return alert("Click Generate Detailed Report first.");

    const doc = generateDailyPDF({
      clientName: activeClientData?.name || "Client",
      reportDate: `${fromDate} → ${toDate}`,
      currency,
      report: {
        ...report,
        analystNotesText: analystNotesText || "",
      },
    });

    doc.save(
      `GTCT-DailyPulse-${activeClientData?.name || "Client"}-${fromDate}_to_${toDate}.pdf`
    );
  };

  const downloadQuickPDF = () => {
    if (!generated && !quickGenerated) return alert("Click Generate Quick Report first.");

    const doc = generateQuickPDF({
      clientName: activeClientData?.name || "Client",
      reportDate: `${fromDate} → ${toDate}`,
      currency,
      quick,
    });

    doc.save(
      `GTCT-QuickReport-${activeClientData?.name || "Client"}-${fromDate}_to_${toDate}.pdf`
    );
  };

  return (
    <div className="space-y-5 pb-24">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">Reports</h2>
          <p className="text-sm text-slate-400">
            Financial Position Report (Active Client:{" "}
            <span className="text-slate-200 font-semibold">
              {activeClientData?.name || "No client selected"}
            </span>
            )
          </p>
        </div>

        {/* ✅ Buttons (Detailed + Quick) */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={generateReport}
            className="inline-flex items-center justify-center rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
            disabled={!activeClientId || loading}
          >
            {loading ? "Generating…" : "Generate Detailed Report"}
          </button>

          <button
            onClick={downloadPDF}
            className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:opacity-90 disabled:opacity-60"
            disabled={!generated}
          >
            Download Detailed PDF
          </button>

          <button
            onClick={generateQuickReport}
            className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
            disabled={!activeClientId || loading}
          >
            Generate Quick Report
          </button>

          <button
            onClick={downloadQuickPDF}
            className="inline-flex items-center justify-center rounded-xl bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-60"
            disabled={!generated && !quickGenerated}
          >
            Download Quick PDF
          </button>
        </div>
      </div>

      {/* Inputs */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div>
            <label className="text-sm text-slate-300">From</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
            />
          </div>

          <div>
            <label className="text-sm text-slate-300">To</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
            />
          </div>

          <div>
            <label className="text-sm text-slate-300">Opening Cash (From)</label>
            <input
              type="number"
              inputMode="decimal"
              value={openingCashFrom}
              onChange={(e) => setOpeningCashFrom(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
            />
          </div>

          <div>
            <label className="text-sm text-slate-300">Opening Bank (From)</label>
            <input
              type="number"
              inputMode="decimal"
              value={openingBankFrom}
              onChange={(e) => setOpeningBankFrom(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
            />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="text-sm text-slate-300">Actual Cash Count (To)</label>
            <input
              type="number"
              inputMode="decimal"
              value={actualCountTo}
              onChange={(e) => setActualCountTo(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
            />
          </div>

          <div className="flex items-end gap-2">
            <button
              onClick={loadSessions}
              className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 hover:bg-slate-800 disabled:opacity-60"
              disabled={!activeClientId}
            >
              Load Saved Inputs
            </button>
          </div>
        </div>

        {err ? (
          <div className="mt-3 rounded-xl border border-red-900 bg-red-950/40 p-2 text-sm text-red-200">
            {err}
          </div>
        ) : null}

        {sessionErr ? (
          <div className="mt-3 rounded-xl border border-amber-900 bg-amber-950/30 p-2 text-sm text-amber-200">
            {sessionErr}
          </div>
        ) : null}

        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3">
          <div className="text-slate-200 font-semibold text-sm mb-2">
            Analyst Notes & Alerts
          </div>

          <textarea
            value={analystNotesText}
            onChange={(e) => setAnalystNotesText(e.target.value)}
            placeholder="Write notes for this report…"
            className="w-full min-h-[120px] rounded-xl bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
          />

          <div className="mt-2 flex flex-col sm:flex-row sm:items-center gap-2">
            <button
              onClick={saveNotesToToDate}
              className="rounded-xl bg-slate-200 px-3 py-2 text-sm font-semibold text-slate-950 hover:opacity-90 disabled:opacity-60"
              disabled={!activeClientId}
            >
              Save Notes
            </button>

            <div className="text-xs text-slate-500">
              Notes + Actual Count saved to <b>To date</b>. Opening saved to{" "}
              <b>From date</b>.
            </div>
          </div>
        </div>
      </div>

      {/* ✅ Quick Report Section */}
      {!quickGenerated ? null : (
        <div className="rounded-3xl border border-slate-800 bg-slate-900/30 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-white font-semibold text-lg">Quick Report</div>
              <div className="text-slate-400 text-sm">
                Range: {fromDate} → {toDate}
              </div>
            </div>

            <div
              className={[
                "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold",
                quick?.isNegative
                  ? "border-red-900/40 bg-red-950/20 text-red-200"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
              ].join(" ")}
            >
              {quick?.isNegative ? "ALERT: NEGATIVE BALANCE" : "HEALTHY: POSITIVE BALANCE"}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <QuickCard title="Total Sales (NET)" value={quick?.totalSales} currency={currency} />
            <QuickCard title="Total Expense" value={quick?.totalExpense} currency={currency} />
            <QuickCard
  title="Balance"
  value={quick?.rangeBalance}
  currency={currency}
  emphasis={num(quick?.rangeBalance) < 0 ? "bad" : "good"}
/>

            <QuickCard title="Bank Balance" value={quick?.bankBalance} currency={currency} />
            <QuickCard
              title="Total Balance (Cash + Bank)"
              value={quick?.totalBalance}
              currency={currency}
              emphasis={num(quick?.totalBalance) < 0 ? "bad" : "good"}
            />
            <QuickCard title="Total Receivable" value={quick?.receivable} currency={currency} />

            <QuickCard title="Total Payable" value={quick?.payable} currency={currency} />
            <QuickCard
              title="Net Position (Bal + Rec - Pay)"
              value={quick?.netPosition}
              currency={currency}
              emphasis={num(quick?.netPosition) < 0 ? "bad" : "good"}
            />
          </div>

          <div
            className={[
              "mt-4 rounded-2xl border p-3 text-sm",
              quick?.isNegative
                ? "border-red-900/40 bg-red-950/20 text-red-100"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
            ].join(" ")}
          >
            {quick?.isNegative ? (
              <div className="flex gap-2">
                <div>⚠️</div>
                <div>
                  Cash + Bank balance is negative. Please review payments, discounts, and cash
                  drawer count.
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <div>✅</div>
                <div>Balance is positive. Keep monitoring receivables/payables to maintain liquidity.</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ✅ Detailed report (existing UI) */}
      {!generated ? null : (
        <>
          {/* Status */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-white font-semibold">Status</div>
              <div
                className={[
                  "rounded-full px-3 py-1 text-xs font-semibold border",
                  report?.status?.healthy
                    ? "bg-emerald-500/15 text-emerald-200 border-emerald-500/30"
                    : "bg-red-500/15 text-red-200 border-red-500/30",
                ].join(" ")}
              >
                {report?.status?.statusText || "STATUS"}
              </div>
            </div>
            <div className="mt-2 text-sm text-slate-400">{report?.status?.statusSub || ""}</div>
          </div>

          {/* 1 Revenue */}
          <Section title="1. Revenue & Inflow">
            <TwoColRow
              label="Total Gross Sales (Z-Report)"
              value={`${money(report?.revenue?.totalGrossSales)} ${currency}`}
            />
            <TwoColRow label="Cash Sales" value={`${money(report?.revenue?.cashSales)} ${currency}`} />
            <TwoColRow label="Bank Sales" value={`${money(report?.revenue?.bankSales)} ${currency}`} />
            <TwoColRow
              label="Credit Sales (Pending)"
              value={`${money(report?.revenue?.creditSales)} ${currency}`}
            />
            <div className="my-3 h-px bg-slate-800" />
            <TwoColRow
              label="Credit Recovery (Old Debts)"
              value={`${money(report?.revenue?.creditRecoveryTotal)} ${currency}`}
            />
            <TwoColRow label="Income" value={`${money(report?.revenue?.totalIncome)} ${currency}`} />
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3 flex items-center justify-between gap-3">
              <div className="text-slate-300 font-semibold">TOTAL REVENUE GENERATED</div>
              <div className="text-white font-bold text-right tabular-nums whitespace-nowrap min-w-[140px]">
                {money(report?.revenue?.totalRevenueGenerated)} {currency}
              </div>
            </div>
          </Section>

          {/* 2 Expenses (details with date) */}
          <Section title="2. Expenses (Verified) — Details">
            {report?.expenses?.details?.length ? (
              report.expenses.details.map((x, idx) => (
                <TwoColRow
                  key={`${x.label}-${idx}`}
                  label={x.label}
                  value={`${money(x.amount)} ${currency}`}
                />
              ))
            ) : (
              <div className="text-slate-400 text-sm">No verified expenses</div>
            )}

            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3 flex items-center justify-between gap-3">
              <div className="text-slate-300 font-semibold">TOTAL EXPENSE INCURRED</div>
              <div className="text-white font-bold text-right tabular-nums whitespace-nowrap min-w-[140px]">
                {money(report?.expenses?.totalExpenseIncurred)} {currency}
              </div>
            </div>
          </Section>

          {/* 3 Liability - credit purchases list with date */}
          <Section title="3. Credit Purchase / Liability (Range)" danger>
            {report?.liabilities?.creditPurchases?.length ? (
              report.liabilities.creditPurchases.map((x, idx) => (
                <TwoColRow
                  key={`${x.supplier}-${x.date}-${idx}`}
                  label={`${x.supplier}${x.date ? ` (${x.date})` : ""}`}
                  value={`${money(x.amount)} ${currency}`}
                />
              ))
            ) : (
              <div className="text-slate-400 text-sm">No credit purchases</div>
            )}

            <TwoColRow
              label="Supplier Paid (Range)"
              value={`${money(report?.liabilities?.totalSupplierPaid)} ${currency}`}
            />

            <div className="mt-4 rounded-xl border border-red-900/40 bg-red-950/20 p-3 flex items-center justify-between gap-3">
              <div className="text-red-200 font-semibold">TOTAL NEW LIABILITY (Range)</div>
              <div className="text-red-100 font-bold text-right tabular-nums whitespace-nowrap min-w-[140px]">
                {money(report?.liabilities?.totalNewLiability)} {currency}
              </div>
            </div>
          </Section>

          {/* Liquidity + Daily Cash */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section title="Liquidity & Balance (Till Date)">
              <TwoColRow
                label="Total Cash Balance"
                value={`${money(report?.liquidity?.totalCashBalance)} ${currency}`}
              />
              <TwoColRow
                label="Total Bank Balance"
                value={`${money(report?.liquidity?.totalBankBalance)} ${currency}`}
              />
              <TwoColRow
                label="Total Receivable (Asset)"
                value={`${money(report?.liquidity?.totalReceivable)} ${currency}`}
              />
              <TwoColRow
                label="Total Payable (Liability)"
                value={`${money(report?.liquidity?.totalPayable)} ${currency}`}
              />

              <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 flex items-center justify-between gap-3">
                <div className="text-emerald-200 font-semibold">TOTAL LIQUID FUNDS (Cash + Bank)</div>
                <div className="text-white font-bold text-right tabular-nums whitespace-nowrap min-w-[140px]">
                  {money(report?.liquidity?.totalLiquidFunds)} {currency}
                </div>
              </div>
            </Section>

            <Section title="Daily Cash Check (Range)">
              <TwoColRow label="Opening Cash (From)" value={`${money(openingCashFrom)} ${currency}`} />
              <TwoColRow
                label="Net Cash Position (Range)"
                value={`${money(report?.cashCheck?.netCashPosition)} ${currency}`}
              />
              <TwoColRow
                label="Expected Drawer (To)"
                value={`${money(report?.cashCheck?.expectedDrawer)} ${currency}`}
              />
              <TwoColRow label="Actual Count (To)" value={`${money(actualCountTo)} ${currency}`} />
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3 flex items-center justify-between gap-3">
                <div className="text-slate-300 font-semibold">VARIANCE</div>
                <div className="text-white font-bold text-right tabular-nums whitespace-nowrap min-w-[140px]">
                  {money(report?.cashCheck?.variance)} {currency}
                </div>
              </div>
            </Section>
          </div>
        </>
      )}
    </div>
  );
}
