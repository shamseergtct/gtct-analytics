/**
 * Compact prev/next pager for list sections.
 * Hide when total fits on one page (unless alwaysShow).
 */
export default function ListPagination({
  page,
  pageCount,
  total,
  from,
  to,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  alwaysShow = false,
  className = "",
}) {
  if (!alwaysShow && (!total || pageCount <= 1)) return null;

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 px-3 py-2.5 text-xs text-slate-400 ${className}`}
    >
      <span className="tabular-nums">
        {total === 0 ? "0 items" : `${from}–${to} of ${total}`}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!hasPrev}
          onClick={onPrev}
          className="min-h-9 rounded-lg border border-slate-700 px-3 font-semibold text-slate-200 disabled:opacity-40"
        >
          Prev
        </button>
        <span className="min-w-[4.5rem] text-center tabular-nums text-slate-300">
          {page}/{pageCount}
        </span>
        <button
          type="button"
          disabled={!hasNext}
          onClick={onNext}
          className="min-h-9 rounded-lg border border-slate-700 px-3 font-semibold text-slate-200 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
