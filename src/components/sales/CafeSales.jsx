import { useMemo, useState } from "react";
import InvoiceMetaFields from "./InvoiceMetaFields.jsx";
import CartBillingPanel from "./CartBillingPanel.jsx";
import { getItemBaseCode, money, num } from "./salesHelpers.js";

const ORDER_TYPES = [
  { value: "COUNTER", label: "Counter" },
  { value: "TAKEAWAY", label: "Take Away" },
  { value: "CARHOP", label: "Car Hop" },
  { value: "DELIVERY", label: "Delivery" },
];

/**
 * Café / restaurant layout — touch-friendly item grid + prominent order type.
 */
export default function CafeSales(props) {
  const {
    items,
    loadingItems,
    search,
    setSearch,
    orderType,
    setOrderType,
    taxPct,
    onQuickAddItem,
  } = props;

  const [menuFilter, setMenuFilter] = useState("");

  const menuItems = useMemo(() => {
    const q = (menuFilter || search || "").trim().toLowerCase();
    const list = Array.isArray(items) ? items : [];
    if (!q) return list.slice(0, 60);
    return list
      .filter((it) =>
        `${getItemBaseCode(it)} ${it.itemName || ""}`.toLowerCase().includes(q)
      )
      .slice(0, 60);
  }, [items, menuFilter, search]);

  const orderTypeControl = (
    <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {ORDER_TYPES.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => setOrderType(opt.value)}
          className={`rounded-xl px-3 py-3 text-sm font-semibold transition-colors ${
            orderType === opt.value
              ? "bg-amber-500 text-slate-950"
              : "border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-12">
      <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4 xl:col-span-7">
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-amber-400/80">
          Café / restaurant mode · touch menu
        </div>
        <InvoiceMetaFields
          {...props}
          showOrderType
          orderTypeControl={orderTypeControl}
        />

        <div className="mt-4 border-t border-slate-800 pt-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="font-semibold text-slate-100">Menu</h3>
              <p className="mt-1 text-xs text-slate-500">
                Tap an item to add (qty 1, tax {num(taxPct)}%).
              </p>
            </div>
            <input
              value={menuFilter}
              onChange={(e) => {
                setMenuFilter(e.target.value);
                setSearch(e.target.value);
              }}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 sm:w-64"
              placeholder="Filter menu…"
            />
          </div>

          {loadingItems ? (
            <div className="mt-4 text-sm text-slate-400">Loading menu…</div>
          ) : menuItems.length === 0 ? (
            <div className="mt-4 text-sm text-slate-400">No items found.</div>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {menuItems.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => onQuickAddItem?.(it)}
                  className="flex min-h-[88px] flex-col justify-between rounded-2xl border border-slate-700 bg-slate-900 p-3 text-left transition-colors hover:border-amber-500/50 hover:bg-slate-800 active:scale-[0.98]"
                >
                  <div className="line-clamp-2 text-sm font-semibold text-slate-100">
                    {it.itemName || "Item"}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-1">
                    <span className="font-mono text-[10px] text-slate-500">
                      {getItemBaseCode(it) || "—"}
                    </span>
                    <span className="text-sm font-bold text-amber-300">
                      {money(it.sellingPrice)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <CartBillingPanel
        {...props}
        emptyHint="Tap menu items to build the order."
      />
    </div>
  );
}
