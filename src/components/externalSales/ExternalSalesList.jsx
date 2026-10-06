import { useMemo, useState } from "react";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { ChevronDown } from "lucide-react";
import { db } from "../../firebase";
import { useAuth } from "../../context/AuthContext";
import { formatMoney } from "../../utils/money.js";
import {
  EXTERNAL_SALE_TYPES,
  compareBillingTerminals,
  externalPaymentModeLabel,
  externalSaleTypeLabel,
  isDeliveryBoyAccountPayment,
  listExternalCreditBills,
  parseBillSequence,
  summarizeExternalBills,
} from "../../utils/externalSales.js";
import {
  BTN_SECONDARY,
  FIELD_CLASS,
  LABEL_CLASS,
} from "./externalSalesUi.js";
import TerminalBillGapChecker from "./TerminalBillGapChecker.jsx";

const PAYMENT_MODE_FILTERS = [
  { value: "CASH", label: "Cash" },
  { value: "BANK", label: "Bank" },
  { value: "CREDIT", label: "Credit" },
  { value: "DELIVERY_ACCOUNT", label: "Delivery Boy Account" },
];

function billMatchesPaymentMode(bill, paymentModeFilter) {
  if (!paymentModeFilter) return true;
  if (paymentModeFilter === "DELIVERY_ACCOUNT") {
    return isDeliveryBoyAccountPayment(bill);
  }
  if (isDeliveryBoyAccountPayment(bill)) return false;
  const mode = String(bill?.paymentMode || "")
    .trim()
    .toUpperCase();
  if (mode === "SPLIT") {
    if (paymentModeFilter === "CASH") return Number(bill?.paidCash) > 0;
    if (paymentModeFilter === "BANK") return Number(bill?.paidBank) > 0;
    return paymentModeFilter === "SPLIT";
  }
  if (paymentModeFilter === "CASH") {
    return mode === "CASH" || !mode;
  }
  return mode === paymentModeFilter;
}

/** Smallest → largest bill number (numeric when possible). */
function compareBillNumberAsc(a, b) {
  const seqA = parseBillSequence(a?.billNumber);
  const seqB = parseBillSequence(b?.billNumber);
  if (seqA != null && seqB != null && seqA !== seqB) return seqA - seqB;
  if (seqA != null && seqB == null) return -1;
  if (seqA == null && seqB != null) return 1;
  return String(a?.billNumber || "").localeCompare(
    String(b?.billNumber || ""),
    undefined,
    { numeric: true, sensitivity: "base" }
  );
}

function groupBillsByTerminal(bills, terminals = []) {
  const terminalMeta = new Map(
    (terminals || []).map((row) => [row.id, row])
  );
  const groups = new Map();

  for (const bill of bills) {
    const terminalId = bill.terminalId || "_unknown";
    if (!groups.has(terminalId)) {
      const meta = terminalMeta.get(bill.terminalId);
      groups.set(terminalId, {
        terminalId: bill.terminalId || "",
        terminalName:
          meta?.name || bill.terminalNameSnapshot || "Unknown terminal",
        sortOrder: meta?.sortOrder,
        bills: [],
      });
    }
    groups.get(terminalId).bills.push(bill);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      bills: [...group.bills].sort(compareBillNumberAsc),
    }))
    .sort((a, b) =>
      compareBillingTerminals(
        { name: a.terminalName, sortOrder: a.sortOrder },
        { name: b.terminalName, sortOrder: b.sortOrder }
      )
    );
}

function SummaryCard({ label, value }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-2">
      <div className="truncate text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-0.5 truncate text-sm font-semibold tabular-nums text-white">
        {value}
      </div>
    </div>
  );
}

