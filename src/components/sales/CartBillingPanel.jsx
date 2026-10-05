import { useMoney } from "../../hooks/useMoney.js";
import { num } from "./salesHelpers.js";

/** Shared cart table + totals + finish/billing actions. */
export default function CartBillingPanel({
  cart,
  totals,
  updateLine,
  removeLine,
  saving,
  editingInvoice,
  printMode,
  finishAndBilling,
  emptyHint = "No items added. Add an item from search.",
}) {
  const { money } = useMoney();

  function descriptionField(row) {
    const isFoc = num(row.sellingPrice) === 0;
    const descMissing = isFoc && !String(row.description || "").trim();
    return (
      <input
        value={row.description || ""}
        onChange={(e) =>
          updateLine(row.lineId, {
            description: e.target.value,
          })
        }
        required={isFoc}
        aria-required={isFoc}
        className={`w-full rounded-lg border bg-slate-900 px-2 py-1.5 text-sm text-slate-100 ${
          descMissing ? "border-amber-500/80" : "border-slate-700"
        }`}
        placeholder={
          isFoc ? "Description required (FOC)..." : "Enter description..."
        }
      />
    );
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-3 sm:p-4 xl:col-span-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-100">Order Items</h2>
        <div className="text-xs text-slate-400">Columns: Total includes Tax</div>
      </div>

      {cart.length === 0 ? (
        <div className="mt-4 text-sm text-slate-400">{emptyHint}</div>
      ) : (
        <>
          {/* Mobile card cart */}
          <ul className="mt-4 space-y-2 md:hidden">
            {cart.map((row, idx) => (
              <li
                key={row.lineId}
                className="rounded-xl border border-slate-800 bg-slate-950/60 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] text-slate-500">#{idx + 1}</div>
                    <div className="line-clamp-2 font-medium text-slate-100 break-words">
                      {row.itemName || row.itemCode || "Item"}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                      {row.itemCode || "—"}
                      {row.unitLabel ? ` · ${row.unitLabel}` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeLine(row.lineId)}
                    className="min-h-9 shrink-0 rounded-lg border border-red-800 px-2.5 text-sm text-red-200 hover:bg-red-950/30"
                  >
                    Remove
                  </button>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[10px] uppercase text-slate-500">Qty</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0.0001"
                      step="any"
                      value={row.qty}
                      onChange={(e) =>
                        updateLine(row.lineId, { qty: e.target.value })
                      }
                      className="mt-0.5 h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 text-right text-slate-100"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] uppercase text-slate-500">Price</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="any"
                      value={row.sellingPrice}
                      onChange={(e) =>
                        updateLine(row.lineId, {
                          sellingPrice: e.target.value,
                        })
                      }
                      className="mt-0.5 h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 text-right text-slate-100"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] uppercase text-slate-500">Tax %</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={row.taxPct ?? 0}
                      onChange={(e) =>
                        updateLine(row.lineId, { taxPct: e.target.value })
                      }
                      className="mt-0.5 h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 text-right text-slate-100"
                      placeholder="0"
                    />
                  </label>
                  <div className="flex flex-col justify-end text-right">
                    <span className="text-[10px] uppercase text-slate-500">Total</span>
                    <div className="h-10 text-lg font-semibold tabular-nums leading-10 text-slate-100">
                      {money(row.total)}
                    </div>
                  </div>
                </div>

                <div className="mt-2">{descriptionField(row)}</div>
              </li>
            ))}
          </ul>

          {/* Desktop table */}
          <div className="mt-4 hidden overflow-x-auto rounded-xl border border-slate-800 md:block">
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-800 bg-slate-900/60">
                <tr className="text-left text-xs text-slate-200">
                  <th className="p-2">#</th>
                  <th className="p-2">Code</th>
                  <th className="p-2">Item</th>
                  <th className="p-2 text-right">Qty</th>
                  <th className="p-2 text-right">Price</th>
                  <th className="p-2 text-right">Tax%</th>
                  <th className="p-2 text-right">Total</th>
                  <th className="p-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {cart.flatMap((row, idx) => [
                  <tr key={`${row.lineId}-main`} className="border-b border-slate-900">
                    <td className="p-2 text-slate-300">{idx + 1}</td>
                    <td className="p-2 text-slate-300">{row.itemCode || "-"}</td>
                    <td className="p-2">
                      <div className="font-medium text-slate-100">{row.itemName}</div>
                      {row.unitLabel ? (
                        <div className="text-[11px] text-slate-500">{row.unitLabel}</div>
                      ) : null}
                    </td>
                    <td className="p-2">
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0.0001"
                        step="any"
                        value={row.qty}
                        onChange={(e) =>
                          updateLine(row.lineId, { qty: e.target.value })
                        }
                        className="w-20 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-right text-slate-100"
                      />
                    </td>
                    <td className="p-2">
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        value={row.sellingPrice}
                        onChange={(e) =>
                          updateLine(row.lineId, {
                            sellingPrice: e.target.value,
                          })
                        }
                        className="w-24 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-right text-slate-100"
                      />
                    </td>
                    <td className="p-2">
                      <input
                        type="number"
                        inputMode="decimal"
                        value={row.taxPct ?? 0}
                        onChange={(e) =>
                          updateLine(row.lineId, { taxPct: e.target.value })
                        }
                        className="w-20 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-right text-slate-100"
                        placeholder="0"
                      />
                    </td>
                    <td className="p-2 text-right font-semibold text-slate-100">
                      {money(row.total)}
                    </td>
                    <td className="p-2">
                      <button
                        type="button"
                        onClick={() => removeLine(row.lineId)}
                        className="rounded-lg border border-red-800 px-2 py-1 text-red-200 hover:bg-red-950/30"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>,
                  <tr
                    key={`${row.lineId}-desc`}
                    className="border-b border-slate-900 bg-slate-950/40"
                  >
                    <td className="p-2 text-slate-500" />
                    <td className="p-2 text-slate-500" colSpan={2}>
                      <span className="text-xs text-slate-400">Item Description</span>
                    </td>
                    <td className="p-2" colSpan={5}>
                      {descriptionField(row)}
                    </td>
                  </tr>,
                ])}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="mt-4 space-y-2 border-t border-slate-800 pt-4 text-sm">
        <div className="flex justify-between text-slate-300">
          <span>Sub Total</span>
          <span className="font-medium text-slate-100">{money(totals.subTotal)}</span>
        </div>
        <div className="flex justify-between text-slate-300">
          <span>Grand Total (Before Tax)</span>
          <span className="font-medium text-slate-100">
            {money(totals.grandTotalBeforeTax)}
          </span>
        </div>
        <div className="flex justify-between text-slate-300">
          <span>Tax (Item-wise)</span>
          <span className="font-medium text-slate-100">{money(totals.taxAmount)}</span>
        </div>
        <div className="flex justify-between text-base text-slate-200">
          <span className="font-semibold">Grand Total</span>
          <span className="font-semibold">{money(totals.grandTotal)}</span>
        </div>

        <div className="grid grid-cols-1 gap-2 pt-2 md:grid-cols-2">
          <button
            type="button"
            onClick={() => finishAndBilling({ doPrint: false })}
            disabled={saving || cart.length === 0}
            className="min-h-11 rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
          >
            {saving
              ? "Saving..."
              : editingInvoice
                ? "Update Invoice"
                : "Finish Order"}
          </button>
          <button
            type="button"
            onClick={() => finishAndBilling({ doPrint: true })}
            disabled={saving || cart.length === 0}
            className="min-h-11 rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
          >
            {saving
              ? "Saving..."
              : editingInvoice
                ? `Update + Print (${printMode})`
                : `Billing + Print (${printMode})`}
          </button>
        </div>
      </div>
    </div>
  );
}
