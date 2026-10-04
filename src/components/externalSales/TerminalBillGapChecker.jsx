import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { AlertTriangle, Check, ChevronDown, Circle } from "lucide-react";
import { db } from "../../firebase";
import { useAuth } from "../../context/AuthContext";
import { formatIsoDate } from "../../utils/dateFormat.js";
import {
  compareBillingTerminals,
  externalTerminalBillRangeDocId,
  findMissingBillNumbers,
  parseBillSequence,
} from "../../utils/externalSales.js";
import { BTN_PRIMARY, BTN_SECONDARY } from "./externalSalesUi.js";

const MISSING_PREVIEW_LIMIT = 12;

const RANGE_INPUT =
  "mt-1.5 h-10 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm tabular-nums text-white outline-none transition-colors placeholder:text-slate-600 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

function resolveRangePreview(draft) {
  const start = parseBillSequence(draft?.startBillNumber);
  const end = parseBillSequence(draft?.endBillNumber);
  if (start == null || end == null) {
    return { valid: false, start: null, end: null, expectedCount: null };
  }
  if (end < start) {
    return { valid: false, start, end, expectedCount: null };
  }
  return {
    valid: true,
    start,
    end,
    expectedCount: end - start + 1,
  };
}

function StatusBadge({ status }) {
  if (status === "complete") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-800/60 bg-emerald-950/40 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
        <Check className="h-3 w-3" aria-hidden="true" />
        Sequence complete
      </span>
    );
  }
  if (status === "missing") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-800/60 bg-amber-950/40 px-2.5 py-1 text-[11px] font-medium text-amber-200">
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        Missing bills
      </span>
    );
  }
  if (status === "range-required") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1 text-[11px] font-medium text-slate-400">
        <Circle className="h-2.5 w-2.5 fill-slate-500 text-slate-500" aria-hidden="true" />
        Range required
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1 text-[11px] font-medium text-slate-400">
      <Circle className="h-2.5 w-2.5 text-slate-500" aria-hidden="true" />
      Not checked
    </span>
  );
}

