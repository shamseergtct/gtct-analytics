// src/pages/Reports.jsx
import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  where,
  Timestamp,
  serverTimestamp,
} from "firebase/firestore";
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

// -------------------------
// Local normalizers (Quick section only)
// -------------------------
function normalizeMode(m) {
  const x = String(m || "").trim().toLowerCase();
  if (!x) return "";
  if (x.startsWith("cas")) return "cash";
  if (x.startsWith("ban")) return "bank";
  if (x.startsWith("car")) return "bank"; // card -> bank bucket
  if (x.startsWith("upi")) return "bank";
  if (x.startsWith("cre")) return "credit";

  // ✅ Petti mapping
  if (x.startsWith("petti")) return "petti";
  if (x.startsWith("petty")) return "petti";
  if (x.includes("petti cash")) return "petti";
  if (x.includes("petty cash")) return "petti";

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
  if (x.startsWith("tra")) return "transfer";
  if (x.startsWith("ref")) return "refill";
  return x;
}

// -------------------------
// Discount helpers (Quick section only)
// -------------------------
function safeSide(v) {
  return String(v || "").trim().toLowerCase();
}
function getDiscountAmount(t) {
  const a =
    num(t?.discountAmount) || num(t?.discountAmt) || num(t?.discount) || 0;
  return a > 0 ? a : 0;
}
function getDiscountEnabled(t) {
  const enabled =
    Boolean(t?.discountEnabled) ||
    Boolean(t?.enableDiscount) ||
    Boolean(t?.hasDiscount) ||
    false;
  return enabled || getDiscountAmount(t) > 0;
}
function getDiscountSide(t) {
  const side =
    safeSide(t?.discountSide) ||
    safeSide(t?.discountFor) ||
    safeSide(t?.discountPartySide) ||
    "";
  return side;
}

function inValue(t) {
  return num(t?.amountIn);
}
function outValue(t) {
  const out = num(t?.amountOut);
  if (out > 0) return out;

  // legacy fallback only for outflow types
  const ty = normalizeType(t?.type);
  if (ty === "purchase" || ty === "payment" || ty === "expense")
    return num(t?.amountIn);
  return 0;
}

// -------------------------
// Internal transfer + Loan detection (Quick section only)
// -------------------------
function internalTransferAmount(t) {
  return num(t?.totalAmount) || num(t?.amountIn) || num(t?.amountOut) || 0;
}
function isInternalTransfer(t) {
  if (!t) return false;
  if (t?.internalTransfer === true) return true;

  const ty = normalizeType(t?.type);
  const m = normalizeMode(t?.mode);
  const src = String(t?.sourceMode || "").trim();

  if ((ty === "transfer" || ty === "refill") && m === "petti" && src)
    return true;

  const cat = String(t?.category || "").trim().toLowerCase();
  const desc = String(t?.description || "").trim().toLowerCase();

  if (
    m === "petti" &&
    (cat.includes("petti refill") || cat.includes("petty refill"))
  )
    return true;
  if (m === "petti" && desc.includes("refill")) return true;

  return false;
}
function isLoanMovement(t) {
  const ty = normalizeType(t?.type);
  const cat = String(t?.category || "").trim().toLowerCase();
  const isLoanCat = cat === "loan" || cat.includes("loan");
  return isLoanCat && (ty === "income" || ty === "payment");
}
function isLoanIncome(t) {
  const ty = normalizeType(t?.type);
  const cat = String(t?.category || "").trim().toLowerCase();
  return (cat === "loan" || cat.includes("loan")) && ty === "income" && inValue(t) > 0;
}
function isLoanRepay(t) {
  const ty = normalizeType(t?.type);
  const cat = String(t?.category || "").trim().toLowerCase();
  // repayment is Payment
  return (cat === "loan" || cat.includes("loan")) && ty === "payment" && outValue(t) > 0;
}

