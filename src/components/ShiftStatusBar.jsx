import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useClient } from "../context/ClientContext";
import { useShift } from "../context/shift-context";
import { useEstimatedLiquidity } from "../hooks/useEstimatedBankBalance.js";
import DateInput from "./DateInput.jsx";
import { formatIsoDate } from "../utils/dateFormat.js";

function todayYYYYMMDD() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export default function ShiftStatusBar() {
  const { role } = useAuth();
  const { activeClientId } = useClient();
  const {
    activeShift,
    loadingShift,
    openShift,
    closeShiftWithoutZReport,
    updateActiveShiftBusinessDate,
  } = useShift();

  const [openModalOpen, setOpenModalOpen] = useState(false);
  const [closeModalOpen, setCloseModalOpen] = useState(false);
  const [businessDate, setBusinessDate] = useState(todayYYYYMMDD());
  const [saving, setSaving] = useState(false);
  const [updatingDate, setUpdatingDate] = useState(false);
  const [dateError, setDateError] = useState("");
  const [error, setError] = useState("");

  const { floatingCash, loading: loadingPreviousCash } = useEstimatedLiquidity(
    openModalOpen ? activeClientId : null,
    businessDate
  );

  const canManageShift = role === "admin" || role === "super_admin";
  const shiftOpen = activeShift?.status === "OPEN";

  useEffect(() => {
    if (!openModalOpen) return;
    setBusinessDate(todayYYYYMMDD());
    setError("");
  }, [openModalOpen]);

  if (!canManageShift || !activeClientId) return null;

  async function handleOpenShift(event) {
    event.preventDefault();
    setError("");
    if (floatingCash == null) {
      setError("Previous cash balance is still loading. Try again in a moment.");
      return;
    }
    const floatAmount = Number(floatingCash);
    if (!Number.isFinite(floatAmount) || floatAmount < 0) {
      setError("Opening float must be zero or greater.");
      return;
    }
    if (!String(businessDate || "").trim()) {
      setError("Business date is required.");
      return;
    }

    setSaving(true);
    try {
      await openShift({
        openingFloat: floatAmount,
        businessDate: String(businessDate).trim(),
      });
      setOpenModalOpen(false);
    } catch (reason) {
      setError(reason?.message || "Failed to open shift.");
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmClose() {
    setError("");
    setSaving(true);
    try {
      await closeShiftWithoutZReport();
      setCloseModalOpen(false);
    } catch (reason) {
      setError(reason?.message || "Failed to close shift.");
    } finally {
      setSaving(false);
    }
  }

  async function handleBusinessDateChange(nextDate) {
    const cleanDate = String(nextDate || "").trim();
    if (!cleanDate || cleanDate === activeShift?.businessDate) return;

    setDateError("");
    setUpdatingDate(true);
    try {
      await updateActiveShiftBusinessDate(cleanDate);
    } catch (reason) {
      setDateError(reason?.message || "Failed to update business date.");
    } finally {
      setUpdatingDate(false);
    }
  }

  return (
    <>
      <div className="border-b border-slate-800/80 bg-slate-900/70">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            {loadingShift ? (
              <span className="rounded-full border border-slate-700 bg-slate-800/80 px-3 py-1 text-xs font-semibold text-slate-300">
                Checking shift…
              </span>
            ) : shiftOpen ? (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-700/60 bg-emerald-950/50 px-3 py-1 text-xs font-semibold text-emerald-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  Shift Open
                </span>
                <label className="inline-flex items-center gap-2 text-sm text-slate-300">
                  <span className="whitespace-nowrap">Business date</span>
                  <DateInput
                    value={activeShift.businessDate || ""}
                    disabled={updatingDate}
                    onChange={(event) =>
                      handleBusinessDateChange(event.target.value)
                    }
                    aria-label="Change shift business date"
                    title={
                      formatIsoDate(activeShift.businessDate) ||
                      activeShift.businessDate
                    }
                    className="h-8 w-[138px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm font-semibold text-white disabled:opacity-60"
                  />
                </label>
                {updatingDate ? (
                  <span className="text-xs text-slate-400">Updating…</span>
                ) : null}
                {dateError ? (
                  <span className="max-w-md text-xs text-rose-300">{dateError}</span>
                ) : null}
              </>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-600 bg-slate-800/80 px-3 py-1 text-xs font-semibold text-slate-300">
                <span className="h-1.5 w-1.5 rounded-full bg-rose-400/80" />
                Shift Closed
              </span>
            )}
          </div>

          {shiftOpen ? (
            <button
              type="button"
              onClick={() => {
                setError("");
                setCloseModalOpen(true);
              }}
              className="rounded-lg border border-rose-800/70 bg-rose-950/40 px-3 py-1.5 text-sm font-semibold text-rose-100 transition-colors hover:bg-rose-900/50"
            >
              Close Shift
            </button>
          ) : (
            <button
              type="button"
              disabled={loadingShift}
              onClick={() => setOpenModalOpen(true)}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              Open New Shift
            </button>
          )}
        </div>
      </div>

      {openModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Open New Shift</h2>
              <button
                type="button"
                onClick={() => setOpenModalOpen(false)}
                className="rounded-lg border border-slate-700 p-2 text-slate-400 hover:text-white"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            {error ? (
              <div className="mb-3 rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
                {error}
              </div>
            ) : null}

            <form onSubmit={handleOpenShift} className="space-y-4">
              <label className="block text-sm text-slate-300">
                Business Date
                <DateInput
                  required
                  value={businessDate}
                  onChange={(event) => setBusinessDate(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-white"
                />
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setOpenModalOpen(false)}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || floatingCash == null}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {saving
                    ? "Opening…"
                    : floatingCash == null || loadingPreviousCash
                      ? "Loading…"
                      : "Open Shift"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {closeModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Close Shift</h2>
              <button
                type="button"
                onClick={() => setCloseModalOpen(false)}
                className="rounded-lg border border-slate-700 p-2 text-slate-400 hover:text-white"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            {error ? (
              <div className="mb-3 rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
                {error}
              </div>
            ) : null}

            <p className="text-sm leading-relaxed text-slate-300">
              Are you sure you want to close this shift? Ensure all Z-Reports for
              this shift have been entered.
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCloseModalOpen(false)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleConfirmClose}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
              >
                {saving ? "Closing…" : "Close Shift"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
