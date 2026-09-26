import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Bell, ChevronRight, X } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useClient } from "../context/ClientContext";
import { useReopenedEodReports } from "../hooks/useReopenedEodReports.js";
import { formatIsoDate } from "../utils/dateFormat.js";

function eodPathForDate(date) {
  const clean = String(date || "").slice(0, 10);
  return `/reports/end-of-day?date=${encodeURIComponent(clean)}`;
}

export default function NotificationPanel() {
  const { role } = useAuth();
  const { activeClientId } = useClient();
  const { reports, count } = useReopenedEodReports(activeClientId);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const canSee =
    role === "admin" || role === "super_admin" || role === "partner";

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!canSee) return null;

  return (
    <div ref={rootRef} className="relative print:hidden">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="relative inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-800 bg-slate-900 text-slate-200 transition-colors hover:bg-slate-800 hover:text-white"
        aria-label={open ? "Close notifications" : "Open notifications"}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Bell size={18} />
        {count > 0 ? (
          <span className="absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
            {count > 9 ? "9+" : count}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/50"
        >
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-white">Notifications</p>
              <p className="text-xs text-slate-400">
                {count === 0
                  ? "You're all caught up"
                  : count === 1
                    ? "1 item needs attention"
                    : `${count} items need attention`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg border border-slate-700 p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              aria-label="Close notifications"
            >
              <X size={14} />
            </button>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {!activeClientId ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">
                Select a shop to see notifications.
              </p>
            ) : count === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">
                No notifications right now.
              </p>
            ) : (
              <ul className="divide-y divide-slate-800">
                {reports.map((report) => {
                  const date = String(report.date || "").slice(0, 10);
                  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
                  return (
                    <li key={report.id}>
                      <Link
                        to={eodPathForDate(date)}
                        onClick={() => setOpen(false)}
                        className="group flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-800/80"
                      >
                        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-amber-700/50 bg-amber-950/50 text-amber-300">
                          <AlertTriangle size={14} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-amber-100 group-hover:text-amber-50">
                            End of Day re-opened
                          </span>
                          <span className="mt-0.5 block text-xs text-slate-400 group-hover:text-slate-300">
                            {formatIsoDate(date) || date} — open End of Day to
                            review and close again.
                          </span>
                        </span>
                        <ChevronRight
                          size={16}
                          className="mt-1 shrink-0 text-slate-500 group-hover:text-slate-300"
                        />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
