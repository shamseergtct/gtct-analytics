import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import ChecklistItemCard from "./ChecklistItemCard.jsx";
import {
  ATTENTION_STATUS_META,
  isAttentionStatus,
  normalizeRequestedQty,
  subscribeDailyReviewLines,
} from "../../utils/inventoryDailyReview.js";
import { formatMoney } from "../../utils/money.js";
import {
  STAFF_INV_ENTRY_TYPE,
  enqueueStaffReview,
  listPendingStaffInvEntries,
} from "../../utils/staffInventoryQueue.js";
import { runStaffInventorySync } from "../../utils/staffInventorySync.js";

function emptyDraft() {
  return { attentionStatus: "", requestedQty: "", notes: "" };
}

function ItemListRow({ item, line, currencyDecimals, onOpen }) {
  const statusMeta = line?.attentionStatus
    ? ATTENTION_STATUS_META[line.attentionStatus]
    : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 border-b border-slate-800/80 px-3 py-3.5 text-left last:border-b-0 active:bg-slate-800/50"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-white">
          {item.itemName || "—"}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
          <span className="tabular-nums">{item.itemCode || "—"}</span>
          <span className="text-slate-600">·</span>
          <span className="tabular-nums text-sky-200/90">
            {formatMoney(item.currentStock, currencyDecimals)}
          </span>
          {statusMeta ? (
            <>
              <span className="text-slate-600">·</span>
              <span className={`font-medium ${statusMeta.textClass}`}>
                {statusMeta.short}
              </span>
            </>
          ) : null}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
    </button>
  );
}

