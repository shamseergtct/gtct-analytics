import DateInput from "../DateInput.jsx";
import {
  REPORT_RANGE_PRESETS,
  formatReportRangeLabel,
} from "../../utils/reportDateRange.js";

export default function DateRangeToolbar({
  preset,
  onPresetChange,
  fromDate,
  toDate,
  onFromChange,
  onToChange,
  onRefresh,
  loading,
}) {
  const isCustom = preset === "custom";

  return (
    <div className="flex flex-wrap items-end gap-3 print:hidden">
      <div className="flex flex-wrap gap-1.5 rounded-xl border border-slate-800 bg-slate-950/60 p-1">
        {REPORT_RANGE_PRESETS.map((item) => {
          const active = preset === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onPresetChange(item.key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-blue-600 text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {isCustom ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-medium uppercase tracking-wider text-slate-400">
            From
            <DateInput
              value={fromDate}
              onChange={(event) => onFromChange(event.target.value)}
              className="mt-1 h-10 w-[150px] rounded-lg border border-slate-700 bg-slate-950 text-sm text-white"
            />
          </label>
          <label className="text-xs font-medium uppercase tracking-wider text-slate-400">
            To
            <DateInput
              value={toDate}
              onChange={(event) => onToChange(event.target.value)}
              className="mt-1 h-10 w-[150px] rounded-lg border border-slate-700 bg-slate-950 text-sm text-white"
            />
          </label>
        </div>
      ) : (
        <p className="pb-2 text-sm text-slate-400">
          {formatReportRangeLabel(fromDate, toDate)}
        </p>
      )}

      {onRefresh ? (
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="h-10 rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      ) : null}
    </div>
  );
}
