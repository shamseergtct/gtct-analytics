import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { formatMoney, numMoney } from "../../utils/money.js";
import { itemMatchesSubCategory } from "../../utils/inventorySubCategory.js";
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
import SubCategoryFilter from "./SubCategoryFilter.jsx";
import ListPagination from "../ListPagination.jsx";
import { usePagination } from "../../hooks/usePagination.js";
import { formatPackHint, formatStockDisplay } from "../../utils/inventoryPack.js";

function matchesQuery(item, rawQuery) {
  const q = String(rawQuery || "")
    .trim()
    .toLowerCase();
  if (!q) return true;
  const name = String(item.itemName || "").toLowerCase();
  const code = String(item.itemCode || "").toLowerCase();
  const barcode = String(item.barcode || "").toLowerCase();
  const sub = String(item.subCategory || "").toLowerCase();
  return (
    name.includes(q) ||
    code.includes(q) ||
    barcode.includes(q) ||
    sub.includes(q)
  );
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
  const [subCategoryFilter, setSubCategoryFilter] = useState("all");
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

  const activeItem = useMemo(
    () => items.find((row) => row.id === activeItemId) || null,
    [items, activeItemId]
  );

  const mergedTodayRows = useMemo(() => {
    const server = todayRows.map((row) => ({
      ...row,
      itemId: row.itemId || "",
      pendingSync: false,
    }));
    const local = localUsage.map((row) => ({
      id: row.entryLocalId,
      itemId: row.itemId,
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

  // Any entry (incl. Nil) removes the item from Needs usage.
  const recordedItemIds = useMemo(() => {
    const ids = new Set();
    for (const row of mergedTodayRows) {
      const id = String(row.itemId || "").trim();
      if (id) ids.add(id);
    }
    return ids;
  }, [mergedTodayRows]);

  const usedQtyByItemId = useMemo(() => {
    const map = new Map();
    for (const row of mergedTodayRows) {
      const id = String(row.itemId || "").trim();
      if (!id) continue;
      map.set(id, numMoney(map.get(id)) + numMoney(row.qty));
    }
    return map;
  }, [mergedTodayRows]);

  // Used today = stock actually deducted (qty > 0). Nil stays in Today's entries only.
  const scopedItems = useMemo(
    () =>
      items.filter((item) => itemMatchesSubCategory(item, subCategoryFilter)),
    [items, subCategoryFilter]
  );

  const { pendingItems, usedItems } = useMemo(() => {
    const pending = [];
    const used = [];
    for (const item of scopedItems) {
      if (!matchesQuery(item, query)) continue;
      const qtyUsed = numMoney(usedQtyByItemId.get(item.id));
      if (qtyUsed > 0) used.push(item);
      else if (!recordedItemIds.has(item.id)) pending.push(item);
    }
    const byName = (a, b) =>
      String(a.itemName || "").localeCompare(String(b.itemName || ""));
    pending.sort(byName);
    used.sort(byName);
    return { pendingItems: pending, usedItems: used };
  }, [scopedItems, query, recordedItemIds, usedQtyByItemId]);

  const nilTodayRows = useMemo(() => {
    const scopedIds = new Set(scopedItems.map((item) => item.id));
    return mergedTodayRows.filter(
      (row) =>
        !(numMoney(row.qty) > 0) &&
        scopedIds.has(String(row.itemId || "").trim())
    );
  }, [mergedTodayRows, scopedItems]);

  const usedCount = useMemo(() => {
    let n = 0;
    for (const item of scopedItems) {
      if (recordedItemIds.has(item.id)) n += 1;
    }
    return n;
  }, [scopedItems, recordedItemIds]);

  const totalCount = scopedItems.length;
  const progressPct = totalCount
    ? Math.round((usedCount / totalCount) * 100)
    : 0;

  const listResetKey = `${subCategoryFilter}:${query.trim().toLowerCase()}`;
  const pendingPage = usePagination(pendingItems, {
    pageSize: 25,
    resetKey: `pending:${listResetKey}`,
  });
  const usedPage = usePagination(usedItems, {
    pageSize: 25,
    resetKey: `used:${listResetKey}`,
  });
  const nilPage = usePagination(nilTodayRows, {
    pageSize: 25,
    resetKey: `nil:${listResetKey}`,
  });

  function openItem(item, preset = null) {
    setActiveItemId(item.id);
    if (preset) {
      setQty(
        preset.qty === "" || preset.qty == null ? "" : String(preset.qty)
      );
      setUsageReason(preset.usageReason || "DAILY_USE");
      setNotes(preset.notes || "");
    } else {
      setQty("");
      setUsageReason("DAILY_USE");
      setNotes("");
    }
    onError?.("");
    onMessage?.("");
  }

  function openNilRow(row) {
    const itemId = String(row.itemId || "").trim();
    const fromCatalog = items.find((item) => item.id === itemId);
    const item = fromCatalog || {
      id: itemId,
      itemName: row.itemName,
      itemCode: row.itemCode,
      currentStock: 0,
    };
    if (!item.id) return;
    openItem(item, {
      qty: "0",
      usageReason: row.usageReason || "DAILY_USE",
      notes: row.notes || "",
    });
  }

  async function handleSave(overrideQty) {
    if (!activeItem || saving) return;
    onError?.("");
    onMessage?.("");
    setSaving(true);
    try {
      const rawQty = overrideQty !== undefined ? overrideQty : qty;
      const qtyNum = numMoney(rawQty);
      if (!Number.isFinite(qtyNum) || qtyNum < 0) {
        throw new Error("Enter a usage quantity of zero or more.");
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
      const label =
        qtyNum === 0
          ? `Nil: ${activeItem.itemName || activeItem.itemCode}`
          : `Saved: ${activeItem.itemName || activeItem.itemCode}`;
      onMessage?.(
        offline
          ? `${label}. Saved on device — will sync when online.`
          : `${label}. Syncing…`
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

  function handleNil() {
    setQty("0");
    void handleSave(0);
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
                {
                  formatStockDisplay(
                    { ...activeItem, currentStock: onHand },
                    currencyDecimals
                  ).label
                }
              </div>
              {formatPackHint(activeItem) ? (
                <div className="mt-0.5 text-[10px] font-medium text-sky-300/90">
                  {formatPackHint(activeItem)}
                </div>
              ) : null}
            </div>
          </div>

          <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Usage qty
            {activeItem.baseUnit ? ` (${activeItem.baseUnit})` : ""}{" "}
            <span className="text-rose-300">(required)</span>
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
          <button
            type="button"
            disabled={saving || !usageReason}
            onClick={handleNil}
            className="mt-2 w-full min-h-12 rounded-xl border border-slate-600 bg-slate-950 text-sm font-semibold text-slate-100 disabled:opacity-40"
          >
            Nil / not used
          </button>
          <p className="mt-1.5 text-xs text-slate-500">
            Use Nil when this item had no usage today — stock stays the same.
          </p>

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
            disabled={
              saving ||
              qty === "" ||
              !Number.isFinite(Number(qty)) ||
              Number(qty) < 0 ||
              !usageReason
            }
            onClick={() => void handleSave()}
            className="mt-4 w-full min-h-12 rounded-xl bg-sky-500 text-sm font-semibold text-slate-950 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save usage"}
          </button>
          <p className="mt-2 text-xs text-slate-500">
            Saves on this device instantly, then syncs stock when online. Enter 0
            or tap Nil if not used.
          </p>
        </article>
      </div>
    );
  }

  function ItemRow({ item, used = false }) {
    const usedQty = used ? usedQtyByItemId.get(item.id) : 0;
    return (
      <button
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
              {formatStockDisplay(item, currencyDecimals).label}
            </span>
            {formatPackHint(item) ? (
              <>
                {" · "}
                <span className="font-medium text-sky-300/90">
                  {formatPackHint(item)}
                </span>
              </>
            ) : null}
            {used && usedQty > 0 ? (
              <>
                {" · "}
                <span className="font-medium text-rose-300">
                  −{formatMoney(usedQty, currencyDecimals)}
                  {item.baseUnit ? ` ${item.baseUnit}` : ""} today
                </span>
              </>
            ) : null}
          </div>
        </div>
        <ChevronRight
          className="h-4 w-4 shrink-0 text-slate-500"
          aria-hidden
        />
      </button>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Usage
            </div>
            <div className="mt-0.5 text-lg font-semibold text-white">
              {businessDate}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">Progress</div>
            <div className="text-lg font-semibold tabular-nums text-sky-200">
              {usedCount}/{totalCount}
            </div>
          </div>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full rounded-full bg-sky-500 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Tap an item to record usage. Entered items move to the bottom.
        </p>
      </section>

      <SubCategoryFilter
        items={items}
        value={subCategoryFilter}
        onChange={setSubCategoryFilter}
      />

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
      ) : !items.length ? (
        <div className="rounded-2xl border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
          No inventory items.
        </div>
      ) : !totalCount ? (
        <div className="rounded-2xl border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
          No items in this sub category.
        </div>
      ) : !pendingItems.length && !usedItems.length && !nilTodayRows.length ? (
        <div className="rounded-2xl border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
          No items match that search.
        </div>
      ) : (
        <>
          <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
            <div className="border-b border-slate-800 px-3 py-2.5 text-sm font-semibold text-white">
              Needs usage ({pendingItems.length})
            </div>
            {pendingItems.length ? (
              <>
                <div>
                  {pendingPage.pageItems.map((item) => (
                    <ItemRow key={item.id} item={item} />
                  ))}
                </div>
                <ListPagination
                  page={pendingPage.page}
                  pageCount={pendingPage.pageCount}
                  total={pendingPage.total}
                  from={pendingPage.from}
                  to={pendingPage.to}
                  hasPrev={pendingPage.hasPrev}
                  hasNext={pendingPage.hasNext}
                  onPrev={pendingPage.goPrev}
                  onNext={pendingPage.goNext}
                />
              </>
            ) : (
              <div className="px-3 py-6 text-center text-sm text-emerald-200">
                All items have usage for today.
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-2xl border border-emerald-900/40 bg-emerald-950/10">
            <div className="border-b border-emerald-900/40 px-3 py-2.5 text-sm font-semibold text-emerald-200">
              Used today ({usedItems.length})
            </div>
            {usedItems.length ? (
              <>
                <div>
                  {usedPage.pageItems.map((item) => (
                    <ItemRow key={item.id} item={item} used />
                  ))}
                </div>
                <ListPagination
                  page={usedPage.page}
                  pageCount={usedPage.pageCount}
                  total={usedPage.total}
                  from={usedPage.from}
                  to={usedPage.to}
                  hasPrev={usedPage.hasPrev}
                  hasNext={usedPage.hasNext}
                  onPrev={usedPage.goPrev}
                  onNext={usedPage.goNext}
                />
              </>
            ) : (
              <div className="px-3 py-6 text-center text-sm text-slate-500">
                Items with usage qty appear here.
              </div>
            )}
          </section>
        </>
      )}

      {nilTodayRows.length ? (
        <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
          <div className="border-b border-slate-800 px-3 py-2.5 text-sm font-semibold text-white">
            Today&apos;s entries · Nil ({nilTodayRows.length})
          </div>
          <div>
            {nilPage.pageItems.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => openNilRow(row)}
                className="flex w-full items-center gap-3 border-b border-slate-800/80 px-3 py-3.5 text-left last:border-b-0 active:bg-slate-800/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium text-white">
                      {row.itemName || "—"}
                    </span>
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
                    <span className="font-medium text-emerald-300">Nil</span>
                    {" · "}
                    {USAGE_REASON_META[row.usageReason]?.label ||
                      row.usageReason ||
                      "Usage"}
                    {row.notes ? ` · ${row.notes}` : ""}
                    {row.itemCode ? ` · ${row.itemCode}` : ""}
                  </div>
                  {row.syncError ? (
                    <div className="mt-1 text-xs text-rose-300">
                      {row.syncError}
                    </div>
                  ) : null}
                </div>
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-slate-500"
                  aria-hidden
                />
              </button>
            ))}
          </div>
          <ListPagination
            page={nilPage.page}
            pageCount={nilPage.pageCount}
            total={nilPage.total}
            from={nilPage.from}
            to={nilPage.to}
            hasPrev={nilPage.hasPrev}
            hasNext={nilPage.hasNext}
            onPrev={nilPage.goPrev}
            onNext={nilPage.goNext}
          />
        </section>
      ) : null}
    </div>
  );
}
