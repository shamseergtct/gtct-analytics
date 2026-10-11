import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthContext";
import { useClient } from "../context/ClientContext.jsx";
import { useShift } from "../context/shift-context.js";
import { resolveCurrencyDecimals } from "../utils/money.js";
import { subscribeDailyReviewLines } from "../utils/inventoryDailyReview.js";
import TodayChecklist from "../components/staffInventory/TodayChecklist.jsx";
import FindItem from "../components/staffInventory/FindItem.jsx";
import StockUsage from "../components/staffInventory/StockUsage.jsx";

const TABS = [
  { id: "today", label: "Today" },
  { id: "usage", label: "Usage" },
  { id: "find", label: "Find" },
];

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

  const clientId = String(activeClientId || "").trim();
  const businessDate = String(activeShift?.businessDate || "").trim();
  const currencyDecimals = resolveCurrencyDecimals(activeClientData);

  useEffect(() => {
    if (!clientId) {
      setItems([]);
      setLoadingItems(false);
      return undefined;
    }
    setLoadingItems(true);
    const q = query(
      collection(db, "inventory"),
      where("clientId", "==", clientId)
    );
    return onSnapshot(
      q,
      (snap) => {
        setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoadingItems(false);
      },
      (err) => {
        setItems([]);
        setLoadingItems(false);
        setError(
          err?.message
            ? `Could not load inventory: ${err.message}`
            : "Could not load inventory."
        );
      }
    );
  }, [clientId]);

  useEffect(() => {
    if (!clientId || !businessDate) {
      setLines([]);
      return undefined;
    }
    return subscribeDailyReviewLines(clientId, businessDate, setLines, (err) => {
      setError(
        err?.message
          ? `Could not load reviews: ${err.message}`
          : "Could not load reviews."
      );
    });
  }, [clientId, businessDate]);

  const lineByItemId = useMemo(() => {
    const map = new Map();
    for (const row of lines) {
      map.set(String(row.itemId || row.id), row);
    }
    return map;
  }, [lines]);

  return (
    <div className="mx-auto max-w-lg space-y-4 p-3 pb-10 sm:p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-white">Staff Inventory</h1>
        <p className="text-sm text-slate-400">
          {activeClientData?.name || clientId || "No shop selected"}
          {businessDate ? ` · ${businessDate}` : ""}
        </p>
      </header>

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
          items={items}
          loadingItems={loadingItems}
          currencyDecimals={currencyDecimals}
          userUid={user?.uid}
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
          items={items}
          loadingItems={loadingItems}
          currencyDecimals={currencyDecimals}
          userUid={user?.uid}
          userName={displayName}
          onError={setError}
          onMessage={setMessage}
        />
      ) : null}

      {tab === "find" ? (
        <FindItem
          items={items}
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
