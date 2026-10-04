import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Download,
  FileText,
  LineChart,
  Printer,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { useClient } from "../context/ClientContext";
import DateRangeToolbar from "../components/reports/DateRangeToolbar.jsx";
import ReportTable from "../components/reports/ReportTable.jsx";
import ProfitLossStatement from "../components/reports/ProfitLossStatement.jsx";
import CashFlowStatement from "../components/reports/CashFlowStatement.jsx";
import DueBalanceList from "../components/reports/DueBalanceList.jsx";
import PartySearchSelect from "../components/PartySearchSelect.jsx";
import AdvancedAnalytics from "../components/reports/AdvancedAnalytics.jsx";
import {
  formatReportRangeLabel,
  resolveReportDateRange,
  toYYYYMMDD,
} from "../utils/reportDateRange.js";
import {
  fetchDetailedLedger,
  fetchPartiesForLedger,
  fetchQuickSnapshot,
} from "../utils/reportsHubApi.js";
import {
  exportCashFlowCsv,
  exportPnLCsv,
  exportReportCsv,
  printCashFlowDocument,
  printPnLDocument,
  printReportDocument,
} from "../utils/reportsHubExport.js";
import { formatIsoDate } from "../utils/dateFormat.js";
import {
  REPORT_VIEW_TYPES,
  PAYMENT_FILTER_OPTIONS,
  aggregateLedgerRows,
  detectPaymentFiltersPresent,
  filterRowsByParty,
  filterRowsByPayment,
  listPartiesFromRows,
  reportViewSupportsAggregation,
} from "../utils/reportAggregation.js";
import { formatMoney, formatMoneyLocale } from "../utils/money.js";
import { useBankAccounts } from "../hooks/useBankAccounts.js";

const MAIN_TABS = [
  { key: "quick", label: "Quick Snapshot", icon: BarChart3 },
  { key: "detailed", label: "Detailed Ledgers", icon: FileText },
  { key: "analytics", label: "Advanced Analytics", icon: LineChart },
];

const LEDGER_TYPES = [
  { key: "pnl", label: "P&L Statement" },
  { key: "sales", label: "Sales Report" },
  { key: "ledger", label: "Transaction Ledger" },
  { key: "cashflow", label: "Cash Flow Statement" },
  { key: "cash", label: "Cash Report" },
  { key: "bank", label: "Bank Report" },
  { key: "locker", label: "Locker Report" },
  { key: "customers", label: "Customer Ledgers" },
  { key: "vendors", label: "Vendor Ledgers" },
  { key: "loans", label: "Loan Report" },
  { key: "receivables", label: "Receivables List" },
  { key: "payables", label: "Payables List" },
  { key: "expense", label: "Expense Breakdown" },
  { key: "z_audit", label: "Z-Report Audit" },
];

const LIQUIDITY_MOVEMENT_OPTIONS = [
  { key: "all", label: "All movements" },
  { key: "sales", label: "Sales" },
  { key: "receipt", label: "Receipts" },
  { key: "payment", label: "Payments" },
  { key: "expense", label: "Purchases / Expenses" },
  { key: "loan", label: "Loans" },
  { key: "transfer", label: "Transfers" },
];

const LOCKER_DIRECTION_OPTIONS = [
  { key: "all", label: "All directions" },
  { key: "cash_to_locker", label: "Cash → Locker" },
  { key: "locker_to_cash", label: "Locker → Cash" },
];

function money(value) {
  return formatMoneyLocale(value);
}

function KpiCard({ label, value, tone = "text-white" }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 print:border-slate-300 print:bg-white">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 print:text-slate-600">
        {label}
      </p>
      <p className={`mt-2 text-2xl font-bold tabular-nums ${tone} print:text-slate-900`}>
        {value}
      </p>
    </div>
  );
}

