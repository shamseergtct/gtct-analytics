import { useEffect, useRef } from "react";
import { ScanBarcode } from "lucide-react";
import { getItemBaseCode, getItemBarcode, money } from "../salesHelpers.js";

/**
 * Primary barcode / product search control for Retail POS.
 * Scanner behavior (Enter → exact code add) is owned by parent handlers.
 */
export default function RetailBarcodeSearch({
  search,
  setSearch,
  setSelectedItemId,
  searchRef,
  filteredItems,
  selectedItemId,
  onSearchKeyDown,
  onSelectResult,
  loadingItems,
  saving,
  activeIndex,
  setActiveIndex,
  noMatch,
}) {
  const listRef = useRef(null);

  useEffect(() => {
    setActiveIndex(-1);
  }, [search, setActiveIndex]);

  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(
      `#retail-result-${filteredItems[activeIndex]?.id}`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filteredItems]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <ScanBarcode
          size={20}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-blue-400"
          aria-hidden
        />
        <input
          ref={searchRef}
          value={search}
          disabled={saving}
          onChange={(e) => {
            setSearch(e.target.value);
            setSelectedItemId("");
          }}
          onKeyDown={onSearchKeyDown}
          className="h-14 w-full rounded-xl border border-slate-700 bg-slate-950 pl-11 pr-20 text-[15px] font-mono text-slate-50 outline-none placeholder:font-sans placeholder:text-slate-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 disabled:opacity-60"
          placeholder="Scan barcode or search product…"
          autoComplete="off"
          autoFocus
          aria-label="Scan barcode or search product"
          aria-autocomplete="list"
          aria-controls="retail-search-results"
          aria-expanded={filteredItems.length > 0}
          aria-activedescendant={
            activeIndex >= 0 && filteredItems[activeIndex]
              ? `retail-result-${filteredItems[activeIndex].id}`
              : undefined
          }
        />
      </div>

      {loadingItems ? (
        <p className="px-1 text-xs text-slate-500" role="status">
          Loading products…
        </p>
      ) : null}

      {noMatch ? (
        <p className="px-1 text-xs text-amber-300/90" role="status">
          No product found for “{noMatch}”
        </p>
      ) : null}

      {filteredItems.length > 0 ? (
        <div
          ref={listRef}
          id="retail-search-results"
          role="listbox"
          className="max-h-44 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950 sm:max-h-52"
        >
          <div className="sticky top-0 z-[1] border-b border-slate-800 bg-slate-900/95 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Search results
          </div>
          {filteredItems.map((it, index) => {
            const selected = selectedItemId === it.id || activeIndex === index;
            return (
              <button
                key={it.id}
                id={`retail-result-${it.id}`}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onSelectResult(it)}
                className={`flex w-full items-center justify-between gap-3 border-b border-slate-900 px-3 py-2.5 text-left last:border-0 hover:bg-slate-900 ${
                  selected ? "bg-blue-950/40 ring-1 ring-inset ring-blue-500/30" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-medium text-slate-50">
                    {it.itemName}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                    {getItemBaseCode(it) ? `Code: ${getItemBaseCode(it)}` : null}
                    {getItemBarcode(it)
                      ? `${getItemBaseCode(it) ? " · " : ""}Barcode: ${getItemBarcode(it)}`
                      : !getItemBaseCode(it)
                        ? "—"
                        : null}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[15px] font-semibold tabular-nums text-slate-100">
                    {money(it.sellingPrice)}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    Stk {money(it.currentStock)}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
