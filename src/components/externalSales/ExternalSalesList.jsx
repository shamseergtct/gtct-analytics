import { useMemo, useState } from "react";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../context/AuthContext";
import DateInput from "../DateInput.jsx";
import { formatMoney } from "../../utils/money.js";
import {
  EXTERNAL_SALE_TYPES,
  externalPaymentModeLabel,
  externalSaleTypeLabel,
  summarizeExternalBills,
} from "../../utils/externalSales.js";
import {
  BTN_SECONDARY,
  FIELD_CLASS,
  LABEL_CLASS,
} from "./externalSalesUi.js";

function SummaryCard({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-white">{value}</div>
    </div>
  );
}

export default function ExternalSalesList({
  bills,
  loading,
  error,
  filterDate,
  onFilterDateChange,
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
  const [boyFilter, setBoyFilter] = useState("");
  const [search, setSearch] = useState("");
  const [showVoided, setShowVoided] = useState(false);

  const currencyPrefix = currency ? `${currency} ` : "";

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return bills.filter((bill) => {
      if (!showVoided && bill.voided === true) return false;
      if (terminalFilter && bill.terminalId !== terminalFilter) return false;
      if (saleTypeFilter && bill.saleType !== saleTypeFilter) return false;
      if (boyFilter && bill.deliveryBoyId !== boyFilter) return false;
      if (!q) return true;
      const hay = [
        bill.billNumber,
        bill.terminalNameSnapshot,
        bill.customerLocation,
        bill.deliveryBoyNameSnapshot,
        bill.notes,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [bills, showVoided, terminalFilter, saleTypeFilter, boyFilter, search]);

  const summary = useMemo(
    () => summarizeExternalBills(filtered.filter((bill) => bill.voided !== true)),
    [filtered]
  );

  const terminalRows = Object.values(summary.byTerminal).sort((a, b) =>
    String(a.terminalName).localeCompare(String(b.terminalName))
  );
  const boyRows = Object.values(summary.byDeliveryBoy).sort((a, b) =>
    String(a.deliveryBoyName).localeCompare(String(b.deliveryBoyName))
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
    <div className="space-y-5">
      <div className="grid gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 md:grid-cols-2 xl:grid-cols-5">
        <label className={LABEL_CLASS}>
          Business Date
          <DateInput
            value={filterDate}
            onChange={(event) => onFilterDateChange?.(event.target.value)}
            className={`${FIELD_CLASS} mt-1.5`}
          />
        </label>
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
            placeholder="Bill no / customer…"
          />
        </label>
      </div>

      <label className="inline-flex items-center gap-2 text-sm text-slate-400">
        <input
          type="checkbox"
          checked={showVoided}
          onChange={(event) => setShowVoided(event.target.checked)}
          className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-blue-600"
        />
        Show voided bills
      </label>

      {error ? (
        <div className="rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Total Bills" value={summary.totalBills} />
        <SummaryCard
          label="Total Sales"
          value={`${currencyPrefix}${formatMoney(summary.totalSales, currencyDecimals)}`}
        />
        <SummaryCard
          label="Delivery Charges"
          value={`${currencyPrefix}${formatMoney(summary.totalDeliveryCharges, currencyDecimals)}`}
        />
        <SummaryCard
          label="Delivery Commission"
          value={`${currencyPrefix}${formatMoney(summary.totalCommission, currencyDecimals)}`}
        />
        <SummaryCard label="Delivery Bills" value={summary.deliveryBills} />
        <SummaryCard label="Dine In Bills" value={summary.dineInBills} />
        <SummaryCard label="Pick Up Bills" value={summary.pickUpBills} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
          <div className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-white">
            Terminal Totals
          </div>
          <table className="min-w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Terminal</th>
                <th className="px-4 py-2">Bills</th>
                <th className="px-4 py-2">Sales</th>
              </tr>
            </thead>
            <tbody>
              {terminalRows.length ? (
                terminalRows.map((row) => (
                  <tr key={row.terminalId} className="border-t border-slate-800/80">
                    <td className="px-4 py-2 text-white">{row.terminalName}</td>
                    <td className="px-4 py-2">{row.bills}</td>
                    <td className="px-4 py-2">
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

        <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
          <div className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-white">
            Delivery Boy Summary
          </div>
          <table className="min-w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Delivery Boy</th>
                <th className="px-4 py-2">Bills</th>
                <th className="px-4 py-2">Sales</th>
                <th className="px-4 py-2">Charges</th>
                <th className="px-4 py-2">Commission</th>
              </tr>
            </thead>
            <tbody>
              {boyRows.length ? (
                boyRows.map((row) => (
                  <tr
                    key={row.deliveryBoyId}
                    className="border-t border-slate-800/80"
                  >
                    <td className="px-4 py-2 text-white">
                      {row.deliveryBoyName}
                    </td>
                    <td className="px-4 py-2">{row.bills}</td>
                    <td className="px-4 py-2">
                      {currencyPrefix}
                      {formatMoney(row.sales, currencyDecimals)}
                    </td>
                    <td className="px-4 py-2">
                      {currencyPrefix}
                      {formatMoney(row.deliveryCharges, currencyDecimals)}
                    </td>
                    <td className="px-4 py-2">
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
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Terminal</th>
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
              {loading ? (
                <tr>
                  <td colSpan={12} className="px-4 py-8 text-center text-slate-500">
                    Loading bills…
                  </td>
                </tr>
              ) : filtered.length ? (
                filtered.map((bill) => (
                  <tr
                    key={bill.id}
                    className={`border-t border-slate-800/80 hover:bg-slate-950/40 ${
                      bill.voided ? "opacity-60" : ""
                    }`}
                  >
                    <td className="px-4 py-3 whitespace-nowrap">
                      {bill.businessDate}
                    </td>
                    <td className="px-4 py-3">
                      {bill.terminalNameSnapshot || "—"}
                    </td>
                    <td className="px-4 py-3 font-medium text-white">
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
                      {formatMoney(bill.billAmount, currencyDecimals)}
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
                      {formatMoney(bill.deliveryCharge, currencyDecimals)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {currencyPrefix}
                      {formatMoney(bill.commissionAmount, currencyDecimals)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {bill.voided ? (
                        <span className="text-xs text-slate-500">—</span>
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
                ))
              ) : (
                <tr>
                  <td colSpan={12} className="px-4 py-8 text-center text-slate-500">
                    No external sales bills for this date.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