export default function ReportsHub() {
  const { activeClientId, activeClientData } = useClient();
  const { accounts: bankAccounts } = useBankAccounts(activeClientId);
  const [mainTab, setMainTab] = useState("quick");
  const [ledgerType, setLedgerType] = useState("pnl");
  const [preset, setPreset] = useState("month");
  const [customFrom, setCustomFrom] = useState(toYYYYMMDD());
  const [customTo, setCustomTo] = useState(toYYYYMMDD());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [partyOptions, setPartyOptions] = useState([]);
  const [selectedPartyId, setSelectedPartyId] = useState("");
  const [loadingParties, setLoadingParties] = useState(false);
  const [viewType, setViewType] = useState("invoice");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [partyFilter, setPartyFilter] = useState("all");
  const [liquidityMovementFilter, setLiquidityMovementFilter] = useState("all");
  const [bankAccountFilter, setBankAccountFilter] = useState("all");
  const [lockerDirectionFilter, setLockerDirectionFilter] = useState("all");
  const [compareYoY, setCompareYoY] = useState(false);
  const isLiquidityReport =
    ledgerType === "cash" || ledgerType === "bank" || ledgerType === "locker";

  const range = useMemo(
    () => resolveReportDateRange(preset, customFrom, customTo),
    [preset, customFrom, customTo]
  );
  const rangeLabel = formatReportRangeLabel(range.fromDate, range.toDate);
  const shopName = activeClientData?.name || activeClientId || "Shop";
  const requiresParty =
    ledgerType === "customers" || ledgerType === "vendors";
  const showPartyPicker = requiresParty || ledgerType === "loans";
  const selectedParty = useMemo(
    () => partyOptions.find((party) => party.id === selectedPartyId) || null,
    [partyOptions, selectedPartyId]
  );
  const supportsViewType = reportViewSupportsAggregation(
    ledger?.layout,
    ledgerType
  );

  const paymentFiltersPresent = useMemo(() => {
    if (
      (ledgerType !== "sales" && ledgerType !== "expense") ||
      !ledger?.rows?.length
    ) {
      return new Set();
    }
    return detectPaymentFiltersPresent(ledger.rows);
  }, [ledgerType, ledger?.rows]);

  const partyFilterOptions = useMemo(() => {
    if (
      (ledgerType !== "sales" && ledgerType !== "expense") ||
      !ledger?.rows?.length
    ) {
      return [];
    }
    return listPartiesFromRows(ledger.rows);
  }, [ledgerType, ledger?.rows]);

  const showPaymentFilter =
    (ledgerType === "sales" || ledgerType === "expense") &&
    paymentFiltersPresent.size >= 1;
  const showPartyFilter =
    (ledgerType === "sales" || ledgerType === "expense") &&
    partyFilterOptions.length > 0;

  const displayedLedger = useMemo(() => {
    if (!ledger) return ledger;

    let sourceRows = ledger.rows || [];
    const usesSalesStyleFilters =
      ledgerType === "sales" || ledgerType === "expense";
    if (usesSalesStyleFilters) {
      sourceRows = filterRowsByPayment(sourceRows, paymentFilter);
      sourceRows = filterRowsByParty(sourceRows, partyFilter);
    }

    if (isLiquidityReport) {
      sourceRows = sourceRows.filter((row) => {
        if (row?.id === "__opening__" || row?._isOpening) return true;
        if (
          liquidityMovementFilter !== "all" &&
          String(row?._movement || "") !== liquidityMovementFilter
        ) {
          return false;
        }
        if (ledgerType === "bank" && bankAccountFilter !== "all") {
          if (String(row?._accountId || "") !== bankAccountFilter) {
            return false;
          }
        }
        if (ledgerType === "locker" && lockerDirectionFilter !== "all") {
          if (String(row?._direction || "") !== lockerDirectionFilter) {
            return false;
          }
        }
        return true;
      });

      // Rebuild running balance after filters (keep opening row first).
      const openingRow = sourceRows.find(
        (row) => row?.id === "__opening__" || row?._isOpening
      );
      const movementRows = sourceRows.filter(
        (row) => !(row?.id === "__opening__" || row?._isOpening)
      );
      let balance = Number(
        openingRow?._balance ?? ledger?.liquidity?.opening ?? 0
      );
      if (!Number.isFinite(balance)) balance = 0;
      const recomputed = movementRows.map((row) => {
        const amountIn = Number(row._in || 0);
        const amountOut = Number(row._out || 0);
        balance += amountIn - amountOut;
        return {
          ...row,
          balance: formatMoney(balance),
          _balance: balance,
        };
      });
      const filteredRows = openingRow
        ? [openingRow, ...recomputed]
        : recomputed;
      const totalIn = recomputed.reduce(
        (sum, row) => sum + Number(row._in || 0),
        0
      );
      const totalOut = recomputed.reduce(
        (sum, row) => sum + Number(row._out || 0),
        0
      );
      const opening = Number(ledger?.liquidity?.opening || 0);
      return {
        ...ledger,
        rows: filteredRows,
        summary: {
          ...ledger.summary,
          opening: formatMoney(opening),
          totalIn: formatMoney(totalIn),
          totalOut: formatMoney(totalOut),
          closing: formatMoney(opening + totalIn - totalOut),
          count: String(recomputed.length),
        },
      };
    }

    const salesFiltersActive =
      usesSalesStyleFilters &&
      (paymentFilter !== "all" || partyFilter !== "all");

    if (!supportsViewType || viewType === "invoice") {
      if (!salesFiltersActive) return ledger;
      return { ...ledger, rows: sourceRows };
    }

    const balanceMode =
      ledgerType === "vendors"
        ? "ap"
        : ledgerType === "customers"
          ? "ar"
          : "cash";
    const aggregated = aggregateLedgerRows({
      rows: sourceRows,
      columns: ledger.columns || [],
      viewType,
      partyLabel: selectedParty?.name || ledger?.summary?.partyName || "",
      balanceMode,
    });
    return {
      ...ledger,
      columns: aggregated.columns,
      rows: aggregated.rows,
    };
  }, [
    ledger,
    supportsViewType,
    viewType,
    selectedParty?.name,
    ledgerType,
    paymentFilter,
    partyFilter,
    isLiquidityReport,
    liquidityMovementFilter,
    bankAccountFilter,
    lockerDirectionFilter,
  ]);

  useEffect(() => {
    setSelectedPartyId("");
    setPartyOptions([]);
    setViewType("invoice");
    setPaymentFilter("all");
    setPartyFilter("all");
    setLiquidityMovementFilter("all");
    setBankAccountFilter("all");
    setLockerDirectionFilter("all");
  }, [ledgerType, activeClientId]);

  useEffect(() => {
    if (partyFilter === "all") return;
    if (
      !partyFilterOptions.some(
        (name) => name.toLowerCase() === partyFilter.toLowerCase()
      )
    ) {
      setPartyFilter("all");
    }
  }, [partyFilterOptions, partyFilter]);

  useEffect(() => {
    if (!activeClientId || !showPartyPicker) return undefined;
    let cancelled = false;
    setLoadingParties(true);
    fetchPartiesForLedger({ clientId: activeClientId, kind: ledgerType })
      .then((rows) => {
        if (!cancelled) setPartyOptions(rows);
      })
      .catch(() => {
        if (!cancelled) setPartyOptions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingParties(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeClientId, showPartyPicker, ledgerType]);

  const loadData = useCallback(async () => {
    if (!activeClientId) {
      setSnapshot(null);
      setLedger(null);
      return;
    }
    if (mainTab === "analytics") {
      // Advanced Analytics fetches its own datasets.
      return;
    }
    setLoading(true);
    setError("");
    try {
      if (mainTab === "quick") {
        const data = await fetchQuickSnapshot({
          clientId: activeClientId,
          fromDate: range.fromDate,
          toDate: range.toDate,
        });
        setSnapshot(data);
      } else {
        const data = await fetchDetailedLedger({
          clientId: activeClientId,
          fromDate: range.fromDate,
          toDate: range.toDate,
          reportType: ledgerType,
          partyId: selectedPartyId,
          partyName: selectedParty?.name || "",
        });
        setLedger(data);
      }
    } catch (reason) {
      setError(reason?.message || "Failed to load reports.");
      if (mainTab === "quick") setSnapshot(null);
      else setLedger(null);
    } finally {
      setLoading(false);
    }
  }, [
    activeClientId,
    mainTab,
    ledgerType,
    range.fromDate,
    range.toDate,
    selectedPartyId,
    selectedParty?.name,
  ]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function handlePresetChange(next) {
    setPreset(next);
    if (next !== "custom") {
      const resolved = resolveReportDateRange(next);
      setCustomFrom(resolved.fromDate);
      setCustomTo(resolved.toDate);
    }
  }

  function handleExportCsv() {
    if (ledger?.layout === "pnl") {
      if (!ledger?.pnl) return;
      exportPnLCsv({
        filename: `profit_loss_${range.fromDate}_${range.toDate}`,
        shopName,
        rangeLabel,
        pnl: ledger.pnl,
      });
      return;
    }
    if (ledger?.layout === "cashflow") {
      if (!ledger?.cashflow) return;
      exportCashFlowCsv({
        filename: `cash_flow_${range.fromDate}_${range.toDate}`,
        shopName,
        rangeLabel,
        cashflow: ledger.cashflow,
      });
      return;
    }
    if (!displayedLedger?.rows?.length) return;
    const viewLabel =
      REPORT_VIEW_TYPES.find((item) => item.key === viewType)?.label ||
      viewType;
    exportReportCsv({
      filename: `${displayedLedger.title}_${viewType}_${range.fromDate}_${range.toDate}`,
      title: `${shopName} — ${displayedLedger.title} (${viewLabel})`,
      rangeLabel,
      columns: displayedLedger.columns,
      rows: displayedLedger.rows,
    });
  }

  function handlePrint() {
    if (ledger?.layout === "pnl") {
      if (!ledger?.pnl) return;
      printPnLDocument({
        shopName,
        rangeLabel,
        pnl: ledger.pnl,
      });
      return;
    }
    if (ledger?.layout === "cashflow") {
      if (!ledger?.cashflow) return;
      printCashFlowDocument({
        shopName,
        rangeLabel,
        cashflow: ledger.cashflow,
      });
      return;
    }
    const source =
      ledger?.layout === "due_list" ? ledger : displayedLedger;
    if (!source?.rows?.length) return;
    const viewLabel =
      REPORT_VIEW_TYPES.find((item) => item.key === viewType)?.label ||
      viewType;
    printReportDocument({
      shopName,
      title:
        supportsViewType && viewType !== "invoice"
          ? `${source.title} (${viewLabel})`
          : source.title || "Report",
      rangeLabel,
      columns: source.columns || [],
      rows: source.rows || [],
    });
  }

  const canExport =
    ledger?.layout === "pnl"
      ? Boolean(ledger?.pnl)
      : ledger?.layout === "cashflow"
        ? Boolean(ledger?.cashflow)
        : ledger?.layout === "due_list"
          ? Boolean(ledger?.rows?.some((row) => row.id !== "__grand_total__"))
          : ledger?.layout === "liquidity"
            ? Boolean(
                displayedLedger?.rows?.some(
                  (row) => !(row.id === "__opening__" || row._isOpening)
                ) || Number(ledger?.liquidity?.opening || 0) !== 0
              )
            : Boolean(displayedLedger?.rows?.length);

  if (!activeClientId) {
    return (
      <div className="p-6 text-slate-300">
        Select a shop to open the Reports Hub.
      </div>
    );
  }

  return (
    <div className="reports-hub mx-auto max-w-6xl space-y-5 p-4 sm:p-6 print:max-w-none print:bg-white print:p-0 print:text-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold text-white">Reports Hub</h1>
          <p className="mt-1 text-sm text-slate-400">{shopName}</p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-400">
          <Wallet size={14} />
          360° executive + ledger views
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <DateRangeToolbar
          preset={preset}
          onPresetChange={handlePresetChange}
          fromDate={customFrom}
          toDate={customTo}
          onFromChange={setCustomFrom}
          onToChange={setCustomTo}
          onRefresh={mainTab === "analytics" ? undefined : loadData}
          loading={loading}
        />
        {mainTab === "analytics" ? (
          <label className="mb-0.5 inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-sm text-slate-200 hover:border-blue-500/50">
            <input
              type="checkbox"
              checked={compareYoY}
              onChange={(event) => setCompareYoY(event.target.checked)}
              className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-blue-500/40"
            />
            <span className="font-semibold">Compare with Previous Year</span>
          </label>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-3 print:hidden">
        {MAIN_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = mainTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setMainTab(tab.key)}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
                active
                  ? "bg-slate-100 text-slate-950"
                  : "border border-slate-800 text-slate-300 hover:bg-slate-900"
              }`}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="rounded-xl border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-200 print:border-rose-300 print:bg-rose-50 print:text-rose-800">
          {error}
        </div>
      ) : null}

      {mainTab === "quick" ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-white print:text-slate-900">
              Quick Snapshot
            </h2>
            <p className="text-sm text-slate-400 print:text-slate-600">
              {[
                rangeLabel,
                snapshot
                  ? `${snapshot.reportCount} daily report${
                      snapshot.reportCount === 1 ? "" : "s"
                    }`
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>

          {loading && !snapshot ? (
            <div className="flex items-center gap-2 text-slate-400">
              <RefreshCw size={16} className="animate-spin" />
              Loading snapshot…
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              <KpiCard label="Total Sales" value={money(snapshot?.totalSales)} tone="text-emerald-300" />
              <KpiCard label="Total Expenses" value={money(snapshot?.totalExpenses)} tone="text-rose-300" />
              <KpiCard label="Net Cash Flow" value={money(snapshot?.netCashFlow)} tone="text-sky-300" />
              <KpiCard label="Cash in Hand" value={money(snapshot?.cashInHand)} />
              <KpiCard label="Bank Balance" value={money(snapshot?.bankBalance)} />
              <KpiCard label="Locker Balance" value={money(snapshot?.lockerBalance)} />
              <KpiCard
                label="Outstanding Receivables"
                value={money(snapshot?.totalReceivable)}
                tone="text-cyan-300"
              />
              <KpiCard
                label="Total Payables"
                value={money(snapshot?.totalPayable)}
                tone="text-amber-300"
              />
            </div>
          )}

          {!loading && snapshot && snapshot.reportCount === 0 ? (
            <p className="text-sm text-slate-400">
              No daily reports found in this range. Close days in End of Day to
              populate the Quick Snapshot.
            </p>
          ) : null}
        </section>
      ) : mainTab === "analytics" ? (
        <AdvancedAnalytics
          clientId={activeClientId}
          fromDate={range.fromDate}
          toDate={range.toDate}
          rangeLabel={rangeLabel}
          compareYoY={compareYoY}
          onCompareYoYChange={setCompareYoY}
        />
      ) : (
        <section className="space-y-4">
          <div className="flex flex-col gap-4 lg:flex-row">
            <aside className="w-full shrink-0 lg:w-56 print:hidden">
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-500 lg:hidden">
                Report type
                <select
                  value={ledgerType}
                  onChange={(event) => setLedgerType(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                >
                  {LEDGER_TYPES.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="hidden space-y-1 lg:block">
                {LEDGER_TYPES.map((item) => {
                  const active = ledgerType === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setLedgerType(item.key)}
                      className={`w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors ${
                        active
                          ? "bg-blue-600 text-white"
                          : "border border-slate-800 text-slate-300 hover:bg-slate-900"
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </aside>

            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-white print:text-slate-900">
                    {ledger?.title ||
                      LEDGER_TYPES.find((item) => item.key === ledgerType)
                        ?.label ||
                      "Report"}
                  </h2>
                  <p className="text-sm text-slate-400 print:text-slate-600">
                    {[
                      rangeLabel,
                      ledger?.summary?.sales
                        ? `Sales ${ledger.summary.sales}`
                        : "",
                      ledger?.summary?.expenses
                        ? `Expenses ${ledger.summary.expenses}`
                        : "",
                      ledger?.summary?.cash
                        ? `Cash ${ledger.summary.cash}`
                        : "",
                      ledger?.summary?.bank
                        ? `Bank ${ledger.summary.bank}`
                        : "",
                      ledger?.summary?.credit
                        ? `Credit ${ledger.summary.credit}`
                        : "",
                      ledger?.summary?.acquired
                        ? `Acquired ${ledger.summary.acquired}`
                        : "",
                      ledger?.summary?.repaid
                        ? `Repaid ${ledger.summary.repaid}`
                        : "",
                      ledger?.summary?.outstanding
                        ? `Outstanding ${ledger.summary.outstanding}`
                        : "",
                      ledger?.summary?.grandTotal
                        ? `Grand total ${ledger.summary.grandTotal}`
                        : "",
                      ledger?.summary?.totalOut
                        ? `Total out ${ledger.summary.totalOut}`
                        : "",
                      displayedLedger?.summary?.opening && isLiquidityReport
                        ? `Opening ${displayedLedger.summary.opening}`
                        : "",
                      displayedLedger?.summary?.totalIn && isLiquidityReport
                        ? `In ${displayedLedger.summary.totalIn}`
                        : "",
                      displayedLedger?.summary?.totalOut && isLiquidityReport
                        ? `Out ${displayedLedger.summary.totalOut}`
                        : "",
                      displayedLedger?.summary?.closing && isLiquidityReport
                        ? `Closing ${displayedLedger.summary.closing}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 print:hidden">
                  <button
                    type="button"
                    onClick={handleExportCsv}
                    disabled={loading || !canExport}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                  >
                    <Download size={15} />
                    Export CSV
                  </button>
                  <button
                    type="button"
                    onClick={handlePrint}
                    disabled={loading || !canExport}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
                  >
                    <Printer size={15} />
                    Print / PDF
                  </button>
                </div>
              </div>

              {showPartyPicker ? (
                <div className="print:hidden">
                  <PartySearchSelect
                    parties={partyOptions}
                    value={selectedPartyId}
                    onChange={setSelectedPartyId}
                    loading={loadingParties}
                    label={
                      ledgerType === "loans"
                        ? "Party / Lender"
                        : `Select ${
                            ledgerType === "customers" ? "Customer" : "Vendor"
                          }`
                    }
                    placeholder={
                      ledgerType === "loans"
                        ? "Search party name…"
                        : ledgerType === "customers"
                          ? "Search customer…"
                          : "Search vendor…"
                    }
                    emptyLabel={
                      ledgerType === "loans"
                        ? "No matching parties."
                        : ledgerType === "customers"
                          ? "No matching customers."
                          : "No matching vendors."
                    }
                    allowClear={ledgerType === "loans"}
                    clearLabel="All parties"
                  />
                </div>
              ) : null}

              {supportsViewType ||
              showPaymentFilter ||
              showPartyFilter ||
              isLiquidityReport ? (
                <div className="flex flex-wrap items-end gap-3 print:hidden">
                  {supportsViewType && !isLiquidityReport ? (
                    <label className="block min-w-[11rem] max-w-xs flex-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Report type
                      <select
                        value={viewType}
                        onChange={(event) => setViewType(event.target.value)}
                        className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-normal normal-case tracking-normal text-white"
                      >
                        {REPORT_VIEW_TYPES.map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  {showPartyFilter ? (
                    <label className="block min-w-[11rem] max-w-xs flex-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Party
                      <select
                        value={partyFilter}
                        onChange={(event) => setPartyFilter(event.target.value)}
                        className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-normal normal-case tracking-normal text-white"
                      >
                        <option value="all">All parties</option>
                        {partyFilterOptions.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  {showPaymentFilter ? (
                    <label className="block min-w-[11rem] max-w-xs flex-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Payment
                      <select
                        value={paymentFilter}
                        onChange={(event) =>
                          setPaymentFilter(event.target.value)
                        }
                        className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-normal normal-case tracking-normal text-white"
                      >
                        {PAYMENT_FILTER_OPTIONS.filter(
                          (item) =>
                            item.key === "all" ||
                            paymentFiltersPresent.has(item.key)
                        ).map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  {isLiquidityReport && ledgerType !== "locker" ? (
                    <label className="block min-w-[11rem] max-w-xs flex-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Movement
                      <select
                        value={liquidityMovementFilter}
                        onChange={(event) =>
                          setLiquidityMovementFilter(event.target.value)
                        }
                        className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-normal normal-case tracking-normal text-white"
                      >
                        {LIQUIDITY_MOVEMENT_OPTIONS.map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  {ledgerType === "bank" ? (
                    <label className="block min-w-[11rem] max-w-xs flex-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Bank account
                      <select
                        value={bankAccountFilter}
                        onChange={(event) =>
                          setBankAccountFilter(event.target.value)
                        }
                        className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-normal normal-case tracking-normal text-white"
                      >
                        <option value="all">All accounts</option>
                        {bankAccounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.accountName || account.id}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  {ledgerType === "locker" ? (
                    <label className="block min-w-[11rem] max-w-xs flex-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Direction
                      <select
                        value={lockerDirectionFilter}
                        onChange={(event) =>
                          setLockerDirectionFilter(event.target.value)
                        }
                        className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-normal normal-case tracking-normal text-white"
                      >
                        {LOCKER_DIRECTION_OPTIONS.map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              ) : null}

              {loading && !ledger ? (
                <div className="flex items-center gap-2 text-slate-400">
                  <RefreshCw size={16} className="animate-spin" />
                  Loading ledger…
                </div>
              ) : (
                <div className="report-print-surface rounded-2xl border border-slate-800 bg-slate-900/40 p-3 sm:p-4 print:border-0 print:bg-white print:p-0">
                  {isLiquidityReport && displayedLedger?.summary ? (
                    <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <KpiCard
                        label="Opening"
                        value={displayedLedger.summary.opening}
                      />
                      <KpiCard
                        label="Total In"
                        value={displayedLedger.summary.totalIn}
                        tone="text-emerald-300"
                      />
                      <KpiCard
                        label="Total Out"
                        value={displayedLedger.summary.totalOut}
                        tone="text-rose-300"
                      />
                      <KpiCard
                        label="Closing"
                        value={displayedLedger.summary.closing}
                        tone="text-sky-300"
                      />
                    </div>
                  ) : null}
                  {ledger?.layout === "pnl" ? (
                    <ProfitLossStatement
                      pnl={ledger?.pnl}
                      emptyMessage="No P&L data for this range."
                    />
                  ) : ledger?.layout === "cashflow" ? (
                    <CashFlowStatement
                      cashflow={ledger?.cashflow}
                      emptyMessage="No cash flow data for this range."
                    />
                  ) : ledger?.layout === "due_list" ? (
                    <DueBalanceList
                      columns={ledger?.columns || []}
                      rows={ledger?.rows || []}
                      asOfLabel={
                        formatIsoDate(ledger?.asOfDate || range.toDate) ||
                        range.toDate
                      }
                      emptyMessage={
                        ledgerType === "receivables"
                          ? "No customers with outstanding receivables."
                          : "No vendors with outstanding payables."
                      }
                    />
                  ) : requiresParty && !selectedPartyId ? (
                    <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-10 text-center text-sm text-slate-400">
                      Select a{" "}
                      {ledgerType === "customers" ? "customer" : "vendor"} to
                      view their historical ledger.
                    </div>
                  ) : (
                    <ReportTable
                      columns={displayedLedger?.columns || []}
                      rows={displayedLedger?.rows || []}
                      emptyMessage="No ledger rows for this range and report type."
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