function Metric({ label, value, tone = "default" }) {
  const valueClass =
    tone === "warn"
      ? "text-amber-200"
      : tone === "ok"
        ? "text-emerald-300"
        : "text-white";
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${valueClass}`}>
        {value}
      </div>
    </div>
  );
}

function TerminalBillControlCard({
  terminal,
  index,
  draft,
  report,
  recordedCount,
  saving,
  clientReady,
  expandedMissing,
  onToggleMissing,
  onDraftChange,
  onSave,
  onFindMissing,
}) {
  const preview = resolveRangePreview(draft);
  let status = "not-checked";
  if (report) {
    status = report.missingCount > 0 ? "missing" : "complete";
  } else if (!preview.valid) {
    status = "range-required";
  }

  const statusDotClass =
    status === "complete"
      ? "bg-emerald-400"
      : status === "missing"
        ? "bg-amber-400"
        : "bg-slate-500";

  const missingList = report?.missing || [];
  const showAllMissing = expandedMissing || missingList.length <= MISSING_PREVIEW_LIMIT;
  const visibleMissing = showAllMissing
    ? missingList
    : missingList.slice(0, MISSING_PREVIEW_LIMIT);

  const expectedDisplay = report
    ? report.expectedCount
    : preview.valid
      ? preview.expectedCount
      : "—";
  const recordedInRange = report ? report.enteredCount : "—";
  const missingDisplay = report ? report.missingCount : "—";

  return (
    <article
      className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4"
      aria-label={`${terminal.name} bill control`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${statusDotClass}`}
              aria-hidden="true"
            />
            <h4 className="truncate text-sm font-semibold tracking-wide text-white">
              {terminal.name}
            </h4>
          </div>
          <p className="mt-1 pl-4 text-xs text-slate-500">
            Terminal {String(index + 1).padStart(2, "0")}
            <span className="mx-1.5 text-slate-700">·</span>
            <span className="tabular-nums text-slate-300">
              {recordedCount} bill{recordedCount === 1 ? "" : "s"} recorded
            </span>
          </p>
        </div>
        <StatusBadge status={status} />
      </header>

      <div className="mt-4 rounded-xl border border-slate-800/80 bg-slate-900/40 p-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Bill range
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block min-w-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">
            Start
            <input
              type="text"
              inputMode="numeric"
              value={draft.startBillNumber}
              onChange={(event) =>
                onDraftChange({ startBillNumber: event.target.value })
              }
              className={RANGE_INPUT}
              placeholder="e.g. 101"
              aria-label={`${terminal.name} starting bill number`}
            />
          </label>
          <label className="block min-w-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">
            Last
            <input
              type="text"
              inputMode="numeric"
              value={draft.endBillNumber}
              onChange={(event) =>
                onDraftChange({ endBillNumber: event.target.value })
              }
              className={RANGE_INPUT}
              placeholder="e.g. 145"
              aria-label={`${terminal.name} last bill number`}
            />
          </label>
          <div className="flex min-w-0 flex-col justify-end rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
              Expected
            </div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-100">
              {expectedDisplay === "—"
                ? "—"
                : `${expectedDisplay} bill${expectedDisplay === 1 ? "" : "s"}`}
            </div>
          </div>
        </div>

        <div
          className="mt-3 flex items-center gap-3 text-xs tabular-nums text-slate-500"
          aria-hidden="true"
        >
          <span className="shrink-0 text-slate-300">
            {preview.start != null ? preview.start : "—"}
          </span>
          <span className="h-px flex-1 bg-slate-700" />
          <span className="shrink-0 text-slate-300">
            {preview.end != null ? preview.end : "—"}
          </span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl border border-slate-800/70 bg-slate-950/30 px-3 py-2.5">
        <Metric label="Expected" value={expectedDisplay} />
        <Metric label="Recorded" value={recordedInRange} />
        <Metric
          label="Missing"
          value={missingDisplay}
          tone={
            report
              ? report.missingCount > 0
                ? "warn"
                : "ok"
              : "default"
          }
        />
      </div>

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          className={`${BTN_SECONDARY} w-full sm:w-auto`}
          disabled={saving || !clientReady}
          onClick={onSave}
        >
          {saving ? "Saving…" : "Save range"}
        </button>
        <button
          type="button"
          className={`${BTN_PRIMARY} w-full sm:w-auto`}
          onClick={onFindMissing}
        >
          Find missing bills
        </button>
      </div>

      {report ? (
        <div
          className={`mt-4 rounded-xl border px-3 py-3 ${
            report.missingCount > 0
              ? "border-amber-900/50 bg-amber-950/20"
              : "border-emerald-900/40 bg-emerald-950/15"
          }`}
          role="status"
          aria-live="polite"
        >
          {report.missingCount > 0 ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-200/90">
                  Missing bills
                </p>
                <p className="text-xs tabular-nums text-amber-100/80">
                  {report.missingCount} of {report.expectedCount}
                </p>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {visibleMissing.map((billNo) => (
                  <span
                    key={billNo}
                    className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium tabular-nums text-amber-100"
                  >
                    {billNo}
                  </span>
                ))}
              </div>
              {missingList.length > MISSING_PREVIEW_LIMIT ? (
                <button
                  type="button"
                  onClick={onToggleMissing}
                  className="mt-2 text-xs font-medium text-amber-200 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
                >
                  {showAllMissing
                    ? "Show fewer"
                    : `View all ${missingList.length}`}
                </button>
              ) : null}
            </>
          ) : (
            <p className="inline-flex items-center gap-2 text-sm font-medium text-emerald-300">
              <Check className="h-4 w-4" aria-hidden="true" />
              No missing bills
            </p>
          )}
        </div>
      ) : null}
    </article>
  );
}

