import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { ClipboardList } from "lucide-react";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext.jsx";
import { useShift } from "../context/shift-context";
import ModuleHelpButton from "../components/ModuleHelpButton.jsx";
import ModuleExitButton from "../components/ModuleExitButton.jsx";
import ExternalSalesForm from "../components/externalSales/ExternalSalesForm.jsx";
import ExternalSalesList from "../components/externalSales/ExternalSalesList.jsx";
import TerminalManager from "../components/externalSales/TerminalManager.jsx";
import DeliveryBoyManager from "../components/externalSales/DeliveryBoyManager.jsx";
import DeliveryBoyCollection from "../components/externalSales/DeliveryBoyCollection.jsx";

const TABS = [
  { id: "entry", label: "Bill Entry" },
  { id: "list", label: "Daily List" },
  { id: "collect", label: "Collect" },
  { id: "setup", label: "Setup" },
];

function todayYYYYMMDD() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export default function ExternalSales() {
  const { activeClientId, activeClientData, currency, currencyDecimals } =
    useClient();
  const { activeShift } = useShift();

  const defaultDate =
    activeShift?.businessDate || todayYYYYMMDD();

  const [tab, setTab] = useState("entry");
  const [filterDate, setFilterDate] = useState("");
  const effectiveFilterDate = filterDate || defaultDate;
  const [message, setMessage] = useState("");
  const [pageError, setPageError] = useState("");

  const [terminals, setTerminals] = useState([]);
  const [loadingTerminals, setLoadingTerminals] = useState(true);
  const [deliveryBoys, setDeliveryBoys] = useState([]);
  const [loadingBoys, setLoadingBoys] = useState(true);
  const [bills, setBills] = useState([]);
  const [loadingBills, setLoadingBills] = useState(false);
  const [billsError, setBillsError] = useState("");

  useEffect(() => {
    if (!message) return undefined;
    const timeoutId = window.setTimeout(() => setMessage(""), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [message]);

  useEffect(() => {
    if (!activeClientId) return undefined;
    const q = query(
      collection(db, "billing_terminals"),
      where("clientId", "==", activeClientId)
    );
    return onSnapshot(
      q,
      (snapshot) => {
        const rows = snapshot.docs
          .map((item) => ({ id: item.id, ...item.data() }))
          .sort((a, b) =>
            String(a.name || "").localeCompare(String(b.name || ""))
          );
        setTerminals(rows);
        setLoadingTerminals(false);
      },
      (reason) => {
        setTerminals([]);
        setLoadingTerminals(false);
        setPageError(reason?.message || "Failed to load terminals.");
      }
    );
  }, [activeClientId]);

  useEffect(() => {
    if (!activeClientId) return undefined;
    const q = query(
      collection(db, "delivery_boys"),
      where("clientId", "==", activeClientId)
    );
    return onSnapshot(
      q,
      (snapshot) => {
        const rows = snapshot.docs
          .map((item) => ({ id: item.id, ...item.data() }))
          .sort((a, b) =>
            String(a.name || "").localeCompare(String(b.name || ""))
          );
        setDeliveryBoys(rows);
        setLoadingBoys(false);
      },
      (reason) => {
        setDeliveryBoys([]);
        setLoadingBoys(false);
        setPageError(reason?.message || "Failed to load delivery boys.");
      }
    );
  }, [activeClientId]);

  useEffect(() => {
    if (!activeClientId || !effectiveFilterDate) return undefined;
    const q = query(
      collection(db, "external_sales_bills"),
      where("clientId", "==", activeClientId),
      where("businessDate", "==", effectiveFilterDate),
      orderBy("createdAtMs", "desc")
    );
    return onSnapshot(
      q,
      (snapshot) => {
        setBills(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
        setLoadingBills(false);
        setBillsError("");
      },
      (reason) => {
        setBills([]);
        setLoadingBills(false);
        setBillsError(reason?.message || "Failed to load external sales bills.");
      }
    );
  }, [activeClientId, effectiveFilterDate]);

  const shopLabel = useMemo(
    () => activeClientData?.name || activeClientId || "shop",
    [activeClientData?.name, activeClientId]
  );

  if (!activeClientId) {
    return (
      <div className="rounded-2xl border border-amber-900/50 bg-amber-950/20 p-6 text-amber-100">
        Select an active shop to use External Sales.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
            <ClipboardList className="h-6 w-6 text-blue-400" />
            External Sales
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Capture summarized sales bills from your existing billing software
            for {shopLabel}. This is not a POS checkout.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ModuleHelpButton moduleId="external-sales" />
          <ModuleExitButton />
        </div>
      </div>

      {pageError ? (
        <div className="rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
          {pageError}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-200">
          {message}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-3">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
              tab === item.id
                ? "bg-blue-600 text-white"
                : "bg-slate-900 text-slate-300 hover:bg-slate-800"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "entry" ? (
        <ExternalSalesForm
          clientId={activeClientId}
          currency={currency}
          currencyDecimals={currencyDecimals}
          defaultBusinessDate={defaultDate}
          terminals={terminals}
          deliveryBoys={deliveryBoys}
          onMessage={(text) => {
            setPageError("");
            setMessage(text);
          }}
          onError={(text) => {
            setMessage("");
            setPageError(text);
          }}
        />
      ) : null}

      {tab === "list" ? (
        <ExternalSalesList
          bills={bills}
          loading={loadingBills}
          error={billsError}
          filterDate={effectiveFilterDate}
          onFilterDateChange={setFilterDate}
          terminals={terminals}
          deliveryBoys={deliveryBoys}
          currency={currency}
          currencyDecimals={currencyDecimals}
          onMessage={(text) => {
            setPageError("");
            setMessage(text);
          }}
          onError={(text) => {
            setMessage("");
            setPageError(text);
          }}
        />
      ) : null}

      {tab === "collect" ? (
        <DeliveryBoyCollection
          clientId={activeClientId}
          currency={currency}
          currencyDecimals={currencyDecimals}
          defaultBusinessDate={defaultDate}
          deliveryBoys={deliveryBoys}
          onMessage={(text) => {
            setPageError("");
            setMessage(text);
          }}
          onError={(text) => {
            setMessage("");
            setPageError(text);
          }}
        />
      ) : null}

      {tab === "setup" ? (
        <div className="grid gap-8 xl:grid-cols-2">
          <TerminalManager
            clientId={activeClientId}
            terminals={terminals}
            loading={loadingTerminals}
            onMessage={(text) => {
              setPageError("");
              setMessage(text);
            }}
            onError={(text) => {
              setMessage("");
              setPageError(text);
            }}
          />
          <DeliveryBoyManager
            clientId={activeClientId}
            deliveryBoys={deliveryBoys}
            loading={loadingBoys}
            onMessage={(text) => {
              setPageError("");
              setMessage(text);
            }}
            onError={(text) => {
              setMessage("");
              setPageError(text);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
