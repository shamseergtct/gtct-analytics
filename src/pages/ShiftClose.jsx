import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { ChevronDown, CircleHelp, Eye, EyeOff, Plus, Trash2, X } from "lucide-react";
import { db } from "../firebase";
import { useAuth } from "../context/AuthContext";
import { useClient } from "../context/ClientContext";
import { useShift } from "../context/shift-context";
import DateInput from "../components/DateInput.jsx";
import ModuleExitButton from "../components/ModuleExitButton.jsx";
import ModuleHelpButton from "../components/ModuleHelpButton.jsx";
import BankAccountSearchSelect from "../components/BankAccountSearchSelect.jsx";
import { useBankAccounts } from "../hooks/useBankAccounts.js";
import { useShiftExpectedCash } from "../hooks/useShiftExpectedCash.js";
import { usePosSalesTotals } from "../hooks/usePosSalesTotals.js";
import { useExternalSalesTotals } from "../hooks/useExternalSalesTotals.js";
import { useEstimatedLiquidity } from "../hooks/useEstimatedBankBalance.js";
import { formatIsoDate } from "../utils/dateFormat.js";
import { useMoney } from "../hooks/useMoney.js";
import {
  formatMoney,
  formatMoneyLocale,
  roundMoney,
  toMinorUnits,
} from "../utils/money.js";

