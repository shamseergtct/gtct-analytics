import { useMemo, useState } from "react";
import InvoiceMetaFields from "./InvoiceMetaFields.jsx";
import CartBillingPanel from "./CartBillingPanel.jsx";
import {
  calcLineTotal,
  getItemBaseCode,
  itemRetailPrice,
  itemWholesalePrice,
  money,
  num,
  unitsPerCarton,
} from "./salesHelpers.js";

/**
 * Wholesale + retail hybrid — unit (piece/carton) + price tier selection.
 * Converts cartons to piece qty before calling the shared billing engine.
 */
export default function WholesaleSales(props) {
  const {
    search,
    setSearch,
    setSelectedItemId,
    searchRef,
    filteredItems,
    selectedItem,
    selectedItemId,
    qty,
    setQty,
    taxPct,
    setTaxPct,
    itemDesc,
    setItemDesc,
    addItemToCart,
    loadingItems,
    onWholesaleAdd,
  } = props;

  const [unit, setUnit] = useState("PIECE"); // PIECE | CARTON
  const [priceTier, setPriceTier] = useState("WHOLESALE"); // RETAIL | WHOLESALE

  const packSize = selectedItem ? unitsPerCarton(selectedItem) : 12;
  const unitPrice = useMemo(() => {
    if (!selectedItem) return 0;
    const piecePrice =
      priceTier === "WHOLESALE"
        ? itemWholesalePrice(selectedItem)
        : itemRetailPrice(selectedItem);
    return unit === "CARTON" ? piecePrice * packSize : piecePrice;
  }, [selectedItem, priceTier, unit, packSize]);

  const pieceQty = unit === "CARTON" ? num(qty) * packSize : num(qty);
  const linePreview = calcLineTotal(num(qty), unitPrice, taxPct);

  function selectItem(it) {
    setSelectedItemId(it.id);
    setSearch(`${getItemBaseCode(it) || "NO CODE"} — ${it.itemName || ""}`);
    setQty("1");
  }

  function handleAdd() {
    if (!selectedItem) return;
    if (typeof onWholesaleAdd === "function") {
      onWholesaleAdd({
        item: selectedItem,
        qtyEntered: num(qty),
        unit,
        priceTier,
        unitPrice,
        pieceQty,
        taxPct: num(taxPct),
        desc: itemDesc || "",
        packSize,
      });
      return;
    }
    addItemToCart?.();
  }

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-12">
      <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4 xl:col-span-7">
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-violet-400/80">
          Wholesale / retail hybrid · units & tiers
        </div>
        <InvoiceMetaFields {...props} showOrderType={false} />

        <div className="mt-4 border-t border-slate-800 pt-4">
          <h3 className="font-semibold text-slate-100">Add Item</h3>

          <div className="mt-2">
            <label className="text-sm text-slate-300">Search Item</label>
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSelectedItemId("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (filteredItems.length > 0) selectItem(filteredItems[0]);
                }
              }}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100"
              placeholder="Search by item code or name…"
            />
            {filteredItems.length > 0 ? (
              <div className="mt-2 max-h-48 overflow-auto rounded-xl border border-slate-800">
                {filteredItems.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => selectItem(it)}
                    className={`w-full border-b border-slate-900 px-3 py-2 text-left hover:bg-slate-900/40 ${
                      selectedItemId === it.id ? "bg-slate-900/60" : ""
                    }`}
                  >
                    <div className="flex justify-between gap-2 text-sm">
                      <span className="font-medium text-slate-100">{it.itemName}</span>
                      <span className="font-mono text-xs text-slate-400">
                        {getItemBaseCode(it) || "-"}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500">
                      Retail {money(itemRetailPrice(it))} · Wholesale{" "}
                      {money(itemWholesalePrice(it))} · Pack{" "}
                      {unitsPerCarton(it)} pcs
                    </div>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="text-sm text-slate-300">Unit</label>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {[
                  { value: "PIECE", label: "Piece" },
                  { value: "CARTON", label: `Carton (${packSize})` },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setUnit(opt.value)}
                    className={`rounded-lg px-3 py-2.5 text-sm font-semibold ${
                      unit === opt.value
                        ? "bg-violet-600 text-white"
                        : "border border-slate-700 bg-slate-900 text-slate-200"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm text-slate-300">Price Tier</label>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {[
                  { value: "RETAIL", label: "Retail" },
                  { value: "WHOLESALE", label: "Wholesale" },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setPriceTier(opt.value)}
                    className={`rounded-lg px-3 py-2.5 text-sm font-semibold ${
                      priceTier === opt.value
                        ? "bg-violet-600 text-white"
                        : "border border-slate-700 bg-slate-900 text-slate-200"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-3">
            <label className="text-sm text-slate-300">Description (optional)</label>
            <input
              value={itemDesc}
              onChange={(e) => setItemDesc(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-200"
              placeholder="PO / batch note…"
            />
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-12">
            <div className="md:col-span-3">
              <label className="text-sm text-slate-300">Tax %</label>
              <input
                type="number"
                inputMode="decimal"
                value={taxPct}
                onChange={(e) => setTaxPct(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100"
              />
            </div>
            <div className="md:col-span-3">
              <label className="text-sm text-slate-300">
                Qty ({unit === "CARTON" ? "cartons" : "pieces"})
              </label>
              <input
                type="number"
                inputMode="decimal"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100"
              />
            </div>
            <div className="md:col-span-3">
              <label className="text-sm text-slate-300">Unit Price</label>
              <input
                readOnly
                value={money(unitPrice)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 font-semibold text-slate-100"
              />
            </div>
            <div className="md:col-span-3">
              <label className="text-sm text-slate-300">Line Total</label>
              <input
                readOnly
                value={money(linePreview)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 font-semibold text-slate-100"
              />
            </div>
            {unit === "CARTON" ? (
              <div className="text-xs text-slate-500 md:col-span-12">
                Stocks as {money(pieceQty)} pieces · {priceTier.toLowerCase()} tier
              </div>
            ) : null}
            <div className="flex justify-end md:col-span-12">
              <button
                type="button"
                onClick={handleAdd}
                disabled={!selectedItem || loadingItems || num(qty) <= 0}
                className="rounded-lg bg-violet-600 px-4 py-2 font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
              >
                + Add to Order
              </button>
            </div>
          </div>
        </div>
      </div>

      <CartBillingPanel
        {...props}
        emptyHint="Search an item, choose unit & price tier, then add."
      />
    </div>
  );
}
