import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  FileDown,
  Flame,
  ImageDown,
  Lock,
  RefreshCw,
  Unlock,
  WalletCards,
  X,
} from "lucide-react";
import { db } from "../firebase";
import { useAuth } from "../context/AuthContext";
import { useClient } from "../context/ClientContext";
import { useShift } from "../context/shift-context.js";
import ModuleExitButton from "../components/ModuleExitButton.jsx";
import ModuleHelpButton from "../components/ModuleHelpButton.jsx";
import DateInput from "../components/DateInput.jsx";
import { formatIsoDate } from "../utils/dateFormat.js";
import { calculateEodSnapshot } from "../utils/eodCalculations.js";
import { loadPriorBankBalancesByAccount } from "../utils/priorBankBalances.js";
import { toBusinessDate } from "../utils/transactionContract.js";
import { formatMoney, formatMoneyLocale } from "../utils/money.js";

function todayYYYYMMDD() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function money(value) {
  if (value == null || value === "") return "—";
  return formatMoney(value);
}

function reportId(clientId, date) {
  return `${clientId}_${date}`;
}

function businessDateRange(value) {
  const start = new Date(`${value}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

function StatCell({ label, value, tone = "text-slate-900" }) {
  return (
    <div className="flex h-full min-h-[4.5rem] flex-col justify-start py-1">
      <p className="min-h-[2rem] text-[11px] font-semibold uppercase leading-tight tracking-wider text-slate-500">
        {label}
      </p>
      <p className={`mt-auto text-xl font-bold tabular-nums sm:text-2xl ${tone}`}>
        {value}
      </p>
    </div>
  );
}

export default function EndOfDay() {
  const { user, role } = useAuth();
  const { activeClientId, activeClientData } = useClient();
  const { activeShift } = useShift();
  const [searchParams, setSearchParams] = useSearchParams();
  const cardRef = useRef(null);
  const previewRunRef = useRef(0);

  const dateFromUrl = String(searchParams.get("date") || "").slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(
    () =>
      (/^\d{4}-\d{2}-\d{2}$/.test(dateFromUrl) && dateFromUrl) ||
      todayYYYYMMDD()
  );
  const [preview, setPreview] = useState(null);
  const [savedReport, setSavedReport] = useState(null);
  const [loadedReportKey, setLoadedReportKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState("");
  const [showUnlockConfirm, setShowUnlockConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const canManage = role === "admin" || role === "super_admin";

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFromUrl)) return;
    setSelectedDate(dateFromUrl);
    setMessage("");
    setError("");
  }, [dateFromUrl]);

  // When opening EOD with no ?date= and a shift is open, lock report date to the shift business date.
  useEffect(() => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateFromUrl)) return;
    if (!activeShift || activeShift.status !== "OPEN") return;
    const shiftDate = String(activeShift.businessDate || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) return;
    if (shiftDate === selectedDate) return;
    setSelectedDate(shiftDate);
    setMessage("");
    setError("");
    setSearchParams({ date: shiftDate }, { replace: true });
  }, [
    activeShift?.businessDate,
    activeShift?.status,
    dateFromUrl,
    selectedDate,
    setSearchParams,
  ]);

  function selectBusinessDate(nextDate) {
    const clean = String(nextDate || "").slice(0, 10);
    setSelectedDate(clean);
    setMessage("");
    setError("");
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
      setSearchParams({ date: clean }, { replace: true });
    }
  }

  const loadPreview = useCallback(async () => {
    if (!activeClientId || !selectedDate) return null;
    const timingLabel = `EOD Operation: Preview ${++previewRunRef.current}`;
    console.time(timingLabel);
    setLoading(true);
    setError("");
    try {
      const { startMs, endMs } = businessDateRange(selectedDate);
      const [
        transactionSnapshot,
        directShiftSnapshot,
        zReportSnapshot,
        previousReportSnapshot,
        externalBillSnapshot,
        deliveryCollectionSnapshot,
        bankAccountSnapshot,
      ] = await Promise.all([
        getDocs(
          query(
            collection(db, "transactions"),
            where("clientId", "==", activeClientId),
            where("dateMs", ">=", startMs),
            where("dateMs", "<", endMs)
          )
        ),
        getDocs(
          query(
            collection(db, "shifts"),
            where("clientId", "==", activeClientId),
            where("businessDate", "==", selectedDate)
          )
        ),
        getDocs(
          query(
            collection(db, "z_reports"),
            where("clientId", "==", activeClientId),
            where("businessDate", "==", selectedDate)
          )
        ),
        getDocs(
          query(
            collection(db, "daily_reports"),
            where("clientId", "==", activeClientId),
            where("date", "<", selectedDate),
            orderBy("date", "desc"),
            limit(1)
          )
        ),
        getDocs(
          query(
            collection(db, "external_sales_bills"),
            where("clientId", "==", activeClientId),
            where("businessDate", "==", selectedDate)
          )
        ),
        getDocs(
          query(
            collection(db, "delivery_boy_collections"),
            where("clientId", "==", activeClientId),
            where("businessDate", "==", selectedDate)
          )
        ),
        getDocs(
          query(
            collection(db, "bank_accounts"),
            where("clientId", "==", activeClientId)
          )
        ),
      ]);
      console.debug(`${timingLabel} query counts`, {
        transactions: transactionSnapshot.size,
        directShifts: directShiftSnapshot.size,
        zReports: zReportSnapshot.size,
        previousReports: previousReportSnapshot.size,
        externalBills: externalBillSnapshot.size,
        deliveryCollections: deliveryCollectionSnapshot.size,
      });
      const zReports = zReportSnapshot.docs.map((item) => ({
        id: item.id,
        ...item.data(),
      }));
      const directShifts = directShiftSnapshot.docs.map((item) => ({
        id: item.id,
        ...item.data(),
      }));
      const selectedZReportIds = new Set(
        zReports.map((report) => String(report.id))
      );
      const shiftsForSelectedDate = directShifts.filter(
        (shift) =>
          !shift?.zReportId ||
          selectedZReportIds.has(String(shift.zReportId))
      );
      const directShiftIds = new Set(directShifts.map((shift) => shift.id));
      const embeddedShifts = zReports
        .filter(
          (report) =>
            report?.shiftId &&
            !directShiftIds.has(String(report.shiftId)) &&
            Number.isFinite(Number(report.openingFloat)) &&
            Number.isFinite(Number(report.closingCashCounted))
        )
        .map((report) => ({
          id: String(report.shiftId),
          clientId: activeClientId,
          businessDate: String(report.businessDate || selectedDate),
          openingFloat: Number(report.openingFloat),
          closingCashCounted: Number(report.closingCashCounted),
          openedAtMs: Number(report.shiftOpenedAtMs || 0),
          status: "CLOSED",
          zReportId: report.id,
        }));
      const embeddedShiftIds = new Set(
        embeddedShifts.map((shift) => shift.id)
      );
      const linkedShiftIds = Array.from(
        new Set(
          zReports
            .map((report) => String(report?.shiftId || ""))
            .filter(
              (shiftId) =>
                shiftId &&
                !directShiftIds.has(shiftId) &&
                !embeddedShiftIds.has(shiftId)
            )
        )
      );
      const linkedShiftSnapshots = await Promise.all(
        linkedShiftIds.map((shiftId) => getDoc(doc(db, "shifts", shiftId)))
      );
      const linkedShifts = linkedShiftSnapshots
        .filter(
          (snapshot) =>
            snapshot.exists() &&
            snapshot.data()?.clientId === activeClientId
        )
        .map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }));
      console.debug(`${timingLabel} linked shift reads`, linkedShiftIds.length);
      const previousReportDoc = previousReportSnapshot.docs[0];
      const previousReport = previousReportDoc
        ? { id: previousReportDoc.id, ...previousReportDoc.data() }
        : null;
      const priorBankBalancesByAccount = await loadPriorBankBalancesByAccount({
        clientId: activeClientId,
        beforeDate: selectedDate,
        previousReport,
      });
      const snapshot = calculateEodSnapshot({
        selectedDate,
        transactions: transactionSnapshot.docs.map((item) => ({
          id: item.id,
          ...item.data(),
        })),
        shifts: [...shiftsForSelectedDate, ...embeddedShifts, ...linkedShifts],
        zReports,
        previousReport,
        externalBills: externalBillSnapshot.docs.map((item) => ({
          id: item.id,
          ...item.data(),
        })),
        deliveryBoyCollections: deliveryCollectionSnapshot.docs.map((item) => ({
          id: item.id,
          ...item.data(),
        })),
        bankAccounts: bankAccountSnapshot.docs.map((item) => ({
          id: item.id,
          ...item.data(),
        })),
        priorBankBalancesByAccount,
      });
      setPreview(snapshot);
      return snapshot;
    } catch (loadError) {
      setError(loadError?.message || "Failed to calculate the day.");
      return null;
    } finally {
      setLoading(false);
      console.timeEnd(timingLabel);
    }
  }, [activeClientId, selectedDate]);

  useEffect(() => {
    if (!activeClientId || !selectedDate) {
      setSavedReport(null);
      return undefined;
    }
    const dailyReportRef = doc(
      db,
      "daily_reports",
      reportId(activeClientId, selectedDate)
    );
    return onSnapshot(
      dailyReportRef,
      (snapshot) => {
        const data = snapshot.exists()
          ? { id: snapshot.id, ...snapshot.data() }
          : null;
        setSavedReport(data);
        setLoadedReportKey(`${activeClientId}_${selectedDate}`);
      },
      (reason) =>
        setError(reason?.message || "Failed to load the saved daily report.")
    );
  }, [activeClientId, selectedDate]);

  useEffect(() => {
    const currentReportKey = `${activeClientId}_${selectedDate}`;
    if (
      activeClientId &&
      loadedReportKey === currentReportKey &&
      savedReport?.status !== "closed"
    ) {
      loadPreview();
    }
  }, [
    activeClientId,
    selectedDate,
    loadedReportKey,
    savedReport?.status,
    loadPreview,
  ]);

  const displayed = useMemo(() => {
    return savedReport?.status === "closed"
      ? savedReport
      : preview || savedReport;
  }, [savedReport, preview]);

  const health = useMemo(() => {
    if (!displayed) {
      return {
        label: "WAITING",
        tone: "text-slate-700",
        badge: "border-slate-200 bg-slate-50 text-slate-700",
        icon: RefreshCw,
      };
    }
    const hasZReportAudit =
      Number(displayed.zReportCount || 0) > 0 ||
      displayed.actualCash != null;
    if (
      hasZReportAudit &&
      Math.abs(Number(displayed.cashVariance || 0)) >= 0.005
    ) {
      return {
        label: "MISMATCH",
        tone: "text-rose-700",
        badge: "border-rose-200 bg-rose-50 text-rose-700",
        icon: AlertTriangle,
      };
    }
    if (Number(displayed.totalExpenses || 0) > Number(displayed.totalSales || 0)) {
      return {
        label: "HIGH BURN",
        tone: "text-amber-700",
        badge: "border-amber-200 bg-amber-50 text-amber-700",
        icon: Flame,
      };
    }
    return {
      label: "HEALTHY",
      tone: "text-emerald-700",
      badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
      icon: CheckCircle2,
    };
  }, [displayed]);

  async function closeDay() {
    setMessage("");
    setError("");
    setSaving(true);
    console.time("EOD Operation: Close Day");
    let transactionAttempts = 0;
    try {
      const snapshot = await loadPreview();
      if (!snapshot) return;
      if ((snapshot.zReportCount || 0) < 1) {
        throw new Error(
          "Save at least one Z-report for this business date before closing the day."
        );
      }
      if ((snapshot.openTransactionCount || 0) > 0) {
        throw new Error(
          "Finish or clear open/draft transactions for this date before closing the day."
        );
      }

      const dailyReportRef = doc(
        db,
        "daily_reports",
        reportId(activeClientId, selectedDate)
      );
      await runTransaction(db, async (transaction) => {
        transactionAttempts += 1;
        const existingSnapshot = await transaction.get(dailyReportRef);
        const existing = existingSnapshot.exists()
          ? existingSnapshot.data()
          : null;
        if (existing?.status === "closed") {
          throw new Error("Unlock the day before closing it again.");
        }

        const isEdited = Boolean(existingSnapshot.exists());
        transaction.set(
          dailyReportRef,
          {
            clientId: activeClientId,
            branchName: activeClientData?.name || activeClientId,
            date: selectedDate,
            dateAt: toBusinessDate(selectedDate),
            totalSales: snapshot.totalSales,
            totalExpenses: snapshot.totalExpenses,
            expectedCash: snapshot.expectedCash,
            actualCash: snapshot.actualCash,
            cashVariance: snapshot.cashVariance,
            totalBank: snapshot.totalBank,
            previousCashInHand: snapshot.previousCashInHand,
            previousBankBalance: snapshot.previousBankBalance,
            previousOperationalBankBalance:
              snapshot.previousOperationalBankBalance,
            previousReserveBankBalance: snapshot.previousReserveBankBalance,
            previousLockerBalance: snapshot.previousLockerBalance,
            todayNetCashDelta: snapshot.todayNetCashDelta,
            todayNetBankDelta: snapshot.todayNetBankDelta,
            todayNetOperationalBankDelta: snapshot.todayNetOperationalBankDelta,
            todayNetReserveBankDelta: snapshot.todayNetReserveBankDelta,
            todayCashToLocker: snapshot.todayCashToLocker,
            todayLockerToCash: snapshot.todayLockerToCash,
            closingCashInHand: snapshot.closingCashInHand,
            closingBankBalance: snapshot.closingBankBalance,
            closingOperationalBankBalance:
              snapshot.closingOperationalBankBalance,
            closingReserveBankBalance: snapshot.closingReserveBankBalance,
            closingBankBalancesByAccount:
              snapshot.closingBankBalancesByAccount || [],
            unassignedOperationalBankBalance:
              snapshot.unassignedOperationalBankBalance ?? 0,
            closingLockerBalance: snapshot.closingLockerBalance,
            floatingCash: snapshot.floatingCash,
            totalReceivable: snapshot.totalReceivable,
            totalPayable: snapshot.totalPayable,
            revenueExpenseRatio: snapshot.revenueExpenseRatio,
            openingFloats: snapshot.openingFloats,
            totalCashIn: snapshot.totalCashIn,
            totalCashOut: snapshot.totalCashOut,
            zReportCount: snapshot.zReportCount,
            openTransactionCount: snapshot.openTransactionCount,
            dayTransactionCount: snapshot.dayTransactionCount,
            status: "closed",
            isEdited,
            closedAt: existing?.closedAt || serverTimestamp(),
            closedBy: existing?.closedBy || user?.uid || null,
            updatedAt: serverTimestamp(),
            updatedBy: user?.uid || null,
            ...(existingSnapshot.exists()
              ? {}
              : { createdAt: serverTimestamp(), createdBy: user?.uid || null }),
          },
          { merge: true }
        );
      });
      setMessage(isEditedReport(savedReport) ? "Day re-closed successfully." : "Day closed successfully.");
    } catch (closeError) {
      setError(closeError?.message || "Failed to close the day.");
    } finally {
      setSaving(false);
      console.debug(
        "EOD Operation: Close Day transaction attempts",
        transactionAttempts
      );
      console.timeEnd("EOD Operation: Close Day");
    }
  }

  async function unlockDay() {
    if (!savedReport || !canManage) return;
    setSaving(true);
    setError("");
    setMessage("");
    console.time("EOD Operation: Unlock Day");
    try {
      const dailyReportRef = doc(db, "daily_reports", savedReport.id);
      await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(dailyReportRef);
        if (!snapshot.exists()) throw new Error("Daily report no longer exists.");
        if (snapshot.data()?.clientId !== activeClientId) {
          throw new Error("Daily report belongs to another client.");
        }
        if (snapshot.data()?.status !== "closed") {
          throw new Error("This day is already re-opened.");
        }
        transaction.update(dailyReportRef, {
          status: "re-opened",
          updatedAt: serverTimestamp(),
          updatedBy: user?.uid || null,
        });
      });
      setShowUnlockConfirm(false);
      await loadPreview();
      setMessage("Day unlocked. Review the figures and close it again when ready.");
    } catch (unlockError) {
      setError(unlockError?.message || "Failed to unlock the day.");
    } finally {
      setSaving(false);
      console.timeEnd("EOD Operation: Unlock Day");
    }
  }

  async function captureCard() {
    if (!cardRef.current) throw new Error("Daily Pulse card is not ready.");
    const { default: html2canvas } = await import("html2canvas-pro");
    const width = Math.ceil(cardRef.current.getBoundingClientRect().width);
    const height = Math.ceil(cardRef.current.scrollHeight);
    return html2canvas(cardRef.current, {
      scale: 2,
      width,
      height,
      useCORS: true,
      backgroundColor: "#ffffff",
      logging: false,
    });
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function saveAsImage() {
    if (!displayed || exporting) return;
    setExporting("image");
    setError("");
    try {
      const canvas = await captureCard();
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png", 1)
      );
      if (!blob) throw new Error("Could not generate the Daily Pulse image.");
      downloadBlob(blob, `GTCT-Daily-Pulse-${selectedDate}.png`);
    } catch (exportError) {
      setError(exportError?.message || "Failed to export the Daily Pulse image.");
    } finally {
      setExporting("");
    }
  }

  async function downloadPdf() {
    if (!displayed || exporting) return;
    setExporting("pdf");
    setError("");
    try {
      const [canvas, { jsPDF }] = await Promise.all([
        captureCard(),
        import("jspdf"),
      ]);
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 12;
      const scale = Math.min(
        (pageWidth - margin * 2) / canvas.width,
        (pageHeight - margin * 2) / canvas.height
      );
      const imageWidth = canvas.width * scale;
      const imageHeight = canvas.height * scale;
      const x = (pageWidth - imageWidth) / 2;
      const y = (pageHeight - imageHeight) / 2;
      pdf.addImage(
        canvas.toDataURL("image/png"),
        "PNG",
        x,
        y,
        imageWidth,
        imageHeight,
        undefined,
        "FAST"
      );
      pdf.save(`GTCT-Daily-Pulse-${selectedDate}.pdf`);
    } catch (exportError) {
      setError(exportError?.message || "Failed to export the Daily Pulse PDF.");
    } finally {
      setExporting("");
    }
  }

  if (!activeClientId) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold text-white">End of Day</h1>
        <p className="mt-2 text-slate-400">Select a client/shop first.</p>
      </div>
    );
  }

  const HealthIcon = health.icon;
  const reportStatus = savedReport?.status || "open";
  const ratio = Math.max(0, Number(displayed?.revenueExpenseRatio || 0));
  const ratioWidth = Math.min(100, ratio);
  const ratioBarClass =
    ratio >= 100
      ? "bg-rose-500"
      : ratio >= 80
        ? "bg-amber-500"
        : "bg-emerald-500";

  return (
    <div className="p-6">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white">End of Day Closure</h1>
          </div>
          <div className="flex items-end gap-2">
            <ModuleHelpButton moduleId="end-of-day" className="h-10" />
            <label className="text-xs font-medium uppercase tracking-wider text-slate-400">
              Business Date
              <DateInput
                value={selectedDate}
                onChange={(event) => selectBusinessDate(event.target.value)}
                className="mt-1 h-10 rounded-lg border border-slate-700 bg-slate-950 text-sm text-white"
              />
            </label>
            <button
              type="button"
              onClick={loadPreview}
              disabled={loading}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>

        {error ? (
          <div className="mt-5 rounded-xl border border-rose-900/60 bg-rose-950/25 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}
        {message ? (
          <div className="mt-5 rounded-xl border border-emerald-900/60 bg-emerald-950/25 px-4 py-3 text-sm text-emerald-200">
            {message}
          </div>
        ) : null}

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_32rem]">
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            <h2 className="font-semibold text-white">Closure Controls</h2>
            <p className="mt-1 text-sm text-slate-400">
              {(() => {
                const zCount =
                  displayed?.zReportCount ?? displayed?.closedShiftCount ?? 0;
                const txnCount = displayed?.dayTransactionCount;
                const openCount = displayed?.openTransactionCount || 0;
                return (
                  <>
                    {zCount === 1 ? "1 Z-report" : `${zCount} Z-reports`}
                    {txnCount != null
                      ? ` · ${
                          txnCount === 1
                            ? "1 posted transaction"
                            : `${txnCount} posted transactions`
                        }`
                      : ""}
                    {openCount > 0 ? ` · ${openCount} open/draft` : ""}
                    .
                  </>
                );
              })()}
            </p>

            <div className="mt-5 rounded-xl bg-slate-950/50 p-4 text-sm">
              <div className="flex justify-between text-slate-400">
                <span>Opening Floats</span>
                <span>{money(displayed?.openingFloats)}</span>
              </div>
              <div className="mt-2 flex justify-between text-slate-400">
                <span>Total Cash In</span>
                <span>{money(displayed?.totalCashIn)}</span>
              </div>
              <div className="mt-2 flex justify-between text-slate-400">
                <span>Total Cash Out</span>
                <span>{money(displayed?.totalCashOut)}</span>
              </div>
              <div className="mt-3 flex justify-between border-t border-slate-800 pt-3 font-semibold text-white">
                <span>Expected Cash</span>
                <span>{money(displayed?.expectedCash)}</span>
              </div>
              <div className="mt-2 flex justify-between font-semibold text-blue-300">
                <span>Actual Cash Counted</span>
                <span>
                  {displayed?.actualCash == null &&
                  !(displayed?.zReportCount > 0)
                    ? "Awaiting Z-report"
                    : money(displayed?.actualCash)}
                </span>
              </div>
            </div>

            {canManage ? (
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                {reportStatus === "closed" ? (
                  <button
                    type="button"
                    onClick={() => setShowUnlockConfirm(true)}
                    className="inline-flex items-center gap-2 rounded-lg border border-amber-800/60 bg-amber-950/20 px-4 py-2.5 font-medium text-amber-300 hover:bg-amber-950/40"
                  >
                    <Unlock size={16} />
                    Unlock Day
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={closeDay}
                    disabled={saving || loading || !preview}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white shadow-lg shadow-blue-900/20 transition-all hover:-translate-y-0.5 hover:bg-blue-500 disabled:translate-y-0 disabled:opacity-50"
                  >
                    <Lock size={16} />
                    {saving
                      ? "Closing…"
                      : savedReport
                      ? "Close Day Again"
                      : "Close Day"}
                  </button>
                )}
              </div>
            ) : (
              <p className="mt-5 text-sm text-slate-500">
                Report access is read-only for your role.
              </p>
            )}
          </section>

          <div>
            <article
              ref={cardRef}
              className="mx-auto max-w-lg rounded-xl border border-slate-200 bg-white p-8 text-slate-800 shadow-sm"
            >
              <header className="flex items-start justify-between gap-6 border-b border-slate-100 pb-6">
                <div>
                  <div className="flex items-center gap-2 text-slate-500">
                    <Building2 size={15} />
                    <span className="text-xs font-semibold uppercase tracking-[0.18em]">
                      Daily Pulse Report
                    </span>
                  </div>
                  <h2 className="mt-3 text-2xl font-bold text-slate-900">
                    {activeClientData?.name || activeClientId}
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {formatIsoDate(selectedDate, "-")}
                  </p>
                </div>
                <div className="text-right">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                      reportStatus === "closed"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : reportStatus === "re-opened"
                        ? "border-amber-200 bg-amber-50 text-amber-700"
                        : "border-slate-200 bg-slate-50 text-slate-600"
                    }`}
                  >
                    {reportStatus === "closed" ? (
                      <Lock size={12} />
                    ) : (
                      <Unlock size={12} />
                    )}
                    {reportStatus === "closed"
                      ? "Day Closed"
                      : reportStatus === "re-opened"
                      ? "Re-opened"
                      : "Ready"}
                  </span>
                  {savedReport?.isEdited ? (
                    <p className="mt-1.5 text-[11px] text-slate-400">
                      Edited after close
                    </p>
                  ) : null}
                </div>
              </header>

              <section className="border-b border-slate-100 py-6">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Today&apos;s Performance
                </p>
                <div className="mt-3 grid grid-cols-2 gap-8">
                  <StatCell
                    label="Daily Sales"
                    value={money(displayed?.totalSales)}
                    tone="text-emerald-700"
                  />
                  <StatCell
                    label="Daily Expense"
                    value={money(displayed?.totalExpenses)}
                    tone="text-rose-700"
                  />
                </div>
                <div className="mt-4">
                  <div className="flex justify-between text-xs font-medium text-slate-500">
                    <span>Expense Ratio</span>
                    <span className="text-slate-700">{ratio.toFixed(0)}%</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${ratioBarClass}`}
                      style={{ width: `${ratioWidth}%` }}
                    />
                  </div>
                </div>
              </section>

              <section className="border-b border-slate-100 py-6">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Financial Health & Audit
                </p>
                <div className="mt-4 flex items-start justify-between gap-5">
                  <div>
                    <span
                      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium ${health.badge}`}
                    >
                      <HealthIcon size={15} />
                      {health.label}
                    </span>
                    <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Cash Variance
                    </p>
                    <p className={`mt-1 text-2xl font-bold ${health.tone}`}>
                      {displayed?.actualCash == null &&
                      !(displayed?.zReportCount > 0)
                        ? "—"
                        : money(displayed?.cashVariance)}
                    </p>
                  </div>
                  <div className="min-w-40 space-y-3 border-l border-slate-100 pl-5 text-sm">
                    <div>
                      <p className="text-xs text-slate-500">Expected Cash</p>
                      <p className="mt-1 font-semibold text-slate-900">
                        {money(displayed?.expectedCash)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Actual Counted</p>
                      <p className="mt-1 font-semibold text-slate-900">
                        {displayed?.actualCash == null &&
                        !(displayed?.zReportCount > 0)
                          ? "Awaiting Z-report"
                          : money(displayed?.actualCash)}
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              <section className="pt-6">
                <div className="flex items-center gap-2 text-slate-500">
                  <WalletCards size={15} />
                  <p className="text-xs font-semibold uppercase tracking-wider">
                    Standing Liquidity
                  </p>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                  {(() => {
                    const cashHand = Number(
                      displayed?.closingCashInHand ??
                        displayed?.actualCash ??
                        0
                    );
                    const cashLocker = Number(
                      displayed?.closingLockerBalance || 0
                    );
                    const cashTotal = cashHand + cashLocker;
                    const bankTotal = Number(
                      displayed?.closingBankBalance ??
                        displayed?.totalBank ??
                        0
                    );
                    const receivable = Number(displayed?.totalReceivable || 0);
                    const payable = Number(displayed?.totalPayable || 0);
                    // Display-only: Cash + Bank + Receivable − Payable
                    const netBalance =
                      cashTotal + bankTotal + receivable - payable;
                    return (
                      <>
                  <StatCell
                    label="Cash (Hand)"
                    value={money(
                      displayed?.closingCashInHand ?? displayed?.actualCash
                    )}
                  />
                  <StatCell
                    label="Cash (Locker)"
                    value={money(displayed?.closingLockerBalance)}
                  />
                  <StatCell
                    label="Cash (Total)"
                    value={money(cashTotal)}
                  />
                  <StatCell
                    label="Bank (Operational)"
                    value={money(
                      displayed?.closingOperationalBankBalance ??
                        displayed?.closingBankBalance ??
                        displayed?.totalBank
                    )}
                  />
                  <StatCell
                    label="Bank (Reserve)"
                    value={money(displayed?.closingReserveBankBalance ?? 0)}
                  />
                  <StatCell
                    label="Bank (Total)"
                    value={money(bankTotal)}
                  />
                  <StatCell
                    label="Receivable (To Get)"
                    value={money(displayed?.totalReceivable)}
                    tone="text-cyan-700"
                  />
                  <StatCell
                    label="Payable (To Pay)"
                    value={money(displayed?.totalPayable)}
                    tone="text-amber-700"
                  />
                  <StatCell
                    label="Net Balance"
                    value={money(netBalance)}
                    tone={
                      netBalance >= 0 ? "text-emerald-700" : "text-rose-700"
                    }
                  />
                      </>
                    );
                  })()}
                </div>
              </section>
            </article>

            <div className="mx-auto mt-3 grid w-full max-w-lg grid-cols-2 gap-3">
              <button
                type="button"
                onClick={downloadPdf}
                disabled={!displayed || Boolean(exporting)}
                className="flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 font-medium text-slate-200 transition-all hover:-translate-y-0.5 hover:bg-slate-800 disabled:translate-y-0 disabled:opacity-50"
              >
                <FileDown size={17} />
                {exporting === "pdf" ? "Preparing…" : "Download PDF"}
              </button>
              <button
                type="button"
                onClick={saveAsImage}
                disabled={!displayed || Boolean(exporting)}
                className="flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 font-medium text-white shadow-lg shadow-blue-950/20 transition-all hover:-translate-y-0.5 hover:bg-blue-500 disabled:translate-y-0 disabled:opacity-50"
              >
                <ImageDown size={17} />
                {exporting === "image" ? "Preparing…" : "Save as Image"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {showUnlockConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-white">Unlock this day?</h2>
                <p className="mt-2 text-sm text-slate-400">
                  The ledger snapshot will become editable and must be closed again.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowUnlockConfirm(false)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-white"
                aria-label="Close confirmation"
              >
                <X size={17} />
              </button>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowUnlockConfirm(false)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={unlockDay}
                disabled={saving}
                className="rounded-lg bg-amber-600 px-4 py-2 font-medium text-white hover:bg-amber-500 disabled:opacity-50"
              >
                {saving ? "Unlocking…" : "Confirm Unlock"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function isEditedReport(report) {
  return report?.status === "re-opened" || report?.isEdited === true;
}