export default function ExternalSalesList({
  clientId,
  bills,
  loading,
  error,
  filterDate,
  terminals,
  deliveryBoys,
  currency,
  currencyDecimals,
  onMessage,
  onError,
}) {
  const { user } = useAuth();
  const [terminalFilter, setTerminalFilter] = useState("");
  const [saleTypeFilter, setSaleTypeFilter] = useState("");
  const [paymentModeFilter, setPaymentModeFilter] = useState("");
  const [boyFilter, setBoyFilter] = useState("");
  const [search, setSearch] = useState("");
  const [showVoided, setShowVoided] = useState(false);
  const [openTerminalLists, setOpenTerminalLists] = useState({});

  const currencyPrefix = currency ? `${currency} ` : "";

  // Day totals / credit report use the full business date (not list filters).
  const dayBills = useMemo(
    () => bills.filter((bill) => bill.voided !== true),
    [bills]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return bills.filter((bill) => {
      if (!showVoided && bill.voided === true) return false;
      if (terminalFilter && bill.terminalId !== terminalFilter) return false;
      if (saleTypeFilter && bill.saleType !== saleTypeFilter) return false;
      if (!billMatchesPaymentMode(bill, paymentModeFilter)) return false;
      if (boyFilter && bill.deliveryBoyId !== boyFilter) return false;
      if (!q) return true;
      const hay = [
        bill.billNumber,
        bill.terminalNameSnapshot,
        bill.customerName,
        bill.customerLocation,
        bill.deliveryBoyNameSnapshot,
        bill.notes,
        externalPaymentModeLabel(bill),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [
    bills,
    showVoided,
    terminalFilter,
    saleTypeFilter,
    paymentModeFilter,
    boyFilter,
    search,
  ]);

  const billsByTerminal = useMemo(
    () => groupBillsByTerminal(filtered, terminals),
    [filtered, terminals]
  );

  const summary = useMemo(
    () => summarizeExternalBills(dayBills),
    [dayBills]
  );

  const terminalRows = Object.values(summary.byTerminal).sort((a, b) =>
    String(a.terminalName).localeCompare(String(b.terminalName))
  );
  const boyRows = Object.values(summary.byDeliveryBoy).sort((a, b) =>
    String(a.deliveryBoyName).localeCompare(String(b.deliveryBoyName))
  );

  const creditBills = useMemo(
    () => listExternalCreditBills(dayBills),
    [dayBills]
  );
  const creditTotal = useMemo(
    () =>
      creditBills.reduce(
        (total, bill) => total + (Number(bill.billAmount) || 0),
        0
      ),
    [creditBills]
  );

  async function voidBill(bill) {
    if (!bill?.id || bill.voided === true) return;
    const ok = window.confirm(
      `Void bill ${bill.billNumber} on ${bill.terminalNameSnapshot}? This keeps history but excludes it from totals.`
    );
    if (!ok) return;
    onError?.("");
    try {
      const updatedAtMs = Number(new Date());
      await updateDoc(doc(db, "external_sales_bills", bill.id), {
        voided: true,
        updatedAt: serverTimestamp(),
        updatedAtMs,
        updatedBy: user?.uid || null,
      });
      onMessage?.("Bill voided.");
    } catch (reason) {
      onError?.(reason?.message || "Failed to void bill.");
    }
  }

  return (
    <div className="space-y-4">
      <TerminalBillGapChecker
        clientId={clientId}
        businessDate={filterDate}
        terminals={terminals}
        bills={bills}
        onMessage={onMessage}
        onError={onError}
      />

      {error ? (
        <div className="rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <h3 className="mb-3 text-sm font-semibold text-white">Day Summary</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
          <SummaryCard label="Total Bills" value={summary.totalBills} />
          <SummaryCard
            label="Net Sale"
            value={`${currencyPrefix}${formatMoney(summary.netSales, currencyDecimals)}`}
          />
          <SummaryCard
            label="Credit Sale"
            value={`${currencyPrefix}${formatMoney(summary.creditSales, currencyDecimals)}`}
          />
          <SummaryCard
            label="Gross Sale"
            value={`${currencyPrefix}${formatMoney(summary.grossSales, currencyDecimals)}`}
          />
          <SummaryCard
            label="Delivery Charges"
            value={`${currencyPrefix}${formatMoney(summary.totalDeliveryCharges, currencyDecimals)}`}
          />
          <SummaryCard
            label="Commission"
            value={`${currencyPrefix}${formatMoney(summary.totalCommission, currencyDecimals)}`}
          />
          <SummaryCard label="Delivery" value={summary.deliveryBills} />
          <SummaryCard label="Dine In" value={summary.dineInBills} />
          <SummaryCard label="Pick Up" value={summary.pickUpBills} />
        </div>
      </section>

      <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
        <div className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-white">
          Terminal Totals
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Terminal</th>
                <th className="px-4 py-2 text-right">Bills</th>
                <th className="px-4 py-2 text-right">Sales</th>
              </tr>
            </thead>
            <tbody>
              {terminalRows.length ? (
                terminalRows.map((row) => (
                  <tr key={row.terminalId} className="border-t border-slate-800/80">
                    <td className="px-4 py-2.5 text-white">{row.terminalName}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{row.bills}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {currencyPrefix}
                      {formatMoney(row.sales, currencyDecimals)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-slate-500">
                    No terminal totals for this day.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
        <div className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-white">
          Delivery Boy Summary
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[520px] w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Delivery Boy</th>
                <th className="px-4 py-2 text-right">Bills</th>
                <th className="px-4 py-2 text-right">Sales</th>
                <th className="px-4 py-2 text-right">Charges</th>
                <th className="px-4 py-2 text-right">Commission</th>
              </tr>
            </thead>
            <tbody>
              {boyRows.length ? (
                boyRows.map((row) => (
                  <tr
                    key={row.deliveryBoyId}
                    className="border-t border-slate-800/80"
                  >
                    <td className="px-4 py-2.5 text-white">
                      {row.deliveryBoyName}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{row.bills}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {currencyPrefix}
                      {formatMoney(row.sales, currencyDecimals)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {currencyPrefix}
                      {formatMoney(row.deliveryCharges, currencyDecimals)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {currencyPrefix}
                      {formatMoney(row.commission, currencyDecimals)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                    No delivery bills for this day.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">Credit Report</h3>
          <div className="text-xs tabular-nums text-slate-400">
            {creditBills.length} · {currencyPrefix}
            {formatMoney(creditTotal, currencyDecimals)}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[720px] w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Terminal</th>
                <th className="px-4 py-2">Bill No.</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">Location</th>
                <th className="px-4 py-2">Delivery Boy</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {creditBills.length ? (
                creditBills.map((bill) => (
                  <tr key={bill.id} className="border-t border-slate-800/80">
                    <td className="px-4 py-2.5 text-white">
                      {bill.terminalNameSnapshot || "—"}
                    </td>
                    <td className="px-4 py-2.5 font-medium tabular-nums text-white">
                      {bill.billNumber}
                    </td>
                    <td className="px-4 py-2.5">
                      {externalSaleTypeLabel(bill.saleType)}
                    </td>
                    <td className="px-4 py-2.5">{bill.customerName || "—"}</td>
                    <td className="px-4 py-2.5">
                      {bill.customerLocation || "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      {bill.deliveryBoyNameSnapshot || "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {currencyPrefix}
                      {formatMoney(bill.billAmount, currencyDecimals)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-6 text-center text-slate-500"
                  >
                    No credit bills for this date.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <h3 className="text-sm font-semibold text-white">All Bills</h3>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <label className={LABEL_CLASS}>
            Terminal
            <select
              value={terminalFilter}
              onChange={(event) => setTerminalFilter(event.target.value)}
              className={FIELD_CLASS}
            >
              <option value="">All terminals</option>
              {terminals.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL_CLASS}>
            Sale Type
            <select
              value={saleTypeFilter}
              onChange={(event) => setSaleTypeFilter(event.target.value)}
              className={FIELD_CLASS}
            >
              <option value="">All types</option>
              {EXTERNAL_SALE_TYPES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL_CLASS}>
            Payment Mode
            <select
              value={paymentModeFilter}
              onChange={(event) => setPaymentModeFilter(event.target.value)}
              className={FIELD_CLASS}
            >
              <option value="">All payment modes</option>
              {PAYMENT_MODE_FILTERS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL_CLASS}>
            Delivery Boy
            <select
              value={boyFilter}
              onChange={(event) => setBoyFilter(event.target.value)}
              className={FIELD_CLASS}
            >
              <option value="">All delivery boys</option>
              {deliveryBoys.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL_CLASS}>
            Search
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={FIELD_CLASS}
              placeholder="Bill no…"
            />
          </label>
          <label className="inline-flex items-end gap-2 pb-2 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={showVoided}
              onChange={(event) => setShowVoided(event.target.checked)}
              className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-blue-600"
            />
            Show voided
          </label>
        </div>

        <div className="space-y-3 pt-1">
          {loading ? (
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-8 text-center text-sm text-slate-500">
              Loading bills…
            </div>
          ) : billsByTerminal.length ? (
            billsByTerminal.map((group) => {
              const groupKey = group.terminalId || group.terminalName;
              const isOpen = openTerminalLists[groupKey] === true;
              const panelId = `terminal-bills-${groupKey}`;

              return (
                <div
                  key={groupKey}
                  className="min-w-0 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/40"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setOpenTerminalLists((prev) => ({
                        ...prev,
                        [groupKey]: !isOpen,
                      }))
                    }
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-900/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/50"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-white">
                        {group.terminalName}
                      </div>
                      <div className="mt-0.5 text-xs tabular-nums text-slate-400">
                        {group.bills.length} bill
                        {group.bills.length === 1 ? "" : "s"}
                      </div>
                    </div>
                    <ChevronDown
                      className={`h-5 w-5 shrink-0 text-slate-400 transition-transform duration-200 ${
                        isOpen ? "rotate-180" : ""
                      }`}
                      aria-hidden="true"
                    />
                  </button>

                  {isOpen ? (
                    <div
                      id={panelId}
                      className="overflow-x-auto overscroll-x-contain border-t border-slate-800"
                    >
                      <table className="min-w-[900px] w-full text-left text-sm text-slate-300">
                        <thead className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500">
                          <tr>
                            <th className="px-4 py-3">Bill No.</th>
                            <th className="px-4 py-3">Type</th>
                            <th className="px-4 py-3">Payment</th>
                            <th className="px-4 py-3">Amount</th>
                            <th className="px-4 py-3">Customer</th>
                            <th className="px-4 py-3">Location</th>
                            <th className="px-4 py-3">Delivery Boy</th>
                            <th className="px-4 py-3">Delivery Charge</th>
                            <th className="px-4 py-3">Commission</th>
                            <th className="px-4 py-3 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.bills.map((bill) => (
                            <tr
                              key={bill.id}
                              className={`border-t border-slate-800/80 hover:bg-slate-950/40 ${
                                bill.voided ? "opacity-60" : ""
                              }`}
                            >
                              <td className="px-4 py-3 font-medium tabular-nums text-white">
                                {bill.billNumber}
                                {bill.voided ? (
                                  <span className="ml-2 text-xs text-amber-300">
                                    Voided
                                  </span>
                                ) : null}
                              </td>
                              <td className="px-4 py-3">
                                {externalSaleTypeLabel(bill.saleType)}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                {externalPaymentModeLabel(bill)}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                {currencyPrefix}
                                {formatMoney(
                                  bill.billAmount,
                                  currencyDecimals
                                )}
                              </td>
                              <td className="px-4 py-3">
                                {bill.customerName || "—"}
                              </td>
                              <td className="px-4 py-3">
                                {bill.customerLocation || "—"}
                              </td>
                              <td className="px-4 py-3">
                                {bill.deliveryBoyNameSnapshot || "—"}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                {currencyPrefix}
                                {formatMoney(
                                  bill.deliveryCharge,
                                  currencyDecimals
                                )}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                {currencyPrefix}
                                {formatMoney(
                                  bill.commissionAmount,
                                  currencyDecimals
                                )}
                              </td>
                              <td className="px-4 py-3 text-right">
                                {bill.voided ? (
                                  <span className="text-xs text-slate-500">
                                    —
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => voidBill(bill)}
                                    className={BTN_SECONDARY}
                                  >
                                    Void
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-8 text-center text-sm text-slate-500">
              No bills match these filters.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
