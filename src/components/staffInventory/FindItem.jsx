import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { formatMoney } from "../../utils/money.js";
import { ATTENTION_STATUS_META } from "../../utils/inventoryDailyReview.js";

function matchesQuery(item, rawQuery) {
  const q = String(rawQuery || "")
    .trim()
    .toLowerCase();
  if (!q) return true;
  const name = String(item.itemName || "").toLowerCase();
  const code = String(item.itemCode || "").toLowerCase();
  const barcode = String(item.barcode || "").toLowerCase();
  return name.includes(q) || code.includes(q) || barcode.includes(q);
}

export default function FindItem({
  items,
  loadingItems,
  currencyDecimals,
  lineByItemId,
  onOpenReview,
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    return items
      .filter((item) => matchesQuery(item, query))
      .sort((a, b) =>
        String(a.itemName || "").localeCompare(String(b.itemName || ""))
      );
  }, [items, query]);

  return (
    <div className="space-y-4">
      <label className="relative block">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, code, or barcode"
          className="w-full rounded-2xl border border-slate-700 bg-slate-900 py-3.5 pl-11 pr-3 text-base text-white outline-none focus:border-sky-500"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>

      {loadingItems ? (
        <div className="rounded-2xl border border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
          Loading items…
        </div>
      ) : !filtered.length ? (
        <div className="rounded-2xl border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
          {query.trim() ? "No items match that search." : "No inventory items."}
        </div>
      ) : (
        <ul className="space-y-2.5">
          {filtered.map((item) => {
            const line = lineByItemId?.get(item.id);
            const statusMeta = line?.attentionStatus
              ? ATTENTION_STATUS_META[line.attentionStatus]
              : null;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onOpenReview?.(item)}
                  className="flex w-full items-start justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/50 p-3.5 text-left transition hover:border-sky-700"
                >
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-white">
                      {item.itemName || "—"}
                    </div>
                    <div className="mt-0.5 text-xs tabular-nums text-slate-400">
                      {item.itemCode || "—"}
                      {item.barcode
                        ? ` · ${item.barcode}`
                        : ""}
                    </div>
                    {statusMeta ? (
                      <div
                        className={`mt-1 text-xs font-medium ${statusMeta.textClass}`}
                      >
                        Today: {statusMeta.label}
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-slate-500">
                        Not reviewed today
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[10px] uppercase tracking-wide text-slate-500">
                      On hand
                    </div>
                    <div className="text-base font-semibold tabular-nums text-sky-200">
                      {formatMoney(item.currentStock, currencyDecimals)}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
