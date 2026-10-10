import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Eye, EyeOff, Pencil } from "lucide-react";
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthContext";
import {
  findBankAccountName,
  parsePaymentModeSelection,
  paymentModeSelectionFromSaved,
} from "../utils/paymentModes.js";
import { filterBankAccountsForPurpose } from "../utils/bankAccountTypes.js";
import {
  DELIVERY_ACCOUNT_PAYMENT,
  EXTERNAL_ENTRY_SOURCE_DELIVERY_APP,
  buildDeliveryBoyPaymentModeChoices,
  deliveryBoyOutstandingPayable,
  externalPaymentModeLabel,
  getTerminalTheme,
  isDeliveryBoyAccountPayment,
  normalizeBillNumber,
  resolveDeliveryBoyAssignedPaymentModes,
  sanitizeBillNumberInput,
  sortBillingTerminals,
} from "../utils/externalSales.js";
import {
  formatMoney,
  moneyInputStep,
  numMoney,
  parseMoneyInput,
  resolveCurrencyDecimals,
  roundMoney,
} from "../utils/money.js";
import {
  buildDeliveryChargeSelectOptions,
  deliveryChargeSelectValue,
} from "../utils/deliveryCharges.js";
import { useDeliveryChargeSettings } from "../hooks/useDeliveryChargeSettings.js";
import {
  DELIVERY_BILL_SUBMISSIONS,
  SUBMISSION_STATUS,
} from "../utils/deliveryBillSubmissions.js";
import {
  SYNC_STATUS,
  createEntryLocalId,
  deleteLocalBill,
  findLocalDuplicateBill,
  getDeliveryMeta,
  getUnsyncedSummary,
  listLocalBills,
  putLocalBill,
  queueDraftsForSync,
  setDeliveryMeta,
  updateLocalBill,
} from "../utils/deliveryBillQueue.js";
import {
  getDeliverySyncState,
  installDeliveryNetworkListeners,
  installUnsyncedNavigationGuard,
  refreshDeliverySyncCounts,
  runDeliveryBillSync,
  subscribeDeliverySync,
} from "../utils/deliveryBillSync.js";

function cleanId(value) {
  return String(value || "").trim();
}

/** Status chip for live bills on the Approved page. */
function approvedBillStatusMeta({ fromShop, edited, voided }) {
  if (voided) {
    return {
      label: "Deleted",
      className: "bg-rose-950/70 text-rose-200",
    };
  }
  if (fromShop) {
    return {
      label: "Entered by shop",
      className: "bg-sky-950/70 text-sky-200",
    };
  }
  if (edited) {
    return {
      label: "Edited & approved",
      className: "bg-amber-950/70 text-amber-200",
    };
  }
  return {
    label: "Approved",
    className: "bg-emerald-950/70 text-emerald-200",
  };
}

/** Status chip for today’s bills list (local + server). */
function dayBillStatusMeta(row) {
  if (row?.source === "local") {
    const sync = String(row.syncStatus || "").trim();
    if (sync === SYNC_STATUS.FAILED) {
      return {
        label: "Sync failed",
        className: "bg-rose-950/70 text-rose-200",
      };
    }
    if (sync === SYNC_STATUS.SYNCING) {
      return {
        label: "Syncing…",
        className: "bg-sky-950/70 text-sky-200",
      };
    }
    if (sync === SYNC_STATUS.DRAFT) {
      return {
        label: "On device",
        className: "bg-violet-950/70 text-violet-200",
      };
    }
    if (sync === SYNC_STATUS.PENDING) {
      return {
        label: "Ready to sync",
        className: "bg-amber-950/70 text-amber-200",
      };
    }
    return {
      label: "Not synced",
      className: "bg-amber-950/70 text-amber-200",
    };
  }

  const status = String(row?.status || "").trim();
  const editedBy = String(row?.lastEditSource || "").trim();

  if (status === SUBMISSION_STATUS.REJECTED) {
    return { label: "Rejected", className: "bg-rose-950/70 text-rose-200" };
  }
  if (status === SUBMISSION_STATUS.EDITED_PENDING) {
    return {
      label:
        editedBy === "shop" ? "Edited · shop · pending" : "Edited · delivery · pending",
      className: "bg-sky-950/70 text-sky-200",
    };
  }
  if (status === SUBMISSION_STATUS.PENDING) {
    return {
      label: "Synced · pending",
      className: "bg-amber-950/70 text-amber-200",
    };
  }
  if (status === SUBMISSION_STATUS.APPROVED) {
    if (editedBy === "shop") {
      return {
        label: "Approved · shop edit",
        className: "bg-emerald-950/70 text-emerald-200",
      };
    }
    if (editedBy === "delivery_boy") {
      return {
        label: "Approved · after edit",
        className: "bg-emerald-950/70 text-emerald-200",
      };
    }
    return { label: "Approved", className: "bg-emerald-950/70 text-emerald-200" };
  }
  return {
    label: status || "—",
    className: "bg-slate-800 text-slate-300",
  };
}

