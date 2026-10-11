import { ATTENTION_STATUSES, ATTENTION_STATUS_META } from "../../utils/inventoryDailyReview.js";
import { formatMoney } from "../../utils/money.js";

const STATUS_BTN = {
  ENOUGH:
    "border-emerald-700/70 bg-emerald-950/40 text-emerald-100 data-[active=true]:bg-emerald-600 data-[active=true]:text-slate-950 data-[active=true]:border-emerald-400",
  LOW: "border-amber-700/70 bg-amber-950/40 text-amber-100 data-[active=true]:bg-amber-500 data-[active=true]:text-slate-950 data-[active=true]:border-amber-300",
  URGENT:
    "border-orange-700/70 bg-orange-950/40 text-orange-100 data-[active=true]:bg-orange-500 data-[active=true]:text-slate-950 data-[active=true]:border-orange-300",
  VERY_URGENT:
    "border-rose-700/70 bg-rose-950/40 text-rose-100 data-[active=true]:bg-rose-500 data-[active=true]:text-white data-[active=true]:border-rose-300",
};

export default function ChecklistItemCard({
  item,
  draft,
  saveState,
  currencyDecimals = 3,
  onStatus,
  onQtyChange,
  onNotesChange,
  onSave,
  completed = false,
}) {
  const status = draft?.attentionStatus || "";
  const pending = saveState === "saving";
  const saved = saveState === "saved";
  const failed = saveState === "error";

  return (
    <article
      className={`rounded-2xl border p-3.5 ${
        completed
          ? "border-emerald-900/50 bg-emerald-950/15"
          : "border-slate-800 bg-slate-900/50"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-white">
            {item.itemName || "—"}
          </h3>
          <p className="mt-0.5 text-xs tabular-nums text-slate-400">
            Code {item.itemCode || "—"}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            On hand (info)
          </div>
          <div className="text-lg font-semibold tabular-nums text-sky-200">
            {formatMoney(item.currentStock, currencyDecimals)}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {ATTENTION_STATUSES.map((key) => {
          const meta = ATTENTION_STATUS_META[key];
          return (
            <button
              key={key}
              type="button"
              disabled={pending}
              data-active={status === key ? "true" : "false"}
              onClick={() => onStatus(key)}
              className={`min-h-12 rounded-xl border px-2 text-sm font-semibold transition disabled:opacity-50 ${STATUS_BTN[key]}`}
            >
              {meta.label}
            </button>
          );
        })}
      </div>

      <div className="mt-3 grid gap-2">
        <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
          Needed qty
          {status && status !== "ENOUGH" ? (
            <span className="text-rose-300"> (required)</span>
          ) : (
            <span className="text-slate-600"> (optional)</span>
          )}
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            disabled={pending}
            value={draft?.requestedQty ?? ""}
            onChange={(e) => onQtyChange(e.target.value)}
            className={`mt-1 w-full rounded-xl border bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-sky-500 ${
              status && status !== "ENOUGH" && !(Number(draft?.requestedQty) > 0)
                ? "border-rose-700"
                : "border-slate-700"
            }`}
            placeholder="0"
          />
        </label>
        <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
          Notes (optional)
          <input
            type="text"
            disabled={pending}
            value={draft?.notes ?? ""}
            onChange={(e) => onNotesChange(e.target.value)}
            maxLength={500}
            className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-sky-500"
            placeholder="Short note"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="text-xs">
          {pending ? (
            <span className="text-sky-300">Saving…</span>
          ) : failed ? (
            <span className="text-rose-300">Save failed — values kept</span>
          ) : saved || completed ? (
            <span className="text-emerald-300">Saved</span>
          ) : status ? (
            <span className="text-amber-200">Unsaved changes</span>
          ) : (
            <span className="text-slate-500">Not reviewed</span>
          )}
        </div>
        <button
          type="button"
          disabled={pending || !status}
          onClick={onSave}
          className="min-h-11 rounded-xl bg-sky-500 px-4 text-sm font-semibold text-slate-950 disabled:opacity-40"
        >
          {pending ? "Saving…" : completed ? "Update" : "Save review"}
        </button>
      </div>
    </article>
  );
}
