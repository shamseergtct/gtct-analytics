import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { Check, X } from "lucide-react";
import { db } from "../../firebase";
import { useAuth } from "../../context/AuthContext";
import { formatMoney } from "../../utils/money.js";
import {
  DELIVERY_BILL_SUBMISSIONS,
  SUBMISSION_STATUS,
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
      where("status", "==", SUBMISSION_STATUS.PENDING),
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

  const title = useMemo(() => {
    if (!count) return "";
    return `${count} delivery bill${count === 1 ? "" : "s"} waiting for approval`;
  }, [count]);

  function handleApprove(row) {
    if (!row?.id) return;
    onReviewSubmission?.(row);
    onMessage?.(
      `Review bill ${row.billNumber} on ${row.terminalNameSnapshot || "terminal"} — edit then Save to approve.`
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
    <div className="rounded-2xl border border-amber-800/60 bg-amber-950/25 p-4 shadow-lg">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-amber-100">
            🔔 {title}
          </div>
          <p className="mt-1 text-xs text-amber-200/80">
            Approve opens the terminal form so you can edit amount, customer,
            payment mode, and delivery charge before saving. Delivery boys
            cannot change a bill after submit until it is voided.
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {rows.map((row) => {
          const busy = busyId === row.id;
          const paymentLabel = externalPaymentModeLabel(row);
          return (
            <div
              key={row.id}
              className="rounded-xl border border-slate-800 bg-slate-950/70 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="text-sm font-semibold text-white">
                    Bill {row.billNumber} · {row.terminalNameSnapshot || "—"}
                  </div>
                  <div className="text-xs text-slate-400">
                    {row.deliveryBoyNameSnapshot || "Delivery"} ·{" "}
                    {paymentLabel}
                    {row.customerName ? ` · ${row.customerName}` : ""}
                  </div>
                  <div className="text-sm text-slate-200">
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
                      <span className="ml-1 text-xs text-slate-500">
                        {currency}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleApprove(row)}
                    className={`${BTN_PRIMARY} disabled:opacity-60`}
                  >
                    <Check size={15} />
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleReject(row)}
                    className={`${BTN_SECONDARY} disabled:opacity-60`}
                  >
                    <X size={15} />
                    Reject
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
