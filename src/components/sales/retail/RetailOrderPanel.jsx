import { useEffect, useRef } from "react";
import { Minus, Plus, ScanBarcode, Trash2 } from "lucide-react";
import { num, tenderTotals } from "../salesHelpers.js";
import { normalizeTransactionMode } from "../../../utils/transactionContract.js";
import {
  isBankAccountSelection,
  parsePaymentModeSelection,
} from "../../../utils/paymentModes.js";
import { useMoney } from "../../../hooks/useMoney.js";

/**
 * Right-rail order list + anchored checkout for Retail POS.
 */
export default function RetailOrderPanel({
  cart,
  totals,
  updateLine,
  removeLine,
  paymentMode,
  setPaymentMode,
  paymentModeOptions,
  paymentSelectRef,
  settlementMode,
  setSettlementMode,
  payCash,
  setPayCash,
  payBank,
  setPayBank,
  payCredit,
  setPayCredit,
  printMode,
  saving,
  editingInvoice,
  finishAndBilling,
  onClearCart,
}) {
  const { money, round, decimals } = useMoney();
  const isCredit =
    normalizeTransactionMode(paymentMode) === "credit" ||
    (settlementMode === "split" && num(payCredit) > 0);
  const listRef = useRef(null);
  const prevLen = useRef(cart.length);
  const grandTotal = round(totals.grandTotal);

  const splitPreview = tenderTotals(
    resolvePreviewTenders({
      settlementMode,
      paymentMode,
      payCash,
      payBank,
      payCredit,
      grandTotal,
    }),
    decimals
  );
  const remaining = round(grandTotal - splitPreview.allocated);

  useEffect(() => {
    if (cart.length > prevLen.current) {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    prevLen.current = cart.length;
  }, [cart.length]);

  function bumpQty(lineId, current, delta) {
    const cur = num(current);
    const next = Math.round((cur + delta) * 1000) / 1000;
    // Retail units: stepping below 1 removes the line (faster than 0.0001 leftovers)
    if (next < 1) {
      removeLine(lineId);
      return;
    }
    updateLine(lineId, { qty: next });
  }

  function switchSettlement(next) {
    setSettlementMode?.(next);
    if (next === "split") {
      // Default: full cash paid now; user can move amounts to bank/credit.
      setPayCash?.(String(grandTotal || ""));
      setPayBank?.("");
      setPayCredit?.("");
      if (
        !paymentMode ||
        normalizeTransactionMode(paymentMode) === "credit" ||
        String(paymentMode).toUpperCase() === "SPLIT"
      ) {
        const firstBank = paymentModeOptions.find((option) =>
          isBankAccountSelection(option.value)
        );
        setPaymentMode?.(firstBank?.value || "CASH");
      }
    } else if (String(paymentMode).toUpperCase() === "SPLIT") {
      setPaymentMode?.("CASH");
    }
  }

  function fillCreditRemainder() {
    const cash = num(payCash);
    const bank = num(payBank);
    const rest = round(grandTotal - cash - bank);
    setPayCredit?.(rest > 0 ? String(rest) : "");
  }

  function fillCashFull() {
    setPayCash?.(String(grandTotal || ""));
    setPayBank?.("");
    setPayCredit?.("");
  }

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-2.5">
        <div>
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-slate-400">
            Current Order
          </h2>
          <p className="text-sm text-slate-200">
            {cart.length} item{cart.length === 1 ? "" : "s"}
          </p>
        </div>
        {saving ? (
          <span className="text-[11px] font-medium text-blue-300" role="status">
            Saving…
          </span>
        ) : null}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {cart.length === 0 ? (
          <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-1.5 px-6 text-center">
            <ScanBarcode size={26} className="text-slate-600" aria-hidden />
            <p className="text-[15px] font-medium text-slate-300">Start a new order</p>
            <p className="text-xs text-slate-500">
              Scan a barcode or search for a product
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-800/90">
            {cart.map((row) => (
              <li key={row.lineId} className="px-3 py-2 hover:bg-slate-900/40">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-[15px] font-medium leading-snug text-slate-50 break-words">
                      {row.itemName || row.itemCode || "Item"}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                      {row.itemCode || "—"}
                      {num(row.taxPct) > 0 ? ` · ${num(row.taxPct)}%` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeLine(row.lineId)}
                    disabled={saving}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-red-950/40 hover:text-red-300 disabled:opacity-50"
                    aria-label={`Remove ${row.itemName || "item"}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>

                {(() => {
                  const isFoc = num(row.sellingPrice) === 0;
                  const descMissing =
                    isFoc && !String(row.description || "").trim();
                  return (
                    <input
                      type="text"
                      disabled={saving}
                      required={isFoc}
                      value={row.description || ""}
                      onChange={(e) =>
                        updateLine(row.lineId, { description: e.target.value })
                      }
                      onKeyDown={(e) => {
                        // Keep typing in description from triggering POS shortcuts.
                        e.stopPropagation();
                      }}
                      className={`mt-1.5 h-9 w-full rounded-lg border bg-slate-900/60 px-2 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:ring-1 disabled:opacity-50 ${
                        descMissing
                          ? "border-amber-500/80 focus:border-amber-400 focus:ring-amber-500/30"
                          : "border-slate-800 focus:border-blue-500 focus:ring-blue-500/30"
                      }`}
                      placeholder={
                        isFoc
                          ? "Description required (FOC)"
                          : "Description"
                      }
                      aria-label={`Description for ${row.itemName || "item"}`}
                      aria-required={isFoc}
                    />
                  );
                })()}

                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="inline-flex w-full items-center rounded-lg border border-slate-700 bg-slate-900 sm:w-auto">
                    <button
                      type="button"
                      aria-label="Decrease quantity"
                      disabled={saving}
                      onClick={() => bumpQty(row.lineId, row.qty, -1)}
                      className="flex h-10 w-11 items-center justify-center text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-50"
                    >
                      <Minus size={14} />
                    </button>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="1"
                      step="any"
                      disabled={saving}
                      value={row.qty}
                      onChange={(e) => {
                        const v = num(e.target.value);
                        if (v < 1 && e.target.value !== "") {
                          removeLine(row.lineId);
                          return;
                        }
                        updateLine(row.lineId, { qty: e.target.value });
                      }}
                      onBlur={() => {
                        if (num(row.qty) < 1) removeLine(row.lineId);
                      }}
                      className="h-10 min-w-0 flex-1 border-x border-slate-700 bg-transparent text-center text-sm font-semibold text-slate-100 outline-none disabled:opacity-50 sm:w-14 sm:flex-none"
                      aria-label={`Quantity for ${row.itemName || "item"}`}
                    />
                    <button
                      type="button"
                      aria-label="Increase quantity"
                      disabled={saving}
                      onClick={() => bumpQty(row.lineId, row.qty, 1)}
                      className="flex h-10 w-11 items-center justify-center text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-50"
                    >
                      <Plus size={14} />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-2">
                    <label className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wide text-slate-500">
                        Price
                      </span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        disabled={saving}
                        value={row.sellingPrice}
                        onChange={(e) =>
                          updateLine(row.lineId, {
                            sellingPrice: e.target.value,
                          })
                        }
                        className="h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 text-right text-sm font-semibold tabular-nums text-slate-100 outline-none focus:border-blue-500 disabled:opacity-50 sm:w-[5.5rem]"
                        aria-label={`Price for ${row.itemName || "item"}`}
                      />
                    </label>
                    <div className="flex min-w-0 flex-col gap-0.5 text-right">
                      <span className="text-[10px] uppercase tracking-wide text-slate-500">
                        Line
                      </span>
                      <div className="flex h-10 items-center justify-end text-[15px] font-semibold tabular-nums text-slate-50">
                        {money(row.total)}
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-slate-800 bg-slate-900/50 px-4 py-3">
        <div className="space-y-0.5 text-sm">
          <div className="flex justify-between text-slate-400">
            <span>Subtotal</span>
            <span className="tabular-nums text-slate-200">{money(totals.subTotal)}</span>
          </div>
          {num(totals.discountTotal) > 0 ? (
            <div className="flex justify-between text-slate-400">
              <span>Discount</span>
              <span className="tabular-nums text-slate-200">
                {money(totals.discountTotal)}
              </span>
            </div>
          ) : null}
          <div className="flex justify-between text-slate-400">
            <span>Tax</span>
            <span className="tabular-nums text-slate-200">{money(totals.taxAmount)}</span>
          </div>
        </div>

        <div className="mt-2.5 flex items-end justify-between gap-2 border-t border-slate-800 pt-2.5">
          <span className="text-sm font-semibold uppercase tracking-wide text-slate-300">
            Total
          </span>
          <span className="text-[24px] font-bold leading-none tracking-tight tabular-nums text-emerald-300 sm:text-[30px]">
            {money(totals.grandTotal)}
          </span>
        </div>

        <div className="mt-2.5">
          <div className="mb-1.5 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Payment
            </span>
            <div className="inline-flex w-full rounded-lg border border-slate-700 p-0.5 sm:w-auto">
              <button
                type="button"
                disabled={saving}
                onClick={() => switchSettlement("full")}
                className={`min-h-9 flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold sm:flex-none ${
                  settlementMode !== "split"
                    ? "bg-slate-800 text-slate-100"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Full
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => switchSettlement("split")}
                className={`min-h-9 flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold sm:flex-none ${
                  settlementMode === "split"
                    ? "bg-slate-800 text-slate-100"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Split / Partial
              </button>
            </div>
          </div>

          {settlementMode === "split" ? (
            <div className="space-y-2">
              <div className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-1.5">
                <span className="text-xs text-slate-400">Cash</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  disabled={saving}
                  value={payCash}
                  onChange={(e) => setPayCash?.(e.target.value)}
                  className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm tabular-nums text-slate-100 outline-none focus:border-blue-500 disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={saving}
                  onClick={fillCashFull}
                  className="h-9 rounded-lg border border-slate-700 px-2 text-[10px] font-medium text-slate-300 hover:bg-slate-900 disabled:opacity-50"
                >
                  Full
                </button>
              </div>

              <div className="grid grid-cols-[4.5rem_1fr] items-center gap-1.5">
                <span className="text-xs text-slate-400">Bank</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  disabled={saving}
                  value={payBank}
                  onChange={(e) => setPayBank?.(e.target.value)}
                  className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm tabular-nums text-slate-100 outline-none focus:border-blue-500 disabled:opacity-50"
                />
              </div>

              <select
                ref={paymentSelectRef}
                value={
                  isBankAccountSelection(paymentMode) ||
                  String(paymentMode).toUpperCase() === "BANK" ||
                  String(paymentMode).toUpperCase() === "BANK_TRANSFER"
                    ? paymentMode
                    : paymentModeOptions.find((option) =>
                        isBankAccountSelection(option.value)
                      )?.value || paymentMode
                }
                disabled={saving || num(payBank) <= 0}
                onChange={(e) => setPaymentMode(e.target.value)}
                className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100 outline-none focus:border-blue-500 disabled:opacity-50"
              >
                {paymentModeOptions
                  .filter(
                    (option) =>
                      isBankAccountSelection(option.value) ||
                      String(option.value).toUpperCase() === "BANK_TRANSFER"
                  )
                  .map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
              </select>

              <div className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-1.5">
                <span className="text-xs text-slate-400">Credit</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  disabled={saving}
                  value={payCredit}
                  onChange={(e) => setPayCredit?.(e.target.value)}
                  className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm tabular-nums text-slate-100 outline-none focus:border-blue-500 disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={saving}
                  onClick={fillCreditRemainder}
                  className="h-9 rounded-lg border border-slate-700 px-2 text-[10px] font-medium text-slate-300 hover:bg-slate-900 disabled:opacity-50"
                >
                  Rest
                </button>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-950/70 px-2.5 py-2 text-[11px] text-slate-400">
                <div className="flex justify-between">
                  <span>Paid now</span>
                  <span className="tabular-nums text-slate-200">
                    {money(splitPreview.paid)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>On credit</span>
                  <span className="tabular-nums text-slate-200">
                    {money(splitPreview.credit)}
                  </span>
                </div>
                <div className="mt-1 flex justify-between border-t border-slate-800 pt-1">
                  <span>Remaining to allocate</span>
                  <span
                    className={`tabular-nums font-semibold ${
                      Math.abs(remaining) < 0.005
                        ? "text-emerald-300"
                        : "text-amber-300"
                    }`}
                  >
                    {money(remaining)}
                  </span>
                </div>
              </div>

              {isCredit ? (
                <p className="text-[11px] text-amber-200/90">
                  Credit requires a selected customer.
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <select
                ref={paymentSelectRef}
                value={paymentMode}
                disabled={saving}
                onChange={(e) => setPaymentMode(e.target.value)}
                className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 disabled:opacity-50"
              >
                {paymentModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
                {normalizeTransactionMode(paymentMode) === "credit" &&
                !paymentModeOptions.some(
                  (option) => String(option.value).toUpperCase() === "CREDIT"
                ) ? (
                  <option value="CREDIT">Credit (Legacy)</option>
                ) : null}
              </select>
              {isCredit ? (
                <p className="mt-1.5 text-[11px] text-amber-200/90">
                  Credit sale — select a customer before billing.
                </p>
              ) : null}
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => finishAndBilling({ doPrint: true })}
          disabled={saving || cart.length === 0}
          className="mt-2.5 h-12 w-full rounded-xl bg-emerald-600 text-[15px] font-bold tracking-wide text-white shadow-lg shadow-emerald-950/30 hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 disabled:opacity-50"
        >
          {saving
            ? "Saving…"
            : editingInvoice
              ? "Update & Print"
              : "Bill & Print"}
        </button>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => finishAndBilling({ doPrint: false })}
            disabled={saving || cart.length === 0}
            className="h-10 rounded-xl border border-slate-700 bg-slate-950 text-sm font-semibold text-slate-200 hover:bg-slate-900 disabled:opacity-50"
          >
            {editingInvoice ? "Update Only" : "Finish Order"}
          </button>
          <button
            type="button"
            onClick={onClearCart}
            disabled={saving || cart.length === 0}
            className="h-10 rounded-xl border border-slate-700 bg-slate-950 text-sm font-semibold text-slate-300 hover:bg-slate-900 disabled:opacity-50"
          >
            Clear
          </button>
        </div>

        <p className="mt-1.5 text-center text-[10px] text-slate-600">
          {printMode}
        </p>
      </div>
    </aside>
  );
}

function resolvePreviewTenders({
  settlementMode,
  paymentMode,
  payCash,
  payBank,
  payCredit,
  grandTotal,
}) {
  if (settlementMode === "split") {
    return [
      { mode: "CASH", amount: num(payCash) },
      { mode: "BANK", amount: num(payBank) },
      { mode: "CREDIT", amount: num(payCredit) },
    ];
  }
  const resolved = parsePaymentModeSelection(paymentMode);
  const mode = String(resolved.paymentMode || "CASH").toUpperCase();
  return [{ mode, amount: grandTotal }];
}
