import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { Bell, Check, ChevronDown, Pencil, X } from "lucide-react";
import { db } from "../../firebase";
import { useAuth } from "../../context/AuthContext";
import { formatMoney } from "../../utils/money.js";
import {
  DELIVERY_BILL_SUBMISSIONS,
  SUBMISSION_REVIEW_STATUSES,
  isEditedSubmission,
  rejectDeliveryBillSubmission,
} from "../../utils/deliveryBillSubmissions.js";
import { externalPaymentModeLabel } from "../../utils/externalSales.js";
import { BTN_PRIMARY, BTN_SECONDARY } from "./externalSalesUi.js";

export default function DeliveryBillApprovals({
  clientId,
  businessDate,
  currency = "",
  currencyDecimals = 3,
  onMessage,
  onError,
  onReviewSubmission,
}) {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const date = String(businessDate || "").slice(0, 10);

  useEffect(() => {
    if (!clientId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setRows([]);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const q = query(
      collection(db, DELIVERY_BILL_SUBMISSIONS),
      where("clientId", "==", clientId),
      where("businessDate", "==", date),
      where("status", "in", SUBMISSION_REVIEW_STATUSES),
      orderBy("createdAtMs", "asc")
    );

    return onSnapshot(
      q,
      (snap) => {
        setRows(snap.docs.map((item) => ({ id: item.id, ...item.data() })));
        setLoading(false);
      },
      (reason) => {
        console.error("delivery_bill_submissions listener failed:", reason);
        setRows([]);
        setLoading(false);
        onError?.(
          reason?.message ||
            "Failed to load delivery bill approvals. A Firestore index may be required."
        );
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- parent onError is often inline
  }, [clientId, date]);

  const count = rows.length;
  const editedCount = useMemo(
    () => rows.filter((row) => isEditedSubmission(row.status)).length,
    [rows]
  );

  useEffect(() => {
    if (!count) setOpen(false);
  }, [count]);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const title = useMemo(() => {
    if (!count) return "";
    if (editedCount && editedCount === count) {
      return `${count} edited`;
    }
    if (editedCount) {
      return `${count} pending · ${editedCount} edited`;
    }
    return `${count} pending`;
  }, [count, editedCount]);

  function handleApprove(row) {
    if (!row?.id) return;
    setOpen(false);
    onReviewSubmission?.(row);
    const edited = isEditedSubmission(row.status);
    onMessage?.(
      edited
        ? `Re-check edited bill ${row.billNumber} on ${row.terminalNameSnapshot || "terminal"} — edit then Save to approve.`
        : `Review bill ${row.billNumber} on ${row.terminalNameSnapshot || "terminal"} — edit then Save to approve.`
    );
  }

  async function handleReject(row) {
    if (!user?.uid || !row?.id) return;
    const ok = window.confirm(
      `Reject bill ${row.billNumber} from ${row.deliveryBoyNameSnapshot || "delivery boy"}?\n\nIt will not become a terminal bill.`
    );
    if (!ok) return;
    setBusyId(row.id);
    onError?.("");
    try {
      await rejectDeliveryBillSubmission({
        submissionId: row.id,
        userUid: user.uid,
        reason: "Rejected by admin.",
      });
      onMessage?.(`Rejected bill ${row.billNumber}.`);
    } catch (error) {
      onError?.(error?.message || "Failed to reject bill.");
    } finally {
      setBusyId("");
    }
  }

  if (loading && !count) return null;
  if (!count) return null;

  return (
    <div ref={rootRef} className="relative z-40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-sm transition-colors ${
          open
            ? "border-amber-500/70 bg-amber-500/20 text-amber-50"
            : "border-amber-700/70 bg-amber-950/80 text-amber-100 hover:border-amber-500/80 hover:bg-amber-900/70"
        }`}
      >
        <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center">
          <Bell size={14} className="text-amber-300" />
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-slate-950">
            {count > 9 ? "9+" : count}
          </span>
        </span>
        <span className="truncate">
          {title} delivery approval{count === 1 ? "" : "s"}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-amber-300 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Delivery bills waiting for approval"
          className="absolute left-0 right-0 top-full z-50 mt-2 w-[min(100vw-2rem,28rem)] max-w-[calc(100vw-2rem)] rounded-2xl border border-amber-800/70 bg-slate-950 p-3 shadow-2xl sm:left-0 sm:right-auto"
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-amber-100">
                Waiting for approval
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-amber-200/70">
                New and edited bills stay here until you approve or reject.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              aria-label="Close approvals"
            >
              <X size={16} />
            </button>
          </div>

          <div className="max-h-72 space-y-2 overflow-y-auto overscroll-y-contain pr-0.5">
            {rows.map((row) => {
              const busy = busyId === row.id;
              const paymentLabel = externalPaymentModeLabel(row);
              const edited = isEditedSubmission(row.status);
              return (
                <div
                  key={row.id}
                  className={`rounded-xl border p-2.5 ${
                    edited
                      ? "border-sky-800/70 bg-sky-950/40"
                      : "border-slate-800 bg-slate-900/80"
                  }`}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-semibold text-white">
                        Bill {row.billNumber} ·{" "}
                        {row.terminalNameSnapshot || "—"}
                      </div>
                      {edited ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-sky-700/60 bg-sky-950/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-200">
                          <Pencil size={10} />
                          Edited
                        </span>
                      ) : (
                        <span className="rounded-full border border-amber-800/50 bg-amber-950/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200">
                          New
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-slate-400">
                      {row.deliveryBoyNameSnapshot || "Delivery"} ·{" "}
                      {paymentLabel}
                      {row.customerName ? ` · ${row.customerName}` : ""}
                    </div>
                    <div className="text-xs text-slate-200">
                      Amount{" "}
                      <span className="font-semibold text-white">
                        {formatMoney(row.billAmount, currencyDecimals)}
                      </span>
                      {Number(row.deliveryCharge) > 0 ? (
                        <>
                          {" "}
                          · Charge{" "}
                          {formatMoney(row.deliveryCharge, currencyDecimals)}
                        </>
                      ) : null}
                      {currency ? (
                        <span className="ml-1 text-[10px] text-slate-500">
                          {currency}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleApprove(row)}
                      className={`${BTN_PRIMARY} !px-2.5 !py-1.5 text-xs disabled:opacity-60`}
                    >
                      <Check size={14} />
                      {edited ? "Re-check" : "Approve"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleReject(row)}
                      className={`${BTN_SECONDARY} !px-2.5 !py-1.5 text-xs disabled:opacity-60`}
                    >
                      <X size={14} />
                      Reject
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