function todayYYYYMMDD() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function FieldLabel({ children }) {
  return (
    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3.5 text-lg text-white outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30";

function loginErrorMessage(error) {
  const code = String(error?.code || "");
  const raw = String(error?.message || "");
  if (code === "auth/invalid-credential" || raw.includes("invalid-credential")) {
    return (
      "Wrong email or password, or this login was never created. " +
      "Ask your shop admin to create a Delivery Entry login in External Sales → Setup → Delivery Boys (email + password)."
    );
  }
  if (code === "auth/user-disabled" || raw.includes("user-disabled")) {
    return "This account is disabled. Ask your admin to activate it.";
  }
  return raw || "Login failed.";
}

export default function DeliveryApp() {
  const {
    user,
    profile,
    role,
    authLoading,
    login,
    logout,
    displayName,
    isDisabled,
  } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  const clientId = useMemo(() => {
    const shops = Array.isArray(profile?.assignedShops)
      ? profile.assignedShops.filter(Boolean)
      : [];
    return String(profile?.clientId || shops[0] || "").trim();
  }, [profile]);

  const deliveryBoyId = String(profile?.deliveryBoyId || "").trim();
  const assignedTerminalIds = useMemo(() => {
    const fromProfile = Array.isArray(profile?.assignedTerminalIds)
      ? profile.assignedTerminalIds.map(String).filter(Boolean)
      : [];
    return fromProfile;
  }, [profile]);

  const [shop, setShop] = useState(null);
  const [deliveryBoy, setDeliveryBoy] = useState(null);
  const [terminals, setTerminals] = useState([]);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [businessDate, setBusinessDate] = useState(todayYYYYMMDD());
  const [selectedTerminalId, setSelectedTerminalId] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [billAmount, setBillAmount] = useState("");
  const [paymentMode, setPaymentMode] = useState(DELIVERY_ACCOUNT_PAYMENT);
  const [customerName, setCustomerName] = useState("");
  const [deliveryCharge, setDeliveryCharge] = useState("");
  const [chargeReady, setChargeReady] = useState(false);
  /** True once the boy changes charge — don’t overwrite with shop default. */
  const [chargeTouched, setChargeTouched] = useState(false);
  const [formError, setFormError] = useState("");
  const [formMessage, setFormMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncState, setSyncState] = useState(getDeliverySyncState());
  const [failedBills, setFailedBills] = useState([]);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [daySubmissions, setDaySubmissions] = useState([]);
  const [dayLiveBills, setDayLiveBills] = useState([]);
  const [dayLocalBills, setDayLocalBills] = useState([]);
  const [dayCollections, setDayCollections] = useState([]);
  const [dayListError, setDayListError] = useState("");
  const [editingSubmission, setEditingSubmission] = useState(null);
  /** entry | drafts | approved */
  const [activePage, setActivePage] = useState("entry");
  const [selectedDraftIds, setSelectedDraftIds] = useState(() => new Set());

  const billNumberRef = useRef(null);
  const syncCtxRef = useRef(null);

  const currencyDecimals = resolveCurrencyDecimals(shop, "OMR");
  const currency = shop?.currency || "";
  const {
    loading: chargeSettingsLoading,
    options: deliveryChargeOptions,
    defaultCharge,
  } = useDeliveryChargeSettings(clientId, currencyDecimals);
  const defaultChargeValue = deliveryChargeSelectValue(
    defaultCharge,
    currencyDecimals
  );
  const chargeSelectOptions = useMemo(
    () =>
      buildDeliveryChargeSelectOptions({
        options: deliveryChargeOptions,
        currencyDecimals,
        currency,
        includeAmount: deliveryCharge,
      }),
    [deliveryChargeOptions, currencyDecimals, currency, deliveryCharge]
  );

  const allowedTerminals = useMemo(() => {
    const active = terminals.filter((row) => row.isActive !== false);
    if (!assignedTerminalIds.length) return [];
    const allowed = new Set(assignedTerminalIds);
    return active.filter((row) => allowed.has(row.id));
  }, [terminals, assignedTerminalIds]);

  const selectedTerminal = useMemo(
    () => allowedTerminals.find((row) => row.id === selectedTerminalId) || null,
    [allowedTerminals, selectedTerminalId]
  );

  const theme = getTerminalTheme(
    selectedTerminal,
    Math.max(
      0,
      allowedTerminals.findIndex((row) => row.id === selectedTerminalId)
    )
  );

  const allowedPaymentModes = useMemo(
    () =>
      resolveDeliveryBoyAssignedPaymentModes(deliveryBoy, bankAccounts),
    [deliveryBoy, bankAccounts]
  );

  const allowedBankAccounts = useMemo(() => {
    const allowed = new Set(
      allowedPaymentModes
        .filter((value) => String(value).startsWith("BANK:"))
        .map((value) => value.slice("BANK:".length))
    );
    return bankAccounts.filter((row) => allowed.has(row.id));
  }, [bankAccounts, allowedPaymentModes]);

  const paymentOptions = useMemo(() => {
    const boyLabel =
      String(deliveryBoy?.name || displayName || "").trim() || "Delivery";
    const choices = buildDeliveryBoyPaymentModeChoices({
      deliveryBoyName: boyLabel,
      bankAccounts: allowedBankAccounts,
    });
    const allowed = new Set(allowedPaymentModes);
    return choices
      .filter((row) => allowed.has(row.value))
      .map((row) => ({ value: row.value, label: row.label }));
  }, [
    allowedBankAccounts,
    allowedPaymentModes,
    deliveryBoy?.name,
    displayName,
  ]);

  const isDeliveryBoyUser = role === "delivery_boy";

  // Sync context for network listeners
  syncCtxRef.current = {
    userUid: user?.uid,
    bankAccounts: allowedBankAccounts,
    deliveryBoy,
    currency,
    currencyDecimals,
  };

  useEffect(() => subscribeDeliverySync(setSyncState), []);
  useEffect(() => installUnsyncedNavigationGuard(), []);
  useEffect(() => {
    return installDeliveryNetworkListeners(() => syncCtxRef.current);
  }, []);

  useEffect(() => {
    if (chargeSettingsLoading || chargeReady) return;
    // Editing a draft or a manually chosen charge must not be reset to default.
    if (editingSubmission || chargeTouched) {
      setChargeReady(true);
      return;
    }
    setDeliveryCharge(defaultChargeValue);
    setChargeReady(true);
  }, [
    chargeSettingsLoading,
    chargeReady,
    defaultChargeValue,
    editingSubmission,
    chargeTouched,
  ]);

  const refreshLocalDayBills = useCallback(async () => {
    if (!clientId || !businessDate) {
      setDayLocalBills([]);
      return;
    }
    const date = String(businessDate).slice(0, 10);
    try {
      const rows = await listLocalBills();
      setDayLocalBills(
        rows.filter(
          (row) =>
            cleanId(row.clientId) === cleanId(clientId) &&
            String(row.businessDate || "").slice(0, 10) === date &&
            row.syncStatus !== SYNC_STATUS.SYNCED
        )
      );
    } catch {
      setDayLocalBills([]);
    }
  }, [clientId, businessDate]);

  useEffect(() => {
    void refreshLocalDayBills();
  }, [refreshLocalDayBills, syncState.pending, syncState.failed, syncState.syncing]);

  useEffect(() => {
    if (!clientId || !deliveryBoyId || !businessDate) {
      setDaySubmissions([]);
      setDayLiveBills([]);
      setDayCollections([]);
      setDayListError("");
      return undefined;
    }
    const date = String(businessDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setDaySubmissions([]);
      setDayLiveBills([]);
      setDayCollections([]);
      return undefined;
    }

    setDayListError("");
    const unsubscribers = [];

    // Live shop bills for this boy (shop-entered Delivery + approved Delivery Entry).
    // Query must include deliveryBoyId so Firestore list rules allow the boy to read them.
    let stopLiveBills = null;
    const attachLiveBills = (withOrderBy) => {
      const constraints = [
        where("clientId", "==", clientId),
        where("deliveryBoyId", "==", deliveryBoyId),
        where("businessDate", "==", date),
      ];
      if (withOrderBy) constraints.push(orderBy("createdAtMs", "desc"));
      stopLiveBills = onSnapshot(
        query(collection(db, "external_sales_bills"), ...constraints),
        (snap) => {
          const rows = snap.docs.map((item) => ({
            id: item.id,
            ...item.data(),
          }));
          if (!withOrderBy) {
            rows.sort(
              (a, b) =>
                Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0)
            );
          }
          setDayLiveBills(rows);
          setDayListError("");
        },
        (reason) => {
          console.error("delivery day live bills failed:", reason);
          if (withOrderBy) {
            if (typeof stopLiveBills === "function") stopLiveBills();
            attachLiveBills(false);
            return;
          }
          setDayLiveBills([]);
          setDayListError(
            reason?.message || "Could not load today’s approved bills."
          );
        }
      );
    };
    attachLiveBills(true);
    unsubscribers.push(() => {
      if (typeof stopLiveBills === "function") stopLiveBills();
    });

    // Pending / edited / rejected submissions from Delivery Entry.
    unsubscribers.push(
      onSnapshot(
        query(
          collection(db, DELIVERY_BILL_SUBMISSIONS),
          where("clientId", "==", clientId),
          where("deliveryBoyId", "==", deliveryBoyId),
          where("businessDate", "==", date)
        ),
        (snap) => {
          setDaySubmissions(
            snap.docs.map((item) => ({ id: item.id, ...item.data() }))
          );
          void refreshLocalDayBills();
        },
        (reason) => {
          console.error("delivery day submissions failed:", reason);
          setDaySubmissions([]);
          setDayListError((prev) =>
            prev ||
            reason?.message ||
            "Could not load pending delivery submissions."
          );
        }
      )
    );

    // Shop settlement collections for this boy (balance owed).
    unsubscribers.push(
      onSnapshot(
        query(
          collection(db, "delivery_boy_collections"),
          where("clientId", "==", clientId),
          where("deliveryBoyId", "==", deliveryBoyId),
          where("businessDate", "==", date)
        ),
        (snap) => {
          setDayCollections(
            snap.docs.map((item) => ({ id: item.id, ...item.data() }))
          );
        },
        (reason) => {
          console.error("delivery day collections failed:", reason);
          setDayCollections([]);
        }
      )
    );

    return () => {
      unsubscribers.forEach((stop) => stop());
    };
  }, [clientId, deliveryBoyId, businessDate, refreshLocalDayBills]);

  /** Unified today list: phone queue first (immediate), then server rows. */
  const dayRows = useMemo(() => {
    const rows = [];
    const coveredKeys = new Set();
    const coveredLocalIds = new Set();

    // Local queue first so edits appear immediately as not-synced.
    for (const local of dayLocalBills) {
      const localId = cleanId(local.entryLocalId);
      if (!localId) continue;
      const key = `${local.terminalId}__${local.billNumber}`;
      coveredKeys.add(key);
      coveredLocalIds.add(localId);
      rows.push({
        key: `local:${localId}`,
        source: "local",
        id: localId,
        billId: "",
        submissionId: "",
        billNumber: local.billNumber,
        terminalId: local.terminalId,
        terminalNameSnapshot: local.terminalNameSnapshot || "",
        billAmount: local.billAmount,
        saleType: "DELIVERY",
        paymentMode: local.paymentMode,
        bankAccountId: local.bankAccountId || "",
        bankAccountNameSnapshot: local.bankAccountNameSnapshot || "",
        customerName: local.customerName || "",
        deliveryCharge: local.deliveryCharge,
        deliveryBoyId: local.deliveryBoyId || deliveryBoyId,
        deliveryBoyNameSnapshot: local.deliveryBoyNameSnapshot || "",
        notes: local.notes || "",
        entryLocalId: localId,
        businessDate: local.businessDate,
        status: "LOCAL",
        syncStatus: local.syncStatus,
        syncError: local.syncError || "",
        lastEditSource: "",
        approvedBillId: "",
        createdAtMs: local.updatedAtMs || local.createdAtMs || 0,
        editable:
          local.syncStatus === SYNC_STATUS.DRAFT ||
          local.syncStatus === SYNC_STATUS.FAILED,
      });
    }

    for (const bill of dayLiveBills) {
      if (bill.voided === true) continue;
      const key = `${bill.terminalId}__${bill.billNumber}`;
      const linked = daySubmissions.find(
        (sub) =>
          cleanId(sub.approvedBillId) === cleanId(bill.id) ||
          (cleanId(sub.entryLocalId) &&
            cleanId(sub.entryLocalId) === cleanId(bill.entryLocalId)) ||
          (cleanId(sub.terminalId) === cleanId(bill.terminalId) &&
            String(sub.billNumber) === String(bill.billNumber))
      );
      const localId = cleanId(
        bill.entryLocalId || linked?.entryLocalId || ""
      );
      if (localId && coveredLocalIds.has(localId)) continue;
      if (coveredKeys.has(key)) continue;
      coveredKeys.add(key);
      if (localId) coveredLocalIds.add(localId);
      rows.push({
        key: `bill:${bill.id}`,
        source: "bill",
        id: linked?.id || bill.id,
        billId: bill.id,
        submissionId: linked?.id || "",
        billNumber: bill.billNumber,
        terminalId: bill.terminalId,
        terminalNameSnapshot: bill.terminalNameSnapshot || "",
        billAmount: bill.billAmount,
        saleType: bill.saleType || "DELIVERY",
        paymentMode: bill.paymentMode,
        bankAccountId: bill.bankAccountId || "",
        bankAccountNameSnapshot: bill.bankAccountNameSnapshot || "",
        customerName: bill.customerName || "",
        deliveryCharge: bill.deliveryCharge,
        deliveryBoyId: bill.deliveryBoyId,
        deliveryBoyNameSnapshot: bill.deliveryBoyNameSnapshot || "",
        notes: bill.notes || "",
        entryLocalId: localId,
        businessDate: bill.businessDate,
        status: linked?.status || SUBMISSION_STATUS.APPROVED,
        lastEditSource: linked?.lastEditSource || "",
        approvedBillId: bill.id,
        createdAtMs: bill.createdAtMs || 0,
        editable: false,
      });
    }

    for (const sub of daySubmissions) {
      const key = `${sub.terminalId}__${sub.billNumber}`;
      const localId = cleanId(sub.entryLocalId);
      if (localId && coveredLocalIds.has(localId)) continue;
      if (coveredKeys.has(key)) continue;
      if (
        sub.status === SUBMISSION_STATUS.APPROVED &&
        cleanId(sub.approvedBillId) &&
        dayLiveBills.some((bill) => cleanId(bill.id) === cleanId(sub.approvedBillId))
      ) {
        continue;
      }
      coveredKeys.add(key);
      if (localId) coveredLocalIds.add(localId);
      rows.push({
        key: `sub:${sub.id}`,
        source: "submission",
        id: sub.id,
        billId: sub.approvedBillId || "",
        submissionId: sub.id,
        billNumber: sub.billNumber,
        terminalId: sub.terminalId,
        terminalNameSnapshot: sub.terminalNameSnapshot || "",
        billAmount: sub.billAmount,
        saleType: sub.saleType || "DELIVERY",
        paymentMode: sub.paymentMode,
        bankAccountId: sub.bankAccountId || "",
        bankAccountNameSnapshot: sub.bankAccountNameSnapshot || "",
        customerName: sub.customerName || "",
        deliveryCharge: sub.deliveryCharge,
        deliveryBoyId: sub.deliveryBoyId,
        deliveryBoyNameSnapshot: sub.deliveryBoyNameSnapshot || "",
        notes: sub.notes || "",
        entryLocalId: localId,
        businessDate: sub.businessDate,
        status: sub.status,
        lastEditSource: sub.lastEditSource || "",
        approvedBillId: sub.approvedBillId || "",
        createdAtMs: sub.createdAtMs || sub.updatedAtMs || 0,
        editable: false,
      });
    }

    rows.sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
    return rows;
  }, [dayLiveBills, daySubmissions, dayLocalBills, deliveryBoyId]);

  const draftRows = useMemo(
    () =>
      dayRows.filter(
        (row) =>
          row.source === "local" &&
          (row.syncStatus === SYNC_STATUS.DRAFT ||
            row.syncStatus === SYNC_STATUS.PENDING ||
            row.syncStatus === SYNC_STATUS.FAILED ||
            row.syncStatus === SYNC_STATUS.SYNCING)
      ),
    [dayRows]
  );

  const editableDraftRows = useMemo(
    () =>
      draftRows.filter(
        (row) =>
          row.syncStatus === SYNC_STATUS.DRAFT ||
          row.syncStatus === SYNC_STATUS.FAILED
      ),
    [draftRows]
  );

  const approvedRows = useMemo(() => {
    return dayLiveBills
      .slice()
      .sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0))
      .map((bill) => {
        const entrySource = String(bill.entrySource || "").trim().toUpperCase();
        const linked = daySubmissions.find(
          (sub) =>
            cleanId(sub.approvedBillId) === cleanId(bill.id) ||
            (cleanId(bill.entryLocalId) &&
              cleanId(sub.entryLocalId) === cleanId(bill.entryLocalId))
        );
        const fromDeliveryApp =
          entrySource === EXTERNAL_ENTRY_SOURCE_DELIVERY_APP ||
          entrySource === "DELIVERY_APP" ||
          Boolean(cleanId(bill.entryLocalId)) ||
          Boolean(linked?.id);
        const fromShop = !fromDeliveryApp;
        const lastEdit = String(
          linked?.lastEditSource || bill.lastEditSource || ""
        )
          .trim()
          .toLowerCase();
        const edited =
          fromDeliveryApp &&
          (lastEdit === "delivery_boy" ||
            lastEdit === "shop" ||
            linked?.status === SUBMISSION_STATUS.EDITED_PENDING);
        return {
          key: `approved:${bill.id}`,
          id: bill.id,
          billNumber: bill.billNumber,
          terminalId: bill.terminalId,
          terminalNameSnapshot: bill.terminalNameSnapshot || "",
          billAmount: bill.billAmount,
          saleType: bill.saleType || "DELIVERY",
          paymentMode: bill.paymentMode,
          bankAccountId: bill.bankAccountId || "",
          bankAccountNameSnapshot: bill.bankAccountNameSnapshot || "",
          customerName: bill.customerName || "",
          deliveryCharge: bill.deliveryCharge,
          deliveryBoyNameSnapshot: bill.deliveryBoyNameSnapshot || "",
          entrySource,
          fromShop,
          edited,
          voided: bill.voided === true,
          createdAtMs: bill.createdAtMs || 0,
          updatedAtMs: bill.updatedAtMs || 0,
        };
      });
  }, [dayLiveBills, daySubmissions]);

  const approvedSummary = useMemo(() => {
    const activeBills = dayLiveBills.filter((bill) => bill.voided !== true);
    const outstanding = deliveryBoyOutstandingPayable({
      bills: activeBills,
      collections: dayCollections,
      deliveryBoyId,
    });
    return {
      count: outstanding.totalBills || activeBills.length,
      /** Money collected on the boy’s account (payment / collection). */
      collection: outstanding.grossAmount,
      /** Cash/bank already paid at the shop (not boy account). */
      shopPaid: outstanding.shopCollectionAmount ?? outstanding.shopPaidAmount,
      credit: outstanding.creditAmount,
      commission: outstanding.totalCommissionAmount,
      alreadySettled: outstanding.alreadyCollected,
      /** Remaining amount the boy still owes the shop. */
      balanceToShop: outstanding.remainingPayable,
      all: outstanding.totalAmount,
    };
  }, [dayLiveBills, dayCollections, deliveryBoyId]);

  const waitingShopRows = useMemo(() => {
    const approvedKeys = new Set(
      approvedRows
        .filter((row) => !row.voided)
        .map((row) => `${row.terminalId}__${normalizeBillNumber(row.billNumber)}`)
    );
    return daySubmissions
      .filter(
        (sub) =>
          (sub.status === SUBMISSION_STATUS.PENDING ||
            sub.status === SUBMISSION_STATUS.EDITED_PENDING) &&
          !approvedKeys.has(
            `${sub.terminalId}__${normalizeBillNumber(sub.billNumber)}`
          )
      )
      .sort(
        (a, b) =>
          Number(b.updatedAtMs || b.createdAtMs || 0) -
          Number(a.updatedAtMs || a.createdAtMs || 0)
      );
  }, [daySubmissions, approvedRows]);

  const draftCount = editableDraftRows.length;

  const syncableDraftIds = useMemo(
    () =>
      draftRows
        .filter(
          (row) =>
            row.syncStatus === SYNC_STATUS.DRAFT ||
            row.syncStatus === SYNC_STATUS.FAILED ||
            row.syncStatus === SYNC_STATUS.PENDING
        )
        .map((row) => cleanId(row.entryLocalId))
        .filter(Boolean),
    [draftRows]
  );

  const selectedDraftCount = useMemo(() => {
    let n = 0;
    for (const id of selectedDraftIds) {
      if (syncableDraftIds.includes(id)) n += 1;
    }
    return n;
  }, [selectedDraftIds, syncableDraftIds]);

  const allSyncableSelected =
    syncableDraftIds.length > 0 &&
    selectedDraftCount === syncableDraftIds.length;

  useEffect(() => {
    setSelectedDraftIds((prev) => {
      if (!prev.size) return prev;
      const valid = new Set(syncableDraftIds);
      let changed = false;
      const next = new Set();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [syncableDraftIds]);

  function toggleDraftSelected(entryLocalId) {
    const id = cleanId(entryLocalId);
    if (!id) return;
    setSelectedDraftIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllDrafts() {
    if (allSyncableSelected) {
      setSelectedDraftIds(new Set());
      return;
    }
    setSelectedDraftIds(new Set(syncableDraftIds));
  }

  // Resolve business date: open shift → cached → today
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = await getDeliveryMeta(`businessDate:${clientId}`);
      if (!cancelled && cached) setBusinessDate(String(cached).slice(0, 10));
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  useEffect(() => {
    if (!clientId || !user) return undefined;
    const q = query(
      collection(db, "shifts"),
      where("clientId", "==", clientId),
      where("status", "==", "OPEN")
    );
    return onSnapshot(
      q,
      async (snap) => {
        const open = snap.docs[0]?.data();
        const date = String(open?.businessDate || "").slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          setBusinessDate(date);
          await setDeliveryMeta(`businessDate:${clientId}`, date);
        } else {
          const fallback = todayYYYYMMDD();
          setBusinessDate(fallback);
          await setDeliveryMeta(`businessDate:${clientId}`, fallback);
        }
      },
      async () => {
        const cached = await getDeliveryMeta(`businessDate:${clientId}`);
        setBusinessDate(
          /^\d{4}-\d{2}-\d{2}$/.test(String(cached || ""))
            ? String(cached).slice(0, 10)
            : todayYYYYMMDD()
        );
      }
    );
  }, [clientId, user]);

  // Load shop
  useEffect(() => {
    if (!clientId) {
      setShop(null);
      return undefined;
    }
    return onSnapshot(
      doc(db, "clients", clientId),
      (snap) => setShop(snap.exists() ? { id: snap.id, ...snap.data() } : null),
      () => setShop(null)
    );
  }, [clientId]);

  // Load delivery boy master
  useEffect(() => {
    if (!deliveryBoyId) {
      setDeliveryBoy(null);
      return undefined;
    }
    return onSnapshot(
      doc(db, "delivery_boys", deliveryBoyId),
      (snap) =>
        setDeliveryBoy(snap.exists() ? { id: snap.id, ...snap.data() } : null),
      () => setDeliveryBoy(null)
    );
  }, [deliveryBoyId]);

  // Load terminals
  useEffect(() => {
    if (!clientId) {
      setTerminals([]);
      return undefined;
    }
    const q = query(
      collection(db, "billing_terminals"),
      where("clientId", "==", clientId)
    );
    return onSnapshot(
      q,
      (snap) => {
        setTerminals(
          sortBillingTerminals(
            snap.docs.map((item) => ({ id: item.id, ...item.data() }))
          )
        );
      },
      () => setTerminals([])
    );
  }, [clientId]);

  // Load operational banks
  useEffect(() => {
    if (!clientId) {
      setBankAccounts([]);
      return undefined;
    }
    const q = query(
      collection(db, "bank_accounts"),
      where("clientId", "==", clientId)
    );
    return onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs
          .map((item) => ({ id: item.id, ...item.data() }))
          .filter((row) => row.isActive !== false);
        setBankAccounts(filterBankAccountsForPurpose(rows, "transaction"));
      },
      () => setBankAccounts([])
    );
  }, [clientId]);

  // Auto-select single terminal / restore last choice
  useEffect(() => {
    if (!allowedTerminals.length) {
      setSelectedTerminalId("");
      return;
    }
    if (allowedTerminals.length === 1) {
      setSelectedTerminalId(allowedTerminals[0].id);
      return;
    }
    let cancelled = false;
    (async () => {
      const saved = await getDeliveryMeta(`terminal:${clientId}:${deliveryBoyId}`);
      if (cancelled) return;
      if (saved && allowedTerminals.some((row) => row.id === saved)) {
        setSelectedTerminalId(String(saved));
      } else if (
        !selectedTerminalId ||
        !allowedTerminals.some((row) => row.id === selectedTerminalId)
      ) {
        setSelectedTerminalId("");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedTerminals, clientId, deliveryBoyId]);

  useEffect(() => {
    if (selectedTerminalId && clientId && deliveryBoyId) {
      setDeliveryMeta(
        `terminal:${clientId}:${deliveryBoyId}`,
        selectedTerminalId
      );
    }
  }, [selectedTerminalId, clientId, deliveryBoyId]);

  const refreshFailedBills = useCallback(async () => {
    const summary = await getUnsyncedSummary();
    setFailedBills(
      (summary.rows || []).filter(
        (row) => row.syncStatus === SYNC_STATUS.FAILED
      )
    );
    return summary;
  }, []);

  const triggerSync = useCallback(async (retryFailed = false) => {
    if (!user?.uid) return;
    await runDeliveryBillSync({
      ...syncCtxRef.current,
      userUid: user.uid,
      retryFailed,
    });
    await refreshFailedBills();
  }, [user?.uid, refreshFailedBills]);

  useEffect(() => {
    if (!user?.uid || !isDeliveryBoyUser) return;
    refreshDeliverySyncCounts()
      .then(() => refreshFailedBills())
      .then(() => triggerSync());
  }, [
    user?.uid,
    isDeliveryBoyUser,
    triggerSync,
    refreshFailedBills,
    bankAccounts.length,
    deliveryBoy?.id,
  ]);

  async function discardFailedBill(entryLocalId) {
    if (!entryLocalId) return;
    const ok = window.confirm(
      "Remove this bill from this phone only?\n\nIt will not delete anything already saved in Analytics. Use this when the bill already exists on the server or was entered by mistake."
    );
    if (!ok) return;
    await deleteLocalBill(entryLocalId);
    await refreshDeliverySyncCounts();
    await refreshFailedBills();
  }

  async function fixFailedBillNumber(bill) {
    if (!bill?.entryLocalId) return;
    const next = window.prompt(
      `Bill ${bill.billNumber} already exists for ${bill.terminalNameSnapshot || "this terminal"}.\n\nEnter a new whole bill number (digits only) to sync instead:`,
      String(bill.billNumber || "")
    );
    if (next == null) return;
    const billNo = normalizeBillNumber(next);
    if (!billNo) {
      window.alert("Bill number must be a whole number (e.g. 1, 2, 3).");
      return;
    }
    await updateLocalBill(bill.entryLocalId, {
      billNumber: billNo,
      syncStatus: SYNC_STATUS.PENDING,
      syncError: "",
    });
    await refreshDeliverySyncCounts();
    await refreshFailedBills();
    await triggerSync(true);
  }

  // Drop payment selection if admin disabled that option for this boy.
  useEffect(() => {
    if (!paymentOptions.length) return;
    if (paymentOptions.some((row) => row.value === paymentMode)) return;
    setPaymentMode(paymentOptions[0].value);
  }, [paymentMode, paymentOptions]);

  async function handleLogin(event) {
    event.preventDefault();
    setLoginError("");
    setLoggingIn(true);
    try {
      await login(email, password);
    } catch (error) {
      setLoginError(loginErrorMessage(error));
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleLogout() {
    const summary = await getUnsyncedSummary();
    const drafts = draftCount || editableDraftRows.length;
    if ((summary.total > 0 || drafts > 0) && !logoutConfirmOpen) {
      setLogoutConfirmOpen(true);
      return;
    }
    setLogoutConfirmOpen(false);
    await logout();
  }

  function clearBillFields() {
    setEditingSubmission(null);
    setBillNumber("");
    setBillAmount("");
    setCustomerName("");
    setDeliveryCharge(defaultChargeValue);
    setChargeTouched(false);
    setPaymentMode(
      paymentOptions[0]?.value || DELIVERY_ACCOUNT_PAYMENT
    );
    setFormError("");
    requestAnimationFrame(() => billNumberRef.current?.focus());
  }

  function loadDraftForEdit(row) {
    if (!row) return;
    if (row.source !== "local") {
      setFormError("Synced and shop bills cannot be edited.");
      return;
    }
    if (
      row.syncStatus !== SYNC_STATUS.DRAFT &&
      row.syncStatus !== SYNC_STATUS.FAILED
    ) {
      setFormError(
        "This bill is already queued or synced and cannot be edited."
      );
      return;
    }

    setFormError("");
    setFormMessage("");
    setActivePage("entry");
    setEditingSubmission({
      id: row.entryLocalId,
      ...row,
      source: "local",
      syncStatus: row.syncStatus,
    });
    if (row.terminalId) setSelectedTerminalId(row.terminalId);
    setBillNumber(String(row.billNumber || ""));
    setBillAmount(
      row.billAmount === 0 || row.billAmount
        ? formatMoney(row.billAmount, currencyDecimals)
        : ""
    );
    setCustomerName(String(row.customerName || ""));
    setDeliveryCharge(
      deliveryChargeSelectValue(row.deliveryCharge, currencyDecimals)
    );
    setChargeTouched(true);
    setChargeReady(true);
    setPaymentMode(
      paymentModeSelectionFromSaved(
        row.paymentMode || DELIVERY_ACCOUNT_PAYMENT,
        row.bankAccountId || ""
      )
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
    requestAnimationFrame(() => billNumberRef.current?.focus());
  }

  function validateBillForm() {
    if (!user?.uid || !isDeliveryBoyUser) {
      return { error: "Delivery boy login required." };
    }
    if (deliveryBoy?.isActive === false) {
      return { error: "Your delivery account is inactive." };
    }
    if (!selectedTerminal) {
      return { error: "Select an assigned terminal." };
    }
    if (!assignedTerminalIds.includes(selectedTerminal.id)) {
      return { error: "You are not assigned to this terminal." };
    }

    const billNo = normalizeBillNumber(billNumber);
    if (!billNo) {
      return { error: "Bill number must be a whole number (e.g. 1, 2, 3)." };
    }
    if (billAmount === "" || billAmount == null) {
      return { error: "Bill amount is required." };
    }
    const amountNum = parseMoneyInput(billAmount, currencyDecimals);
    if (!Number.isFinite(Number(String(billAmount).trim().replace(/,/g, "")))) {
      return { error: "Bill amount must be a valid number." };
    }

    let chargeNum = 0;
    if (deliveryCharge !== "" && deliveryCharge != null) {
      chargeNum = parseMoneyInput(deliveryCharge, currencyDecimals);
      if (chargeNum < 0) {
        return { error: "Delivery charge must be a non-negative number." };
      }
    }
    chargeNum = roundMoney(Math.max(0, chargeNum), currencyDecimals);

    const resolved = parsePaymentModeSelection(paymentMode);
    let savedPaymentMode = resolved.paymentMode;
    let bankAccountId = "";
    let bankAccountNameSnapshot = "";

    if (!paymentOptions.some((row) => row.value === paymentMode)) {
      return {
        error:
          "That payment option is not enabled for you. Ask an admin to update your payment options.",
      };
    }

    if (paymentMode === DELIVERY_ACCOUNT_PAYMENT) {
      savedPaymentMode = DELIVERY_ACCOUNT_PAYMENT;
    } else if (resolved.paymentMode === "BANK") {
      bankAccountId = String(resolved.bankAccountId || "").trim();
      if (!bankAccountId) {
        return { error: "Select a bank account." };
      }
      if (!allowedBankAccounts.some((row) => row.id === bankAccountId)) {
        return {
          error:
            "That bank account is not assigned to you. Ask an admin to update your payment options.",
        };
      }
      bankAccountNameSnapshot = findBankAccountName(
        allowedBankAccounts,
        bankAccountId
      );
      savedPaymentMode = "BANK";
    } else if (resolved.paymentMode === "CASH") {
      savedPaymentMode = "CASH";
    } else {
      return { error: "Select a valid payment type." };
    }

    const date = String(businessDate || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return {
        error: "Business date is unavailable. Reconnect once to continue.",
      };
    }

    return {
      billNo,
      amountNum,
      chargeNum,
      savedPaymentMode,
      bankAccountId,
      bankAccountNameSnapshot,
      date,
    };
  }

  function formHasAnyInput() {
    return Boolean(
      String(billNumber || "").trim() ||
        String(billAmount || "").trim() ||
        String(customerName || "").trim() ||
        editingSubmission?.id
    );
  }

  async function persistLocalBill({ syncStatus }) {
    const validated = validateBillForm();
    if (validated.error) {
      setFormError(validated.error);
      return null;
    }

    const {
      billNo,
      amountNum,
      chargeNum,
      savedPaymentMode,
      bankAccountId,
      bankAccountNameSnapshot,
      date,
    } = validated;

    if (billNo !== String(billNumber || "").trim()) {
      setBillNumber(billNo);
    }

    if (editingSubmission?.id) {
      if (
        editingSubmission.syncStatus !== SYNC_STATUS.DRAFT &&
        editingSubmission.syncStatus !== SYNC_STATUS.FAILED
      ) {
        setFormError(
          "This bill was already synced and cannot be edited."
        );
        return null;
      }
    } else {
      const alreadyInList = dayRows.some(
        (row) =>
          row.status !== SUBMISSION_STATUS.REJECTED &&
          !row.voided &&
          cleanId(row.terminalId) === cleanId(selectedTerminal.id) &&
          normalizeBillNumber(row.billNumber) === billNo
      );
      if (alreadyInList) {
        setFormError(
          `Bill ${billNo} is already listed for ${selectedTerminal.name}. Open View & Edit if it is still on this phone.`
        );
        return null;
      }

      const duplicate = await findLocalDuplicateBill({
        clientId,
        businessDate: date,
        terminalId: selectedTerminal.id,
        billNumber: billNo,
        excludeEntryLocalId: "",
      });
      if (duplicate) {
        setFormError(
          `Bill ${billNo} is already saved on this phone for ${selectedTerminal.name}. Open View & Edit to change it.`
        );
        return null;
      }
    }

    if (editingSubmission?.id) {
      const duplicate = await findLocalDuplicateBill({
        clientId,
        businessDate: date,
        terminalId: selectedTerminal.id,
        billNumber: billNo,
        excludeEntryLocalId: cleanId(
          editingSubmission.entryLocalId || editingSubmission.id
        ),
      });
      if (duplicate) {
        setFormError(
          `Bill ${billNo} is already saved on this phone for ${selectedTerminal.name}.`
        );
        return null;
      }
    }

    const nowMs = Date.now();
    const entryLocalId = editingSubmission?.id
      ? cleanId(editingSubmission.entryLocalId || editingSubmission.id)
      : createEntryLocalId();

    const localRecord = {
      entryLocalId,
      clientId,
      businessDate: date,
      terminalId: selectedTerminal.id,
      terminalNameSnapshot: selectedTerminal.name || "",
      billNumber: billNo,
      billAmount: roundMoney(amountNum, currencyDecimals),
      paymentMode: savedPaymentMode,
      bankAccountId,
      bankAccountNameSnapshot,
      customerName: String(customerName || "").trim(),
      deliveryCharge: roundMoney(chargeNum, currencyDecimals),
      deliveryBoyId: deliveryBoy?.id || deliveryBoyId,
      deliveryBoyNameSnapshot: deliveryBoy?.name || displayName || "",
      commissionEnabled: Boolean(deliveryBoy?.commissionEnabled),
      commissionRate: Number(deliveryBoy?.commissionRate) || 0,
      currency,
      currencyDecimals,
      notes: "",
      entrySource: EXTERNAL_ENTRY_SOURCE_DELIVERY_APP,
      syncStatus,
      syncError: "",
      createdAtMs: Number(editingSubmission?.createdAtMs) || nowMs,
      updatedAtMs: nowMs,
      createdBy: user.uid,
    };

    await putLocalBill(localRecord);
    return localRecord;
  }

  async function handleSaveOnDevice(event) {
    event.preventDefault();
    setFormError("");
    setFormMessage("");
    setSaving(true);
    try {
      const saved = await persistLocalBill({ syncStatus: SYNC_STATUS.DRAFT });
      if (!saved) return;
      await refreshLocalDayBills();
      setFormMessage(`Bill ${saved.billNumber} saved on this phone.`);
      clearBillFields();
      setActivePage("drafts");
    } catch (error) {
      setFormError(error?.message || "Could not save bill on this phone.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSyncNow({ onlySelected = false } = {}) {
    setFormError("");
    setFormMessage("");
    setSaving(true);
    try {
      if (activePage === "entry" && formHasAnyInput()) {
        const saved = await persistLocalBill({
          syncStatus: SYNC_STATUS.PENDING,
        });
        if (!saved) return;
        clearBillFields();
      }

      const selectedIds = [...selectedDraftIds].filter((id) =>
        syncableDraftIds.includes(id)
      );
      if (onlySelected && selectedIds.length === 0) {
        setFormMessage("Select bills to sync.");
        return;
      }

      const queued = await queueDraftsForSync({
        clientId,
        businessDate,
        entryLocalIds: onlySelected ? selectedIds : null,
      });
      await refreshDeliverySyncCounts();
      await refreshLocalDayBills();
      const summary = await getUnsyncedSummary();
      if (summary.total === 0 && queued === 0) {
        setFormMessage("Nothing to sync.");
        return;
      }

      setFormMessage(
        onlySelected
          ? `Syncing ${selectedIds.length}…`
          : queued > 0
            ? `Syncing ${queued}…`
            : "Syncing…"
      );
      await triggerSync(true);
      await refreshLocalDayBills();
      if (onlySelected) setSelectedDraftIds(new Set());
      setFormMessage("Synced.");
    } catch (error) {
      setFormError(error?.message || "Sync failed.");
    } finally {
      setSaving(false);
    }
  }

  if (authLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-950 text-slate-200">
        Loading…
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-dvh bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 px-4 py-10">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-8 text-center">
            <div className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-400">
              GTCT
            </div>
            <h1 className="mt-2 text-3xl font-bold text-white">Delivery Entry</h1>
            <p className="mt-2 text-sm text-slate-400">
              Fast bill entry for delivery boys
            </p>
          </div>
          <form
            onSubmit={handleLogin}
            className="space-y-4 rounded-3xl border border-slate-800 bg-slate-950/80 p-6 shadow-2xl"
          >
            <div>
              <FieldLabel>Email</FieldLabel>
              <input
                type="email"
                autoComplete="username"
                className={inputClass}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <FieldLabel>Password</FieldLabel>
              <div className="relative">
                <input
                  type={showLoginPassword ? "text" : "password"}
                  autoComplete="current-password"
                  className={`${inputClass} pr-14`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowLoginPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-xl p-2.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                  aria-label={showLoginPassword ? "Hide password" : "Show password"}
                >
                  {showLoginPassword ? (
                    <EyeOff size={22} aria-hidden />
                  ) : (
                    <Eye size={22} aria-hidden />
                  )}
                </button>
              </div>
            </div>
            {loginError ? (
              <div className="rounded-xl border border-rose-800 bg-rose-950/40 px-3 py-2 text-sm text-rose-100">
                {loginError}
              </div>
            ) : null}
            <button
              type="submit"
              disabled={loggingIn}
              className="w-full rounded-2xl bg-sky-500 py-3.5 text-base font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-60"
            >
              {loggingIn ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (isDisabled || !isDeliveryBoyUser) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-slate-950 px-4 text-center text-slate-200">
        <p className="max-w-sm text-sm text-slate-300">
          {isDisabled
            ? "This account is disabled."
            : "This app is for delivery boy accounts only. Use GTCT Analytics for admin access."}
        </p>
        <button
          type="button"
          onClick={() => logout()}
          className="rounded-xl border border-slate-700 px-4 py-2 text-sm"
        >
          Sign out
        </button>
        <a href="/" className="text-sm text-sky-400 underline">
          Open Analytics
        </a>
      </div>
    );
  }

  if (!deliveryBoyId || !clientId) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-slate-950 px-4 text-center">
        <p className="max-w-sm text-sm text-amber-100">
          Your login is not linked to a delivery boy / shop. Ask an admin to
          finish setup.
        </p>
        <button
          type="button"
          onClick={() => logout()}
          className="rounded-xl border border-slate-700 px-4 py-2 text-sm"
        >
          Sign out
        </button>
      </div>
    );
  }

  const pendingTotal = (syncState.pending || 0) + (syncState.failed || 0);

  return (
    <div
      className="min-h-dvh bg-slate-950 text-slate-100"
      style={{
        "--term-accent": theme.accent,
        "--term-tint": theme.tint,
        "--term-border": theme.border,
        "--term-ring": theme.ring,
      }}
    >
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">
              {deliveryBoy?.name || displayName}
            </div>
            <div className="truncate text-xs text-slate-400">
              {shop?.name || clientId} · {businessDate}
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="shrink-0 rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300"
          >
            Logout
          </button>
        </div>

        <div className="mx-auto mt-2 flex max-w-lg items-center gap-2 text-xs">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ${
              syncState.online
                ? "bg-emerald-950/60 text-emerald-300"
                : "bg-amber-950/60 text-amber-200"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                syncState.online ? "bg-emerald-400" : "bg-amber-400"
              }`}
            />
            {syncState.online ? "Online" : "Offline"}
          </span>
          {syncState.syncing ? (
            <span className="text-sky-300">⟳ Syncing…</span>
          ) : pendingTotal > 0 ? (
            <span className="text-amber-200">
              {pendingTotal} bill{pendingTotal === 1 ? "" : "s"} waiting to sync
            </span>
          ) : draftCount > 0 ? (
            <span className="text-violet-200">
              {draftCount} on device (not synced)
            </span>
          ) : (
            <span className="text-slate-500">All synced</span>
          )}
        </div>
      </header>

      {pendingTotal > 0 ? (
        <div className="border-b border-amber-900/50 bg-amber-950/40 px-4 py-2.5">
          <div className="mx-auto max-w-lg space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-amber-100">
                  {pendingTotal} waiting to sync
                </div>
                {syncState.lastError ? (
                  <div className="mt-1 text-xs text-rose-200">
                    {syncState.lastError}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => triggerSync(true)}
                className="shrink-0 rounded-lg border border-amber-700/60 px-2 py-1 text-xs text-amber-100"
              >
                Retry
              </button>
            </div>

            {failedBills.map((bill) => (
              <div
                key={bill.entryLocalId}
                className="rounded-xl border border-rose-900/50 bg-rose-950/30 p-3"
              >
                <div className="text-sm font-medium text-rose-100">
                  Bill {bill.billNumber} · {bill.terminalNameSnapshot || "Terminal"}
                </div>
                <div className="mt-1 text-xs text-rose-200/90">
                  {bill.syncError || "Could not sync this bill."}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {/already|duplicate|exists/i.test(
                    String(bill.syncError || "")
                  ) ? (
                    <button
                      type="button"
                      onClick={() => fixFailedBillNumber(bill)}
                      className="rounded-lg border border-sky-700/60 bg-sky-950/40 px-2.5 py-1.5 text-xs font-semibold text-sky-100"
                    >
                      Change bill no.
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => discardFailedBill(bill.entryLocalId)}
                    className="rounded-lg border border-slate-600 px-2.5 py-1.5 text-xs text-slate-200"
                  >
                    Discard from phone
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : syncState.message === "All bills synced" && draftCount === 0 ? (
        <div className="border-b border-emerald-900/40 bg-emerald-950/30 px-4 py-2 text-center text-sm text-emerald-200">
          ✓ All bills synced
        </div>
      ) : null}

      <nav className="mx-auto grid max-w-lg grid-cols-3 gap-1 border-b border-slate-800 px-2 py-2">
        {[
          { id: "entry", label: "New entry" },
          {
            id: "drafts",
            label: "View & Edit",
            badge: draftCount > 0 ? draftCount : null,
          },
          {
            id: "approved",
            label: "Approved",
            badge: approvedSummary.count > 0 ? approvedSummary.count : null,
          },
        ].map((tab) => {
          const active = activePage === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActivePage(tab.id)}
              className={`relative rounded-xl px-2 py-2.5 text-xs font-semibold transition ${
                active
                  ? "bg-sky-500 text-slate-950"
                  : "bg-slate-900 text-slate-300"
              }`}
            >
              {tab.label}
              {tab.badge != null ? (
                <span
                  className={`ml-1 inline-flex min-w-[1.1rem] justify-center rounded-full px-1 text-[10px] ${
                    active
                      ? "bg-slate-950/20 text-slate-950"
                      : "bg-slate-700 text-slate-200"
                  }`}
                >
                  {tab.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <main className="mx-auto max-w-lg space-y-5 px-4 py-5 pb-28">
        {activePage === "entry" ? (
          <>
            {approvedSummary.count > 0 ? (
              <button
                type="button"
                onClick={() => setActivePage("approved")}
                className="flex w-full items-center justify-between rounded-2xl border border-emerald-800/50 bg-emerald-950/30 px-4 py-3 text-left"
              >
                <span className="text-sm text-emerald-100">
                  {approvedSummary.count} bill
                  {approvedSummary.count === 1 ? "" : "s"} in shop
                </span>
                <span className="text-xs font-semibold text-emerald-300">
                  Approved →
                </span>
              </button>
            ) : null}

            <section>
              <FieldLabel>Terminal</FieldLabel>
              {!allowedTerminals.length ? (
                <div className="rounded-2xl border border-amber-800/60 bg-amber-950/30 p-4 text-sm text-amber-100">
                  No terminals assigned. Ask an admin to assign terminals to your
                  account.
                </div>
              ) : (
                <div className="grid gap-2">
                  {allowedTerminals.map((terminal, index) => {
                    const t = getTerminalTheme(terminal, index);
                    const selected = terminal.id === selectedTerminalId;
                    return (
                      <button
                        key={terminal.id}
                        type="button"
                        onClick={() => setSelectedTerminalId(terminal.id)}
                        className={`flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition ${
                          selected
                            ? "border-[color:var(--term-border)] bg-[color:var(--term-tint)] ring-2 ring-[color:var(--term-ring)]"
                            : "border-slate-800 bg-slate-900/70"
                        }`}
                        style={
                          selected
                            ? {
                                "--term-border": t.border,
                                "--term-tint": t.tint,
                                "--term-ring": t.ring,
                              }
                            : undefined
                        }
                      >
                        <span
                          className={`flex h-5 w-5 items-center justify-center rounded-full border-2 ${
                            selected ? "border-white" : "border-slate-500"
                          }`}
                        >
                          {selected ? (
                            <span
                              className="h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: t.accent }}
                            />
                          ) : null}
                        </span>
                        <span
                          className="h-3 w-3 rounded-full"
                          style={{ backgroundColor: t.accent }}
                        />
                        <span className="text-base font-semibold text-white">
                          {terminal.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <form
              onSubmit={handleSaveOnDevice}
              className="space-y-4 rounded-3xl border p-4"
              style={{
                borderColor: theme.border,
                background: theme.tint,
              }}
            >
              <div
                className="rounded-2xl px-3 py-2 text-sm font-semibold text-white"
                style={{ background: theme.accentSoft, color: theme.accent }}
              >
                {editingSubmission
                  ? `Editing bill ${editingSubmission.billNumber}`
                  : selectedTerminal?.name || "Select terminal"}
              </div>

              {editingSubmission ? (
                <button
                  type="button"
                  onClick={() => clearBillFields()}
                  className="text-xs text-sky-300 underline"
                >
                  Cancel edit
                </button>
              ) : null}

              <div>
                <FieldLabel>Bill Number</FieldLabel>
                <input
                  ref={billNumberRef}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  className={inputClass}
                  value={billNumber}
                  onChange={(e) =>
                    setBillNumber(sanitizeBillNumberInput(e.target.value))
                  }
                  onBlur={() => {
                    const cleaned = normalizeBillNumber(billNumber);
                    if (cleaned !== billNumber) setBillNumber(cleaned);
                  }}
                  placeholder="1256"
                />
              </div>

              <div>
                <FieldLabel>Bill Amount</FieldLabel>
                <input
                  inputMode="decimal"
                  step={moneyInputStep(currencyDecimals)}
                  autoComplete="off"
                  className={inputClass}
                  value={billAmount}
                  onChange={(e) => setBillAmount(e.target.value)}
                  placeholder="0.000"
                />
              </div>

              <div>
                <FieldLabel>Payment Type</FieldLabel>
                <select
                  className={inputClass}
                  value={paymentMode}
                  onChange={(e) => setPaymentMode(e.target.value)}
                >
                  {paymentOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <FieldLabel>Customer Name</FieldLabel>
                <input
                  autoComplete="off"
                  className={inputClass}
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Optional"
                />
              </div>

              <div>
                <FieldLabel>Delivery Charge</FieldLabel>
                <select
                  className={inputClass}
                  value={deliveryCharge}
                  onChange={(e) => {
                    setChargeTouched(true);
                    setDeliveryCharge(e.target.value);
                  }}
                >
                  {chargeSelectOptions.map((row) => (
                    <option key={row.value || "none"} value={row.value}>
                      {row.label}
                    </option>
                  ))}
                </select>
              </div>

              {formError ? (
                <div className="rounded-xl border border-rose-800 bg-rose-950/50 px-3 py-2 text-sm text-rose-100">
                  {formError}
                </div>
              ) : null}
              {formMessage ? (
                <div className="rounded-xl border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-100">
                  ✓ {formMessage}
                </div>
              ) : null}

              <div className="grid gap-2">
                <button
                  type="submit"
                  disabled={saving || !selectedTerminal}
                  className="w-full rounded-2xl py-4 text-lg font-bold text-slate-950 disabled:opacity-50"
                  style={{ backgroundColor: theme.accent }}
                >
                  {saving
                    ? "Saving…"
                    : editingSubmission
                      ? "Update on device"
                      : "Save on device"}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSyncNow()}
                  className="w-full rounded-2xl border border-sky-600/70 bg-sky-950/50 py-3.5 text-base font-semibold text-sky-100 disabled:opacity-50"
                >
                  {saving ? "Working…" : "Sync"}
                </button>
              </div>
            </form>
          </>
        ) : null}

        {activePage === "drafts" ? (
          <section className="space-y-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-white">
                  On this phone
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {draftRows.length
                    ? `${draftRows.length} bill${draftRows.length === 1 ? "" : "s"}`
                    : "Empty"}
                  {selectedDraftCount
                    ? ` · ${selectedDraftCount} selected`
                    : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActivePage("entry")}
                className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200"
              >
                New
              </button>
            </div>

            {formError ? (
              <div className="rounded-xl border border-rose-800 bg-rose-950/50 px-3 py-2 text-sm text-rose-100">
                {formError}
              </div>
            ) : null}
            {formMessage ? (
              <div className="rounded-xl border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-100">
                ✓ {formMessage}
              </div>
            ) : null}

            {draftRows.length ? (
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={toggleSelectAllDrafts}
                  className="text-xs font-semibold text-sky-300"
                >
                  {allSyncableSelected ? "Clear selection" : "Select all"}
                </button>
                <button
                  type="button"
                  disabled={saving || selectedDraftCount === 0}
                  onClick={() => void handleSyncNow({ onlySelected: true })}
                  className="rounded-xl bg-sky-500 px-3.5 py-2.5 text-xs font-semibold text-slate-950 disabled:opacity-40"
                >
                  Sync selected
                  {selectedDraftCount ? ` (${selectedDraftCount})` : ""}
                </button>
              </div>
            ) : null}

            {!draftRows.length ? (
              <div className="rounded-3xl border border-dashed border-slate-800 bg-slate-900/40 px-4 py-10 text-center text-sm text-slate-500">
                No bills on this phone.
              </div>
            ) : (
              <ul className="space-y-2.5">
                {draftRows.map((row) => {
                  const boyAcct = isDeliveryBoyAccountPayment(row);
                  const statusMeta = dayBillStatusMeta(row);
                  const canEdit = row.editable;
                  const id = cleanId(row.entryLocalId);
                  const selected = selectedDraftIds.has(id);
                  const charge = numMoney(row.deliveryCharge);
                  const canSelect =
                    row.syncStatus === SYNC_STATUS.DRAFT ||
                    row.syncStatus === SYNC_STATUS.FAILED ||
                    row.syncStatus === SYNC_STATUS.PENDING;
                  return (
                    <li
                      key={row.key}
                      className={`rounded-2xl border transition ${
                        selected
                          ? "border-sky-500/70 bg-sky-950/35"
                          : "border-slate-800 bg-slate-900/70"
                      }`}
                    >
                      <div className="flex items-stretch gap-0">
                        <button
                          type="button"
                          disabled={!canSelect}
                          onClick={() => toggleDraftSelected(id)}
                          aria-label={
                            selected ? "Deselect bill" : "Select bill"
                          }
                          className="flex w-12 shrink-0 items-center justify-center border-r border-slate-800/80 disabled:opacity-40"
                        >
                          <span
                            className={`flex h-5 w-5 items-center justify-center rounded-md border-2 ${
                              selected
                                ? "border-sky-400 bg-sky-500 text-slate-950"
                                : "border-slate-500 bg-transparent"
                            }`}
                          >
                            {selected ? (
                              <Check size={12} strokeWidth={3} />
                            ) : null}
                          </span>
                        </button>

                        <div className="min-w-0 flex-1 px-3 py-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="text-sm font-semibold text-white">
                                  Bill {row.billNumber}
                                </span>
                                <span className="truncate text-xs text-slate-400">
                                  {row.terminalNameSnapshot || "Terminal"}
                                </span>
                              </div>
                              <div className="mt-1 truncate text-xs text-slate-400">
                                {externalPaymentModeLabel(row)}
                                {row.customerName
                                  ? ` · ${row.customerName}`
                                  : ""}
                              </div>
                            </div>
                            {canEdit ? (
                              <button
                                type="button"
                                onClick={() => loadDraftForEdit(row)}
                                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white"
                                aria-label={`Edit bill ${row.billNumber}`}
                              >
                                <Pencil size={14} />
                              </button>
                            ) : null}
                          </div>

                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <div className="rounded-xl bg-slate-950/70 px-2.5 py-2">
                              <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                                Amount
                              </div>
                              <div className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                                {formatMoney(row.billAmount, currencyDecimals)}
                              </div>
                            </div>
                            <div className="rounded-xl bg-slate-950/70 px-2.5 py-2">
                              <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                                Delivery charge
                              </div>
                              <div className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                                {charge
                                  ? formatMoney(charge, currencyDecimals)
                                  : "—"}
                              </div>
                            </div>
                          </div>

                          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                boyAcct
                                  ? "bg-violet-950/70 text-violet-200"
                                  : "bg-emerald-950/70 text-emerald-200"
                              }`}
                            >
                              {boyAcct ? "My account" : "Shop"}
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusMeta.className}`}
                            >
                              {statusMeta.label}
                            </span>
                          </div>
                          {row.syncError ? (
                            <div className="mt-2 text-[11px] text-rose-300">
                              {row.syncError}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}

        {activePage === "approved" ? (
          <section className="space-y-4">
            <div>
              <h2 className="text-base font-semibold text-white">Approved</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {approvedSummary.count
                  ? `${approvedSummary.count} bill${
                      approvedSummary.count === 1 ? "" : "s"
                    } in shop`
                  : "No bills yet"}
                {waitingShopRows.length
                  ? ` · ${waitingShopRows.length} waiting`
                  : ""}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-2xl border border-violet-800/40 bg-violet-950/25 px-3 py-3">
                <div className="text-[10px] font-medium uppercase tracking-wide text-violet-300/80">
                  Collection
                </div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-white">
                  {formatMoney(approvedSummary.collection, currencyDecimals)}
                </div>
              </div>
              <div className="rounded-2xl border border-amber-800/40 bg-amber-950/25 px-3 py-3">
                <div className="text-[10px] font-medium uppercase tracking-wide text-amber-300/80">
                  Balance to shop
                </div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-white">
                  {formatMoney(approvedSummary.balanceToShop, currencyDecimals)}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-2xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-xs text-slate-400">
              <div className="flex justify-between gap-2">
                <span>Total</span>
                <span className="tabular-nums text-slate-200">
                  {formatMoney(approvedSummary.all, currencyDecimals)}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Shop paid</span>
                <span className="tabular-nums text-slate-200">
                  {formatMoney(approvedSummary.shopPaid, currencyDecimals)}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Credit</span>
                <span className="tabular-nums text-slate-200">
                  {formatMoney(approvedSummary.credit, currencyDecimals)}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Commission</span>
                <span className="tabular-nums text-slate-200">
                  {formatMoney(approvedSummary.commission, currencyDecimals)}
                </span>
              </div>
              {approvedSummary.alreadySettled > 0 ? (
                <div className="col-span-2 flex justify-between gap-2 border-t border-slate-800 pt-1.5">
                  <span>Settled</span>
                  <span className="tabular-nums text-slate-200">
                    {formatMoney(
                      approvedSummary.alreadySettled,
                      currencyDecimals
                    )}
                  </span>
                </div>
              ) : null}
            </div>

            {dayListError ? (
              <p className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-100">
                {dayListError}
              </p>
            ) : null}

            {!approvedRows.length && !waitingShopRows.length ? (
              <div className="rounded-3xl border border-dashed border-slate-800 bg-slate-900/40 px-4 py-10 text-center text-sm text-slate-500">
                No approved bills for this date yet.
              </div>
            ) : null}

            {approvedRows.length ? (
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-200/90">
                  In shop
                </h3>
                <ul className="space-y-2.5">
                  {approvedRows.map((row) => {
                    const boyAcct = isDeliveryBoyAccountPayment(row);
                    const statusMeta = approvedBillStatusMeta(row);
                    const charge = numMoney(row.deliveryCharge);
                    return (
                      <li
                        key={row.key}
                        className={`rounded-2xl border px-3 py-3 ${
                          row.voided
                            ? "border-rose-900/40 bg-rose-950/20 opacity-75"
                            : row.fromShop
                              ? "border-sky-800/45 bg-sky-950/20"
                              : row.edited
                                ? "border-amber-800/40 bg-amber-950/15"
                                : "border-slate-800 bg-slate-900/70"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="text-sm font-semibold text-white">
                                Bill {row.billNumber}
                              </span>
                              <span className="truncate text-xs text-slate-400">
                                {row.terminalNameSnapshot || "Terminal"}
                              </span>
                            </div>
                            <div className="mt-1 truncate text-xs text-slate-400">
                              {externalPaymentModeLabel(row)}
                              {row.customerName
                                ? ` · ${row.customerName}`
                                : ""}
                            </div>
                          </div>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusMeta.className}`}
                          >
                            {statusMeta.label}
                          </span>
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <div className="rounded-xl bg-slate-950/70 px-2.5 py-2">
                            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                              Amount
                            </div>
                            <div
                              className={`mt-0.5 text-sm font-semibold tabular-nums ${
                                row.voided
                                  ? "text-slate-500 line-through"
                                  : "text-white"
                              }`}
                            >
                              {formatMoney(row.billAmount, currencyDecimals)}
                            </div>
                          </div>
                          <div className="rounded-xl bg-slate-950/70 px-2.5 py-2">
                            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                              Delivery charge
                            </div>
                            <div
                              className={`mt-0.5 text-sm font-semibold tabular-nums ${
                                row.voided
                                  ? "text-slate-500 line-through"
                                  : "text-white"
                              }`}
                            >
                              {charge
                                ? formatMoney(charge, currencyDecimals)
                                : "—"}
                            </div>
                          </div>
                        </div>

                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                              boyAcct
                                ? "bg-violet-950/70 text-violet-200"
                                : "bg-emerald-950/70 text-emerald-200"
                            }`}
                          >
                            {boyAcct ? "Collection" : "Shop paid"}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            {waitingShopRows.length ? (
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-200/90">
                  Waiting for shop
                </h3>
                <ul className="space-y-2.5">
                  {waitingShopRows.map((row) => {
                    const charge = numMoney(row.deliveryCharge);
                    return (
                      <li
                        key={row.id}
                        className="rounded-2xl border border-amber-900/40 bg-amber-950/20 px-3 py-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="text-sm font-semibold text-white">
                                Bill {row.billNumber}
                              </span>
                              <span className="truncate text-xs text-slate-400">
                                {row.terminalNameSnapshot || "Terminal"}
                              </span>
                            </div>
                            <div className="mt-1 truncate text-xs text-slate-400">
                              {externalPaymentModeLabel(row)}
                              {row.customerName
                                ? ` · ${row.customerName}`
                                : ""}
                            </div>
                          </div>
                          <span className="shrink-0 rounded-full bg-amber-950/70 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
                            Pending
                          </span>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <div className="rounded-xl bg-slate-950/50 px-2.5 py-2">
                            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                              Amount
                            </div>
                            <div className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                              {formatMoney(row.billAmount, currencyDecimals)}
                            </div>
                          </div>
                          <div className="rounded-xl bg-slate-950/50 px-2.5 py-2">
                            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                              Delivery charge
                            </div>
                            <div className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                              {charge
                                ? formatMoney(charge, currencyDecimals)
                                : "—"}
                            </div>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}
      </main>

      {logoutConfirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center">
          <div className="w-full max-w-sm rounded-3xl border border-slate-700 bg-slate-950 p-5 shadow-2xl">
            <div className="text-base font-semibold text-white">
              {pendingTotal + draftCount > 0
                ? `${pendingTotal + draftCount} bill${
                    pendingTotal + draftCount === 1 ? "" : "s"
                  } still on this phone`
                : "Bills still on this phone"}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setLogoutConfirmOpen(false)}
                className="flex-1 rounded-xl border border-slate-700 py-3 text-sm font-semibold"
              >
                Stay
              </button>
              <button
                type="button"
                onClick={async () => {
                  setLogoutConfirmOpen(false);
                  await logout();
                }}
                className="flex-1 rounded-xl bg-rose-600 py-3 text-sm font-semibold text-white"
              >
                Logout Anyway
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
