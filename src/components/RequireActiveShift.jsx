import { Clock3 } from "lucide-react";
import { useShift } from "../context/shift-context";

export default function RequireActiveShift({ children }) {
  const { activeShift, loadingShift, shiftError } = useShift();

  if (loadingShift) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center p-6">
        <div className="flex flex-col items-center gap-2 text-slate-300">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
          <span className="text-sm text-slate-400">Checking active shift…</span>
        </div>
      </div>
    );
  }

  if (shiftError) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <div className="rounded-2xl border border-rose-800/60 bg-rose-950/30 p-6 text-center">
          <h2 className="text-lg font-semibold text-rose-200">Shift Unavailable</h2>
          <p className="mt-2 text-sm text-rose-100/80">{shiftError}</p>
        </div>
      </div>
    );
  }

  if (!activeShift || activeShift.status !== "OPEN") {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-lg items-center p-6">
        <div className="w-full rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center shadow-xl">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-amber-800/50 bg-amber-950/40 text-amber-300">
            <Clock3 size={26} />
          </div>
          <h2 className="mt-5 text-xl font-semibold text-white">
            No active shift found
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            Please open a shift from the status bar above to proceed. Operational
            entries are locked to the open shift business date.
          </p>
        </div>
      </div>
    );
  }

  return children;
}