export default function TodayChecklist({
  clientId,
  businessDate,
  items,
  loadingItems,
  currencyDecimals,
  userUid,
  userName,
  focusItemId = "",
  onFocusConsumed,
  onError,
  onMessage,
}) {
  const [lines, setLines] = useState([]);
  const [localReviews, setLocalReviews] = useState([]);
  const [loadingLines, setLoadingLines] = useState(true);
  const [drafts, setDrafts] = useState({});
  const [saveStates, setSaveStates] = useState({});
  const [activeItemId, setActiveItemId] = useState("");

  const refreshLocalReviews = useCallback(async () => {
    if (!clientId || !businessDate) {
      setLocalReviews([]);
      return;
    }
    try {
      const rows = await listPendingStaffInvEntries({
        clientId,
        businessDate,
        type: STAFF_INV_ENTRY_TYPE.REVIEW,
      });
      setLocalReviews(rows);
    } catch {
      setLocalReviews([]);
    }
  }, [clientId, businessDate]);

  useEffect(() => {
    void refreshLocalReviews();
  }, [refreshLocalReviews]);

  useEffect(() => {
    if (!clientId || !businessDate) {
      setLines([]);
      setLoadingLines(false);
      return undefined;
    }
    setLoadingLines(true);
    return subscribeDailyReviewLines(
      clientId,
      businessDate,
      (rows) => {
        setLines(rows);
        setLoadingLines(false);
        void refreshLocalReviews();
      },
      (err) => {
        setLoadingLines(false);
        // Offline / listener errors: still allow local queue work.
        onError?.(
          err?.message
            ? `Live reviews unavailable (${err.message}). Local saves still work.`
            : "Live reviews unavailable. Local saves still work."
        );
      }
    );
  }, [clientId, businessDate, onError, refreshLocalReviews]);

  const lineByItemId = useMemo(() => {
    const map = new Map();
    for (const row of lines) {
      map.set(String(row.itemId || row.id), row);
    }
    // Pending local reviews overlay server lines so the list feels instant.
    for (const row of localReviews) {
      const itemId = String(row.itemId || "");
      if (!itemId) continue;
      map.set(itemId, {
        id: itemId,
        itemId,
        attentionStatus: row.attentionStatus,
        requestedQty:
          row.requestedQty === "" || row.requestedQty == null
            ? null
            : Number(row.requestedQty),
        notes: row.notes || "",
        completed: true,
        pendingSync: true,
        syncStatus: row.syncStatus,
        syncError: row.syncError || "",
      });
    }
    return map;
  }, [lines, localReviews]);

  useEffect(() => {
    if (!focusItemId) return;
    if (items.some((row) => row.id === focusItemId)) {
      setActiveItemId(focusItemId);
      onFocusConsumed?.();
    }
  }, [focusItemId, items, onFocusConsumed]);

  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const item of items) {
        const id = item.id;
        const localState = saveStates[id];
        if (
          localState === "dirty" ||
          localState === "saving" ||
          localState === "error"
        ) {
          if (!next[id]) next[id] = emptyDraft();
          continue;
        }
        const line = lineByItemId.get(id);
        if (line) {
          next[id] = {
            attentionStatus: line.attentionStatus || "",
            requestedQty:
              line.requestedQty == null || line.requestedQty === ""
                ? ""
                : String(line.requestedQty),
            notes: line.notes || "",
          };
        } else if (!next[id]) {
          next[id] = emptyDraft();
        }
      }
      return next;
    });
  }, [items, lineByItemId, saveStates]);

  const { pendingItems, completedItems } = useMemo(() => {
    const pending = [];
    const completed = [];
    for (const item of items) {
      const line = lineByItemId.get(item.id);
      if (line?.completed) completed.push(item);
      else pending.push(item);
    }
    pending.sort((a, b) =>
      String(a.itemName || "").localeCompare(String(b.itemName || ""))
    );
    completed.sort((a, b) =>
      String(a.itemName || "").localeCompare(String(b.itemName || ""))
    );
    return { pendingItems: pending, completedItems: completed };
  }, [items, lineByItemId]);

  const reviewedCount = completedItems.length;
  const totalCount = items.length;
  const progressPct = totalCount
    ? Math.round((reviewedCount / totalCount) * 100)
    : 0;

  const activeItem = useMemo(
    () => items.find((row) => row.id === activeItemId) || null,
    [items, activeItemId]
  );
  const activeCompleted = Boolean(
    activeItem && lineByItemId.get(activeItem.id)?.completed
  );

  function patchDraft(itemId, patch) {
    setDrafts((prev) => ({
      ...prev,
      [itemId]: { ...(prev[itemId] || emptyDraft()), ...patch },
    }));
    setSaveStates((prev) => ({ ...prev, [itemId]: "dirty" }));
  }

  async function handleSave(item, overrideDraft) {
    const draft = overrideDraft || drafts[item.id] || emptyDraft();
    if (!draft.attentionStatus) return;
    onError?.("");
    onMessage?.("");
    setSaveStates((prev) => ({ ...prev, [item.id]: "saving" }));
    try {
      const status = String(draft.attentionStatus || "").trim().toUpperCase();
      if (!isAttentionStatus(status)) {
        throw new Error("Select Enough, Low, Urgent, or Very Urgent.");
      }
      let qty = normalizeRequestedQty(draft.requestedQty);
      if (qty === 0) qty = null;
      if (status !== "ENOUGH" && (qty == null || qty <= 0)) {
        throw new Error(
          "Enter the required quantity for Low, Urgent, or Very Urgent."
        );
      }

      await enqueueStaffReview({
        clientId,
        businessDate,
        item,
        attentionStatus: status,
        requestedQty: qty == null ? "" : String(qty),
        notes: draft.notes,
        userUid,
        userName,
      });
      await refreshLocalReviews();
      setSaveStates((prev) => ({ ...prev, [item.id]: "saved" }));
      const offline =
        typeof navigator !== "undefined" && navigator.onLine === false;
      onMessage?.(
        offline
          ? `Saved on device: ${item.itemName || item.itemCode}. Will sync when online.`
          : `Saved: ${item.itemName || item.itemCode}. Syncing…`
      );
      setActiveItemId("");
      void runStaffInventorySync({ clientId, userUid });
    } catch (err) {
      setSaveStates((prev) => ({ ...prev, [item.id]: "error" }));
      onError?.(err?.message || "Failed to save review.");
    }
  }

  function handleStatus(item, status) {
    const nextDraft = {
      ...(drafts[item.id] || emptyDraft()),
      attentionStatus: status,
    };
    setDrafts((prev) => ({ ...prev, [item.id]: nextDraft }));
    setSaveStates((prev) => ({ ...prev, [item.id]: "dirty" }));
    // Enough can save immediately; other statuses need a required qty first.
    if (status === "ENOUGH") {
      void handleSave(item, nextDraft);
      return;
    }
    const qty = Number(nextDraft.requestedQty);
    if (Number.isFinite(qty) && qty > 0) {
      void handleSave(item, nextDraft);
      return;
    }
    onError?.("Enter the required quantity, then save.");
  }

  if (!clientId) {
    return (
      <div className="rounded-2xl border border-amber-800/50 bg-amber-950/20 px-4 py-8 text-center text-sm text-amber-100">
        Select an active shop to review stock.
      </div>
    );
  }

  if (!businessDate) {
    return (
      <div className="rounded-2xl border border-amber-800/50 bg-amber-950/20 px-4 py-8 text-center text-sm text-amber-100">
        Open a shift to start today's checklist. Reviews follow the open shift
        business date.
      </div>
    );
  }

  if (loadingItems || loadingLines) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 px-4 py-10 text-center text-sm text-slate-400">
        Loading checklist…
      </div>
    );
  }

  if (activeItem) {
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
        <ChecklistItemCard
          item={activeItem}
          draft={drafts[activeItem.id] || emptyDraft()}
          saveState={saveStates[activeItem.id]}
          currencyDecimals={currencyDecimals}
          completed={activeCompleted}
          onStatus={(status) => handleStatus(activeItem, status)}
          onQtyChange={(value) =>
            patchDraft(activeItem.id, { requestedQty: value })
          }
          onNotesChange={(value) => patchDraft(activeItem.id, { notes: value })}
          onSave={() => void handleSave(activeItem)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Today
            </div>
            <div className="mt-0.5 text-lg font-semibold text-white">
              {businessDate}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">Progress</div>
            <div className="text-lg font-semibold tabular-nums text-sky-200">
              {reviewedCount}/{totalCount}
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
          Tap an item to review. On-hand qty is informational only.
        </p>
      </section>

      {!totalCount ? (
        <div className="rounded-2xl border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
          No inventory items for this shop yet.
        </div>
      ) : (
        <>
          <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
            <div className="border-b border-slate-800 px-3 py-2.5 text-sm font-semibold text-white">
              Needs review ({pendingItems.length})
            </div>
            {pendingItems.length ? (
              <div>
                {pendingItems.map((item) => (
                  <ItemListRow
                    key={item.id}
                    item={item}
                    line={lineByItemId.get(item.id)}
                    currencyDecimals={currencyDecimals}
                    onOpen={() => setActiveItemId(item.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="px-3 py-6 text-center text-sm text-emerald-200">
                All items reviewed for today.
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-2xl border border-emerald-900/40 bg-emerald-950/10">
            <div className="border-b border-emerald-900/40 px-3 py-2.5 text-sm font-semibold text-emerald-200">
              Completed ({completedItems.length})
            </div>
            {completedItems.length ? (
              <div>
                {completedItems.map((item) => (
                  <ItemListRow
                    key={item.id}
                    item={item}
                    line={lineByItemId.get(item.id)}
                    currencyDecimals={currencyDecimals}
                    onOpen={() => setActiveItemId(item.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="px-3 py-6 text-center text-sm text-slate-500">
                Reviewed items appear here.
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
