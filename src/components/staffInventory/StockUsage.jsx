import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { formatMoney, numMoney } from "../../utils/money.js";
import {
  USAGE_REASONS,
  USAGE_REASON_META,
  fetchTodayStockUsage,
  subscribeTodayStockUsage,
} from "../../utils/inventoryStockUsage.js";
import {
  STAFF_INV_ENTRY_TYPE,
  STAFF_INV_SYNC_STATUS,
  enqueueStaffUsage,
  listPendingStaffInvEntries,
} from "../../utils/staffInventoryQueue.js";
import {
  runStaffInventorySync,
  subscribeStaffInvSync,
} from "../../utils/staffInventorySync.js";

function matchesQuery(item, rawQuery) {
  const q = String(rawQuery || "")
    .trim()
    .toLowerCase();
  if (!q) return true;
  const name = String(item.itemName || "").toLowerCase();
  const code = String(item.itemCode || "").toLowerCase();
  const barcode = String(item.barcode || "").toLowerCase();
  return name.includes(q) || code.includes(q) || barcode.includes(q);
}

export default function StockUsage({
  clientId,
  businessDate,
  shiftId,
  items,
  loadingItems,
  currencyDecimals,
  userUid,
  userName,
  onError,
  onMessage,
  onQueued,
}) {
  const [query, setQuery] = useState("");
  const [activeItemId, setActiveItemId] = useState("");
  const [qty, setQty] = useState("");
  const [usageReason, setUsageReason] = useState("DAILY_USE");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [todayRows, setTodayRows] = useState([]);
  const [localUsage, setLocalUsage] = useState([]);

  const refreshLocalUsage = useCallback(async () => {
    if (!clientId || !businessDate) {
      setLocalUsage([]);
      return;
    }
    try {
      const rows = await listPendingStaffInvEntries({
        clientId,
        businessDate,
        type: STAFF_INV_ENTRY_TYPE.USAGE,
      });
      setLocalUsage(rows);
    } catch {
      setLocalUsage([]);
    }
  }, [clientId, businessDate]);

  useEffect(() => {
    void refreshLocalUsage();
  }, [refreshLocalUsage]);

  useEffect(() => {
    if (!clientId || !businessDate) {
      setTodayRows([]);
      return undefined;
    }
    return subscribeTodayStockUsage(
      clientId,
      businessDate,
      (rows) => {
        setTodayRows(rows);
        void refreshLocalUsage();
      },
      (err) => {
        onError?.(
          err?.message
            ? `Live usage list unavailable (${err.message}). Local saves still work.`
            : "Live usage list unavailable. Local saves still work."
        );
      }
    );
  }, [clientId, businessDate, onError, refreshLocalUsage]);

  // After each successful usage sync, force-refresh Today's usage list.
  useEffect(() => {
    return subscribeStaffInvSync((state) => {
      if (!clientId || !businessDate) return;
      if (!state?.usageRefreshToken) return;
      if (
        state.lastUsageClientId &&
        state.lastUsageClientId !== clientId
      ) {
        return;
      }
      void fetchTodayStockUsage(clientId, businessDate)
        .then((rows) => {
          setTodayRows(rows);
          void refreshLocalUsage();
        })
        .catch(() => {
          void refreshLocalUsage();
        });
    });
  }, [clientId, businessDate, refreshLocalUsage]);

  const filtered = useMemo(() => {
    return items
      .filter((item) => matchesQuery(item, query))
      .sort((a, b) =>
        String(a.itemName || "").localeCompare(String(b.itemName || ""))
      );
  }, [items, query]);

  const activeItem = useMemo(
    () => items.find((row) => row.id === activeItemId) || null,
    [items, activeItemId]
  );

  const mergedTodayRows = useMemo(() => {
    const server = todayRows.map((row) => ({
      ...row,
      pendingSync: false,
    }));
    const local = localUsage.map((row) => ({
      id: row.entryLocalId,
      itemName: row.itemName,
      itemCode: row.itemCode,
      qty: numMoney(row.qty),
      usageReason: row.usageReason,
      notes: row.notes,
      pendingSync: true,
      syncStatus: row.syncStatus,
      syncError: row.syncError || "",
      dateMs: row.createdAtMs,
    }));
    return [...local, ...server].sort(
      (a, b) => numMoney(b.dateMs) - numMoney(a.dateMs)
    );
  }, [todayRows, localUsage]);

  function openItem(item) {
    setActiveItemId(item.id);
    setQty("");
    setUsageReason("DAILY_USE");
    setNotes("");
    onError?.("");
    onMessage?.("");
  }

  async function handleSave() {
    if (!activeItem || saving) return;
    onError?.("");
    onMessage?.("");
    setSaving(true);
    try {
      const qtyNum = numMoney(qty);
      if (!(qtyNum > 0)) {
        throw new Error("Enter a usage quantity greater than zero.");
      }
      const onHand = numMoney(activeItem.currentStock);
      // Soft local guard — server still enforces on sync.
      if (qtyNum > onHand) {
        throw new Error(
          `Not enough stock. On hand is ${onHand}, usage is ${qtyNum}.`
        );
      }

      await enqueueStaffUsage({
        clientId,
        businessDate,
        item: activeItem,
        qty: qtyNum,
        usageReason,
        notes,
        userUid,
        userName,
        shiftId,
      });

      await refreshLocalUsage();
      onQueued?.();

      const offline =
        typeof navigator !== "undefined" && navigator.onLine === false;
      onMessage?.(
        offline
          ? `Saved on device: ${activeItem.itemName || activeItem.itemCode}. Will sync when online.`
          : `Saved: ${activeItem.itemName || activeItem.itemCode}. Syncing…`
      );
      setActiveItemId("");
      setQty("");
      setNotes("");
      void runStaffInventorySync({ clientId, userUid });
    } catch (err) {
      onError?.(err?.message || "Failed to save usage.");
    } finally {
      setSaving(false);
    }
  }

  if (!clientId) {
    return (
      <div className="rounded-2xl border border-amber-800/50 bg-amber-950/20 px-4 py-8 text-center text-sm text-amber-100">
        Select an active shop to record usage.
      </div>
    );
  }

  if (!businessDate) {
    return (
      <div className="rounded-2xl border border-amber-800/50 bg-amber-950/20 px-4 py-8 text-center text-sm text-amber-100">
        Open a shift to record daily usage.
      </div>
    );
  }

  if (activeItem) {
    const onHand = Number(activeItem.currentStock) || 0;
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setActiveItemId("")}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-sky-300"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to list
        </button>

        <article className="rounded-2xl border border-slate-800 bg-slate-900/50 p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold text-white">
                {activeItem.itemName || "—"}
              </h3>
              <p className="mt-0.5 text-xs tabular-nums text-slate-400">
                Code {activeItem.itemCode || "—"}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                On hand
              </div>
              <div className="text-lg font-semibold tabular-nums text-sky-200">
                {formatMoney(onHand, currencyDecimals)}
              </div>
            </div>
          </div>

          <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Usage qty <span className="text-rose-300">(required)</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              disabled={saving}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-sky-500"
              placeholder="0"
            />
          </label>

          <div className="mt-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Reason <span className="text-rose-300">(required)</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {USAGE_REASONS.map((key) => (
                <button
                  key={key}
                  type="button"
                  disabled={saving}
                  onClick={() => setUsageReason(key)}
                  className={`min-h-12 rounded-xl border px-2 text-sm font-semibold transition disabled:opacity-50 ${
                    usageReason === key
                      ? "border-sky-400 bg-sky-500 text-slate-950"
                      : "border-slate-700 bg-slate-950 text-slate-200"
                  }`}
                >
                  {USAGE_REASON_META[key].label}
                </button>
              ))}
            </div>
          </div>

          <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Notes (optional)
            <input
              type="text"
              disabled={saving}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-sky-500"
              placeholder="Short note"
            />
          </label>

          <button
            type="button"
            disabled={saving || !(Number(qty) > 0) || !usageReason}
            onClick={() => void handleSave()}
            className="mt-4 w-full min-h-12 rounded-xl bg-sky-500 text-sm font-semibold text-slate-950 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save usage"}
          </button>
          <p className="mt-2 text-xs text-slate-500">
            Saves on this device instantly, then syncs stock when online.
          </p>
        </article>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <label className="relative block">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, code, or barcode"
          className="w-full rounded-2xl border border-slate-700 bg-slate-900 py-3.5 pl-11 pr-3 text-base text-white outline-none focus:border-sky-500"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>

      {loadingItems ? (
        <div className="rounded-2xl border border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
          Loading items…
        </div>
      ) : !filtered.length ? (
        <div className="rounded-2xl border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
          {query.trim() ? "No items match that search." : "No inventory items."}
        </div>
      ) : (
        <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
          <div className="border-b border-slate-800 px-3 py-2.5 text-sm font-semibold text-white">
            Select item to record usage
          </div>
          <div>
            {filtered.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => openItem(item)}
                className="flex w-full items-center gap-3 border-b border-slate-800/80 px-3 py-3.5 text-left last:border-b-0 active:bg-slate-800/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-white">
                    {item.itemName || "—"}
                  </div>
                  <div className="mt-0.5 text-xs tabular-nums text-slate-400">
                    {item.itemCode || "—"} ·{" "}
                    <span className="text-sky-200/90">
                      {formatMoney(item.currentStock, currencyDecimals)}
                    </span>
                  </div>
                </div>
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-slate-500"
                  aria-hidden
                />
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
        <div className="border-b border-slate-800 px-3 py-2.5 text-sm font-semibold text-white">
          Today&apos;s usage ({mergedTodayRows.length})
        </div>
        {!mergedTodayRows.length ? (
          <div className="px-3 py-6 text-center text-sm text-slate-500">
            No usage recorded for this date yet.
          </div>
        ) : (
          <ul>
            {mergedTodayRows.map((row) => (
              <li
                key={row.id}
                className="border-b border-slate-800/80 px-3 py-3 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium text-white">
                    {row.itemName || "—"}
                  </div>
                  {row.pendingSync ? (
                    <span
                      className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide ${
                        row.syncStatus === STAFF_INV_SYNC_STATUS.FAILED
                          ? "text-rose-300"
                          : "text-amber-300"
                      }`}
                    >
                      {row.syncStatus === STAFF_INV_SYNC_STATUS.FAILED
                        ? "Failed"
                        : "Pending sync"}
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-xs text-slate-400">
                  <span className="tabular-nums text-rose-300">
                    −{formatMoney(row.qty, currencyDecimals)}
                  </span>
                  {" · "}
                  {USAGE_REASON_META[row.usageReason]?.label ||
                    row.usageReason ||
                    "Usage"}
                  {row.notes ? ` · ${row.notes}` : ""}
                </div>
                {row.syncError ? (
                  <div className="mt-1 text-xs text-rose-300">{row.syncError}</div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
