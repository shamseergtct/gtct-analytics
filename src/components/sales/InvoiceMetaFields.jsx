import DateInput from "../DateInput.jsx";
import { money, num, roundMoney } from "./salesHelpers.js";
import { normalizeTransactionMode } from "../../utils/transactionContract.js";
import { isBankAccountSelection } from "../../utils/paymentModes.js";

const FIELD =
  "mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100";

/**
 * Shared invoice / customer / payment header used by all sales layouts.
 */
export default function InvoiceMetaFields({
  saleDate,
  setSaleDate,
  editingInvoice,
  invoiceNo,
  setInvoiceNo,
  orderType,
  setOrderType,
  showOrderType = true,
  orderTypeControl = null,
  paymentMode,
  setPaymentMode,
  paymentModeOptions,
  settlementMode = "full",
  setSettlementMode,
  payCash = "",
  setPayCash,
  payBank = "",
  setPayBank,
  payCredit = "",
  setPayCredit,
  printMode,
  onPrintModeChange,
  customerId,
  onSelectCustomer,
  loadingCustomers,
  customers,
  customerName,
  setCustomerName,
  setCustomerId,
  customerPhone,
  setCustomerPhone,
  address1,
  setAddress1,
  address2,
  setAddress2,
  address3,
  setAddress3,
  grandTotal = 0,
}) {
  const creditRequired =
    normalizeTransactionMode(paymentMode) === "credit" ||
    (settlementMode === "split" && num(payCredit) > 0);
  const total = roundMoney(grandTotal);
  const allocated =
    settlementMode === "split"
      ? roundMoney(num(payCash) + num(payBank) + num(payCredit))
      : total;
  const remaining = roundMoney(total - allocated);

  function switchSettlement(next) {
    setSettlementMode?.(next);
    if (next === "split") {
      setPayCash?.(String(total || ""));
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

  return (
    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-12">
      <div className="md:col-span-4">
        <label className="text-sm text-slate-300">Sale Date</label>
        <DateInput
          value={saleDate}
          disabled={!editingInvoice}
          onChange={(e) => setSaleDate(e.target.value)}
          className="mt-1 h-10 w-full rounded-lg border border-slate-700 bg-slate-900 text-slate-100"
        />
      </div>

      <div className="md:col-span-8">
        <label className="text-sm text-slate-300">Invoice No</label>
        <input
          value={invoiceNo}
          onChange={(e) => setInvoiceNo(e.target.value)}
          className={FIELD}
        />
      </div>

      {showOrderType ? (
        <div className="md:col-span-6">
          <label className="text-sm text-slate-300">Order Type</label>
          {orderTypeControl || (
            <select
              value={orderType}
              onChange={(e) => setOrderType(e.target.value)}
              className={FIELD}
            >
              <option value="COUNTER">Counter Sale</option>
              <option value="TAKEAWAY">Take Away</option>
              <option value="CARHOP">Car Hop</option>
              <option value="DELIVERY">Delivery</option>
            </select>
          )}
        </div>
      ) : null}

      <div className="md:col-span-6">
        <div className="flex items-center justify-between gap-2">
          <label className="text-sm text-slate-300">Payment</label>
          <div className="inline-flex rounded-lg border border-slate-700 p-0.5">
            <button
              type="button"
              onClick={() => switchSettlement("full")}
              className={`rounded-md px-2 py-1 text-[11px] font-semibold ${
                settlementMode !== "split"
                  ? "bg-slate-800 text-slate-100"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Full
            </button>
            <button
              type="button"
              onClick={() => switchSettlement("split")}
              className={`rounded-md px-2 py-1 text-[11px] font-semibold ${
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
          <div className="mt-1 space-y-2 rounded-lg border border-slate-800 bg-slate-950/50 p-2.5">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] uppercase text-slate-500">Cash</label>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={payCash}
                  onChange={(e) => setPayCash?.(e.target.value)}
                  className={FIELD}
                />
              </div>
              <div>
                <label className="text-[10px] uppercase text-slate-500">Bank</label>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={payBank}
                  onChange={(e) => setPayBank?.(e.target.value)}
                  className={FIELD}
                />
              </div>
              <div>
                <label className="text-[10px] uppercase text-slate-500">Credit</label>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={payCredit}
                  onChange={(e) => setPayCredit?.(e.target.value)}
                  className={FIELD}
                />
              </div>
            </div>
            <select
              value={
                isBankAccountSelection(paymentMode) ||
                ["BANK", "BANK_TRANSFER"].includes(
                  String(paymentMode).toUpperCase()
                )
                  ? paymentMode
                  : paymentModeOptions.find((option) =>
                      isBankAccountSelection(option.value)
                    )?.value || paymentMode
              }
              disabled={num(payBank) <= 0}
              onChange={(e) => setPaymentMode(e.target.value)}
              className={FIELD}
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
            <div className="flex justify-between text-xs text-slate-400">
              <span>Remaining to allocate</span>
              <span
                className={
                  Math.abs(remaining) < 0.005
                    ? "text-emerald-300"
                    : "text-amber-300"
                }
              >
                {money(remaining)}
              </span>
            </div>
          </div>
        ) : (
          <select
            value={paymentMode}
            onChange={(e) => setPaymentMode(e.target.value)}
            className={FIELD}
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
              <option value="CREDIT">Credit (Legacy Record)</option>
            ) : null}
          </select>
        )}
        {creditRequired ? (
          <p className="mt-1 text-xs text-amber-200/90">
            Credit requires a customer selection.
          </p>
        ) : null}
      </div>

      <div className="md:col-span-6">
        <label className="text-sm text-slate-300">Printer</label>
        <select value={printMode} onChange={onPrintModeChange} className={FIELD}>
          <option value="A4">A4</option>
          <option value="THERMAL">Thermal</option>
        </select>
      </div>

      <div className="md:col-span-6">
        <label className="text-sm text-slate-300">
          Select Customer{creditRequired ? " (required)" : " (optional)"}
        </label>
        <select
          value={customerId}
          onChange={(e) => onSelectCustomer(e.target.value)}
          className={FIELD}
          disabled={loadingCustomers}
        >
          <option value="">
            {loadingCustomers ? "Loading customers..." : "— Select customer —"}
          </option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="md:col-span-6">
        <label className="text-sm text-slate-300">Customer Name</label>
        <input
          value={customerName}
          onChange={(e) => {
            setCustomerName(e.target.value);
            setCustomerId("");
          }}
          className={FIELD}
          placeholder="Enter customer name..."
        />
      </div>

      <div className="md:col-span-6">
        <label className="text-sm text-slate-300">Contact Number</label>
        <input
          value={customerPhone}
          onChange={(e) => {
            setCustomerPhone(e.target.value);
            setCustomerId("");
          }}
          className={FIELD}
          placeholder="Phone / WhatsApp..."
        />
      </div>

      <div className="md:col-span-4">
        <label className="text-sm text-slate-300">Address 1</label>
        <input
          value={address1}
          onChange={(e) => {
            setAddress1(e.target.value);
            setCustomerId("");
          }}
          className={FIELD}
          placeholder="House / Building..."
        />
      </div>

      <div className="md:col-span-4">
        <label className="text-sm text-slate-300">Address 2</label>
        <input
          value={address2}
          onChange={(e) => {
            setAddress2(e.target.value);
            setCustomerId("");
          }}
          className={FIELD}
          placeholder="Street / Area..."
        />
      </div>

      <div className="md:col-span-4">
        <label className="text-sm text-slate-300">Address 3</label>
        <input
          value={address3}
          onChange={(e) => {
            setAddress3(e.target.value);
            setCustomerId("");
          }}
          className={FIELD}
          placeholder="City / State..."
        />
      </div>
    </div>
  );
}