function todayYYYYMMDD() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function nonNegativeNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be zero or greater.`);
  }
  return parsed;
}

function toCents(value, decimals) {
  return toMinorUnits(value, decimals);
}

function sumEntryAmounts(entries) {
  return entries.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
}

function formatAmountDisplay(value, decimals) {
  return formatMoney(value, decimals);
}

function moneyHint(value, decimals) {
  return formatMoneyLocale(value, decimals);
}

/**
 * Canonical Z-report sales math:
 *   Net  = Cash + Bank
 *   Gross = Net + Credit = Cash + Bank + Credit
 */
function deriveZReportSalesTotals({
  cashTotal = 0,
  bankTotal = 0,
  creditSalesTotal = 0,
  decimals,
} = {}) {
  const cash = roundMoney(cashTotal, decimals);
  const bank = roundMoney(bankTotal, decimals);
  const credit = roundMoney(creditSalesTotal, decimals);
  const netSales = roundMoney(cash + bank, decimals);
  const grossSales = roundMoney(netSales + credit, decimals);
  return { cashTotal: cash, bankTotal: bank, creditSalesTotal: credit, netSales, grossSales };
}

function createBankEntry(overrides = {}) {
  return {
    rowId: crypto.randomUUID(),
    bankAccountId: "",
    bankAccountName: "",
    amount: "",
    ...overrides,
  };
}

function ExpectedCashHint({
  clientId,
  businessDate,
  openingFloat,
  shiftId,
  cashTotal,
  shiftOpeningFloat,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const hint = useShiftExpectedCash({
    clientId,
    businessDate,
    openingFloat,
    shiftId,
    cashTotal,
    shiftOpeningFloat,
  });

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-400 hover:bg-slate-800 hover:text-blue-300"
        aria-label="Show expected cash breakdown"
        title="Expected cash hint"
      >
        <CircleHelp className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-30 mt-2 w-80 rounded-xl border border-slate-700 bg-slate-950 p-3 shadow-xl shadow-black/40">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Expected Cash
            </p>
            <p className="text-sm font-semibold text-white">
              {hint.loading ? "…" : moneyHint(hint.expectedCash)}
            </p>
          </div>
          <p className="mt-1 text-[10px] text-slate-500">
            Z cash is terminal-only. External + Collect always add separately.
          </p>
          <div className="mt-3 space-y-1.5 border-t border-slate-800 pt-3 text-xs text-slate-300">
            <div className="flex justify-between gap-3">
              <span>Last closed day</span>
              <span className="tabular-nums text-slate-200">
                {moneyHint(hint.openingFloat)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span>Z cash entered</span>
              <span className="tabular-nums text-slate-200">
                {moneyHint(hint.zCashEntered)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span>
                Sales module cash
                {Number(hint.zCashEntered) > 0 ? " (not used)" : ""}
              </span>
              <span className="tabular-nums text-slate-200">
                {moneyHint(hint.posCashSales)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span>External cash bills</span>
              <span className="tabular-nums text-slate-200">
                {moneyHint(hint.externalCashSales)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span>Delivery collect (cash sale)</span>
              <span className="tabular-nums text-slate-200">
                {moneyHint(hint.collectionCash)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span>Today&apos;s cash sales (used)</span>
              <span className="tabular-nums text-slate-200">
                {moneyHint(hint.todaySales)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span>Other cash in/out</span>
              <span className="tabular-nums text-slate-200">
                {moneyHint(hint.expenseNet)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span>Loan</span>
              <span className="tabular-nums text-slate-200">
                {moneyHint(hint.loanNet)}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </span>
  );
}

function createCreditEntry() {
  return {
    rowId: crypto.randomUUID(),
    partyId: "",
    partyName: "",
    amount: "",
  };
}

function createCashEntry() {
  return createCreditEntry();
}

const EMPTY_Z_REPORT = {
  businessDate: todayYYYYMMDD(),
  grossSales: "0",
  netSales: "0",
  cashTotal: "0",
  bankTotal: "0",
  creditSalesTotal: "0",
};

/** Stable identity for one Z-report per day (no terminal / report number UI). */
function dayReportIdentity(businessDate) {
  const date = String(businessDate || todayYYYYMMDD()).trim();
  return { reportNo: date || "DAY", terminalId: "DAY" };
}

function zReportBankTotalFromDoc(report) {
  if (report?.bankTotal != null && report.bankTotal !== "") {
    return Number(report.bankTotal) || 0;
  }
  return (Number(report?.cardTotal) || 0) + (Number(report?.qrTotal) || 0);
}

function bankEntriesFromDoc(report) {
  if (Array.isArray(report?.bankEntries) && report.bankEntries.length) {
    return report.bankEntries;
  }
  if (Array.isArray(report?.cardEntries) && report.cardEntries.length) {
    return report.cardEntries;
  }
  // Legacy reports may only have bankTotal — seed one row so edit/save
  // does not wipe the stored total when breakdown rows are missing.
  const legacyBank = zReportBankTotalFromDoc(report);
  if (legacyBank > 0) {
    return [
      {
        bankAccountId: "",
        bankAccountName: "",
        amount: legacyBank,
      },
    ];
  }
  return [];
}

function cashEntriesFromDoc(report) {
  if (Array.isArray(report?.cashEntries) && report.cashEntries.length) {
    return report.cashEntries;
  }
  const legacyCash = Number(report?.cashTotal) || 0;
  if (legacyCash > 0) {
    return [{ partyId: "", partyName: "", amount: legacyCash }];
  }
  return [];
}

function BankEntryRow({ entry, accounts, onChange, onRemove }) {
  const { step, sample } = useMoney();
  return (
    <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3 sm:grid-cols-[minmax(0,1fr)_180px_42px] sm:items-end">
      <BankAccountSearchSelect
        accounts={accounts}
        value={entry.bankAccountId || ""}
        onChange={(nextId) => {
          const selected = accounts.find((account) => account.id === nextId);
          onChange({
            ...entry,
            bankAccountId: nextId,
            bankAccountName: selected?.accountName || "",
          });
        }}
        label="Bank Account"
        placeholder="Search bank account…"
        required={Boolean(entry.amount)}
        className="mt-0"
      />

      <label className="block text-xs font-medium text-slate-400">
        Amount
        <input
          type="number"
          min="0"
          step={step}
          value={entry.amount}
          onChange={(event) => onChange({ ...entry, amount: event.target.value })}
          className="mt-1.5 h-[42px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={sample}
        />
      </label>

      <button
        type="button"
        onClick={onRemove}
        className="inline-flex h-[42px] w-[42px] items-center justify-center rounded-lg border border-red-900/60 text-red-300 hover:bg-red-950/40 sm:self-end"
        aria-label="Remove bank entry"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function CreditEntryRow({
  entry,
  parties,
  onChange,
  onRemove,
  onQuickAddCustomer,
}) {
  const { step, sample } = useMoney();
  const containerRef = useRef(null);
  const [search, setSearch] = useState(entry.partyName || "");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerContact, setNewCustomerContact] = useState("");
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [quickAddError, setQuickAddError] = useState("");

  useEffect(() => {
    function closeOverlays(event) {
      if (!containerRef.current?.contains(event.target)) {
        setDropdownOpen(false);
        setQuickAddOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeOverlays);
    return () => document.removeEventListener("pointerdown", closeOverlays);
  }, []);

  const filteredParties = useMemo(() => {
    const term = search.trim().toLowerCase();
    return parties
      .filter((party) => {
        if (!term) return true;
        return `${party.name || ""} ${party.contact || ""}`
          .toLowerCase()
          .includes(term);
      })
      .slice(0, 20);
  }, [parties, search]);

  async function saveCustomer() {
    if (!newCustomerName.trim()) return;
    setQuickAddError("");
    setSavingCustomer(true);
    try {
      const party = await onQuickAddCustomer({
        name: newCustomerName,
        contact: newCustomerContact,
      });
      setSearch(party.name);
      onChange({ ...entry, partyId: party.id, partyName: party.name });
      setNewCustomerName("");
      setNewCustomerContact("");
      setQuickAddOpen(false);
    } catch (reason) {
      setQuickAddError(reason?.message || "Failed to add customer.");
    } finally {
      setSavingCustomer(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3 sm:grid-cols-[minmax(0,1fr)_180px_42px] sm:items-end">
      <div ref={containerRef} className="relative">
        <label className="block text-xs font-medium text-slate-400">
          Customer
        </label>
        <div className="mt-1.5 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <input
              value={search}
              autoComplete="off"
              onFocus={() => setDropdownOpen(true)}
              onChange={(event) => {
                setSearch(event.target.value);
                setDropdownOpen(true);
                onChange({ ...entry, partyId: "", partyName: "" });
              }}
              className="h-[42px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Search customer"
            />
            {dropdownOpen ? (
              <div className="absolute z-30 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 p-1 shadow-2xl">
                {filteredParties.length ? (
                  filteredParties.map((party) => (
                    <button
                      key={party.id}
                      type="button"
                      onClick={() => {
                        setSearch(party.name || "");
                        onChange({
                          ...entry,
                          partyId: party.id,
                          partyName: party.name || "",
                        });
                        setDropdownOpen(false);
                      }}
                      className="flex w-full justify-between rounded-md px-3 py-2 text-left text-sm text-white hover:bg-slate-800"
                    >
                      <span>{party.name || "Unnamed customer"}</span>
                      <span className="text-xs text-slate-500">
                        {party.type || "Customer"}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-2 text-sm text-slate-500">
                    No matching customers.
                  </div>
                )}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => {
              setQuickAddOpen((current) => !current);
              setDropdownOpen(false);
            }}
            className="inline-flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-white hover:bg-slate-800"
            aria-label="Quick add customer"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {quickAddOpen ? (
          <div className="absolute z-40 mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-white">
                Quick Add Customer
              </span>
              <button
                type="button"
                onClick={() => setQuickAddOpen(false)}
                className="text-slate-400 hover:text-white"
                aria-label="Close quick add customer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <input
              value={newCustomerName}
              onChange={(event) => setNewCustomerName(event.target.value)}
              className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Customer name"
            />
            <input
              value={newCustomerContact}
              onChange={(event) => setNewCustomerContact(event.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Contact"
            />
            {quickAddError ? (
              <div className="mt-2 text-xs text-red-300">{quickAddError}</div>
            ) : null}
            <button
              type="button"
              disabled={savingCustomer || !newCustomerName.trim()}
              onClick={saveCustomer}
              className="mt-3 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
            >
              {savingCustomer ? "Saving…" : "Save Customer"}
            </button>
          </div>
        ) : null}
      </div>

      <label className="block text-xs font-medium text-slate-400">
        Amount
        <input
          type="number"
          min="0"
          step={step}
          value={entry.amount}
          onChange={(event) => onChange({ ...entry, amount: event.target.value })}
          className="mt-1.5 h-[42px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={sample}
        />
      </label>

      <button
        type="button"
        onClick={onRemove}
        className="inline-flex h-[42px] w-[42px] items-center justify-center rounded-lg border border-red-900/60 text-red-300 hover:bg-red-950/40 sm:self-end"
        aria-label="Remove credit entry"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function TenderTotalCards({ cashTotal, bankTotal, creditTotal, loading }) {
  return (
    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">
          Cash
        </span>
        <p className="mt-0.5 text-sm font-semibold tabular-nums text-slate-100">
          {loading ? "…" : moneyHint(cashTotal)}
        </p>
      </div>
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">
          Bank
        </span>
        <p className="mt-0.5 text-sm font-semibold tabular-nums text-slate-100">
          {loading ? "…" : moneyHint(bankTotal)}
        </p>
      </div>
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">
          Credit
        </span>
        <p className="mt-0.5 text-sm font-semibold tabular-nums text-slate-100">
          {loading ? "…" : moneyHint(creditTotal)}
        </p>
      </div>
    </div>
  );
}

/**
 * Collapsible day sales view: Sales module + External + Z entry displays,
 * plus a combined day totals card (POS + External + Z).
 */
function DaySalesModule({
  clientId,
  businessDate,
  shiftId,
  cashTotal = 0,
  bankTotal = 0,
  creditTotal = 0,
}) {
  const { decimals } = useMoney();
  const pos = usePosSalesTotals({ clientId, businessDate, shiftId });
  const external = useExternalSalesTotals({ clientId, businessDate });
  const [open, setOpen] = useState(true);

  const zTotals = deriveZReportSalesTotals({
    cashTotal,
    bankTotal,
    creditSalesTotal: creditTotal,
    decimals,
  });

  const dayLoading = pos.loading || external.loading;
  const dayCashSale = roundMoney(
    (Number(pos.cashTotal) || 0) +
      (Number(external.cashTotal) || 0) +
      (Number(zTotals.cashTotal) || 0),
    decimals
  );
  const dayBankSale = roundMoney(
    (Number(pos.bankTotal) || 0) +
      (Number(external.bankTotal) || 0) +
      (Number(zTotals.bankTotal) || 0),
    decimals
  );
  const dayNetSale = roundMoney(dayCashSale + dayBankSale, decimals);
  const dayCreditSale = roundMoney(
    (Number(pos.creditTotal) || 0) +
      (Number(external.creditTotal) || 0) +
      (Number(zTotals.creditSalesTotal) || 0),
    decimals
  );
  const dayGrossSale = roundMoney(dayNetSale + dayCreditSale, decimals);

  return (
    <section className="mt-4 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-900/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/50"
        aria-expanded={open}
        aria-controls="day-sales-module-panel"
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-white">Day Sales</div>
        </div>
        <ChevronDown
          className={`h-5 w-5 shrink-0 text-slate-400 transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          id="day-sales-module-panel"
          className="space-y-3 border-t border-slate-800 px-4 py-4"
        >
          <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-300/90">
                Day totals
              </p>
              <p className="text-[11px] text-slate-500">
                Sales module + External + Z entry
              </p>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-amber-900/40 bg-slate-950/40 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">
                  Net Sale
                </div>
                <p className="mt-0.5 text-sm font-semibold tabular-nums text-slate-100">
                  {dayLoading ? "…" : moneyHint(dayNetSale)}
                </p>
                <p className="mt-1 text-[11px] tabular-nums text-slate-500">
                  Cash {dayLoading ? "…" : moneyHint(dayCashSale)}
                  {" · "}
                  Bank {dayLoading ? "…" : moneyHint(dayBankSale)}
                </p>
              </div>
              <div className="rounded-lg border border-amber-900/40 bg-slate-950/40 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">
                  Credit Sale
                </div>
                <p className="mt-0.5 text-sm font-semibold tabular-nums text-slate-100">
                  {dayLoading ? "…" : moneyHint(dayCreditSale)}
                </p>
              </div>
              <div className="rounded-lg border border-amber-900/40 bg-slate-950/40 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">
                  Gross Sale
                </div>
                <p className="mt-0.5 text-sm font-semibold tabular-nums text-slate-100">
                  {dayLoading ? "…" : moneyHint(dayGrossSale)}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-sky-900/50 bg-sky-950/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-sky-300/90">
                Sales module totals
              </p>
              <p className="text-[11px] text-slate-500">
                {pos.loading
                  ? "Loading…"
                  : `${pos.invoiceCount} invoice${pos.invoiceCount === 1 ? "" : "s"}`}
              </p>
            </div>
            <TenderTotalCards
              cashTotal={pos.cashTotal}
              bankTotal={pos.bankTotal}
              creditTotal={pos.creditTotal}
              loading={pos.loading}
            />
          </div>

          <div className="rounded-xl border border-violet-900/50 bg-violet-950/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-violet-300/90">
                External sales totals
              </p>
              <p className="text-[11px] text-slate-500">
                {external.loading
                  ? "Loading…"
                  : `${external.billCount} bill${external.billCount === 1 ? "" : "s"}`}
              </p>
            </div>
            <TenderTotalCards
              cashTotal={external.cashTotal}
              bankTotal={external.bankTotal}
              creditTotal={external.creditTotal}
              loading={external.loading}
            />
            {!external.loading &&
            (external.collectionCash > 0 || external.collectionBank > 0) ? (
              <p className="mt-2 text-[11px] text-violet-200/80">
                Delivery collect (counts as sale): Cash{" "}
                {moneyHint(external.collectionCash)}
                {external.collectionBank > 0
                  ? ` · Bank ${moneyHint(external.collectionBank)}`
                  : ""}
              </p>
            ) : null}
            {!external.loading && external.deliveryOutstanding > 0 ? (
              <p className="mt-1 text-[11px] text-violet-200/70">
                Delivery boy still outstanding:{" "}
                {moneyHint(external.deliveryOutstanding)}
              </p>
            ) : null}
          </div>

          <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/20 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-300/90">
              Z sales entry
            </p>
            <TenderTotalCards
              cashTotal={zTotals.cashTotal}
              bankTotal={zTotals.bankTotal}
              creditTotal={zTotals.creditSalesTotal}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}



