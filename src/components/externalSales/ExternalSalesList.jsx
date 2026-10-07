import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { ChevronDown, Eye, Landmark, Lock, UserRound, Wallet, X } from "lucide-react";
import { db } from "../../firebase";
import { useAuth } from "../../context/AuthContext";
import { useEstimatedLiquidity } from "../../hooks/useEstimatedBankBalance.js";
import { formatMoney } from "../../utils/money.js";
import {
  isDaySummarySessionUnlocked,
  setDaySummarySessionUnlocked,
  verifyDaySummaryPassword,
} from "../../utils/daySummaryPrivacy.js";
import {
  EXTERNAL_SALE_TYPES,
  compareBillingTerminals,
  externalPaymentModeLabel,
  externalSaleTypeLabel,
  isDeliveryBoyAccountPayment,
  listExternalCreditBills,
  parseBillSequence,
  summarizeDeliveryBoysForCollection,
  summarizeExternalBills,
} from "../../utils/externalSales.js";
import {
  BTN_PRIMARY,
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

function StandingBalanceCard({
  icon: Icon,
  label,
  value,
  accentClass,
  iconClass,
  selector = null,
}) {
  return (
    <div
      className={`min-w-0 rounded-xl border bg-slate-950/60 px-3.5 py-3 shadow-sm ${accentClass}`}
    >
      <div className="flex items-start gap-2">
        <span
          className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconClass}`}
        >
          <Icon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {label}
            </div>
            {selector}
          </div>
          <div className="mt-0.5 truncate text-base font-bold tabular-nums text-white sm:text-lg">
            {value}
          </div>
        </div>
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
  const {
    cashBalance,
    operationalBankBalances,
    loading: loadingLiquidity,
  } = useEstimatedLiquidity(clientId, filterDate);
  const [terminalFilter, setTerminalFilter] = useState("");
  const [saleTypeFilter, setSaleTypeFilter] = useState("");
  const [paymentModeFilter, setPaymentModeFilter] = useState("");
  const [boyFilter, setBoyFilter] = useState("");
  const [search, setSearch] = useState("");
  const [showVoided, setShowVoided] = useState(false);
  const [openTerminalLists, setOpenTerminalLists] = useState({});
  const [dayCollections, setDayCollections] = useState([]);
  const [balanceAccountKey, setBalanceAccountKey] = useState("cash");
  const [summaryPasswordHash, setSummaryPasswordHash] = useState("");
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockError, setUnlockError] = useState("");

  const currencyPrefix = currency ? `${currency} ` : "";
  const summaryProtected = Boolean(String(summaryPasswordHash || "").trim());

  // Day totals / credit report use the full business date (not list filters).
  const dayBills = useMemo(
    () => bills.filter((bill) => bill.voided !== true),
    [bills]
  );

  useEffect(() => {
    if (!clientId || !filterDate) {
      setDayCollections([]);
      return undefined;
    }
    const collectionsQuery = query(
      collection(db, "delivery_boy_collections"),
      where("clientId", "==", clientId),
      where("businessDate", "==", filterDate)
    );
    return onSnapshot(
      collectionsQuery,
      (snapshot) => {
        setDayCollections(
          snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        );
      },
      () => setDayCollections([])
    );
  }, [clientId, filterDate]);

  useEffect(() => {
    if (!clientId) {
      setSummaryPasswordHash("");
      setSummaryOpen(false);
      return undefined;
    }
    // Always start closed on load/refresh; do not restore prior unlock.
    setSummaryOpen(false);
    setDaySummarySessionUnlocked(clientId, false);
    const settingsRef = doc(db, "client_settings", clientId);
    return onSnapshot(
      settingsRef,
      (snapshot) => {
        const hash = String(
          snapshot.exists() ? snapshot.data()?.daySummaryPasswordHash || "" : ""
        ).trim();
        setSummaryPasswordHash(hash);
      },
      () => {
        setSummaryPasswordHash("");
      }
    );
  }, [clientId]);

  useEffect(() => {
    function lockSummaryAway() {
      setSummaryOpen(false);
      setUnlockOpen(false);
      setUnlockPassword("");
      setUnlockError("");
      if (clientId) setDaySummarySessionUnlocked(clientId, false);
    }

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") lockSummaryAway();
    }

    function onPageHide() {
      lockSummaryAway();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [clientId]);

  function closeSummary() {
    setSummaryOpen(false);
    setUnlockOpen(false);
    setUnlockPassword("");
    setUnlockError("");
    if (clientId) setDaySummarySessionUnlocked(clientId, false);
  }

  function requestOpenSummary() {
    setUnlockError("");
    if (!summaryProtected) {
      setSummaryOpen(true);
      return;
    }
    if (isDaySummarySessionUnlocked(clientId)) {
      setSummaryOpen(true);
      return;
    }
    setUnlockPassword("");
    setUnlockOpen(true);
  }

  async function confirmUnlockSummary(event) {
    event.preventDefault();
    setUnlockError("");
    const ok = await verifyDaySummaryPassword(
      unlockPassword,
      summaryPasswordHash
    );
    if (!ok) {
      setUnlockError("Incorrect password.");
      return;
    }
    setDaySummarySessionUnlocked(clientId, true);
    setSummaryOpen(true);
    setUnlockOpen(false);
    setUnlockPassword("");
  }

  const standingBalanceOptions = useMemo(() => {
    const options = [
      {
        key: "cash",
        kind: "cash",
        label: "Cash (Hand)",
        amount: cashBalance,
        icon: Wallet,
        accentClass: "border-emerald-800/50",
        iconClass: "bg-emerald-950/70 text-emerald-300",
      },
    ];

    for (const account of operationalBankBalances || []) {
      if (account.bankAccountId === "_unassigned") continue;
      options.push({
        key: `bank:${account.bankAccountId}`,
        kind: "bank",
        label: account.bankAccountName,
        amount: account.amount,
        icon: Landmark,
        accentClass: "border-sky-800/50",
        iconClass: "bg-sky-950/70 text-sky-300",
      });
    }

    const boyRows = summarizeDeliveryBoysForCollection({
      bills: dayBills,
      collections: dayCollections,
    }).filter((row) => Number(row.balance) > 0);

    for (const row of boyRows) {
      options.push({
        key: `boy:${row.deliveryBoyId}`,
        kind: "delivery_boy",
        label: row.deliveryBoyName,
        amount: row.balance,
        icon: UserRound,
        accentClass: "border-amber-800/50",
        iconClass: "bg-amber-950/70 text-amber-300",
      });
    }

    return options;
  }, [cashBalance, operationalBankBalances, dayBills, dayCollections]);

  const selectedBalanceOption = useMemo(() => {
    const found = standingBalanceOptions.find(
      (option) => option.key === balanceAccountKey
    );
    return found || standingBalanceOptions[0] || null;
  }, [standingBalanceOptions, balanceAccountKey]);

  useEffect(() => {
    if (!standingBalanceOptions.length) return;
    const stillValid = standingBalanceOptions.some(
      (option) => option.key === balanceAccountKey
    );
    if (!stillValid) setBalanceAccountKey(standingBalanceOptions[0].key);
  }, [standingBalanceOptions, balanceAccountKey]);

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
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
            Day Summary
            {summaryProtected ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                <Lock size={10} />
                Protected
              </span>
            ) : null}
          </h3>
          <div className="flex items-center gap-2">
            {summaryOpen ? (
              <button
                type="button"
                onClick={closeSummary}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800"
                aria-label="Close day summary"
              >
                <X size={14} />
                Close
              </button>
            ) : (
              <button
                type="button"
                onClick={requestOpenSummary}
                className="inline-flex items-center gap-1.5 rounded-lg border border-sky-800/60 bg-sky-950/40 px-2.5 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-950/70"
                aria-label="View day summary"
              >
                {summaryProtected ? <Lock size={14} /> : <Eye size={14} />}
                View summary
              </button>
            )}
          </div>
        </div>

        {!summaryOpen ? (
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-6 text-center text-sm text-slate-500">
            {summaryProtected
              ? "Day Summary is closed. Enter the password to view totals and standing balances."
              : "Day Summary is closed. Click View summary to open it."}
          </div>
        ) : (
          <>
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

            <div className="mt-4 border-t border-slate-800/80 pt-4">
              <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Standing balances
                </h4>
                <span className="text-[11px] text-slate-500">
                  Select cash, bank, or delivery boy with outstanding
                </span>
              </div>
              <div className="max-w-md">
                <StandingBalanceCard
                  icon={selectedBalanceOption?.icon || Wallet}
                  label="Balance"
                  value={
                    loadingLiquidity || selectedBalanceOption?.amount == null
                      ? "…"
                      : `${currencyPrefix}${formatMoney(
                          selectedBalanceOption.amount,
                          currencyDecimals
                        )}`
                  }
                  accentClass={
                    selectedBalanceOption?.accentClass || "border-slate-700"
                  }
                  iconClass={
                    selectedBalanceOption?.iconClass ||
                    "bg-slate-900 text-slate-300"
                  }
                  selector={
                    <select
                      value={selectedBalanceOption?.key || "cash"}
                      onChange={(event) =>
                        setBalanceAccountKey(event.target.value)
                      }
                      className="max-w-[14rem] rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] font-medium normal-case tracking-normal text-slate-200"
                      aria-label="Select balance account"
                    >
                      {standingBalanceOptions.map((option) => (
                        <option key={option.key} value={option.key}>
                          {option.kind === "delivery_boy"
                            ? `${option.label} (Delivery)`
                            : option.label}
                        </option>
                      ))}
                    </select>
                  }
                />
              </div>
            </div>
          </>
        )}
      </section>

      {unlockOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <form
            onSubmit={confirmUnlockSummary}
            className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
          >
            <h4 className="text-sm font-semibold text-white">
              Enter Day Summary password
            </h4>
            <p className="mt-1 text-xs text-slate-500">
              Required to view day totals and standing balances.
            </p>
            <label className={`${LABEL_CLASS} mt-4`}>
              Password
              <input
                type="password"
                autoFocus
                value={unlockPassword}
                onChange={(event) => setUnlockPassword(event.target.value)}
                className={FIELD_CLASS}
                placeholder="Password"
                autoComplete="current-password"
              />
            </label>
            {unlockError ? (
              <p className="mt-2 text-sm text-red-300">{unlockError}</p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={() => {
                  setUnlockOpen(false);
                  setUnlockPassword("");
                  setUnlockError("");
                }}
              >
                Cancel
              </button>
              <button type="submit" className={BTN_PRIMARY}>
                Unlock
              </button>
            </div>
          </form>
        </div>
      ) : null}

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
