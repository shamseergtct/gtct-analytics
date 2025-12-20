// src/pages/Reports.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { collection, getDocs, query, where, orderBy } from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext";

import { generateDailyPulseReport } from "../utils/reportCalculations";
import { generateDailyPDF } from "../utils/pdfGenerator";

// ✅ Firestore daily session (shared with Transactions page)
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

export default function Reports() {
  const { activeClientId, activeClientData } = useClient();
  const currency = activeClientData?.currency || "BHD";

  const [selectedDate, setSelectedDate] = useState(toYYYYMMDD(new Date()));

  // Inputs required by your report model (Firestore-backed)
  const [openingCash, setOpeningCash] = useState("0");
  const [openingBank, setOpeningBank] = useState("0");
  const [actualCount, setActualCount] = useState("0");
  const [analystNotesText, setAnalystNotesText] = useState("");

  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionErr, setSessionErr] = useState("");

  const [loading, setLoading] = useState(false);
  const [txns, setTxns] = useState([]);
  const [err, setErr] = useState("");

  // ✅ Load daily session from Firestore when client/date changes
  useEffect(() => {
    const run = async () => {
      setSessionErr("");
      if (!activeClientId) return;

      setSessionLoading(true);
      try {
        const s = await fetchDailySession(activeClientId, selectedDate);

        setOpeningCash(String(s?.openingCash ?? "0"));
        setOpeningBank(String(s?.openingBank ?? "0"));
        setActualCount(String(s?.actualCashDrawer ?? "0"));
        setAnalystNotesText(String(s?.analystNotes ?? ""));
      } catch (e) {
        console.error(e);
        setSessionErr(e?.message || "Failed to load daily session.");
      } finally {
        setSessionLoading(false);
      }
    };

    run();
  }, [activeClientId, selectedDate]);

  // ✅ Auto-save to Firestore (debounced)
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!activeClientId) return;

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      upsertDailySession(activeClientId, selectedDate, {
        openingCash: Number(openingCash || 0),
        openingBank: Number(openingBank || 0),
        actualCashDrawer: Number(actualCount || 0),
        analystNotes: String(analystNotesText || ""),
      }).catch((e) => {
        console.error(e);
        setSessionErr(e?.message || "Auto-save failed.");
      });
    }, 700);

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [activeClientId, selectedDate, openingCash, openingBank, actualCount, analystNotesText]);

  // ✅ Fetch daily txns
  useEffect(() => {
    const run = async () => {
      setErr("");
      setTxns([]);

      if (!activeClientId) return;

      setLoading(true);
      try {
        const from = startOfDay(selectedDate);
        const to = endOfDay(selectedDate);

        // ✅ Match your enabled index for reports:
        // transactions: clientId ASC + date DESC
        const qy = query(
          collection(db, "transactions"),
          where("clientId", "==", activeClientId),
          where("date", ">=", from),
          where("date", "<=", to),
          orderBy("date", "desc")
        );

        const snap = await getDocs(qy);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setTxns(rows);
      } catch (e) {
        console.error(e);
        setErr(e?.message || "Failed to load transactions for report.");
      } finally {
        setLoading(false);
      }
    };

    run();
  }, [activeClientId, selectedDate]);

  const report = useMemo(() => {
    return generateDailyPulseReport(txns, {
      selectedDate,
      openingCash: Number(openingCash || 0),
      openingBank: Number(openingBank || 0),
      actualCount: Number(actualCount || 0),
      // optional: pass notes text if your calculations want it
      analystNotesText: String(analystNotesText || ""),
    });
  }, [txns, selectedDate, openingCash, openingBank, actualCount, analystNotesText]);

  const downloadPDF = () => {
    if (!activeClientId) return alert("Please select an active client first.");

    const doc = generateDailyPDF({
      clientName: activeClientData?.name || "Client Name",
      reportDate: selectedDate,
      currency,
      report: {
        ...report,
        // ✅ ensure PDF gets notes text if needed
        analystNotesText: analystNotesText || "",
      },
    });

    doc.save(
      `GTCT-DailyPulse-${activeClientData?.name || "Client"}-${selectedDate}.pdf`
    );
  };

  return (
    <div className="space-y-5">
      {/* Header */}
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

        <button
          onClick={downloadPDF}
          className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:opacity-90 disabled:opacity-60"
          disabled={!activeClientId}
        >
          Download PDF
        </button>
      </div>

      {/* Controls */}
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
                {report?.meta?.count || 0}
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
            <label className="text-sm text-slate-300">Actual Cash Count</label>
            <input
              type="number"
              inputMode="decimal"
              value={actualCount}
              onChange={(e) => setActualCount(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
            />
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
      </div>

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
        {loading ? <div className="mt-3 text-slate-300">Loading report…</div> : null}
      </div>

      {/* 1. Revenue & Inflow */}
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
        <TwoColRow
          label="By Cash"
          value={`${money(report?.revenue?.creditRecoveryCash)} ${currency}`}
        />
        <TwoColRow
          label="By Bank/Card"
          value={`${money(report?.revenue?.creditRecoveryBank)} ${currency}`}
        />
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3 flex items-center justify-between">
          <div className="text-slate-300 font-semibold">TOTAL REVENUE GENERATED</div>
          <div className="text-white font-bold">
            {money(report?.revenue?.totalRevenueGenerated)} {currency}
          </div>
        </div>
      </Section>

      {/* 2. Expenses */}
      <Section title="2. Expenses (Verified)">
        {report?.expenses?.items?.length ? (
          <div className="space-y-2">
            {report.expenses.items.map((x) => (
              <TwoColRow key={x.key} label={x.key} value={`${money(x.amount)} ${currency}`} />
            ))}
          </div>
        ) : (
          <div className="text-slate-400 text-sm">No verified expenses</div>
        )}

        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3 flex items-center justify-between">
          <div className="text-slate-300 font-semibold">TOTAL EXPENSE INCURRED</div>
          <div className="text-white font-bold">
            {money(report?.expenses?.totalExpenseIncurred)} {currency}
          </div>
        </div>
      </Section>

      {/* 3. Credit Liability */}
      <Section title="3. Credit Purchase / Liability" danger>
        {report?.liabilities?.items?.length ? (
          <div className="space-y-2">
            {report.liabilities.items.map((x) => (
              <TwoColRow key={x.key} label={x.key} value={`${money(x.amount)} ${currency}`} />
            ))}
          </div>
        ) : (
          <div className="text-slate-400 text-sm">No liabilities loaded</div>
        )}

        <div className="mt-4 rounded-xl border border-red-900/40 bg-red-950/20 p-3 flex items-center justify-between">
          <div className="text-red-200 font-semibold">TOTAL NEW LIABILITY</div>
          <div className="text-red-100 font-bold">
            {money(report?.liabilities?.totalNewLiability)} {currency}
          </div>
        </div>
      </Section>

      {/* Bottom boxes */}
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
          <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 flex items-center justify-between">
            <div className="text-emerald-200 font-semibold">TOTAL LIQUID FUNDS</div>
            <div className="text-white font-bold">
              {money(report?.liquidity?.totalLiquidFunds)} {currency}
            </div>
          </div>
        </Section>

        <Section title="Daily Cash Check">
          <TwoColRow
            label="Opening Cash"
            value={`${money(report?.cashCheck?.openingCash)} ${currency}`}
          />
          <TwoColRow
            label="Net Cash Position"
            value={`${money(report?.cashCheck?.netCashPosition)} ${currency}`}
          />
          <TwoColRow
            label="Expected Drawer"
            value={`${money(report?.cashCheck?.expectedDrawer)} ${currency}`}
          />
          <TwoColRow
            label="Actual Count"
            value={`${money(report?.cashCheck?.actualCount)} ${currency}`}
          />
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3 flex items-center justify-between">
            <div className="text-slate-300 font-semibold">VARIANCE</div>
            <div className="text-white font-bold">
              {money(report?.cashCheck?.variance)} {currency}
            </div>
          </div>
        </Section>
      </div>

      {/* Analyst Notes (editable + saved to Firestore) */}
      <Section title="Analyst Notes & Alerts">
        <textarea
          value={analystNotesText}
          onChange={(e) => setAnalystNotesText(e.target.value)}
          placeholder="Write notes for this report (auto-saved)…"
          className="w-full min-h-[120px] rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
        />
        <div className="mt-2 text-xs text-slate-500">
          Auto-saved to Firestore (dailySessions).
        </div>

        {/* Also show generated system notes list */}
        {report?.notes?.length ? (
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3">
            <div className="text-slate-200 font-semibold text-sm mb-2">
              System Alerts
            </div>
            <ul className="list-disc pl-5 text-slate-300 text-sm space-y-1">
              {report.notes.map((n, idx) => (
                <li key={idx}>{n}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>
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
      <div className="flex items-center justify-between">
        <div className="text-white font-semibold">{title}</div>
      </div>
      <div className="mt-3">{children}</div>
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
