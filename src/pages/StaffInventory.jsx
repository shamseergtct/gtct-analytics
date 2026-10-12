import { useCallback, useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthContext";
import { useClient } from "../context/ClientContext.jsx";
import { useShift } from "../context/shift-context.js";
import { resolveCurrencyDecimals, numMoney } from "../utils/money.js";
import { subscribeDailyReviewLines } from "../utils/inventoryDailyReview.js";
import {
  STAFF_INV_ENTRY_TYPE,
  getStaffInvMeta,
  listPendingStaffInvEntries,
  setStaffInvMeta,
} from "../utils/staffInventoryQueue.js";
import {
  bindStaffInventoryOnlineSync,
  refreshStaffInvSyncCounts,
  runStaffInventorySync,
  subscribeStaffInvSync,
} from "../utils/staffInventorySync.js";
import TodayChecklist from "../components/staffInventory/TodayChecklist.jsx";
import FindItem from "../components/staffInventory/FindItem.jsx";
import StockUsage from "../components/staffInventory/StockUsage.jsx";

const TABS = [
  { id: "today", label: "Today" },
  { id: "usage", label: "Usage" },
  { id: "find", label: "Find" },
];

function itemsCacheKey(clientId) {
  return `items:${String(clientId || "").trim()}`;
}

export default function StaffInventory() {
  const { user, displayName } = useAuth();
  const { activeClientId, activeClientData } = useClient();
  const { activeShift } = useShift();

  const [tab, setTab] = useState("today");
  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [lines, setLines] = useState([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [focusItemId, setFocusItemId] = useState("");
  const [pendingUsageQtyByItem, setPendingUsageQtyByItem] = useState({});
  const [syncState, setSyncState] = useState(() => ({
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
    syncing: false,
    pending: 0,
    failed: 0,
    message: "",
    lastError: "",
  }));

  const clientId = String(activeClientId || "").trim();
  const businessDate = String(activeShift?.businessDate || "").trim();
  const currencyDecimals = resolveCurrencyDecimals(activeClientData);
  const userUid = user?.uid || "";

  const refreshPendingUsageStock = useCallback(async () => {
    if (!clientId || !businessDate) {
      setPendingUsageQtyByItem({});
      return;
    }
    try {
      const rows = await listPendingStaffInvEntries({
        clientId,
        businessDate,
        type: STAFF_INV_ENTRY_TYPE.USAGE,
      });
      const map = {};
      for (const row of rows) {
        const id = String(row.itemId || "").trim();
        if (!id) continue;
        map[id] = numMoney(map[id]) + numMoney(row.qty);
      }
      setPendingUsageQtyByItem(map);
    } catch {
      setPendingUsageQtyByItem({});
    }
  }, [clientId, businessDate]);

  const displayItems = useMemo(() => {
    if (!Object.keys(pendingUsageQtyByItem).length) return items;
    return items.map((item) => {
      const pendingQty = numMoney(pendingUsageQtyByItem[item.id]);
      if (!pendingQty) return item;
      return {
        ...item,
        currentStock: Math.max(0, numMoney(item.currentStock) - pendingQty),
      };
    });
  }, [items, pendingUsageQtyByItem]);

  useEffect(() => {
    return subscribeStaffInvSync((state) => {
      setSyncState(state);
      void refreshPendingUsageStock();
    });
  }, [refreshPendingUsageStock]);

  useEffect(() => {
    return bindStaffInventoryOnlineSync(() => ({
      clientId,
      userUid,
    }));
  }, [clientId, userUid]);

  useEffect(() => {
    if (!clientId || !userUid) return;
    void refreshStaffInvSyncCounts(clientId);
    void runStaffInventorySync({ clientId, userUid });
  }, [clientId, userUid, businessDate]);

  // Load cached items immediately, then live snapshot.
  useEffect(() => {
    if (!clientId) {
      setItems([]);
      setLoadingItems(false);
      setLocalStockDelta({});
      return undefined;
    }

    let cancelled = false;
    setLoadingItems(true);
    void refreshPendingUsageStock();

    (async () => {
      try {
        const cached = await getStaffInvMeta(itemsCacheKey(clientId));
        if (!cancelled && Array.isArray(cached) && cached.length) {
          setItems(cached);
          setLoadingItems(false);
        }
      } catch {
        // ignore cache miss
      }
    })();

    const q = query(
      collection(db, "inventory"),
      where("clientId", "==", clientId)
    );
    return onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setItems(rows);
        setLoadingItems(false);
        void setStaffInvMeta(itemsCacheKey(clientId), rows);
        void refreshPendingUsageStock();
      },
      (err) => {
        setLoadingItems(false);
        setError(
          err?.message
            ? `Could not refresh inventory: ${err.message}. Showing last saved list if available.`
            : "Could not refresh inventory. Showing last saved list if available."
        );
      }
    );
  }, [clientId, refreshPendingUsageStock]);

  useEffect(() => {
    if (!clientId || !businessDate) {
      setLines([]);
      return undefined;
    }
    return subscribeDailyReviewLines(clientId, businessDate, setLines, () => {
      // Local checklist still works from its own listener / cache.
    });
  }, [clientId, businessDate]);

  const lineByItemId = useMemo(() => {
    const map = new Map();
    for (const row of lines) {
      map.set(String(row.itemId || row.id), row);
    }
    return map;
  }, [lines]);

  async function handleSyncNow() {
    setError("");
    setMessage("");
    const result = await runStaffInventorySync({ clientId, userUid });
    if (result?.lastError) setError(result.lastError);
    else if (result?.message) setMessage(result.message);
  }

  const showSyncBar = syncState.pending > 0 || syncState.failed > 0 || syncState.syncing;

  return (
    <div className="mx-auto max-w-lg space-y-4 p-3 pb-10 sm:p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-white">Staff Inventory</h1>
        <p className="text-sm text-slate-400">
          {activeClientData?.name || clientId || "No shop selected"}
          {businessDate ? ` · ${businessDate}` : ""}
        </p>
      </header>

      {showSyncBar ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2.5">
          <div className="min-w-0 text-xs text-slate-300">
            {!syncState.online ? (
              <span className="text-amber-200">Offline — saves stay on device</span>
            ) : syncState.syncing ? (
              <span>Syncing…</span>
            ) : syncState.failed > 0 ? (
              <span className="text-rose-200">
                {syncState.failed} failed · {syncState.pending} waiting
              </span>
            ) : (
              <span className="text-amber-100">
                {syncState.pending} pending sync
              </span>
            )}
            {syncState.message ? (
              <div className="mt-0.5 truncate text-slate-500">{syncState.message}</div>
            ) : null}
          </div>
          <button
            type="button"
            disabled={syncState.syncing || !userUid}
            onClick={() => void handleSyncNow()}
            className="shrink-0 rounded-lg bg-sky-500 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-40"
          >
            {syncState.syncing ? "Syncing…" : "Sync now"}
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-1.5 rounded-2xl border border-slate-800 bg-slate-900/60 p-1">
        {TABS.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => {
              setTab(row.id);
              setError("");
              setMessage("");
            }}
            className={`min-h-11 rounded-xl text-sm font-semibold transition ${
              tab === row.id
                ? "bg-sky-500 text-slate-950"
                : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            {row.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="rounded-xl border border-rose-800 bg-rose-950/40 px-3 py-2 text-sm text-rose-100">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-xl border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-100">
          {message}
        </div>
      ) : null}

      {tab === "today" ? (
        <TodayChecklist
          clientId={clientId}
          businessDate={businessDate}
          items={displayItems}
          loadingItems={loadingItems}
          currencyDecimals={currencyDecimals}
          userUid={userUid}
          userName={displayName}
          focusItemId={focusItemId}
          onFocusConsumed={() => setFocusItemId("")}
          onError={setError}
          onMessage={setMessage}
        />
      ) : null}

      {tab === "usage" ? (
        <StockUsage
          clientId={clientId}
          businessDate={businessDate}
          shiftId={activeShift?.id || ""}
          items={displayItems}
          loadingItems={loadingItems}
          currencyDecimals={currencyDecimals}
          userUid={userUid}
          userName={displayName}
          onError={setError}
          onMessage={setMessage}
          onQueued={() => void refreshPendingUsageStock()}
        />
      ) : null}

      {tab === "find" ? (
        <FindItem
          items={displayItems}
          loadingItems={loadingItems}
          currencyDecimals={currencyDecimals}
          lineByItemId={lineByItemId}
          onOpenReview={(item) => {
            setFocusItemId(item.id);
            setTab("today");
            setMessage("");
          }}
        />
      ) : null}
    </div>
  );
}