// -------------------------
// Firestore: Opening Inputs stored in client_settings/{clientId}
// -------------------------
function clientSettingsRef(clientId) {
  return doc(db, "client_settings", clientId);
}
async function fetchOpeningInputs(clientId) {
  if (!clientId) return null;
  const ref = clientSettingsRef(clientId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const d = snap.data() || {};
  return {
    openingCashFrom: d.openingCashFrom ?? d.openingCash ?? 0,
    openingBankFrom: d.openingBankFrom ?? d.openingBank ?? 0,
  };
}
async function upsertOpeningInputs(clientId, openingCashFrom, openingBankFrom) {
  if (!clientId) return;
  const ref = clientSettingsRef(clientId);
  await setDoc(
    ref,
    {
      clientId,
      openingCashFrom: num(openingCashFrom),
      openingBankFrom: num(openingBankFrom),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

// -------------------------
// UI components
// -------------------------
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

export default function Reports() {
  const { activeClientId, activeClientData } = useClient();
  const currency = activeClientData?.currency || "BHD";

  const [fromDate, setFromDate] = useState(toYYYYMMDD(new Date()));
  const [toDate, setToDate] = useState(toYYYYMMDD(new Date()));

  // ✅ Stored in Firestore (client_settings) and must remain until changed
  const [openingCashFrom, setOpeningCashFrom] = useState("0");
  const [openingBankFrom, setOpeningBankFrom] = useState("0");

  // Petti opening not stored
  const openingPettiFrom = "0";

  const [actualCountTo, setActualCountTo] = useState("0");
  const [analystNotesText, setAnalystNotesText] = useState("");

  const [loading, setLoading] = useState(false);
  const [txnsRange, setTxnsRange] = useState([]);
  const [txnsTill, setTxnsTill] = useState([]);

  const [err, setErr] = useState("");
  const [sessionErr, setSessionErr] = useState("");

  const [generated, setGenerated] = useState(false);
  const [quickGenerated, setQuickGenerated] = useState(false);

  // status for opening inputs
  const [inputsLoaded, setInputsLoaded] = useState(false);
  const [savingOpening, setSavingOpening] = useState(false);

  const isSingleDay = fromDate === toDate;

  // -----------------------------------------
  // ✅ AUTO LOAD (NO BUTTON) — Opening inputs per client
  // -----------------------------------------
  useEffect(() => {
    let mounted = true;
    (async () => {
      setInputsLoaded(false);
      if (!activeClientId) return;

      try {
        const saved = await fetchOpeningInputs(activeClientId);
        if (!mounted) return;

        if (saved) {
          setOpeningCashFrom(String(saved.openingCashFrom ?? 0));
          setOpeningBankFrom(String(saved.openingBankFrom ?? 0));
        } else {
          // keep defaults (0) if no saved doc
          setOpeningCashFrom("0");
          setOpeningBankFrom("0");
        }
      } catch (e) {
        console.error("Auto load opening inputs failed:", e);
        // don't block UI
      } finally {
        if (mounted) setInputsLoaded(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [activeClientId]);

  // -----------------------------------------
  // ✅ AUTO LOAD — ToDate session (actual cash + notes)
  // This fixes: "not loading automatically into respected fields"
  // -----------------------------------------
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!activeClientId || !toDate) return;
      try {
        const sTo = await fetchDailySession(activeClientId, toDate);
        if (!mounted) return;
        setActualCountTo(String(sTo?.actualCashDrawer ?? "0"));
        setAnalystNotesText(String(sTo?.analystNotes ?? ""));
      } catch (e) {
        // silent (live safe)
        console.error("Auto load ToDate session failed:", e);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [activeClientId, toDate]);

  // -----------------------------------------
  // ✅ AUTO SAVE (debounced) — opening inputs to Firestore client_settings
  // -----------------------------------------
  useEffect(() => {
    if (!activeClientId) return;
    if (!inputsLoaded) return;

    const t = setTimeout(async () => {
      try {
        setSavingOpening(true);
        await upsertOpeningInputs(
          activeClientId,
          Number(openingCashFrom || 0),
          Number(openingBankFrom || 0)
        );
      } catch (e) {
        console.error("Auto save opening inputs failed:", e);
      } finally {
        setSavingOpening(false);
      }
    }, 650);

    return () => clearTimeout(t);
  }, [activeClientId, openingCashFrom, openingBankFrom, inputsLoaded]);

  // -----------------------------------------
  // ✅ Load Saved Inputs button (manual)
  // Fixes: "button not loading"
  // -----------------------------------------
  async function loadSavedInputs() {
    setSessionErr("");
    if (!activeClientId) return;

    try {
      // Opening inputs (client_settings)
      const saved = await fetchOpeningInputs(activeClientId);
      if (saved) {
        setOpeningCashFrom(String(saved.openingCashFrom ?? 0));
        setOpeningBankFrom(String(saved.openingBankFrom ?? 0));
      }

      // ToDate session inputs
      const sTo = await fetchDailySession(activeClientId, toDate);
      setActualCountTo(String(sTo?.actualCashDrawer ?? "0"));
      setAnalystNotesText(String(sTo?.analystNotes ?? ""));
    } catch (e) {
      console.error(e);
      setSessionErr(e?.message || "Failed to load saved inputs.");
    }
  }

  // -----------------------------------------
  // Report generator
  // -----------------------------------------
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

      // RANGE
      const qRange = query(
        collection(db, "transactions"),
        where("clientId", "==", activeClientId),
        where("date", ">=", from),
        where("date", "<=", to),
        orderBy("date", "desc")
      );

      // TILL DATE (1970 -> To)
      const veryOld = Timestamp.fromDate(new Date(1970, 0, 1, 0, 0, 0, 0));
      const qTill = query(
        collection(db, "transactions"),
        where("clientId", "==", activeClientId),
        where("date", ">=", veryOld),
        where("date", "<=", to),
        orderBy("date", "desc")
      );

      const [snapRange, snapTill] = await Promise.all([
        getDocs(qRange),
        getDocs(qTill),
      ]);

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
    if (!generated) {
      await generateReport();
    }
    setQuickGenerated(true);
  }

  // -----------------------------------------
  // Save notes + actual cash (ToDate)
  // Opening already auto-saves; but we also save immediately here (safe)
  // -----------------------------------------
  async function saveNotesToToDate() {
    setSessionErr("");
    if (!activeClientId) return;

    try {
      // Ensure opening stored (immediate save)
      await upsertOpeningInputs(
        activeClientId,
        Number(openingCashFrom || 0),
        Number(openingBankFrom || 0)
      );

      // Save ToDate session
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
  // Detailed report (engine)
  // -------------------------
  const reportBase = useMemo(() => {
    return generateDailyPulseReport(txnsRange, {
      selectedDate: `${fromDate} → ${toDate}`,
      openingCash: Number(openingCashFrom || 0),
      openingBank: Number(openingBankFrom || 0),
      openingPetti: Number(openingPettiFrom || 0),
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
    openingPettiFrom,
    actualCountTo,
    analystNotesText,
    isSingleDay,
  ]);

  // -------------------------
  // ✅ Loan summary (Range + TillDate) computed here (no dependency)
  // -------------------------
  const loan = useMemo(() => {
    const range = Array.isArray(txnsRange) ? txnsRange : [];
    const till = Array.isArray(txnsTill) ? txnsTill : range;

    const acquiredRange = range
      .filter((t) => !isInternalTransfer(t) && isLoanIncome(t))
      .reduce((s, t) => s + inValue(t), 0);

    const repaidRange = range
      .filter((t) => !isInternalTransfer(t) && isLoanRepay(t))
      .reduce((s, t) => s + outValue(t), 0);

    const acquiredTill = till
      .filter((t) => !isInternalTransfer(t) && isLoanIncome(t))
      .reduce((s, t) => s + inValue(t), 0);

    const repaidTill = till
      .filter((t) => !isInternalTransfer(t) && isLoanRepay(t))
      .reduce((s, t) => s + outValue(t), 0);

    return {
      acquiredRange: num(acquiredRange),
      repaidRange: num(repaidRange),
      netRange: num(acquiredRange - repaidRange),
      outstandingTillDate: num(acquiredTill - repaidTill),
    };
  }, [txnsRange, txnsTill]);

  // Final report object used in UI + PDF (includes loan)
  const report = useMemo(() => {
    return {
      ...reportBase,
      loan,
    };
  }, [reportBase, loan]);

  // -------------------------
  // Quick report (UI)
  // -------------------------
  const quick = useMemo(() => {
    const range = Array.isArray(txnsRange) ? txnsRange : [];

    // Range Balance (cash+bank+petti only), exclude loan + internal transfer, apply discounts
    let rangeIn = 0;
    let rangeOut = 0;

    for (const t of range) {
      if (isInternalTransfer(t)) continue;
      if (isLoanMovement(t)) continue;

      const m = normalizeMode(t?.mode);
      if (m !== "cash" && m !== "bank" && m !== "petti") continue;

      const side = getDiscountSide(t);
      const disc = getDiscountEnabled(t) ? getDiscountAmount(t) : 0;

      const _in = inValue(t);
      const _out = outValue(t);

      const inAdj = side === "customer" ? Math.max(0, _in - disc) : _in;
      const outAdj = side === "supplier" ? Math.max(0, _out - disc) : _out;

      rangeIn += inAdj;
      rangeOut += outAdj;
    }

    const rangeBalance = rangeIn - rangeOut;

    // Balances from engine (till-date)
    const cashBalance = num(report?.liquidity?.totalCashBalance);
    const bankBalance = num(report?.liquidity?.totalBankBalance);
    const pettiBalance = num(report?.liquidity?.totalPettiBalance);
    const totalBalance = num(report?.liquidity?.totalBalance);

    const totalSalesNet = num(report?.revenue?.totalNetSales);
    const totalExpenseNet = num(report?.expenses?.totalExpenseIncurred);

    const receivable = num(report?.liquidity?.totalReceivable);
    const payable = num(report?.liquidity?.totalPayable);
    const netPosition = totalBalance + receivable - payable;

    const isNegative = totalBalance < -0.009;

    return {
      openingCash: num(openingCashFrom),
      openingBank: num(openingBankFrom),

      totalSales: totalSalesNet,
      totalExpense: totalExpenseNet,
      rangeBalance,

      cashBalance,
      bankBalance,
      pettiBalance,
      totalBalance,

      receivable,
      payable,
      netPosition,
      isNegative,

      loanAcquiredRange: num(report?.loan?.acquiredRange),
      loanRepaidRange: num(report?.loan?.repaidRange),
      loanOutstandingTill: num(report?.loan?.outstandingTillDate),
    };
  }, [txnsRange, report, openingCashFrom, openingBankFrom]);

  // -------------------------
  // PDFs
  // -------------------------
  const downloadPDF = () => {
    if (!generated) return alert("Click Generate Detailed Report first.");

    const docPdf = generateDailyPDF({
      clientName: activeClientData?.name || "Client",
      reportDate: `${fromDate} → ${toDate}`,
      currency,
      report: {
        ...report,
        analystNotesText: analystNotesText || "",
      },
    });

    docPdf.save(
      `GTCT-DailyPulse-${activeClientData?.name || "Client"}-${fromDate}_to_${toDate}.pdf`
    );
  };

  const downloadQuickPDF = () => {
    if (!generated && !quickGenerated)
      return alert("Click Generate Quick Report first.");

    const docPdf = generateQuickPDF({
      clientName: activeClientData?.name || "Client",
      reportDate: `${fromDate} → ${toDate}`,
      currency,
      quick: {
        ...quick,
        // optional text for pdf generator if you use these keys
        pdfStatusText: quick?.isNegative ? "ALERT: NEGATIVE" : "HEALTHY: POSITIVE",
      },
    });

    docPdf.save(
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
            <div className="mt-1 text-[11px] text-slate-500">
              {savingOpening
                ? "Saving to Firestore..."
                : inputsLoaded
                ? "Saved (Firestore)"
                : "Loading..."}
            </div>
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
            <div className="mt-1 text-[11px] text-slate-500">
              {savingOpening
                ? "Saving to Firestore..."
                : inputsLoaded
                ? "Saved (Firestore)"
                : "Loading..."}
            </div>
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
              onClick={loadSavedInputs}
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
              Notes + Actual Count saved to <b>To date</b>. Opening Cash/Bank saved to{" "}
              <b>Firestore (until you change)</b>.
            </div>
          </div>
        </div>
      </div>

      {/* Quick Report Section */}
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
            <QuickCard title="Opening Cash (From)" value={quick?.openingCash} currency={currency} />
            <QuickCard title="Opening Bank (From)" value={quick?.openingBank} currency={currency} />
            <QuickCard
              title="Balance (Range)"
              value={quick?.rangeBalance}
              currency={currency}
              emphasis={num(quick?.rangeBalance) < 0 ? "bad" : "good"}
            />

            <QuickCard title="Total Sales (NET)" value={quick?.totalSales} currency={currency} />
            <QuickCard title="Total Expense" value={quick?.totalExpense} currency={currency} />
            <QuickCard
              title="Loan Outstanding (Till ToDate)"
              value={quick?.loanOutstandingTill}
              currency={currency}
            />

            <QuickCard title="Cash Balance" value={quick?.cashBalance} currency={currency} />
            <QuickCard title="Bank Balance" value={quick?.bankBalance} currency={currency} />
            <QuickCard title="Petti Cash Balance" value={quick?.pettiBalance} currency={currency} />

            <QuickCard
              title="Total Balance (Cash + Bank + Petti)"
              value={quick?.totalBalance}
              currency={currency}
              emphasis={num(quick?.totalBalance) < 0 ? "bad" : "good"}
            />

            <QuickCard title="Loan Acquired (Range)" value={quick?.loanAcquiredRange} currency={currency} />
            <QuickCard title="Loan Repaid (Range)" value={quick?.loanRepaidRange} currency={currency} />
            <QuickCard
              title="Net Position (Bal + Rec - Pay)"
              value={quick?.netPosition}
              currency={currency}
              emphasis={num(quick?.netPosition) < 0 ? "bad" : "good"}
            />
          </div>
        </div>
      )}

      {/* Detailed report */}
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
            <div className="mt-2 text-sm text-slate-400">
              {report?.status?.statusSub || ""}
            </div>
          </div>

          {/* Loan Report */}
          <Section title="Loan Report">
            <TwoColRow
              label="Loan Acquired (Range)"
              value={`${money(report?.loan?.acquiredRange)} ${currency}`}
            />
            <TwoColRow
              label="Loan Repaid (Range)"
              value={`${money(report?.loan?.repaidRange)} ${currency}`}
            />
            <TwoColRow
              label="Loan Net Change (Range)"
              value={`${money(report?.loan?.netRange)} ${currency}`}
            />
            <div className="my-3 h-px bg-slate-800" />
            <TwoColRow
              label="Loan Outstanding (Till ToDate)"
              value={`${money(report?.loan?.outstandingTillDate)} ${currency}`}
            />
          </Section>

          {/* Revenue */}
          <Section title="1. Revenue & Inflow">
            <TwoColRow
              label="Total Gross Sales (Z-Report)"
              value={`${money(report?.revenue?.totalGrossSales)} ${currency}`}
            />
            <TwoColRow
              label="Cash Sales"
              value={`${money(report?.revenue?.cashSales)} ${currency}`}
            />
            <TwoColRow
              label="Bank Sales"
              value={`${money(report?.revenue?.bankSales)} ${currency}`}
            />
            <TwoColRow
              label="Petti Sales"
              value={`${money(report?.revenue?.pettiSales)} ${currency}`}
            />
            <TwoColRow
              label="Credit Sales (Pending)"
              value={`${money(report?.revenue?.creditSales)} ${currency}`}
            />
            <div className="my-3 h-px bg-slate-800" />
            <TwoColRow
              label="Credit Recovery (Old Debts)"
              value={`${money(report?.revenue?.creditRecoveryTotal)} ${currency}`}
            />
            <TwoColRow
              label="Income"
              value={`${money(report?.revenue?.totalIncome)} ${currency}`}
            />
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3 flex items-center justify-between gap-3">
              <div className="text-slate-300 font-semibold">TOTAL REVENUE GENERATED</div>
              <div className="text-white font-bold text-right tabular-nums whitespace-nowrap min-w-[140px]">
                {money(report?.revenue?.totalRevenueGenerated)} {currency}
              </div>
            </div>
          </Section>

          {/* Expenses */}
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

          {/* Liability */}
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

          {/* Liquidity + Cash Check */}
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
                label="Petti Cash Balance"
                value={`${money(report?.liquidity?.totalPettiBalance)} ${currency}`}
              />

              <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950 p-3 flex items-center justify-between gap-3">
                <div className="text-slate-300 font-semibold">
                  TOTAL BALANCE (Cash + Bank + Petti)
                </div>
                <div className="text-white font-bold text-right tabular-nums whitespace-nowrap min-w-[140px]">
                  {money(report?.liquidity?.totalBalance)} {currency}
                </div>
              </div>

              <TwoColRow
                label="Total Receivable (Asset)"
                value={`${money(report?.liquidity?.totalReceivable)} ${currency}`}
              />
              <TwoColRow
                label="Total Payable (Liability)"
                value={`${money(report?.liquidity?.totalPayable)} ${currency}`}
              />

              <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 flex items-center justify-between gap-3">
                <div className="text-emerald-200 font-semibold">TOTAL LIQUID FUNDS</div>
                <div className="text-white font-bold text-right tabular-nums whitespace-nowrap min-w-[140px]">
                  {money(report?.liquidity?.totalLiquidFunds)} {currency}
                </div>
              </div>
            </Section>

            <Section title="Daily Cash Check (Range)">
              <TwoColRow
                label="Opening Cash (From)"
                value={`${money(openingCashFrom)} ${currency}`}
              />
              <TwoColRow
                label="Net Cash Position (Range)"
                value={`${money(report?.cashCheck?.netCashPosition)} ${currency}`}
              />
              <TwoColRow
                label="Expected Drawer (To)"
                value={`${money(report?.cashCheck?.expectedDrawer)} ${currency}`}
              />
              <TwoColRow
                label="Actual Count (To)"
                value={`${money(actualCountTo)} ${currency}`}
              />
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