export default function TerminalBillGapChecker({
  clientId,
  businessDate,
  terminals = [],
  bills = [],
  onMessage,
  onError,
}) {
  const { user } = useAuth();
  const [rangesByTerminal, setRangesByTerminal] = useState({});
  const [drafts, setDrafts] = useState({});
  const [results, setResults] = useState({});
  const [savingId, setSavingId] = useState("");
  const [rangesError, setRangesError] = useState("");
  const [expandedMissingByTerminal, setExpandedMissingByTerminal] = useState(
    {}
  );
  const [moduleOpen, setModuleOpen] = useState(true);

  const activeTerminals = useMemo(
    () =>
      [...terminals]
        .filter((row) => row.isActive !== false && row.active !== false)
        .sort(compareBillingTerminals),
    [terminals]
  );

  const displayDate = formatIsoDate(businessDate, businessDate || "—");

  useEffect(() => {
    if (!clientId || !businessDate) {
      setRangesByTerminal({});
      return undefined;
    }
    setRangesError("");
    const q = query(
      collection(db, "external_terminal_bill_ranges"),
      where("clientId", "==", clientId),
      where("businessDate", "==", businessDate)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const next = {};
        snap.forEach((row) => {
          const data = { id: row.id, ...row.data() };
          if (data.terminalId) next[data.terminalId] = data;
        });
        setRangesByTerminal(next);
      },
      (reason) => {
        setRangesByTerminal({});
        setRangesError(reason?.message || "Failed to load bill ranges.");
      }
    );
    return () => unsub();
  }, [clientId, businessDate]);

  useEffect(() => {
    setDrafts({});
    setResults({});
    setExpandedMissingByTerminal({});
  }, [businessDate, clientId]);

  function getDraft(terminalId) {
    if (drafts[terminalId]) return drafts[terminalId];
    const saved = rangesByTerminal[terminalId];
    return {
      startBillNumber: saved?.startBillNumber
        ? String(saved.startBillNumber)
        : "",
      endBillNumber: saved?.endBillNumber ? String(saved.endBillNumber) : "",
    };
  }

  function updateDraft(terminalId, patch) {
    setDrafts((prev) => {
      const saved = rangesByTerminal[terminalId];
      const base = prev[terminalId] || {
        startBillNumber: saved?.startBillNumber
          ? String(saved.startBillNumber)
          : "",
        endBillNumber: saved?.endBillNumber
          ? String(saved.endBillNumber)
          : "",
      };
      return {
        ...prev,
        [terminalId]: {
          ...base,
          ...patch,
        },
      };
    });
  }

  function billsForTerminal(terminalId) {
    return bills.filter((bill) => bill.terminalId === terminalId);
  }

  async function saveRange(terminal) {
    if (!clientId || !businessDate || !terminal?.id) return;
    const draft = getDraft(terminal.id);
    const start = parseBillSequence(draft.startBillNumber);
    const end = parseBillSequence(draft.endBillNumber);
    onError?.("");
    if (start == null || end == null) {
      onError?.(
        "Enter whole-number start and last bill numbers for this terminal."
      );
      return;
    }
    if (end < start) {
      onError?.("Last bill number must be ≥ starting bill number.");
      return;
    }

    setSavingId(terminal.id);
    try {
      const id = externalTerminalBillRangeDocId({
        clientId,
        businessDate,
        terminalId: terminal.id,
      });
      const existing = rangesByTerminal[terminal.id];
      const nowMs = Number(new Date());
      await setDoc(
        doc(db, "external_terminal_bill_ranges", id),
        {
          clientId,
          businessDate,
          terminalId: terminal.id,
          terminalNameSnapshot: terminal.name || "",
          startBillNumber: String(start),
          endBillNumber: String(end),
          startSeq: start,
          endSeq: end,
          updatedAt: serverTimestamp(),
          updatedAtMs: nowMs,
          updatedBy: user?.uid || null,
          ...(existing
            ? {}
            : {
                createdAt: serverTimestamp(),
                createdAtMs: nowMs,
                createdBy: user?.uid || null,
              }),
        },
        { merge: true }
      );
      setDrafts((prev) => ({
        ...prev,
        [terminal.id]: {
          startBillNumber: String(start),
          endBillNumber: String(end),
        },
      }));
      onMessage?.(
        `Saved ${terminal.name} range ${start}–${end} for ${businessDate}.`
      );
    } catch (reason) {
      onError?.(reason?.message || "Failed to save bill range.");
    } finally {
      setSavingId("");
    }
  }

  function findMissing(terminal) {
    const draft = getDraft(terminal.id);
    onError?.("");
    try {
      const report = findMissingBillNumbers({
        startBillNumber: draft.startBillNumber,
        endBillNumber: draft.endBillNumber,
        bills: billsForTerminal(terminal.id),
      });
      setResults((prev) => ({ ...prev, [terminal.id]: report }));
      if (report.missingCount === 0) {
        onMessage?.(
          `${terminal.name}: all ${report.expectedCount} bills from ${report.start}–${report.end} are entered.`
        );
      } else {
        onMessage?.(
          `${terminal.name}: ${report.missingCount} missing of ${report.expectedCount} (${report.start}–${report.end}).`
        );
      }
    } catch (reason) {
      setResults((prev) => {
        const next = { ...prev };
        delete next[terminal.id];
        return next;
      });
      onError?.(reason?.message || "Could not check missing bills.");
    }
  }

  const checkedCount = activeTerminals.filter(
    (terminal) => results[terminal.id]
  ).length;
  const missingTerminalCount = activeTerminals.filter(
    (terminal) => (results[terminal.id]?.missingCount || 0) > 0
  ).length;

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
      <button
        type="button"
        onClick={() => setModuleOpen((open) => !open)}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-900/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/50 sm:px-5"
        aria-expanded={moduleOpen}
        aria-controls="todays-bill-control-panel"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h3 className="text-base font-semibold text-white">
              Today&apos;s Bill Control
            </h3>
            <span className="rounded-md border border-slate-800 bg-slate-950/70 px-2 py-0.5 text-[11px] tabular-nums text-slate-300">
              {displayDate}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {activeTerminals.length
              ? `${activeTerminals.length} terminal${
                  activeTerminals.length === 1 ? "" : "s"
                }${
                  checkedCount
                    ? ` · ${checkedCount} checked`
                    : " · not checked yet"
                }${
                  missingTerminalCount
                    ? ` · ${missingTerminalCount} with gaps`
                    : ""
                }`
              : "No active terminals"}
          </p>
        </div>
        <ChevronDown
          className={`h-5 w-5 shrink-0 text-slate-400 transition-transform duration-200 ${
            moduleOpen ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        />
      </button>

      {moduleOpen ? (
        <div
          id="todays-bill-control-panel"
          className="space-y-3 border-t border-slate-800 px-4 py-4 sm:px-5"
        >
          {rangesError ? (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              {rangesError}
            </div>
          ) : null}

          {!activeTerminals.length ? (
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3 text-sm text-slate-400">
              Add an active terminal in Setup before checking bill number gaps.
            </div>
          ) : (
            activeTerminals.map((terminal, index) => {
              const draft = getDraft(terminal.id);
              const report = results[terminal.id];
              const recordedCount = billsForTerminal(terminal.id).filter(
                (bill) => bill.voided !== true
              ).length;

              return (
                <TerminalBillControlCard
                  key={terminal.id}
                  terminal={terminal}
                  index={index}
                  draft={draft}
                  report={report}
                  recordedCount={recordedCount}
                  saving={savingId === terminal.id}
                  clientReady={Boolean(clientId)}
                  expandedMissing={Boolean(
                    expandedMissingByTerminal[terminal.id]
                  )}
                  onToggleMissing={() =>
                    setExpandedMissingByTerminal((prev) => ({
                      ...prev,
                      [terminal.id]: !prev[terminal.id],
                    }))
                  }
                  onDraftChange={(patch) => updateDraft(terminal.id, patch)}
                  onSave={() => saveRange(terminal)}
                  onFindMissing={() => findMissing(terminal)}
                />
              );
            })
          )}
        </div>
      ) : null}
    </section>
  );
}