export default function ShiftClose() {
  const { user } = useAuth();
  const { activeClientId, activeClientData } = useClient();
  const { step: moneyStep } = useMoney();
  const {
    activeShift,
    loadingShift,
    shiftError,
    saveZReport,
    updateClosedZReport,
  } = useShift();
  const { accounts: bankAccounts } = useBankAccounts(activeClientId);
  const [closeOpeningFloat, setCloseOpeningFloat] = useState("0");
  const [closingCashCounted, setClosingCashCounted] = useState("0");
  const [zReport, setZReport] = useState(EMPTY_Z_REPORT);
  const openBusinessDate =
    activeShift?.businessDate || zReport.businessDate || todayYYYYMMDD();
  const { floatingCash, hasPreviousClosing } = useEstimatedLiquidity(
    activeClientId,
    openBusinessDate
  );
  const shiftOpeningFloat = Number(activeShift?.openingFloat);
  const resolvedOpeningFloat = hasPreviousClosing
    ? Number(floatingCash ?? 0)
    : Number.isFinite(shiftOpeningFloat)
      ? shiftOpeningFloat
      : Number(floatingCash ?? closeOpeningFloat ?? 0);
  const [cashEntries, setCashEntries] = useState([createCashEntry()]);
  const [creditEntries, setCreditEntries] = useState([createCreditEntry()]);
  const [bankEntries, setBankEntries] = useState([createBankEntry()]);
  const [customerParties, setCustomerParties] = useState([]);
  const [recentZReports, setRecentZReports] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [showRecentReports, setShowRecentReports] = useState(true);
  const [zReportDateFilter, setZReportDateFilter] = useState("");
  const [editingReport, setEditingReport] = useState(null);
  const [editZReport, setEditZReport] = useState(null);
  const [editOpeningFloat, setEditOpeningFloat] = useState("0");
  const [editClosingCash, setEditClosingCash] = useState("0");
  const [editCashEntries, setEditCashEntries] = useState([]);
  const [editCreditEntries, setEditCreditEntries] = useState([]);
  const [editBankEntries, setEditBankEntries] = useState([]);
  const [savingEdit, setSavingEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [dayZReports, setDayZReports] = useState([]);
  const autoEditOpenedForRef = useRef("");

  const currentBusinessDate =
    activeShift?.businessDate || zReport.businessDate || todayYYYYMMDD();

  const existingReportForDate = useMemo(() => {
    if (!currentBusinessDate) return null;
    const rows = dayZReports.filter(
      (report) => String(report.businessDate || "") === currentBusinessDate
    );
    if (!rows.length) return null;
    return [...rows].sort(
      (a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0)
    )[0];
  }, [currentBusinessDate, dayZReports]);

  useEffect(() => {
    if (!activeShift?.id) return;
    setZReport((current) => ({
      ...current,
      businessDate: activeShift.businessDate || current.businessDate,
    }));
  }, [activeShift?.id, activeShift?.businessDate]);

  useEffect(() => {
    if (floatingCash == null) return;
    if (hasPreviousClosing) {
      setCloseOpeningFloat(formatAmountDisplay(floatingCash));
      return;
    }
    if (Number.isFinite(shiftOpeningFloat)) {
      setCloseOpeningFloat(formatAmountDisplay(shiftOpeningFloat));
    } else {
      setCloseOpeningFloat(formatAmountDisplay(floatingCash));
    }
  }, [floatingCash, hasPreviousClosing, shiftOpeningFloat]);

  useEffect(() => {
    if (!activeClientId) return undefined;
    const partiesQuery = query(
      collection(db, "parties"),
      where("clientId", "==", activeClientId),
      where("type", "in", [
        "Customer",
        "customer",
        "CUSTOMER",
        "Both",
        "both",
        "BOTH",
      ]),
      orderBy("name", "asc"),
      limit(250)
    );
    const timingLabel = `Shift Operation: Customer Listener ${activeClientId}`;
    console.time(timingLabel);
    let initialSnapshotPending = true;
    return onSnapshot(
      partiesQuery,
      (snapshot) => {
        if (initialSnapshotPending) {
          console.timeEnd(timingLabel);
          initialSnapshotPending = false;
        }
        setCustomerParties(
          snapshot.docs
            .map((item) => ({ id: item.id, ...item.data() }))
        );
      },
      (reason) => {
        if (initialSnapshotPending) {
          console.timeEnd(timingLabel);
          initialSnapshotPending = false;
        }
        setError(reason?.message || "Failed to load customers.");
      }
    );
  }, [activeClientId]);

  useEffect(() => {
    if (!activeClientId || !currentBusinessDate) {
      setDayZReports([]);
      return undefined;
    }
    const dayQuery = query(
      collection(db, "z_reports"),
      where("clientId", "==", activeClientId),
      where("businessDate", "==", currentBusinessDate),
      limit(10)
    );
    const unsub = onSnapshot(
      dayQuery,
      (snapshot) => {
        setDayZReports(
          snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        );
      },
      () => setDayZReports([])
    );
    return () => unsub();
  }, [activeClientId, currentBusinessDate]);

  useEffect(() => {
    if (!activeClientId || !showRecentReports) return undefined;
    setLoadingHistory(true);
    const reportConstraints = [
      where("clientId", "==", activeClientId),
      ...(zReportDateFilter
        ? [where("businessDate", "==", zReportDateFilter)]
        : [orderBy("businessDate", "desc")]),
      orderBy("createdAtMs", "desc"),
      limit(50),
    ];
    const reportsQuery = query(
      collection(db, "z_reports"),
      ...reportConstraints
    );
    const timingLabel = `Shift Operation: Z-Report Listener ${activeClientId}:${zReportDateFilter || "recent"}`;
    console.time(timingLabel);
    let initialSnapshotPending = true;
    return onSnapshot(
      reportsQuery,
      (snapshot) => {
        if (initialSnapshotPending) {
          console.timeEnd(timingLabel);
          initialSnapshotPending = false;
        }
        setRecentZReports(
          snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        );
        setLoadingHistory(false);
      },
      (reason) => {
        if (initialSnapshotPending) {
          console.timeEnd(timingLabel);
          initialSnapshotPending = false;
        }
        setError(reason?.message || "Failed to load Z-report history.");
        setLoadingHistory(false);
      }
    );
  }, [activeClientId, showRecentReports, zReportDateFilter]);

  const filteredZReports = useMemo(
    () =>
      zReportDateFilter
        ? recentZReports.filter(
            (report) => String(report.businessDate || "") === zReportDateFilter
          )
        : recentZReports,
    [recentZReports, zReportDateFilter]
  );

  const liveCashTotal = useMemo(
    () => sumEntryAmounts(cashEntries),
    [cashEntries]
  );
  const liveBankTotal = useMemo(
    () => sumEntryAmounts(bankEntries),
    [bankEntries]
  );
  const liveCreditTotal = useMemo(
    () => sumEntryAmounts(creditEntries),
    [creditEntries]
  );
  const editLiveCashTotal = useMemo(
    () => sumEntryAmounts(editCashEntries),
    [editCashEntries]
  );
  const editLiveBankTotal = useMemo(
    () => sumEntryAmounts(editBankEntries),
    [editBankEntries]
  );
  const editLiveCreditTotal = useMemo(
    () => sumEntryAmounts(editCreditEntries),
    [editCreditEntries]
  );

  function updateCashEntry(rowId, nextEntry) {
    setCashEntries((current) =>
      current.map((entry) => (entry.rowId === rowId ? nextEntry : entry))
    );
  }

  function updateCreditEntry(rowId, nextEntry) {
    setCreditEntries((current) =>
      current.map((entry) => (entry.rowId === rowId ? nextEntry : entry))
    );
  }

  function updateBankEntry(rowId, nextEntry) {
    setBankEntries((current) =>
      current.map((entry) => (entry.rowId === rowId ? nextEntry : entry))
    );
  }

  function normalizePopulatedCashEntries(entries) {
    const populated = entries.filter(
      (entry) =>
        entry.partyId ||
        entry.partyName ||
        Number(entry.amount || 0) !== 0
    );
    for (const entry of populated) {
      if (!entry.partyId || !entry.partyName) {
        throw new Error("Select a customer for every cash entry.");
      }
      if (!Number.isFinite(Number(entry.amount)) || Number(entry.amount) <= 0) {
        throw new Error("Every cash entry amount must be greater than zero.");
      }
    }
    return populated.map(({ partyId, partyName, amount }) => ({
      partyId,
      partyName,
      amount: Number(amount),
    }));
  }

  function normalizePopulatedBankEntries(entries) {
    const populated = entries.filter(
      (entry) =>
        entry.bankAccountId ||
        String(entry.bankAccountName || "").trim() ||
        Number(entry.amount || 0) !== 0
    );
    for (const entry of populated) {
      if (!entry.bankAccountId || !String(entry.bankAccountName || "").trim()) {
        throw new Error("Select a bank account for every bank entry.");
      }
      if (!Number.isFinite(Number(entry.amount)) || Number(entry.amount) <= 0) {
        throw new Error("Every bank entry amount must be greater than zero.");
      }
    }
    return populated.map(({ bankAccountId, bankAccountName, amount }) => ({
      bankAccountId,
      bankAccountName,
      amount: Number(amount),
    }));
  }

  async function quickAddCustomer({ name, contact }) {
    if (!activeClientId || !user?.uid) {
      throw new Error("Select a shop and sign in before adding a customer.");
    }
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("Customer name is required.");

    const partyRef = doc(collection(db, "parties"));
    console.time("Shift Operation: Quick Add Customer");
    try {
      await setDoc(partyRef, {
        clientId: activeClientId,
        name: cleanName,
        contact: String(contact || "").trim(),
        type: "Customer",
        taxNumber: "",
        createdBy: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } finally {
      console.timeEnd("Shift Operation: Quick Add Customer");
    }

    const party = {
      id: partyRef.id,
      name: cleanName,
      contact: String(contact || "").trim(),
      type: "Customer",
    };
    setCustomerParties((current) =>
      current.some((item) => item.id === party.id)
        ? current
        : [...current, party].sort((a, b) =>
            String(a.name || "").localeCompare(String(b.name || ""))
          )
    );
    return party;
  }

  async function openEditReport(report) {
    setError("");
    try {
      const shiftSnapshot = await getDoc(doc(db, "shifts", report.shiftId));
      if (!shiftSnapshot.exists()) {
        throw new Error("The linked shift could not be found.");
      }
      setEditingReport(report);
      setEditZReport({
        businessDate: report.businessDate || "",
        grossSales: formatAmountDisplay(report.grossSales ?? 0),
        netSales: formatAmountDisplay(report.netSales ?? 0),
        cashTotal: formatAmountDisplay(report.cashTotal ?? 0),
        bankTotal: formatAmountDisplay(zReportBankTotalFromDoc(report)),
        creditSalesTotal: formatAmountDisplay(report.creditSalesTotal ?? 0),
      });
      setEditClosingCash(
        formatAmountDisplay(shiftSnapshot.data()?.closingCashCounted ?? 0)
      );
      setEditOpeningFloat(
        formatAmountDisplay(
          report.openingFloat ?? shiftSnapshot.data()?.openingFloat ?? 0
        )
      );
      const savedCashEntries = cashEntriesFromDoc(report).map((entry) => ({
        rowId: crypto.randomUUID(),
        partyId: entry.partyId || "",
        partyName: entry.partyName || "",
        amount:
          entry.amount === "" || entry.amount == null
            ? ""
            : formatAmountDisplay(entry.amount),
      }));
      setEditCashEntries(
        savedCashEntries.length ? savedCashEntries : [createCashEntry()]
      );
      const savedEntries = (
        Array.isArray(report.creditEntries) ? report.creditEntries : []
      ).map((entry) => ({
        rowId: crypto.randomUUID(),
        partyId: entry.partyId || "",
        partyName: entry.partyName || "",
        amount:
          entry.amount === "" || entry.amount == null
            ? ""
            : formatAmountDisplay(entry.amount),
      }));
      setEditCreditEntries(
        savedEntries.length ? savedEntries : [createCreditEntry()]
      );
      const savedBankEntries = bankEntriesFromDoc(report).map((entry) => ({
        rowId: crypto.randomUUID(),
        bankAccountId: entry.bankAccountId || "",
        bankAccountName: entry.bankAccountName || "",
        amount:
          entry.amount === "" || entry.amount == null
            ? ""
            : formatAmountDisplay(entry.amount),
      }));
      setEditBankEntries(
        savedBankEntries.length ? savedBankEntries : [createBankEntry()]
      );
    } catch (reason) {
      setError(reason?.message || "Failed to open Z-report.");
    }
  }

  function closeEditReport() {
    setEditingReport(null);
    setEditZReport(null);
    setEditOpeningFloat("0");
    setEditClosingCash("0");
    setEditCashEntries([]);
    setEditCreditEntries([]);
    setEditBankEntries([]);
    setError("");
    if (existingReportForDate?.id) {
      autoEditOpenedForRef.current = existingReportForDate.id;
      setMessage(
        "A Z-report already exists for this date. Use Update Z-Report — creating a new one is not allowed."
      );
    }
  }

  function setEditZField(field, value) {
    setEditZReport((current) => ({ ...current, [field]: value }));
  }

  async function handleEditReport(event) {
    event.preventDefault();
    if (!editingReport || !editZReport) return;
    setError("");
    setSavingEdit(true);
    try {
      const populatedEntries = editCreditEntries.filter(
        (entry) =>
          entry.partyId ||
          entry.partyName ||
          Number(entry.amount || 0) !== 0
      );
      for (const entry of populatedEntries) {
        if (!entry.partyId || !entry.partyName) {
          throw new Error("Select a customer for every credit entry.");
        }
        if (!Number.isFinite(Number(entry.amount)) || Number(entry.amount) <= 0) {
          throw new Error("Every credit entry amount must be greater than zero.");
        }
      }
      const creditSalesTotal = sumEntryAmounts(populatedEntries);
      const normalizedCashEntries = normalizePopulatedCashEntries(
        editCashEntries
      );
      const cashTotal = sumEntryAmounts(normalizedCashEntries);
      const normalizedBankEntries = normalizePopulatedBankEntries(
        editBankEntries
      );
      const bankTotal = sumEntryAmounts(normalizedBankEntries);
      const derived = deriveZReportSalesTotals({
        cashTotal,
        bankTotal,
        creditSalesTotal,
      });
      const previousGrossCents =
        toCents(editingReport.grossSales) ||
        toCents(editingReport.cashTotal) +
          toCents(zReportBankTotalFromDoc(editingReport)) +
          toCents(editingReport.creditSalesTotal);
      const nextGrossCents =
        toCents(derived.cashTotal) +
        toCents(derived.bankTotal) +
        toCents(derived.creditSalesTotal);
      if (previousGrossCents > 0 && nextGrossCents === 0) {
        throw new Error(
          "Cash / Bank / Credit breakdowns are empty. Add Z sales entries before saving — this would clear today's totals."
        );
      }
      const payload = {
        ...editZReport,
        openingFloat: nonNegativeNumber(
          editOpeningFloat,
          "Opening float"
        ),
        cashTotal: derived.cashTotal,
        bankTotal: derived.bankTotal,
        creditSalesTotal: derived.creditSalesTotal,
        netSales: derived.netSales,
        grossSales: derived.grossSales,
      };
      if (
        toCents(payload.grossSales) !==
        toCents(payload.cashTotal) +
          toCents(payload.bankTotal) +
          toCents(payload.creditSalesTotal)
      ) {
        throw new Error(
          "Gross Sales must equal Cash + Bank + Credit Sales Total."
        );
      }
      if (
        toCents(payload.netSales) !==
        toCents(payload.cashTotal) + toCents(payload.bankTotal)
      ) {
        throw new Error("Net Sales must equal Cash Total + Bank Total.");
      }

      const identity = dayReportIdentity(payload.businessDate);
      const updatedReport = {
        ...editingReport,
        ...payload,
        reportNo: identity.reportNo,
        terminalId: identity.terminalId,
        // Z entry is additive with Sales-module + External (not a merge).
        cashIncludesExternal: false,
        bankIncludesExternal: false,
        cashEntries: normalizedCashEntries,
        creditEntries: populatedEntries.map(
          ({ partyId, partyName, amount }) => ({
            partyId,
            partyName,
            amount: Number(amount),
          })
        ),
        bankEntries: normalizedBankEntries,
      };
      const closingCash = nonNegativeNumber(
        editClosingCash,
        "Closing cash counted"
      );
      await updateClosedZReport({
        zReportId: editingReport.id,
        closingCashCounted: closingCash,
        zReport: updatedReport,
      });
      if (existingReportForDate?.id) {
        autoEditOpenedForRef.current = existingReportForDate.id;
      }
      setEditingReport(null);
      setEditZReport(null);
      setEditOpeningFloat("0");
      setEditClosingCash("0");
      setEditCashEntries([]);
      setEditCreditEntries([]);
      setEditBankEntries([]);
      setError("");
      setMessage(
        "Z-report saved. Re-open Update Z-Report to review or edit again."
      );
    } catch (reason) {
      setError(reason?.message || "Failed to update Z-report.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleSaveZReport(event) {
    event.preventDefault();
    setError("");
    setMessage("");

    const businessDate =
      activeShift?.businessDate || zReport.businessDate || todayYYYYMMDD();
    const existing =
      existingReportForDate ||
      dayZReports.find(
        (report) => String(report.businessDate || "") === businessDate
      ) ||
      null;
    if (existing?.id) {
      setSaving(false);
      setMessage("");
      setError(
        "A Z-report already exists for this date. Update the existing report — new save is not allowed."
      );
      await openEditReport(existing);
      return;
    }

    setSaving(true);
    try {
      const populatedCreditEntries = creditEntries.filter(
        (entry) =>
          entry.partyId ||
          entry.partyName ||
          Number(entry.amount || 0) !== 0
      );
      for (const entry of populatedCreditEntries) {
        if (!entry.partyId || !entry.partyName) {
          throw new Error("Select a customer for every credit entry.");
        }
        if (!Number.isFinite(Number(entry.amount)) || Number(entry.amount) <= 0) {
          throw new Error("Every credit entry amount must be greater than zero.");
        }
      }
      const creditSalesTotal = sumEntryAmounts(populatedCreditEntries);
      const normalizedCashEntries = normalizePopulatedCashEntries(cashEntries);
      const cashTotal = sumEntryAmounts(normalizedCashEntries);
      const normalizedBankEntries = normalizePopulatedBankEntries(bankEntries);
      const bankTotal = sumEntryAmounts(normalizedBankEntries);
      const businessDate =
        activeShift?.businessDate || zReport.businessDate || todayYYYYMMDD();
      const derived = deriveZReportSalesTotals({
        cashTotal,
        bankTotal,
        creditSalesTotal,
      });
      const payload = {
        ...zReport,
        businessDate,
        openingFloat: nonNegativeNumber(
          resolvedOpeningFloat,
          "Opening float"
        ),
        cashTotal: derived.cashTotal,
        bankTotal: derived.bankTotal,
        creditSalesTotal: derived.creditSalesTotal,
        netSales: derived.netSales,
        grossSales: derived.grossSales,
      };
      if (
        toCents(payload.grossSales) !==
        toCents(payload.cashTotal) +
          toCents(payload.bankTotal) +
          toCents(payload.creditSalesTotal)
      ) {
        throw new Error(
          "Gross Sales must equal Cash + Bank + Credit Sales Total."
        );
      }
      if (
        toCents(payload.netSales) !==
        toCents(payload.cashTotal) + toCents(payload.bankTotal)
      ) {
        throw new Error("Net Sales must equal Cash Total + Bank Total.");
      }
      const identity = dayReportIdentity(businessDate);
      await saveZReport({
        closingCashCounted: nonNegativeNumber(
          closingCashCounted,
          "Closing cash counted"
        ),
        zReport: {
          ...payload,
          reportNo: identity.reportNo,
          terminalId: identity.terminalId,
          // Z entry is additive with Sales-module + External (not a merge).
          cashIncludesExternal: false,
          bankIncludesExternal: false,
          cashEntries: normalizedCashEntries,
          creditEntries: populatedCreditEntries.map(
            ({ partyId, partyName, amount }) => ({
              partyId,
              partyName,
              amount: Number(amount),
            })
          ),
          bankEntries: normalizedBankEntries,
        },
      });
      setMessage("Z-report saved. Shift remains open.");
      setClosingCashCounted("0");
      setZReport({
        ...EMPTY_Z_REPORT,
        businessDate: activeShift?.businessDate || todayYYYYMMDD(),
      });
      setCashEntries([createCashEntry()]);
      setCreditEntries([createCreditEntry()]);
      setBankEntries([createBankEntry()]);
    } catch (reason) {
      setError(reason?.message || "Failed to save Z-report.");
    } finally {
      setSaving(false);
    }
  }

  if (!activeClientId) {
    return <div className="text-slate-300">Select a shop to manage its shift.</div>;
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-4xl space-y-4 sm:space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Z-Report Entry</h1>
          <p className="mt-1 text-sm text-slate-400">
            {activeClientData?.name || activeClientId}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ModuleHelpButton moduleId="z-report" />
          <ModuleExitButton ariaLabel="Close Z-report entry module" />
        </div>
      </div>

      {shiftError || error ? (
        <div className="rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
          {error || shiftError}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-200">
          {message}
        </div>
      ) : null}

      {existingReportForDate && !editingReport ? (
        <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 p-3 text-sm text-amber-100">
          A Z-report already exists for{" "}
          <span className="font-semibold">
            {formatIsoDate(currentBusinessDate) || currentBusinessDate}
          </span>
          . New save is not allowed —{" "}
          <button
            type="button"
            className="font-semibold text-amber-200 underline hover:text-white"
            onClick={() => openEditReport(existingReportForDate)}
          >
            open it to update
          </button>
          .
        </div>
      ) : null}

      {loadingShift ? (
        <div className="text-slate-300">Loading active shift…</div>
      ) : existingReportForDate ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 text-sm text-slate-300">
          <p>
            Business date{" "}
            <span className="font-semibold text-white">
              {formatIsoDate(currentBusinessDate) || currentBusinessDate}
            </span>
          </p>
          <p className="mt-2 text-slate-400">
            Editing the saved Z-report for this date. Create is disabled when a
            report already exists.
          </p>
          {!editingReport ? (
            <button
              type="button"
              onClick={() => openEditReport(existingReportForDate)}
              className="mt-4 rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-500"
            >
              Update Z-Report
            </button>
          ) : null}
        </div>
      ) : (
        <form
          onSubmit={handleSaveZReport}
          className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-slate-400">
              Business date{" "}
              <span className="font-semibold text-white">
                {formatIsoDate(activeShift?.businessDate || zReport.businessDate) ||
                  activeShift?.businessDate ||
                  zReport.businessDate}
              </span>
            </span>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="text-sm text-slate-300">
              Opening Float
              <input
                readOnly
                tabIndex={-1}
                value={formatAmountDisplay(resolvedOpeningFloat)}
                className="mt-1 w-full cursor-default rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-slate-200 outline-none"
              />
            </label>
            <label className="text-sm text-slate-300">
              <span className="inline-flex items-center gap-1.5">
                Closing Cash Counted
                <ExpectedCashHint
                  clientId={activeClientId}
                  businessDate={zReport.businessDate}
                  openingFloat={resolvedOpeningFloat}
                  shiftOpeningFloat={
                    Number.isFinite(shiftOpeningFloat) ? shiftOpeningFloat : null
                  }
                  shiftId={activeShift?.id}
                  cashTotal={liveCashTotal}
                />
              </span>
              <input
                required
                type="number"
                min="0"
                step={moneyStep}
                value={closingCashCounted}
                onChange={(event) => setClosingCashCounted(event.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-white"
              />
            </label>
          </div>

          <DaySalesModule
            clientId={activeClientId}
            businessDate={
              activeShift?.businessDate || zReport.businessDate || todayYYYYMMDD()
            }
            shiftId={activeShift?.id}
            cashTotal={liveCashTotal}
            bankTotal={liveBankTotal}
            creditTotal={liveCreditTotal}
          />

          <section className="mt-5 border-t border-slate-800 pt-5">
            <h3 className="font-semibold text-white">Cash Sales Breakdown</h3>

            <div className="mt-3 space-y-3">
              {cashEntries.map((entry) => (
                <CreditEntryRow
                  key={entry.rowId}
                  entry={entry}
                  parties={customerParties}
                  onChange={(nextEntry) =>
                    updateCashEntry(entry.rowId, nextEntry)
                  }
                  onRemove={() =>
                    setCashEntries((current) =>
                      current.filter((item) => item.rowId !== entry.rowId)
                    )
                  }
                  onQuickAddCustomer={quickAddCustomer}
                />
              ))}
            </div>

            <button
              type="button"
              onClick={() =>
                setCashEntries((current) => [...current, createCashEntry()])
              }
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" />
              Add Cash Entry
            </button>
          </section>

          <section className="mt-5 border-t border-slate-800 pt-5">
            <h3 className="font-semibold text-white">Bank Sales Breakdown</h3>

            <div className="mt-3 space-y-3">
              {bankEntries.map((entry) => (
                <BankEntryRow
                  key={entry.rowId}
                  entry={entry}
                  accounts={bankAccounts}
                  onChange={(nextEntry) =>
                    updateBankEntry(entry.rowId, nextEntry)
                  }
                  onRemove={() =>
                    setBankEntries((current) =>
                      current.filter((item) => item.rowId !== entry.rowId)
                    )
                  }
                />
              ))}
            </div>

            <button
              type="button"
              onClick={() =>
                setBankEntries((current) => [...current, createBankEntry()])
              }
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" />
              Add Bank Entry
            </button>
          </section>

          <section className="mt-5 border-t border-slate-800 pt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold text-white">
                  Credit Sales Breakdown
                </h3>
              </div>
            </div>

            <div className="mt-3 space-y-3">
              {creditEntries.map((entry) => (
                <CreditEntryRow
                  key={entry.rowId}
                  entry={entry}
                  parties={customerParties}
                  onChange={(nextEntry) =>
                    updateCreditEntry(entry.rowId, nextEntry)
                  }
                  onRemove={() =>
                    setCreditEntries((current) =>
                      current.filter((item) => item.rowId !== entry.rowId)
                    )
                  }
                  onQuickAddCustomer={quickAddCustomer}
                />
              ))}
            </div>

            <button
              type="button"
              onClick={() =>
                setCreditEntries((current) => [
                  ...current,
                  createCreditEntry(),
                ])
              }
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" />
              Add Credit Entry
            </button>
          </section>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-blue-600 px-5 py-2 font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save Z-Report"}
            </button>
          </div>
        </form>
      )}

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold text-white">Recent Z-Reports</h2>
            <p className="mt-1 text-xs text-slate-500">
              Z-entry totals only (Sales module + External are in Day Sales).
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs font-medium uppercase tracking-wider text-slate-400">
              Filter by Date
              <DateInput
                value={zReportDateFilter}
                onChange={(event) => setZReportDateFilter(event.target.value)}
                className="mt-1 h-10 min-w-36 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-200"
                aria-label="Filter Z-reports by date"
              />
            </label>
            {zReportDateFilter ? (
              <button
                type="button"
                onClick={() => setZReportDateFilter("")}
                className="h-10 rounded-lg border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                Clear Date
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setShowRecentReports((current) => !current)}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-700 px-3 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800"
            >
              {showRecentReports ? <EyeOff size={16} /> : <Eye size={16} />}
              {showRecentReports ? "Hide List" : "Show List"}
            </button>
          </div>
        </div>
        {showRecentReports ? (
          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-950/70 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3 text-right">Net Sales</th>
                <th className="px-4 py-3 text-right">Cash</th>
                <th className="px-4 py-3 text-right">Bank</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loadingHistory ? (
                <tr>
                  <td colSpan={5} className="px-4 py-5 text-slate-400">
                    Loading Z-reports…
                  </td>
                </tr>
              ) : filteredZReports.length ? (
                filteredZReports.map((report) => (
                  <tr
                    key={report.id}
                    className="border-t border-slate-800 text-slate-200"
                  >
                    <td className="px-4 py-3">
                      {formatIsoDate(report.businessDate, "-")}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {formatMoney(report.netSales || 0)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {formatMoney(report.cashTotal || 0)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {formatMoney(zReportBankTotalFromDoc(report))}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => openEditReport(report)}
                        className="rounded-lg border border-slate-700 px-3 py-1.5 font-medium text-slate-200 hover:bg-slate-800"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-4 py-5 text-slate-400">
                    No Z-reports found for the selected date.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        ) : null}
      </section>

      {editingReport && editZReport ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={handleEditReport}
            className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {existingReportForDate
                    ? "Update Z-Report"
                    : "Edit Z-Report"}
                </h2>
                <p className="mt-1 text-xs text-slate-400">
                  {existingReportForDate
                    ? `Saved report for ${formatIsoDate(editingReport.businessDate) || editingReport.businessDate}`
                    : `Linked shift: ${editingReport.shiftId}`}
                </p>
              </div>
              <button
                type="button"
                onClick={closeEditReport}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"
                aria-label="Close Z-report editor"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {error ? (
              <div className="mt-4 rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
                {error}
              </div>
            ) : null}

            <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="text-sm text-slate-300">
                Business Date
                <DateInput
                  required
                  value={editZReport.businessDate}
                  onChange={(event) =>
                    setEditZField("businessDate", event.target.value)
                  }
                  className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-950 text-white"
                />
              </label>
              <label className="text-sm text-slate-300">
                Opening Float
                <input
                  required
                  type="number"
                  min="0"
                  step={moneyStep}
                  value={editOpeningFloat}
                  onChange={(event) => setEditOpeningFloat(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                />
              </label>
              <label className="text-sm text-slate-300">
                <span className="inline-flex items-center gap-1.5">
                  Closing Cash Counted
                  <ExpectedCashHint
                    clientId={activeClientId}
                    businessDate={editZReport.businessDate}
                    openingFloat={editOpeningFloat}
                    shiftId={editingReport?.shiftId}
                    cashTotal={editLiveCashTotal}
                  />
                </span>
                <input
                  required
                  type="number"
                  min="0"
                  step={moneyStep}
                  value={editClosingCash}
                  onChange={(event) => setEditClosingCash(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-white"
                />
              </label>
            </div>

            <DaySalesModule
              clientId={activeClientId}
              businessDate={editZReport.businessDate}
              shiftId={editingReport?.shiftId}
              cashTotal={editLiveCashTotal}
              bankTotal={editLiveBankTotal}
              creditTotal={editLiveCreditTotal}
            />

            <section className="mt-5 border-t border-slate-800 pt-5">
              <h3 className="font-semibold text-white">Cash Sales Breakdown</h3>
              <div className="mt-3 space-y-3">
                {editCashEntries.map((entry) => (
                  <CreditEntryRow
                    key={entry.rowId}
                    entry={entry}
                    parties={customerParties}
                    onChange={(nextEntry) =>
                      setEditCashEntries((current) =>
                        current.map((item) =>
                          item.rowId === entry.rowId ? nextEntry : item
                        )
                      )
                    }
                    onRemove={() =>
                      setEditCashEntries((current) =>
                        current.filter((item) => item.rowId !== entry.rowId)
                      )
                    }
                    onQuickAddCustomer={quickAddCustomer}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={() =>
                  setEditCashEntries((current) => [
                    ...current,
                    createCashEntry(),
                  ])
                }
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
              >
                <Plus className="h-4 w-4" />
                Add Cash Entry
              </button>
            </section>

            <section className="mt-5 border-t border-slate-800 pt-5">
              <h3 className="font-semibold text-white">Bank Sales Breakdown</h3>
              <div className="mt-3 space-y-3">
                {editBankEntries.map((entry) => (
                  <BankEntryRow
                    key={entry.rowId}
                    entry={entry}
                    accounts={bankAccounts}
                    onChange={(nextEntry) =>
                      setEditBankEntries((current) =>
                        current.map((item) =>
                          item.rowId === entry.rowId ? nextEntry : item
                        )
                      )
                    }
                    onRemove={() =>
                      setEditBankEntries((current) =>
                        current.filter((item) => item.rowId !== entry.rowId)
                      )
                    }
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={() =>
                  setEditBankEntries((current) => [
                    ...current,
                    createBankEntry(),
                  ])
                }
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
              >
                <Plus className="h-4 w-4" />
                Add Bank Entry
              </button>
            </section>

            <section className="mt-5 border-t border-slate-800 pt-5">
              <h3 className="font-semibold text-white">
                Credit Sales Breakdown
              </h3>
              <div className="mt-3 space-y-3">
                {editCreditEntries.map((entry) => (
                  <CreditEntryRow
                    key={entry.rowId}
                    entry={entry}
                    parties={customerParties}
                    onChange={(nextEntry) =>
                      setEditCreditEntries((current) =>
                        current.map((item) =>
                          item.rowId === entry.rowId ? nextEntry : item
                        )
                      )
                    }
                    onRemove={() =>
                      setEditCreditEntries((current) =>
                        current.filter((item) => item.rowId !== entry.rowId)
                      )
                    }
                    onQuickAddCustomer={quickAddCustomer}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={() =>
                  setEditCreditEntries((current) => [
                    ...current,
                    createCreditEntry(),
                  ])
                }
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
              >
                <Plus className="h-4 w-4" />
                Add Credit Entry
              </button>
            </section>

            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={closeEditReport}
                className="rounded-lg border border-slate-700 px-4 py-2 font-medium text-slate-300 hover:bg-slate-800"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={savingEdit}
                className="rounded-lg bg-blue-600 px-5 py-2 font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {savingEdit ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
