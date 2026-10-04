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
import { db } from "../../firebase";
import { useAuth } from "../../context/AuthContext";
import {
  compareBillingTerminals,
  externalTerminalBillRangeDocId,
  findMissingBillNumbers,
  parseBillSequence,
} from "../../utils/externalSales.js";
const INLINE_INPUT =
  "h-9 w-[5.5rem] shrink-0 rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm tabular-nums text-white outline-none placeholder:text-slate-600 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";
const INLINE_BTN_SECONDARY =
  "inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50";
const INLINE_BTN_PRIMARY =
  "inline-flex h-9 shrink-0 items-center justify-center rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50";

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

  const activeTerminals = useMemo(
    () =>
      [...terminals]
        .filter((row) => row.isActive !== false && row.active !== false)
        .sort(compareBillingTerminals),
    [terminals]
  );

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

  if (!activeTerminals.length) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-400">
        Add an active terminal in Setup before checking bill number gaps.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <div>
        <h3 className="text-sm font-semibold text-white">
          Today&apos;s bill range &amp; missing bills
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          Enter each terminal&apos;s starting and last bill number for{" "}
          <span className="text-slate-300">{businessDate || "—"}</span>, then find
          numbers not yet entered (voided bills count as missing).
        </p>
      </div>

      {rangesError ? (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {rangesError}
        </div>
      ) : null}

      <div className="space-y-2">
        {activeTerminals.map((terminal) => {
          const draft = getDraft(terminal.id);
          const report = results[terminal.id];
          const enteredOnDate = billsForTerminal(terminal.id).filter(
            (bill) => bill.voided !== true
          ).length;

          return (
            <div
              key={terminal.id}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2"
            >
              <div className="flex flex-nowrap items-center gap-2 overflow-x-auto">
                <div className="min-w-[6.5rem] shrink-0 text-sm font-medium text-white">
                  {terminal.name}
                </div>
                <div className="shrink-0 whitespace-nowrap text-[11px] text-slate-500">
                  Entered: {enteredOnDate}
                </div>
                <label className="flex shrink-0 items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                  Start
                  <input
                    type="text"
                    inputMode="numeric"
                    value={draft.startBillNumber}
                    onChange={(event) =>
                      updateDraft(terminal.id, {
                        startBillNumber: event.target.value,
                      })
                    }
                    className={INLINE_INPUT}
                    placeholder="101"
                    aria-label={`${terminal.name} starting bill number`}
                  />
                </label>
                <label className="flex shrink-0 items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                  Last
                  <input
                    type="text"
                    inputMode="numeric"
                    value={draft.endBillNumber}
                    onChange={(event) =>
                      updateDraft(terminal.id, {
                        endBillNumber: event.target.value,
                      })
                    }
                    className={INLINE_INPUT}
                    placeholder="145"
                    aria-label={`${terminal.name} last bill number`}
                  />
                </label>
                <button
                  type="button"
                  className={INLINE_BTN_SECONDARY}
                  disabled={savingId === terminal.id || !clientId}
                  onClick={() => saveRange(terminal)}
                >
                  {savingId === terminal.id ? "Saving…" : "Save range"}
                </button>
                <button
                  type="button"
                  className={INLINE_BTN_PRIMARY}
                  onClick={() => findMissing(terminal)}
                >
                  Find missing
                </button>
              </div>

              {report ? (
                <div className="mt-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm">
                  <div className="text-slate-300">
                    Range {report.start}–{report.end}:{" "}
                    <span className="text-white">
                      {report.enteredCount}/{report.expectedCount}
                    </span>{" "}
                    entered
                    {report.missingCount > 0 ? (
                      <>
                        {" "}
                        ·{" "}
                        <span className="text-amber-300">
                          {report.missingCount} missing
                        </span>
                      </>
                    ) : (
                      <>
                        {" "}
                        · <span className="text-emerald-300">none missing</span>
                      </>
                    )}
                  </div>
                  {report.missingCount > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {report.missing.map((billNo) => (
                        <span
                          key={billNo}
                          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-200"
                        >
                          {billNo}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
