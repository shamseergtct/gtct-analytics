import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, UserRound, X } from "lucide-react";
import { normalizeTransactionMode } from "../../../utils/transactionContract.js";
import { getPartyCode, partyMatchesQuery } from "../../../utils/partyCode.js";

const FIELD =
  "h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40";

/**
 * Compact customer strip + progressive disclosure sheet.
 * Search by name, mobile, or simple customer ID (partyCode).
 */
export default function RetailCustomerBar({
  open,
  setOpen,
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
  paymentMode,
  creditRequired = false,
  panelRef,
}) {
  const isCredit =
    creditRequired || normalizeTransactionMode(paymentMode) === "credit";
  const [customerQuery, setCustomerQuery] = useState("");
  const [showPicker, setShowPicker] = useState(true);
  const searchRef = useRef(null);

  const selected = customers.find((c) => c.id === customerId) || null;
  const selectedCode = getPartyCode(selected);
  const label =
    customerName?.trim() ||
    selected?.name ||
    "Walk-in Customer";
  const isWalkIn = !customerId && !customerName?.trim();
  const hasSelectedCustomer = Boolean(customerId);

  const filteredCustomers = useMemo(() => {
    const list = Array.isArray(customers) ? customers : [];
    return list
      .filter((party) => partyMatchesQuery(party, customerQuery))
      .slice(0, 12);
  }, [customers, customerQuery]);

  useEffect(() => {
    if (!open) {
      setCustomerQuery("");
      return;
    }
    // Only when the panel opens: show search if no linked customer yet.
    setShowPicker(!customerId);
    setCustomerQuery("");
    if (!customerId) {
      const t = setTimeout(() => searchRef.current?.focus?.(), 40);
      return () => clearTimeout(t);
    }
    return undefined;
    // Intentionally depend on `open` only so Walk-in / Change are not overridden.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function pickCustomer(party) {
    onSelectCustomer?.(party?.id || "");
    setCustomerQuery("");
    setShowPicker(false);
  }

  function clearToWalkIn() {
    // Reset to anonymous cash customer — clear link + typed fields, then close.
    onSelectCustomer?.("");
    setCustomerName?.("");
    setCustomerPhone?.("");
    setAddress1?.("");
    setAddress2?.("");
    setAddress3?.("");
    setCustomerId?.("");
    setCustomerQuery("");
    setShowPicker(true);
    setOpen?.(false);
  }

  function startChangeCustomer() {
    setShowPicker(true);
    setCustomerQuery("");
    setTimeout(() => searchRef.current?.focus?.(), 40);
  }

  return (
    <div ref={panelRef} className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/80 px-3.5 py-3 text-left transition-colors hover:border-slate-700 hover:bg-slate-900"
        aria-expanded={open}
        aria-controls="retail-customer-panel"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-slate-300 ring-1 ring-slate-700">
            <UserRound size={16} />
          </span>
          <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
              Customer
              {selectedCode ? (
                <span className="ml-1.5 font-mono normal-case text-slate-400">
                  {selectedCode}
                </span>
              ) : null}
            </div>
            <div className="truncate text-[15px] font-medium text-slate-50">
              {label}
            </div>
            {!isWalkIn && customerPhone?.trim() ? (
              <div className="truncate text-[11px] text-slate-500">
                {customerPhone}
              </div>
            ) : null}
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-blue-300">
          {isWalkIn ? "+ Add Customer" : "Change"}
          <ChevronDown
            size={14}
            className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden
          />
        </span>
      </button>

      {open ? (
        <div
          id="retail-customer-panel"
          className="rounded-xl border border-slate-800 bg-slate-950 p-3 shadow-lg shadow-black/20"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {hasSelectedCustomer && !showPicker
                ? "Selected customer"
                : "Customer details"}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-900 hover:text-slate-100"
              aria-label="Close customer panel"
            >
              <X size={14} />
            </button>
          </div>

          <div className="space-y-2">
            {showPicker ? (
              <>
                <div>
                  <label className="mb-0.5 block text-[10px] uppercase text-slate-500">
                    Search name / mobile / ID
                  </label>
                  <div className="relative">
                    <Search
                      size={14}
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500"
                    />
                    <input
                      ref={searchRef}
                      value={customerQuery}
                      onChange={(e) => setCustomerQuery(e.target.value)}
                      className={`${FIELD} pl-8`}
                      placeholder="e.g. Ahmed, 05…, C001"
                      autoComplete="off"
                      disabled={loadingCustomers}
                    />
                  </div>
                </div>

                <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/40">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      clearToWalkIn();
                    }}
                    className={`flex w-full items-center justify-between gap-2 border-b border-slate-800 px-3 py-2 text-left text-sm hover:bg-slate-900 ${
                      isWalkIn ? "bg-blue-950/30 text-blue-100" : "text-slate-200"
                    }`}
                  >
                    <span>Walk-in Customer</span>
                    {isWalkIn ? (
                      <span className="text-[10px] font-medium uppercase text-blue-300">
                        Selected
                      </span>
                    ) : (
                      <span className="text-[11px] text-slate-500">Cash</span>
                    )}
                  </button>

                  {loadingCustomers ? (
                    <p className="px-3 py-2 text-xs text-slate-500">Loading…</p>
                  ) : filteredCustomers.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-slate-500">
                      No match — enter name/phone below to save as new.
                    </p>
                  ) : (
                    filteredCustomers.map((party) => {
                      const code = getPartyCode(party) || "—";
                      const phone =
                        party.phone || party.mobile || party.contact || "—";
                      return (
                        <button
                          key={party.id}
                          type="button"
                          onClick={() => pickCustomer(party)}
                          className="flex w-full items-start justify-between gap-2 border-b border-slate-800/80 px-3 py-2 text-left last:border-0 hover:bg-slate-900"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-slate-100">
                              {party.name || "Customer"}
                            </div>
                            <div className="mt-0.5 truncate text-[11px] text-slate-500">
                              <span className="font-mono text-slate-400">
                                {code}
                              </span>
                              {" · "}
                              {phone}
                            </div>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>

                {!hasSelectedCustomer ? (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div>
                      <label className="mb-0.5 block text-[10px] uppercase text-slate-500">
                        Name
                      </label>
                      <input
                        value={customerName}
                        onChange={(e) => {
                          setCustomerName(e.target.value);
                          setCustomerId("");
                        }}
                        className={FIELD}
                        placeholder="Customer name"
                      />
                    </div>
                    <div>
                      <label className="mb-0.5 block text-[10px] uppercase text-slate-500">
                        Contact
                      </label>
                      <input
                        value={customerPhone}
                        onChange={(e) => {
                          setCustomerPhone(e.target.value);
                          setCustomerId("");
                        }}
                        className={FIELD}
                        placeholder="Phone"
                      />
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wide text-slate-500">
                      Customer ID
                    </div>
                    <div className="font-mono text-sm text-slate-200">
                      {selectedCode || "Pending"}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={startChangeCustomer}
                      className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-blue-300 hover:bg-slate-900"
                    >
                      Change
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        clearToWalkIn();
                      }}
                      className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-900"
                    >
                      Walk-in
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div>
                    <label className="mb-0.5 block text-[10px] uppercase text-slate-500">
                      Name
                    </label>
                    <input
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      className={FIELD}
                      placeholder="Customer name"
                    />
                  </div>
                  <div>
                    <label className="mb-0.5 block text-[10px] uppercase text-slate-500">
                      Contact
                    </label>
                    <input
                      value={customerPhone}
                      onChange={(e) => setCustomerPhone(e.target.value)}
                      className={FIELD}
                      placeholder="Phone"
                    />
                  </div>
                  {isCredit ? (
                    <>
                      <input
                        value={address1}
                        onChange={(e) => setAddress1(e.target.value)}
                        className={FIELD}
                        placeholder="Address 1"
                      />
                      <input
                        value={address2}
                        onChange={(e) => setAddress2(e.target.value)}
                        className={FIELD}
                        placeholder="Address 2"
                      />
                      <input
                        value={address3}
                        onChange={(e) => setAddress3(e.target.value)}
                        className={`${FIELD} sm:col-span-2`}
                        placeholder="Address 3"
                      />
                    </>
                  ) : (
                    <input
                      value={address1}
                      onChange={(e) => setAddress1(e.target.value)}
                      className={`${FIELD} sm:col-span-2`}
                      placeholder="Address"
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
