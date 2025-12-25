// src/pages/Reports.jsx
import { useMemo, useState } from "react";
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext";

import { generateDailyPulseReport } from "../utils/reportCalculations";
import { generateDailyPDF } from "../utils/pdfGenerator";
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
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
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
  const [txns, setTxns] = useState([]);
  const [err, setErr] = useState("");

  const [sessionErr, setSessionErr] = useState("");
  const [generated, setGenerated] = useState(false);

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

    if (!activeClientId) return setErr("Please select an active client first.");
    if (!fromDate || !toDate) return setErr("Please select From and To dates.");
    if (fromDate > toDate) return setErr("From date cannot be after To date.");

    setLoading(true);
    try {
      const from = startOfDay(fromDate);
      const to = endOfDay(toDate);

      const qy = query(
        collection(db, "transactions"),
        where("clientId", "==", activeClientId),
        where("date", ">=", from),
        where("date", "<=", to),
        orderBy("date", "desc")
      );

      const snap = await getDocs(qy);
      setTxns(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setGenerated(true);
    } catch (e) {
      console.error(e);
      setErr(e?.message || "Failed to load transactions for report.");
    } finally {
      setLoading(false);
    }
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

  const report = useMemo(() => {
    return generateDailyPulseReport(txns, {
      selectedDate: `${fromDate} → ${toDate}`,
      openingCash: Number(openingCashFrom || 0),
      openingBank: Number(openingBankFrom || 0),
      actualCount: Number(actualCountTo || 0),
      analystNotesText: String(analystNotesText || ""),
      isSingleDay,
    });
  }, [txns, fromDate, toDate, openingCashFrom, openingBankFrom, actualCountTo, analystNotesText, isSingleDay]);

  const downloadPDF = () => {
    if (!generated) return alert("Click Generate Report first.");

    const doc = generateDailyPDF({
      clientName: activeClientData?.name || "Client",
      reportDate: `${fromDate} → ${toDate}`,
      currency,
      report: {
        ...report,
        analystNotesText: analystNotesText || "",
      },
    });

    doc.save(`GTCT-DailyPulse-${activeClientData?.name || "Client"}-${fromDate}_to_${toDate}.pdf`);
  };

  return (
    <div className="space-y-5">
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

        <div className="flex gap-2">
          <button
            onClick={generateReport}
            className="inline-flex items-center justify-center rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
            disabled={!activeClientId || loading}
          >
            {loading ? "Generating…" : "Generate Report"}
          </button>

          <button
            onClick={downloadPDF}
            className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:opacity-90 disabled:opacity-60"
            disabled={!generated}
          >
            Download PDF
          </button>
        </div>
      </div>

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
              className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 hover:bg-slate-800"
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
          <div className="text-slate-200 font-semibold text-sm mb-2">Analyst Notes & Alerts</div>

          <textarea
            value={analystNotesText}
            onChange={(e) => setAnalystNotesText(e.target.value)}
            placeholder="Write notes for this report…"
            className="w-full min-h-[120px] rounded-xl bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
          />

          <div className="mt-2 flex gap-2">
            <button
              onClick={saveNotesToToDate}
              className="rounded-xl bg-slate-200 px-3 py-2 text-sm font-semibold text-slate-950 hover:opacity-90 disabled:opacity-60"
              disabled={!activeClientId}
            >
              Save Notes
            </button>

            <div className="text-xs text-slate-500 flex items-center">
              Notes + Actual Count saved to <b>To date</b>. Opening saved to <b>From date</b>.
            </div>
          </div>
        </div>
      </div>

      {!generated ? null : (
        <>
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

          <Section title="1. Revenue & Inflow">
            <TwoColRow label="Total Gross Sales (Z-Report)" value={`${money(report?.revenue?.totalGrossSales)} ${currency}`} />
            <TwoColRow label="Cash Sales" value={`${money(report?.revenue?.cashSales)} ${currency}`} />
            <TwoColRow label="Bank Sales" value={`${money(report?.revenue?.bankSales)} ${currency}`} />
            <TwoColRow label="Credit Sales (Pending)" value={`${money(report?.revenue?.creditSales)} ${currency}`} />
            <div className="my-3 h-px bg-slate-800" />
            <TwoColRow label="Credit Recovery (Old Debts)" value={`${money(report?.revenue?.creditRecoveryTotal)} ${currency}`} />
            <TwoColRow label="Income" value={`${money(report?.revenue?.totalIncome)} ${currency}`} />
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3 flex items-center justify-between">
              <div className="text-slate-300 font-semibold">TOTAL REVENUE GENERATED</div>
              <div className="text-white font-bold">{money(report?.revenue?.totalRevenueGenerated)} {currency}</div>
            </div>
          </Section>

          <Section title="2. Expenses (Verified)">
            {report?.expenses?.items?.length ? (
              report.expenses.items.map((x) => (
                <TwoColRow key={x.key} label={x.key} value={`${money(x.amount)} ${currency}`} />
              ))
            ) : (
              <div className="text-slate-400 text-sm">No verified expenses</div>
            )}
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3 flex items-center justify-between">
              <div className="text-slate-300 font-semibold">TOTAL EXPENSE INCURRED</div>
              <div className="text-white font-bold">{money(report?.expenses?.totalExpenseIncurred)} {currency}</div>
            </div>
          </Section>

          {/* ✅ RULE:
              - If single day: show "Total New Liability"
              - If range: DO NOT show "Total New Liability"
              - But Total Payable must always show (it is in Liquidity section)
          */}
          {isSingleDay ? (
            <Section title="3. Supplier Liability (Purchase / Expense CREDIT - Payment reduces)" danger>
              {report?.liabilities?.itemsNet?.length ? (
                report.liabilities.itemsNet.map((x) => (
                  <TwoColRow
                    key={x.key}
                    label={`${x.key} (Created - Paid)`}
                    value={`${money(x.balance)} ${currency}`}
                  />
                ))
              ) : (
                <div className="text-slate-400 text-sm">No supplier liability changes in this range</div>
              )}

              <TwoColRow label="Supplier Paid (This Period)" value={`${money(report?.liabilities?.totalSupplierPaid)} ${currency}`} />

              <div className="mt-4 rounded-xl border border-red-900/40 bg-red-950/20 p-3 flex items-center justify-between">
                <div className="text-red-200 font-semibold">TOTAL NEW LIABILITY (Single Day)</div>
                <div className="text-red-100 font-bold">{money(report?.liabilities?.totalNewLiability)} {currency}</div>
              </div>
            </Section>
          ) : (
            <Section title="3. Supplier Liability (Purchase / Payment)" danger>
              {report?.liabilities?.itemsNet?.length ? (
                report.liabilities.itemsNet.map((x) => (
                  <TwoColRow
                    key={x.key}
                    label={`${x.key} (Created - Paid)`}
                    value={`${money(x.balance)} ${currency}`}
                  />
                ))
              ) : (
                <div className="text-slate-400 text-sm">No supplier liability changes in this range</div>
              )}
              <TwoColRow label="Supplier Paid (This Period)" value={`${money(report?.liabilities?.totalSupplierPaid)} ${currency}`} />
              <div className="text-xs text-slate-500 mt-2">
                Range report: Total New Liability is hidden. Total Payable is shown below in Liquidity.
              </div>
            </Section>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section title="Liquidity & Balance (Till Date)">
              <TwoColRow label="Total Cash Balance" value={`${money(report?.liquidity?.totalCashBalance)} ${currency}`} />
              <TwoColRow label="Total Bank Balance" value={`${money(report?.liquidity?.totalBankBalance)} ${currency}`} />
              <TwoColRow label="Total Receivable (Asset)" value={`${money(report?.liquidity?.totalReceivable)} ${currency}`} />

              {/* ✅ IMPORTANT: Payable is NET (created - paid) */}
              <TwoColRow label="Total Payable (Liability)" value={`${money(report?.liquidity?.totalPayable)} ${currency}`} />

              <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 flex items-center justify-between">
                <div className="text-emerald-200 font-semibold">TOTAL LIQUID FUNDS</div>
                <div className="text-white font-bold">{money(report?.liquidity?.totalLiquidFunds)} {currency}</div>
              </div>
            </Section>

            <Section title="Daily Cash Check (Range)">
              <TwoColRow label="Opening Cash (From)" value={`${money(openingCashFrom)} ${currency}`} />
              <TwoColRow label="Net Cash Position (Range)" value={`${money(report?.cashCheck?.netCashPosition)} ${currency}`} />
              <TwoColRow label="Expected Drawer (To)" value={`${money(report?.cashCheck?.expectedDrawer)} ${currency}`} />
              <TwoColRow label="Actual Count (To)" value={`${money(actualCountTo)} ${currency}`} />
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3 flex items-center justify-between">
                <div className="text-slate-300 font-semibold">VARIANCE</div>
                <div className="text-white font-bold">{money(report?.cashCheck?.variance)} {currency}</div>
              </div>
            </Section>
          </div>
        </>
      )}
    </div>
  );
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
      <div className="text-sm text-slate-300">{label}</div>
      <div className="text-sm font-semibold text-white">{value}</div>
    </div>
  );
}
