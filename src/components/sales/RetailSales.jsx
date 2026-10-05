import { useEffect, useRef, useState } from "react";
import { ChevronDown, History, Plus, X } from "lucide-react";
import DateInput from "../DateInput.jsx";
import ModuleHelpButton from "../ModuleHelpButton.jsx";
import { itemMatchesScanCode, num } from "./salesHelpers.js";
import { normalizeTransactionMode } from "../../utils/transactionContract.js";
import RetailBarcodeSearch from "./retail/RetailBarcodeSearch.jsx";
import RetailCustomerBar from "./retail/RetailCustomerBar.jsx";
import RetailOrderPanel from "./retail/RetailOrderPanel.jsx";

const META =
  "h-9 w-full rounded-lg border border-slate-700/80 bg-slate-950 px-2.5 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40";

/**
 * Professional retail POS workspace.
 * Presentation layer only — billing/stock/accounting stay in Sales.jsx.
 */
export default function RetailSales(props) {
  const {
    invoiceNo,
    setInvoiceNo,
    saleDate,
    setSaleDate,
    editingInvoice,
    paymentMode,
    setPaymentMode,
    paymentModeOptions,
    settlementMode,
    setSettlementMode,
    payCash,
    setPayCash,
    payBank,
    setPayBank,
    payCredit,
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
    search,
    setSearch,
    setSelectedItemId,
    searchRef,
    filteredItems,
    items,
    selectedItemId,
    loadingItems,
    onBarcodeMatch,
    cart,
    totals,
    updateLine,
    removeLine,
    saving,
    finishAndBilling,
    setTab,
    onNewOrder,
    onClearCart,
    onCloseModule,
  } = props;

  const [customerOpen, setCustomerOpen] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [resultIndex, setResultIndex] = useState(-1);
  const [noMatch, setNoMatch] = useState("");
  const paymentSelectRef = useRef(null);
  const customerPanelRef = useRef(null);
  const isCredit =
    normalizeTransactionMode(paymentMode) === "credit" ||
    (settlementMode === "split" && num(payCredit) > 0);

  // Mount: land focus on scanner. Do NOT re-steal focus on cart removes.
  useEffect(() => {
    const t = setTimeout(() => searchRef?.current?.focus?.(), 40);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isCredit) setCustomerOpen(true);
  }, [isCredit]);

  useEffect(() => {
    if (search.trim()) setNoMatch("");
  }, [search]);

  useEffect(() => {
    function onKey(e) {
      const tag = String(e.target?.tagName || "").toLowerCase();
      const typing =
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        e.target?.isContentEditable;

      if (e.key === "Escape") {
        setCustomerOpen(false);
        setNoMatch("");
        return;
      }

      if (e.key === "F2") {
        e.preventDefault();
        searchRef?.current?.focus?.();
        searchRef?.current?.select?.();
        return;
      }

      if (e.key === "F4") {
        e.preventDefault();
        setCustomerOpen(true);
        return;
      }

      if (e.key === "F8") {
        e.preventDefault();
        if (!typing && !saving) onClearCart?.();
        return;
      }

      if (e.key === "F10") {
        e.preventDefault();
        paymentSelectRef.current?.focus?.();
        return;
      }

      if (e.key === "F12") {
        e.preventDefault();
        if (!saving && cart.length > 0) finishAndBilling({ doPrint: true });
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cart.length, saving, finishAndBilling, onClearCart, searchRef]);

  function selectResult(it) {
    setNoMatch("");
    setResultIndex(-1);
    onBarcodeMatch?.(it);
  }

  function handleSearchKeyDown(e) {
    if (e.key === "ArrowDown" && filteredItems.length > 0) {
      e.preventDefault();
      setResultIndex((i) => (i + 1) % filteredItems.length);
      return;
    }
    if (e.key === "ArrowUp" && filteredItems.length > 0) {
      e.preventDefault();
      setResultIndex((i) => (i <= 0 ? filteredItems.length - 1 : i - 1));
      return;
    }

    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = search.trim().toLowerCase();
    if (!q) return;

    if (resultIndex >= 0 && filteredItems[resultIndex]) {
      selectResult(filteredItems[resultIndex]);
      return;
    }

    const exact = items.find((it) => itemMatchesScanCode(it, q));
    if (exact) {
      selectResult(exact);
      return;
    }
    if (filteredItems.length > 0) {
      selectResult(filteredItems[0]);
      return;
    }
    setNoMatch(search.trim());
  }

  return (
    <div className="flex min-h-0 flex-col gap-2.5 sm:gap-3 lg:h-[calc(100dvh-7.25rem)]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 sm:gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h1 className="text-[20px] font-semibold tracking-tight text-slate-50 sm:text-[21px]">
              Sales / Billing
            </h1>
            <span className="text-[12px] font-medium text-sky-400/90 sm:text-[13px]">
              Retail POS
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-slate-500">
            <span className="font-mono text-slate-300">
              Invoice: {invoiceNo || "—"}
            </span>
            {editingInvoice ? (
              <span className="rounded-full border border-amber-600/40 bg-amber-950/40 px-2 py-0.5 text-[11px] text-amber-200">
                Editing
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <ModuleHelpButton moduleId="sales" />
          <button
            type="button"
            onClick={() => onNewOrder?.()}
            disabled={saving}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-2.5 text-sm font-medium text-slate-100 hover:bg-slate-900 disabled:opacity-50 sm:px-3"
          >
            <Plus size={15} />
            <span className="hidden sm:inline">New Order</span>
            <span className="sm:hidden">New</span>
          </button>
          <button
            type="button"
            onClick={() => setTab?.("history")}
            disabled={saving}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-2.5 text-sm font-medium text-slate-200 hover:bg-slate-900 disabled:opacity-50 sm:px-3"
          >
            <History size={15} />
            History
          </button>
          <button
            type="button"
            onClick={() => onCloseModule?.()}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-900 hover:text-white"
            aria-label="Close sales module"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {/* lg (1024+) keeps two columns on 1366×768; xl was too late */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2.5 lg:grid-cols-12 lg:gap-3">
        <section className="order-1 flex min-h-0 flex-col gap-2.5 overflow-y-auto overscroll-contain lg:order-none lg:col-span-8">
          <RetailBarcodeSearch
            search={search}
            setSearch={setSearch}
            setSelectedItemId={setSelectedItemId}
            searchRef={searchRef}
            filteredItems={filteredItems}
            selectedItemId={selectedItemId}
            onSearchKeyDown={handleSearchKeyDown}
            onSelectResult={selectResult}
            loadingItems={loadingItems}
            saving={saving}
            activeIndex={resultIndex}
            setActiveIndex={setResultIndex}
            noMatch={noMatch}
          />

          <RetailCustomerBar
            open={customerOpen}
            setOpen={setCustomerOpen}
            panelRef={customerPanelRef}
            customerId={customerId}
            onSelectCustomer={onSelectCustomer}
            loadingCustomers={loadingCustomers}
            customers={customers}
            customerName={customerName}
            setCustomerName={setCustomerName}
            setCustomerId={setCustomerId}
            customerPhone={customerPhone}
            setCustomerPhone={setCustomerPhone}
            address1={address1}
            setAddress1={setAddress1}
            address2={address2}
            setAddress2={setAddress2}
            address3={address3}
            setAddress3={setAddress3}
            paymentMode={paymentMode}
            creditRequired={isCredit}
          />

          <div>
            <button
              type="button"
              onClick={() => setMetaOpen((v) => !v)}
              className="flex w-full items-center justify-between rounded-lg px-1 py-1 text-left text-[11px] text-slate-500 hover:text-slate-300"
              aria-expanded={metaOpen}
            >
              <span>
                Order settings
                <span className="ml-2 font-mono text-slate-600">
                  {printMode}
                  {!editingInvoice ? " · date locked" : ""}
                </span>
              </span>
              <ChevronDown
                size={14}
                className={`transition-transform ${metaOpen ? "rotate-180" : ""}`}
              />
            </button>
            {metaOpen ? (
              <div className="mt-1.5 grid grid-cols-2 gap-2 lg:grid-cols-3">
                <div>
                  <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">
                    Sale date
                  </label>
                  <DateInput
                    value={saleDate}
                    disabled={!editingInvoice}
                    onChange={(e) => setSaleDate(e.target.value)}
                    className={META}
                  />
                </div>
                <div>
                  <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">
                    Invoice no
                  </label>
                  <input
                    value={invoiceNo}
                    onChange={(e) => setInvoiceNo(e.target.value)}
                    className={META}
                  />
                </div>
                <div className="col-span-2 lg:col-span-1">
                  <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">
                    Printer
                  </label>
                  <select
                    value={printMode}
                    onChange={onPrintModeChange}
                    className={META}
                  >
                    <option value="A4">A4</option>
                    <option value="THERMAL">Thermal</option>
                  </select>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        <div className="order-2 min-h-[min(420px,70dvh)] lg:order-none lg:col-span-4 lg:min-h-0 lg:h-full">
          <RetailOrderPanel
            cart={cart}
            totals={totals}
            updateLine={updateLine}
            removeLine={removeLine}
            paymentMode={paymentMode}
            setPaymentMode={setPaymentMode}
            paymentModeOptions={paymentModeOptions}
            paymentSelectRef={paymentSelectRef}
            settlementMode={settlementMode}
            setSettlementMode={setSettlementMode}
            payCash={payCash}
            setPayCash={setPayCash}
            payBank={payBank}
            setPayBank={setPayBank}
            payCredit={payCredit}
            setPayCredit={setPayCredit}
            printMode={printMode}
            saving={saving}
            editingInvoice={editingInvoice}
            finishAndBilling={finishAndBilling}
            onClearCart={onClearCart}
          />
        </div>
      </div>
    </div>
  );
}
