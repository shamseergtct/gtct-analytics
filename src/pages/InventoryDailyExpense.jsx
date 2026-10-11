import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext.jsx";
import { useShift } from "../context/shift-context.js";
import {
  formatMoney,
  resolveCurrencyDecimals,
} from "../utils/money.js";
import { STOCK_USAGE_SOURCE } from "../utils/inventoryStockUsage.js";
import {
  buildDailyInventoryExpenseRows,
  sumExpenseAmount,
  sumExpenseQty,
} from "../utils/inventoryDailyExpense.js";

function todayYYYYMMDD() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function InventoryDailyExpense() {
  const { activeClientId, activeClientData } = useClient();
  const { activeShift } = useShift();

  const clientId = String(activeClientId || "").trim();
  const currency = String(activeClientData?.currency || "").trim();
  const currencyDecimals = resolveCurrencyDecimals(activeClientData);
  const currencyPrefix = currency ? `${currency} ` : "";

  const [businessDate, setBusinessDate] = useState(
    () => activeShift?.businessDate || todayYYYYMMDD()
  );
  const [movements, setMovements] = useState([]);
  const [inventoryById, setInventoryById] = useState(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (activeShift?.businessDate) {
      setBusinessDate(activeShift.businessDate);
    }
  }, [activeShift?.businessDate]);

  useEffect(() => {
    if (!clientId) {
      setInventoryById(new Map());
      return undefined;
    }
    const q = query(
      collection(db, "inventory"),
      where("clientId", "==", clientId)
    );
    return onSnapshot(
      q,
      (snap) => {
        const map = new Map();
        snap.docs.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
        setInventoryById(map);
      },
      () => setInventoryById(new Map())
    );
  }, [clientId]);

  useEffect(() => {
    if (!clientId || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      setMovements([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    setError("");
    const q = query(
      collection(db, "inventory_movements"),
      where("clientId", "==", clientId),
      where("businessDate", "==", businessDate),
      where("source", "==", STOCK_USAGE_SOURCE)
    );
    return onSnapshot(
      q,
      (snap) => {
        setMovements(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        setMovements([]);
        setLoading(false);
        setError(
          err?.message
            ? `Could not load usage: ${err.message}`
            : "Could not load daily inventory expense."
        );
      }
    );
  }, [clientId, businessDate]);

  const rows = useMemo(
    () =>
      buildDailyInventoryExpenseRows({
        movements,
        inventoryById,
        currencyDecimals,
      }),
    [movements, inventoryById, currencyDecimals]
  );

  // Select all when shop/date changes or the item set for that day changes.
  const rowIdKey = useMemo(
    () => rows.map((row) => row.itemId).sort().join("|"),
    [rows]
  );
  useEffect(() => {
    setSelectedIds(new Set(rowIdKey ? rowIdKey.split("|") : []));
  }, [clientId, businessDate, rowIdKey]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => {
      const name = String(row.itemName || "").toLowerCase();
      const code = String(row.itemCode || "").toLowerCase();
      return name.includes(q) || code.includes(q);
    });
  }, [rows, search]);

  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.has(row.itemId)),
    [rows, selectedIds]
  );

  const wholeTotal = useMemo(() => sumExpenseAmount(rows), [rows]);
  const selectedTotal = useMemo(
    () => sumExpenseAmount(selectedRows),
    [selectedRows]
  );
  const wholeQty = useMemo(() => sumExpenseQty(rows), [rows]);
  const selectedQty = useMemo(() => sumExpenseQty(selectedRows), [selectedRows]);

  const allFilteredSelected =
    filteredRows.length > 0 &&
    filteredRows.every((row) => selectedIds.has(row.itemId));

  function toggleItem(itemId) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function toggleAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filteredRows.forEach((row) => next.delete(row.itemId));
      } else {
        filteredRows.forEach((row) => next.add(row.itemId));
      }
      return next;
    });
  }

  if (!clientId) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <div className="rounded-2xl border border-amber-800/50 bg-amber-950/20 px-4 py-8 text-center text-sm text-amber-100">
          Select an active shop to view daily inventory expense.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 pb-28 sm:p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">
          Daily inventory expense
        </h1>
        <p className="text-sm text-slate-400">
          Usage cost for {activeClientData?.name || clientId}
        </p>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
          Business date
          <input
            type="date"
            value={businessDate}
            onChange={(e) => setBusinessDate(e.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-sky-500 sm:w-56"
          />
        </label>
        <label className="block min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-slate-500 sm:max-w-xs">
          Filter items
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or code"
            className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-sky-500"
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 px-4 py-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Whole total
          </div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-white">
            {currencyPrefix}
            {formatMoney(wholeTotal, currencyDecimals)}
          </div>
          <div className="mt-0.5 text-xs tabular-nums text-slate-500">
            {rows.length} items · qty {formatMoney(wholeQty, currencyDecimals)}
          </div>
        </div>
        <div className="rounded-2xl border border-sky-900/50 bg-sky-950/20 px-4 py-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-sky-400/80">
            Selected total
          </div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-sky-200">
            {currencyPrefix}
            {formatMoney(selectedTotal, currencyDecimals)}
          </div>
          <div className="mt-0.5 text-xs tabular-nums text-sky-400/70">
            {selectedRows.length} items · qty{" "}
            {formatMoney(selectedQty, currencyDecimals)}
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-rose-800 bg-rose-950/40 px-3 py-2 text-sm text-rose-100">
          {error}
        </div>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-slate-800">
        <div className="flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/50 px-3 py-2.5">
          <button
            type="button"
            onClick={toggleAllFiltered}
            disabled={!filteredRows.length}
            className="text-sm font-semibold text-sky-300 disabled:opacity-40"
          >
            {allFilteredSelected ? "Uncheck all" : "Check all"}
          </button>
          <div className="text-xs text-slate-500">
            {filteredRows.length} shown
          </div>
        </div>

        {loading ? (
          <div className="px-4 py-12 text-center text-sm text-slate-500">
            Loading…
          </div>
        ) : !filteredRows.length ? (
          <div className="px-4 py-12 text-center text-sm text-slate-500">
            {rows.length
              ? "No items match this filter."
              : "No usage recorded for this date."}
          </div>
        ) : (
          <ul className="divide-y divide-slate-800/80">
            {filteredRows.map((row) => {
              const checked = selectedIds.has(row.itemId);
              return (
                <li key={row.itemId}>
                  <label
                    className={`flex cursor-pointer items-start gap-3 px-3 py-3.5 transition ${
                      checked ? "bg-slate-900/30" : "opacity-55"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleItem(row.itemId)}
                      className="mt-1 h-4 w-4 shrink-0 rounded border-slate-600 bg-slate-950 text-sky-500 focus:ring-sky-500/40"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-white">
                            {row.itemName}
                          </div>
                          <div className="mt-0.5 text-xs tabular-nums text-slate-500">
                            {row.itemCode || "—"}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-sm font-semibold tabular-nums text-white">
                            {currencyPrefix}
                            {formatMoney(row.amount, currencyDecimals)}
                          </div>
                          <div className="mt-0.5 text-[11px] tabular-nums text-slate-500">
                            line total
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-slate-400">
                        <span>
                          Qty{" "}
                          <span className="text-slate-200">
                            {formatMoney(row.qty, currencyDecimals)}
                          </span>
                        </span>
                        <span>
                          Cost{" "}
                          <span className="text-slate-200">
                            {currencyPrefix}
                            {formatMoney(row.unitCost, currencyDecimals)}
                          </span>
                        </span>
                      </div>
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Sticky summary for mobile */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur sm:hidden">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 text-sm">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500">
              Selected
            </div>
            <div className="font-semibold tabular-nums text-sky-200">
              {currencyPrefix}
              {formatMoney(selectedTotal, currencyDecimals)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">
              Whole
            </div>
            <div className="font-semibold tabular-nums text-white">
              {currencyPrefix}
              {formatMoney(wholeTotal, currencyDecimals)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
