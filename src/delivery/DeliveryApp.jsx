import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Pencil } from "lucide-react";
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
  resolveCurrencyDecimals,
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
  const [formError, setFormError] = useState("");
  const [formMessage, setFormMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncState, setSyncState] = useState(getDeliverySyncState());
  const [failedBills, setFailedBills] = useState([]);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [daySubmissions, setDaySubmissions] = useState([]);
  const [dayLiveBills, setDayLiveBills] = useState([]);
  const [dayLocalBills, setDayLocalBills] = useState([]);
  const [dayListError, setDayListError] = useState("");
  const [editingSubmission, setEditingSubmission] = useState(null);

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
    if (editingSubmission) {
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
      setDayListError("");
      return undefined;
    }
    const date = String(businessDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setDaySubmissions([]);
      setDayLiveBills([]);
      return undefined;
    }

    setDayListError("");
    const unsubscribers = [];

    // Approved bills live on external_sales_bills (same source as shop "Bills entered today").
    unsubscribers.push(
      onSnapshot(
        query(
          collection(db, "external_sales_bills"),
          where("clientId", "==", clientId),
          where("businessDate", "==", date),
          orderBy("createdAtMs", "desc")
        ),
        (snap) => {
          const rows = snap.docs
            .map((item) => ({ id: item.id, ...item.data() }))
            .filter(
              (bill) =>
                bill.voided !== true &&
                String(bill.deliveryBoyId || "").trim() === deliveryBoyId
            );
          setDayLiveBills(rows);
        },
        (reason) => {
          console.error("delivery day live bills failed:", reason);
          setDayLiveBills([]);
          setDayListError(
            reason?.message || "Could not load today’s approved bills."
          );
        }
      )
    );

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
        editable: true,
      });
    }

    for (const bill of dayLiveBills) {
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
        editable: Boolean(linked?.id),
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
        editable: sub.status !== SUBMISSION_STATUS.REJECTED,
      });
    }

    rows.sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
    return rows;
  }, [dayLiveBills, daySubmissions, dayLocalBills, deliveryBoyId]);

  const dayTotals = useMemo(() => {
    let boyAccount = 0;
    let shopAccount = 0;
    let count = 0;
    for (const row of dayRows) {
      if (row?.status === SUBMISSION_STATUS.REJECTED) continue;
      count += 1;
      const amount = numMoney(row.billAmount);
      if (isDeliveryBoyAccountPayment(row)) boyAccount += amount;
      else shopAccount += amount;
    }
    return {
      boyAccount,
      shopAccount,
      all: boyAccount + shopAccount,
      count,
    };
  }, [dayRows]);

  const editingLockedIdentity = Boolean(
    editingSubmission &&
      editingSubmission.source !== "local" &&
      (editingSubmission.status === SUBMISSION_STATUS.APPROVED ||
        editingSubmission.status === SUBMISSION_STATUS.EDITED_PENDING)
  );

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
    if (summary.total > 0 && !logoutConfirmOpen) {
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
    setPaymentMode(
      paymentOptions[0]?.value || DELIVERY_ACCOUNT_PAYMENT
    );
    setFormError("");
    requestAnimationFrame(() => billNumberRef.current?.focus());
  }

  function loadSubmissionForEdit(row) {
    if (!row) return;
    if (row.status === SUBMISSION_STATUS.REJECTED) {
      setFormError("Rejected bills cannot be edited.");
      return;
    }
    if (!row.editable) {
      setFormError("This bill cannot be edited.");
      return;
    }

    const isLocal = row.source === "local";
    const submissionId = cleanId(
      row.submissionId || (row.source === "submission" ? row.id : "")
    );
    if (!isLocal && !submissionId) {
      setFormError(
        "This bill was entered by the shop. Ask admin to edit it, or enter new bills from Delivery Entry."
      );
      return;
    }

    setFormError("");
    setFormMessage("");
    setEditingSubmission({
      id: isLocal ? row.entryLocalId : submissionId,
      ...row,
      source: row.source,
      status: row.status,
      syncStatus: row.syncStatus,
      approvedBillId: row.approvedBillId || row.billId || "",
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
    setPaymentMode(
      paymentModeSelectionFromSaved(
        row.paymentMode || DELIVERY_ACCOUNT_PAYMENT,
        row.bankAccountId || ""
      )
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
    requestAnimationFrame(() => billNumberRef.current?.focus());
  }

  async function handleSave(event) {
    event.preventDefault();
    setFormError("");
    setFormMessage("");

    if (!user?.uid || !isDeliveryBoyUser) {
      setFormError("Delivery boy login required.");
      return;
    }
    if (deliveryBoy?.isActive === false) {
      setFormError("Your delivery account is inactive.");
      return;
    }
    if (!selectedTerminal) {
      setFormError("Select an assigned terminal.");
      return;
    }
    if (!assignedTerminalIds.includes(selectedTerminal.id)) {
      setFormError("You are not assigned to this terminal.");
      return;
    }

    const billNo = normalizeBillNumber(billNumber);
    if (!billNo) {
      setFormError("Bill number must be a whole number (e.g. 1, 2, 3).");
      return;
    }
    if (billNo !== String(billNumber || "").trim()) {
      setBillNumber(billNo);
    }
    if (billAmount === "" || billAmount == null) {
      setFormError("Bill amount is required.");
      return;
    }
    const amountNum = numMoney(billAmount);
    if (!Number.isFinite(Number(billAmount)) || !Number.isFinite(amountNum)) {
      setFormError("Bill amount must be a valid number.");
      return;
    }

    let chargeNum = 0;
    if (deliveryCharge !== "" && deliveryCharge != null) {
      chargeNum = numMoney(deliveryCharge);
      if (!Number.isFinite(Number(deliveryCharge)) || chargeNum < 0) {
        setFormError("Delivery charge must be a non-negative number.");
        return;
      }
    }

    const resolved = parsePaymentModeSelection(paymentMode);
    let savedPaymentMode = resolved.paymentMode;
    let bankAccountId = "";
    let bankAccountNameSnapshot = "";

    if (!paymentOptions.some((row) => row.value === paymentMode)) {
      setFormError(
        "That payment option is not enabled for you. Ask an admin to update your payment options."
      );
      return;
    }

    if (paymentMode === DELIVERY_ACCOUNT_PAYMENT) {
      savedPaymentMode = DELIVERY_ACCOUNT_PAYMENT;
    } else if (resolved.paymentMode === "BANK") {
      bankAccountId = String(resolved.bankAccountId || "").trim();
      if (!bankAccountId) {
        setFormError("Select a bank account.");
        return;
      }
      if (!allowedBankAccounts.some((row) => row.id === bankAccountId)) {
        setFormError(
          "That bank account is not assigned to you. Ask an admin to update your payment options."
        );
        return;
      }
      bankAccountNameSnapshot = findBankAccountName(
        allowedBankAccounts,
        bankAccountId
      );
      savedPaymentMode = "BANK";
    } else if (resolved.paymentMode === "CASH") {
      savedPaymentMode = "CASH";
    } else {
      setFormError("Select a valid payment type.");
      return;
    }

    const date = String(businessDate || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setFormError("Business date is unavailable. Reconnect once to continue.");
      return;
    }

    if (editingSubmission?.id) {
      if (editingLockedIdentity) {
        if (billNo !== normalizeBillNumber(editingSubmission.billNumber)) {
          setFormError("Bill number cannot change after shop approval.");
          return;
        }
        if (selectedTerminal.id !== editingSubmission.terminalId) {
          setFormError("Terminal cannot change after shop approval.");
          return;
        }
      }

      // Treat edits like a new local bill: save on phone, sync later for approval.
      const entryLocalId = cleanId(
        editingSubmission.entryLocalId || editingSubmission.id
      );
      const serverEdit =
        editingSubmission.source === "submission" ||
        editingSubmission.source === "bill";
      const nowMs = Date.now();
      const localRecord = {
        entryLocalId,
        clientId,
        businessDate: date,
        terminalId: selectedTerminal.id,
        terminalNameSnapshot: selectedTerminal.name || "",
        billNumber: billNo,
        billAmount: amountNum,
        paymentMode: savedPaymentMode,
        bankAccountId,
        bankAccountNameSnapshot,
        customerName: String(customerName || "").trim(),
        deliveryCharge: chargeNum,
        deliveryBoyId: deliveryBoy?.id || deliveryBoyId,
        deliveryBoyNameSnapshot: deliveryBoy?.name || displayName || "",
        commissionEnabled: Boolean(deliveryBoy?.commissionEnabled),
        commissionRate: Number(deliveryBoy?.commissionRate) || 0,
        currency,
        currencyDecimals,
        notes: "",
        entrySource: EXTERNAL_ENTRY_SOURCE_DELIVERY_APP,
        resubmitEdit: serverEdit,
        syncStatus: SYNC_STATUS.PENDING,
        syncError: "",
        createdAtMs: Number(editingSubmission.createdAtMs) || nowMs,
        updatedAtMs: nowMs,
        createdBy: user.uid,
      };

      setSaving(true);
      try {
        await putLocalBill(localRecord);
        await refreshDeliverySyncCounts();
        await refreshLocalDayBills();
        setFormMessage(
          `Bill ${billNo} saved on this phone. Will sync for shop approval.`
        );
        clearBillFields();
        triggerSync();
      } catch (error) {
        setFormError(error?.message || "Failed to save bill.");
      } finally {
        setSaving(false);
      }
      return;
    }

    // New bills only: block if this bill number is already on today's list.
    const alreadyInList = dayRows.some(
      (row) =>
        row.status !== SUBMISSION_STATUS.REJECTED &&
        cleanId(row.terminalId) === cleanId(selectedTerminal.id) &&
        normalizeBillNumber(row.billNumber) === billNo
    );
    if (alreadyInList) {
      setFormError(
        `Bill ${billNo} is already in today’s list for ${selectedTerminal.name}. Open it from the list to edit.`
      );
      return;
    }

    const duplicate = await findLocalDuplicateBill({
      clientId,
      businessDate: date,
      terminalId: selectedTerminal.id,
      billNumber: billNo,
    });
    if (duplicate) {
      setFormError(
        `Bill ${billNo} is already saved locally for ${selectedTerminal.name}. Open it from the list to edit.`
      );
      return;
    }

    const entryLocalId = createEntryLocalId();
    const nowMs = Date.now();
    const localRecord = {
      entryLocalId,
      clientId,
      businessDate: date,
      terminalId: selectedTerminal.id,
      terminalNameSnapshot: selectedTerminal.name || "",
      billNumber: billNo,
      billAmount: amountNum,
      paymentMode: savedPaymentMode,
      bankAccountId,
      bankAccountNameSnapshot,
      customerName: String(customerName || "").trim(),
      deliveryCharge: chargeNum,
      deliveryBoyId,
      deliveryBoyNameSnapshot: deliveryBoy?.name || displayName || "",
      commissionEnabled: Boolean(deliveryBoy?.commissionEnabled),
      commissionRate: Number(deliveryBoy?.commissionRate) || 0,
      currency,
      currencyDecimals,
      notes: "",
      entrySource: EXTERNAL_ENTRY_SOURCE_DELIVERY_APP,
      syncStatus: SYNC_STATUS.PENDING,
      syncError: "",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      createdBy: user.uid,
    };

    setSaving(true);
    try {
      // LOCAL SAVE FIRST — list updates immediately; sync runs in background.
      await putLocalBill(localRecord);
      await refreshDeliverySyncCounts();
      await refreshLocalDayBills();

      const online = typeof navigator === "undefined" ? true : navigator.onLine;
      setFormMessage(
        online
          ? "Bill saved. Appears below — syncing for shop approval."
          : "Bill saved on this phone. Waiting for connection."
      );
      clearBillFields();

      // Sync in background — does not block next entry.
      triggerSync();
    } catch (error) {
      setFormError(error?.message || "Could not save bill locally.");
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
                  🟠 {pendingTotal} bill{pendingTotal === 1 ? "" : "s"} waiting
                  to sync
                </div>
                <div className="text-xs text-amber-200/80">
                  {failedBills.length
                    ? "A bill needs attention. Retry sync, or discard it from this phone."
                    : "Keep the app open while connection returns."}
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
      ) : syncState.message === "All bills synced" ? (
        <div className="border-b border-emerald-900/40 bg-emerald-950/30 px-4 py-2 text-center text-sm text-emerald-200">
          ✓ All bills synced
        </div>
      ) : null}

      <main className="mx-auto max-w-lg space-y-5 px-4 py-5 pb-28">
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
                    disabled={editingLockedIdentity && !selected}
                    onClick={() => setSelectedTerminalId(terminal.id)}
                    className={`flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition disabled:opacity-50 ${
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
          onSubmit={handleSave}
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
            <div className="rounded-xl border border-sky-800/60 bg-sky-950/30 px-3 py-2 text-xs text-sky-100">
              {editingLockedIdentity
                ? "Editing an approved bill. Save stores it on this phone like a new entry, then syncs later for shop re-approval. Bill number and terminal stay locked."
                : "Editing this bill. Save stores it on this phone, then syncs later for shop approval."}
              <button
                type="button"
                onClick={() => clearBillFields()}
                className="mt-2 block text-sky-300 underline"
              >
                Cancel edit
              </button>
            </div>
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
              disabled={editingLockedIdentity}
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
              onChange={(e) => setDeliveryCharge(e.target.value)}
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

          <button
            type="submit"
            disabled={saving || !selectedTerminal}
            className="w-full rounded-2xl py-4 text-lg font-bold text-slate-950 disabled:opacity-50"
            style={{ backgroundColor: theme.accent }}
          >
            {saving
              ? "Saving…"
              : editingSubmission
                ? "Save (sync later)"
                : "Save Bill"}
          </button>
        </form>

        <section className="space-y-3 rounded-3xl border border-slate-800 bg-slate-900/50 p-4">
          <div>
            <h2 className="text-sm font-semibold text-white">
              Today’s bills
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {dayTotals.count} bill{dayTotals.count === 1 ? "" : "s"} · updates
              live · tap to edit
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                My account
              </div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-white">
                {formatMoney(dayTotals.boyAccount, currencyDecimals)}
              </div>
              {currency ? (
                <div className="text-[11px] text-slate-500">{currency}</div>
              ) : null}
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                Shop account
              </div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-white">
                {formatMoney(dayTotals.shopAccount, currencyDecimals)}
              </div>
              {currency ? (
                <div className="text-[11px] text-slate-500">{currency}</div>
              ) : null}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-700/80 bg-slate-950/40 px-3 py-2 text-sm text-slate-300">
            Combined total{" "}
            <span className="font-semibold text-white tabular-nums">
              {formatMoney(dayTotals.all, currencyDecimals)}
            </span>
            {currency ? (
              <span className="ml-1 text-xs text-slate-500">{currency}</span>
            ) : null}
          </div>

          {dayListError ? (
            <p className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-100">
              {dayListError}
            </p>
          ) : null}

          {!dayRows.length ? (
            <p className="py-2 text-center text-sm text-slate-500">
              No bills entered for this date yet.
            </p>
          ) : (
            <ul className="max-h-72 space-y-2 overflow-y-auto overscroll-y-contain">
              {dayRows.map((row) => {
                const rejected = row.status === SUBMISSION_STATUS.REJECTED;
                const boyAcct = isDeliveryBoyAccountPayment(row);
                const statusMeta = dayBillStatusMeta(row);
                const selected =
                  editingSubmission?.id === row.submissionId ||
                  editingSubmission?.id === row.id ||
                  editingSubmission?.id === row.entryLocalId;
                return (
                  <li key={row.key}>
                    <button
                      type="button"
                      disabled={rejected}
                      onClick={() => loadSubmissionForEdit(row)}
                      className={`flex w-full min-w-0 items-start gap-3 rounded-2xl border px-3 py-2.5 text-left transition ${
                        selected
                          ? "border-sky-600/70 bg-sky-950/40"
                          : rejected
                            ? "cursor-not-allowed border-slate-800/60 bg-slate-950/30 opacity-60"
                            : "border-slate-800 bg-slate-950/60 hover:border-slate-600"
                      }`}
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-white">
                            Bill {row.billNumber}
                          </span>
                          <span className="truncate text-xs text-slate-400">
                            {row.terminalNameSnapshot || "Terminal"}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400">
                          {externalPaymentModeLabel(row)}
                          {row.customerName ? ` · ${row.customerName}` : ""}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-semibold tabular-nums text-white">
                            {formatMoney(row.billAmount, currencyDecimals)}
                          </span>
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
                          <div className="text-[11px] text-rose-300">
                            {row.syncError}
                          </div>
                        ) : null}
                      </div>
                      {!rejected ? (
                        <Pencil
                          size={15}
                          className="mt-1 shrink-0 text-slate-500"
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>

      {logoutConfirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center">
          <div className="w-full max-w-sm rounded-3xl border border-slate-700 bg-slate-950 p-5 shadow-2xl">
            <div className="text-base font-semibold text-white">
              {pendingTotal} bill{pendingTotal === 1 ? "" : "s"} waiting to sync
            </div>
            <p className="mt-2 text-sm text-slate-400">
              Please wait until synchronization is complete. Pending bills stay
              on this device if you log out.
            </p>
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
