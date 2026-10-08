import { useEffect, useState } from "react";
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
import DateInput from "../components/DateInput.jsx";
import ModuleHelpButton from "../components/ModuleHelpButton.jsx";
import ModuleExitButton from "../components/ModuleExitButton.jsx";
import ExternalSalesForm from "../components/externalSales/ExternalSalesForm.jsx";
import ExternalSalesList from "../components/externalSales/ExternalSalesList.jsx";
import TerminalManager from "../components/externalSales/TerminalManager.jsx";
import DeliveryBoyManager from "../components/externalSales/DeliveryBoyManager.jsx";
import DeliveryBoyCollection from "../components/externalSales/DeliveryBoyCollection.jsx";
import DeliveryBillApprovals from "../components/externalSales/DeliveryBillApprovals.jsx";
import DaySummaryPrivacySettings from "../components/externalSales/DaySummaryPrivacySettings.jsx";
import DeliveryChargeSettings from "../components/externalSales/DeliveryChargeSettings.jsx";
import { sortBillingTerminals } from "../utils/externalSales.js";
import { useBankAccounts } from "../hooks/useBankAccounts.js";
import {
  FIELD_CLASS,
  LABEL_CLASS,
} from "../components/externalSales/externalSalesUi.js";

const TABS = [
  { id: "entry", label: "Bill Entry" },
  { id: "list", label: "Daily List" },
  { id: "collect", label: "Collect" },
  { id: "setup", label: "Setup" },
];

const DATE_TABS = new Set(["entry", "list", "collect"]);

function todayYYYYMMDD() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export default function ExternalSales() {
  const { activeClientId, currency, currencyDecimals } = useClient();
  const { activeShift } = useShift();
  const { accounts: shopBankAccounts } = useBankAccounts(activeClientId, {
    activeOnly: false,
    purpose: "all",
  });

  const defaultDate = activeShift?.businessDate || todayYYYYMMDD();

  const [tab, setTab] = useState("entry");
  const [filterDate, setFilterDate] = useState("");
  const effectiveFilterDate = filterDate || defaultDate;
  const [message, setMessage] = useState("");
  const [pageError, setPageError] = useState("");
  const [dateLocked, setDateLocked] = useState(false);
  const [approvalSubmission, setApprovalSubmission] = useState(null);

  const [terminals, setTerminals] = useState([]);
  const [loadingTerminals, setLoadingTerminals] = useState(true);
  const [deliveryBoys, setDeliveryBoys] = useState([]);
  const [loadingBoys, setLoadingBoys] = useState(true);
  const [bills, setBills] = useState([]);
  const [loadingBills, setLoadingBills] = useState(false);
  const [billsError, setBillsError] = useState("");
  const [terminalToolbarEl, setTerminalToolbarEl] = useState(null);

  useEffect(() => {
    if (!message) return undefined;
    const timeoutId = window.setTimeout(() => setMessage(""), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [message]);

  useEffect(() => {
    setDateLocked(false);
  }, [tab]);

  useEffect(() => {
    if (!activeClientId) return undefined;
    const q = query(
      collection(db, "billing_terminals"),
      where("clientId", "==", activeClientId)
    );
    return onSnapshot(
      q,
      (snapshot) => {
        const rows = sortBillingTerminals(
          snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
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

  if (!activeClientId) {
    return (
      <div className="rounded-2xl border border-amber-900/50 bg-amber-950/20 p-6 text-amber-100">
        Select an active shop to use External Sales.
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-bold text-white sm:text-2xl">
            <ClipboardList className="h-5 w-5 shrink-0 text-blue-400 sm:h-6 sm:w-6" />
            <span className="truncate">External Sales</span>
          </h1>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
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

      <div
        data-external-sales-sticky
        className="sticky top-16 z-30 -mx-1 border-b border-slate-800/80 bg-slate-950/90 py-3 backdrop-blur-md supports-[backdrop-filter]:bg-slate-950/75"
      >
        <div className="flex flex-col gap-3 px-1 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <div className="min-w-0 overflow-x-auto overscroll-x-contain">
              <div className="flex min-w-max gap-2 sm:min-w-0 sm:flex-wrap">
                {TABS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setTab(item.id)}
                    className={`rounded-lg px-3 py-2 text-sm font-semibold whitespace-nowrap shadow-sm transition-colors ${
                      tab === item.id
                        ? "bg-blue-600 text-white shadow-blue-900/40"
                        : "border border-slate-800 bg-slate-900/90 text-slate-300 hover:bg-slate-800"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            {tab === "entry" ? (
              <DeliveryBillApprovals
                clientId={activeClientId}
                businessDate={effectiveFilterDate}
                currency={currency}
                currencyDecimals={currencyDecimals}
                onReviewSubmission={(row) => {
                  setApprovalSubmission(row);
                }}
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
          </div>

          {DATE_TABS.has(tab) ? (
            <label
              className={`${LABEL_CLASS} w-full shrink-0 rounded-xl border border-slate-800 bg-slate-900/90 px-3 py-2 sm:w-auto sm:min-w-[11rem]`}
            >
              Business Date
              <DateInput
                value={effectiveFilterDate}
                onChange={(event) => setFilterDate(event.target.value)}
                className={`${FIELD_CLASS} mt-1.5`}
                required
                disabled={dateLocked}
              />
            </label>
          ) : null}
        </div>

        {tab === "entry" ? (
          <div
            ref={setTerminalToolbarEl}
            className="mt-3 min-w-0 border-t border-slate-800/70 px-1 pt-3"
          />
        ) : null}
      </div>

      {tab === "entry" ? (
        <div className="space-y-4">
          <ExternalSalesForm
            clientId={activeClientId}
            currency={currency}
            currencyDecimals={currencyDecimals}
            businessDate={effectiveFilterDate}
            terminals={terminals}
            deliveryBoys={deliveryBoys}
            bills={bills}
            loadingBills={loadingBills}
            toolbarPortalEl={terminalToolbarEl}
            approvalSubmission={approvalSubmission}
            onApprovalSubmissionConsumed={() => setApprovalSubmission(null)}
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

      {tab === "list" ? (
        <ExternalSalesList
          clientId={activeClientId}
          bills={bills}
          loading={loadingBills}
          error={billsError}
          filterDate={effectiveFilterDate}
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
          businessDate={effectiveFilterDate}
          deliveryBoys={deliveryBoys}
          onDateLockChange={setDateLocked}
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
            terminals={terminals}
            bankAccounts={shopBankAccounts}
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
          <div className="xl:col-span-2 grid gap-8 lg:grid-cols-2">
            <DeliveryChargeSettings
              clientId={activeClientId}
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
            <DaySummaryPrivacySettings
              clientId={activeClientId}
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
        </div>
      ) : null}
    </div>
  );
}
