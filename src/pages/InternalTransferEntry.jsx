import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthContext";
import { useClient } from "../context/ClientContext";
import { useShift, useUnsavedWork } from "../context/shift-context";
import {
  buildTransactionPayload,
  toBusinessDate,
} from "../utils/transactionContract";
import { formatIsoDate } from "../utils/dateFormat.js";
import DateInput from "../components/DateInput.jsx";
import ModuleExitButton from "../components/ModuleExitButton.jsx";
import ModuleHelpButton from "../components/ModuleHelpButton.jsx";
import BankAccountSearchSelect from "../components/BankAccountSearchSelect.jsx";
import { useFormDraft } from "../hooks/useFormDraft.js";
import {
  useEstimatedLiquidity,
} from "../hooks/useEstimatedBankBalance.js";
import { useBankAccounts } from "../hooks/useBankAccounts.js";
import { findBankAccountName } from "../utils/paymentModes.js";
import { Eye, EyeOff, Lock, Pencil, Unlock, X } from "lucide-react";
import { formatMoney, moneyInputStep, roundMoney } from "../utils/money.js";

const TRANSFER_TYPES = [
  ["CASH_TO_BANK", "Cash → Bank"],
  ["BANK_TO_CASH", "Bank → Cash"],
  ["BANK_TO_BANK", "Bank → Bank"],
  ["CASH_TO_PETTI", "Cash → Petti"],
  ["PETTI_TO_CASH", "Petti → Cash"],
  ["BANK_TO_PETTI", "Bank → Petti"],
  ["PETTI_TO_BANK", "Petti → Bank"],
  ["CASH_TO_LOCKER", "Cash → Locker"],
  ["LOCKER_TO_CASH", "Locker → Cash"],
];
const LABEL_CLASS = "block text-sm font-medium text-gray-300";
const FIELD_CLASS =
  "mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white transition-all focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60";
const CONTROL_CLASS = `${FIELD_CLASS} h-[42px]`;
const DATE_KEY = "gtct_internal_transfer_date";

function todayYYYYMMDD() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function transferTypeLabel(value) {
  return TRANSFER_TYPES.find(([key]) => key === value)?.[1] || value || "-";
}

function transferNeedsBankAccount(transferType) {
  return [
    "CASH_TO_BANK",
    "BANK_TO_CASH",
    "BANK_TO_BANK",
    "BANK_TO_PETTI",
    "PETTI_TO_BANK",
  ].includes(transferType);
}

function isLockerTransfer(transferType) {
  return transferType === "CASH_TO_LOCKER" || transferType === "LOCKER_TO_CASH";
}

function transferDocPaymentMode(transferType) {
  if (transferNeedsBankAccount(transferType)) return "BANK";
  if (isLockerTransfer(transferType)) return "LOCKER";
  return "PETTI";
}

function buildTransferTxnFields({
  activeClientId,
  businessDate,
  transferType,
  amount,
  note,
  shiftId,
  transferId,
  bankAccountId = "",
  bankAccountName = "",
  destinationBankAccountId = "",
  destinationBankAccountName = "",
}) {
  const bankLabel = bankAccountName ? ` (${bankAccountName})` : "";
  const destLabel = destinationBankAccountName
    ? ` (${destinationBankAccountName})`
    : "";

  const descriptions = {
    CASH_TO_BANK: `Cash to Bank${bankLabel}`,
    BANK_TO_CASH: `Bank${bankLabel} to Cash`,
    BANK_TO_BANK: `Bank${bankLabel} → Bank${destLabel}`,
    CASH_TO_PETTI: "Cash to Petti",
    PETTI_TO_CASH: "Petti to Cash",
    BANK_TO_PETTI: `Bank${bankLabel} to Petti`,
    PETTI_TO_BANK: `Petti to Bank${bankLabel}`,
    CASH_TO_LOCKER: "Cash to Locker",
    LOCKER_TO_CASH: "Locker to Cash",
  };

  const description =
    String(note || "").trim() || descriptions[transferType] || "Internal transfer";

  // Cash drawer movement only when cash is a leg of the transfer.
  // Locker moves previous/floating cash only — never today's drawer sales cash.
  const cashOutTypes = new Set(["CASH_TO_BANK", "CASH_TO_PETTI"]);
  const cashInTypes = new Set(["BANK_TO_CASH", "PETTI_TO_CASH"]);
  const bankRailTypes = new Set([
    "BANK_TO_BANK",
    "BANK_TO_PETTI",
    "PETTI_TO_BANK",
  ]);
  const lockerTypes = new Set(["CASH_TO_LOCKER", "LOCKER_TO_CASH"]);

  const sourceModeByType = {
    CASH_TO_BANK: "cash",
    BANK_TO_CASH: "bank_transfer",
    BANK_TO_BANK: "bank_transfer",
    CASH_TO_PETTI: "cash",
    PETTI_TO_CASH: "petti",
    BANK_TO_PETTI: "bank_transfer",
    PETTI_TO_BANK: "petti",
    CASH_TO_LOCKER: "cash",
    LOCKER_TO_CASH: "locker",
  };
  const destinationModeByType = {
    CASH_TO_BANK: "bank_transfer",
    BANK_TO_CASH: "cash",
    BANK_TO_BANK: "bank_transfer",
    CASH_TO_PETTI: "petti",
    PETTI_TO_CASH: "cash",
    BANK_TO_PETTI: "petti",
    PETTI_TO_BANK: "bank_transfer",
    CASH_TO_LOCKER: "locker",
    LOCKER_TO_CASH: "cash",
  };

  return {
    ...buildTransactionPayload({
      clientId: activeClientId,
      date: businessDate,
      type: "transfer",
      category: transferType,
      mode: bankRailTypes.has(transferType)
        ? "bank_transfer"
        : lockerTypes.has(transferType)
          ? "locker"
          : "cash",
      partyType: "Internal",
      partyId: null,
      partyName: "Internal Transfer",
      description,
      amountBeforeTax: amount,
      totalAmount: amount,
      amountIn: cashInTypes.has(transferType) ? amount : 0,
      amountOut: cashOutTypes.has(transferType) ? amount : 0,
      status: "POSTED",
      source: "internal_transfer",
      refType: "internal_transfer",
      refId: transferId,
      shiftId,
      internalTransfer: true,
      sourceMode: sourceModeByType[transferType] || "cash",
      destinationMode: destinationModeByType[transferType] || "cash",
      transferType,
      bankAccountId,
      bankAccountName,
      destinationBankAccountId,
      destinationBankAccountName,
    }),
  };
}

export default function InternalTransferEntry() {
  const { user } = useAuth();
  const { activeClientId, activeClientData } = useClient();
  const { activeShift, loadingShift, shiftError } = useShift();
  const draftKey = `internal-transfers:${activeClientId || "none"}`;
  const {
    initialDraft,
    syncDraft,
    clearDraft,
    readDraft,
    markDraftHydrated,
  } = useFormDraft(draftKey, {
    label: "Internal Transfers",
    path: "/internal-transfers",
    moduleId: "internal-transfers",
  });
  const draft = initialDraft || {};

  const [transferDate, setTransferDate] = useState(
    () =>
      draft.transferDate ||
      localStorage.getItem(DATE_KEY) ||
      todayYYYYMMDD()
  );
  const liquidityDate =
    transferDate || activeShift?.businessDate || todayYYYYMMDD();
  const {
    cashBalance,
    bankBalance,
    floatingCash,
    lockerBalance,
    bankBalancesByAccount,
    loading: loadingLiquidity,
  } = useEstimatedLiquidity(activeClientId, liquidityDate);
  const { accounts: bankAccounts } = useBankAccounts(activeClientId, {
    purpose: "transfer",
  });

  const bankBalanceById = useMemo(() => {
    const map = new Map();
    for (const row of bankBalancesByAccount || []) {
      if (!row?.bankAccountId) continue;
      map.set(String(row.bankAccountId), Number(row.amount) || 0);
    }
    return map;
  }, [bankBalancesByAccount]);

  function formatAccountBalance(accountId) {
    const id = String(accountId || "").trim();
    if (!id) return "";
    if (loadingLiquidity) return "Balance …";
    if (!bankBalanceById.has(id)) return "Balance —";
    return `Balance ${formatMoney(bankBalanceById.get(id))}`;
  }

  function formatMoneyBalance(amount) {
    if (loadingLiquidity || amount == null) return "Balance …";
    return `Balance ${formatMoney(amount)}`;
  }

  function cashSideInfo(type = transferType) {
    if (
      type === "CASH_TO_BANK" ||
      type === "CASH_TO_PETTI" ||
      type === "BANK_TO_CASH" ||
      type === "PETTI_TO_CASH"
    ) {
      return {
        label: "Cash (Hand)",
        balanceText: formatMoneyBalance(cashBalance),
      };
    }
    if (type === "CASH_TO_LOCKER") {
      return {
        label: "Cash (Previous)",
        balanceText: formatMoneyBalance(floatingCash),
      };
    }
    if (type === "LOCKER_TO_CASH") {
      return {
        label: "Locker",
        balanceText: formatMoneyBalance(lockerBalance),
      };
    }
    return null;
  }

  function RailBalanceCard({ label, balanceText }) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-gray-300">{label}</span>
          <span className="text-xs font-semibold tabular-nums text-emerald-300">
            {balanceText}
          </span>
        </div>
      </div>
    );
  }
  const [isDateUnlocked, setIsDateUnlocked] = useState(
    () => Boolean(draft.isDateUnlocked)
  );
  const [transferType, setTransferType] = useState(
    () => draft.transferType ?? "CASH_TO_BANK"
  );
  const [bankAccountId, setBankAccountId] = useState(
    () => draft.bankAccountId ?? ""
  );
  const [destinationBankAccountId, setDestinationBankAccountId] = useState(
    () => draft.destinationBankAccountId ?? ""
  );
  const [amount, setAmount] = useState(() => draft.amount ?? "");
  const [note, setNote] = useState(() => draft.note ?? "");
  const isBankToBank = transferType === "BANK_TO_BANK";
  const needsBankPicker = transferNeedsBankAccount(transferType);
  const bankPickerLabel =
    transferType === "CASH_TO_BANK" || transferType === "PETTI_TO_BANK"
      ? "To Bank Account"
      : transferType === "BANK_TO_CASH" || transferType === "BANK_TO_PETTI"
        ? "From Bank Account"
        : "Bank Account";
  const activeCashSide = cashSideInfo(transferType);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [historyEntries, setHistoryEntries] = useState([]);
  const [showHistory, setShowHistory] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [editingEntry, setEditingEntry] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const hasUnsavedWork = Boolean(
    String(amount || "").trim() ||
      String(note || "").trim() ||
      editingEntry
  );
  useUnsavedWork("internal-transfers", "Internal Transfers", hasUnsavedWork);

  const fundsError = (() => {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    // Internal moves that don't pull from cash/bank aggregate.
    if (
      transferType === "BANK_TO_BANK" ||
      transferType === "PETTI_TO_CASH" ||
      transferType === "PETTI_TO_BANK"
    ) {
      return null;
    }
    if (transferType === "CASH_TO_LOCKER") {
      if (floatingCash === null) {
        return "Previous cash balance is still loading. Try again in a moment.";
      }
      if (floatingCash < parsed) {
        return `Insufficient previous cash for locker (available ${formatMoney(floatingCash)}, need ${formatMoney(parsed)}). Locker transfers use previous balance only, not today's sales.`;
      }
      return null;
    }
    if (transferType === "LOCKER_TO_CASH") {
      if (lockerBalance === null) {
        return "Locker balance is still loading. Try again in a moment.";
      }
      if (lockerBalance < parsed) {
        return `Insufficient locker funds (available ${formatMoney(lockerBalance)}, need ${formatMoney(parsed)}).`;
      }
      return null;
    }
    if (
      transferType === "CASH_TO_BANK" ||
      transferType === "CASH_TO_PETTI"
    ) {
      if (cashBalance === null) {
        return "Cash balance is still loading. Try again in a moment.";
      }
      if (cashBalance < parsed) {
        return `Insufficient cash (available ${formatMoney(cashBalance)}, need ${formatMoney(parsed)}). Record a Loan Receipt first.`;
      }
      return null;
    }
    if (transferType === "BANK_TO_CASH" || transferType === "BANK_TO_PETTI") {
      if (bankBalance === null) {
        return "Bank balance is still loading. Try again in a moment.";
      }
      if (bankBalance < parsed) {
        return `Insufficient bank funds (available ${formatMoney(bankBalance)}, need ${formatMoney(parsed)}). Record a Loan Receipt first.`;
      }
    }
    return null;
  })();
  const showFundsBlock = Boolean(fundsError);

  const transferDraftKeyRef = useRef(null);
  useLayoutEffect(() => {
    const isFirst = transferDraftKeyRef.current === null;
    const keyChanged = transferDraftKeyRef.current !== draftKey;
    transferDraftKeyRef.current = draftKey;
    if (isFirst) {
      markDraftHydrated();
      return;
    }
    if (!keyChanged) return;
    const d = readDraft() || {};
    setTransferDate(
      d.transferDate || localStorage.getItem(DATE_KEY) || todayYYYYMMDD()
    );
    setIsDateUnlocked(Boolean(d.isDateUnlocked));
    setTransferType(d.transferType ?? "CASH_TO_BANK");
    setBankAccountId(d.bankAccountId ?? "");
    setDestinationBankAccountId(d.destinationBankAccountId ?? "");
    setAmount(d.amount ?? "");
    setNote(d.note ?? "");
    markDraftHydrated();
  }, [draftKey, readDraft, markDraftHydrated]);

  useEffect(() => {
    syncDraft(
      {
        transferDate,
        isDateUnlocked,
        transferType,
        bankAccountId,
        destinationBankAccountId,
        amount,
        note,
      },
      { dirty: hasUnsavedWork }
    );
  }, [
    syncDraft,
    hasUnsavedWork,
    transferDate,
    isDateUnlocked,
    transferType,
    bankAccountId,
    destinationBankAccountId,
    amount,
    note,
  ]);

  useEffect(() => {
    if (
      bankAccountId &&
      bankAccounts.length &&
      !bankAccounts.some((account) => account.id === bankAccountId)
    ) {
      setBankAccountId("");
    }
    if (
      destinationBankAccountId &&
      bankAccounts.length &&
      !bankAccounts.some((account) => account.id === destinationBankAccountId)
    ) {
      setDestinationBankAccountId("");
    }
  }, [bankAccounts, bankAccountId, destinationBankAccountId]);

  useEffect(() => {
    if (!isDateUnlocked && activeShift?.businessDate) {
      setTransferDate(activeShift.businessDate);
    }
  }, [activeShift?.businessDate, isDateUnlocked]);

  useEffect(() => {
    if (transferDate) localStorage.setItem(DATE_KEY, transferDate);
  }, [transferDate]);

  useEffect(() => {
    if (!message) return undefined;
    const timeoutId = window.setTimeout(() => setMessage(""), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [message]);

  useEffect(() => {
    if (!activeClientId || !transferDate || !showHistory) return undefined;
    setLoadingHistory(true);
    const historyQuery = query(
      collection(db, "internal_transfers"),
      where("clientId", "==", activeClientId),
      where("businessDate", "==", transferDate),
      limit(200)
    );
    return onSnapshot(
      historyQuery,
      (snapshot) => {
        setHistoryEntries(
          snapshot.docs
            .map((item) => ({ id: item.id, ...item.data() }))
            .sort(
              (a, b) =>
                Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0)
            )
        );
        setLoadingHistory(false);
      },
      (reason) => {
        setLoadingHistory(false);
        setError(reason?.message || "Failed to load transfer history.");
      }
    );
  }, [activeClientId, transferDate, showHistory]);

  const historyTotal = useMemo(
    () =>
      historyEntries.reduce(
        (total, entry) => total + Number(entry.amount || 0),
        0
      ),
    [historyEntries]
  );

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setMessage("");

    const parsedAmount = roundMoney(amount);
    if (!activeClientId) {
      setError("Select an active shop first.");
      return;
    }
    if (!user?.uid) {
      setError("You must be signed in.");
      return;
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError("Amount must be greater than zero.");
      return;
    }
    if (!TRANSFER_TYPES.some(([value]) => value === transferType)) {
      setError("Select a valid transfer type.");
      return;
    }
    if (isBankToBank) {
      if (!bankAccountId) {
        setError("Select the source bank account.");
        return;
      }
      if (!destinationBankAccountId) {
        setError("Select the destination bank account.");
        return;
      }
      if (bankAccountId === destinationBankAccountId) {
        setError("Source and destination bank accounts must be different.");
        return;
      }
    } else if (needsBankPicker && !bankAccountId) {
      setError("Select a bank account for this transfer.");
      return;
    }
    if (!activeShift?.id || activeShift.status !== "OPEN") {
      setError("Open a shift before recording an internal transfer.");
      return;
    }

    const businessDate = isDateUnlocked
      ? transferDate
      : activeShift.businessDate || transferDate;
    if (!businessDate) {
      setError("Transfer date is required.");
      return;
    }
    if (businessDate !== activeShift.businessDate) {
      setError("Transfer date must match the active shift business date.");
      return;
    }
    if (fundsError) {
      setError(fundsError);
      return;
    }

    const selectedBankName = findBankAccountName(bankAccounts, bankAccountId);
    const selectedDestinationName = findBankAccountName(
      bankAccounts,
      isBankToBank
        ? destinationBankAccountId
        : transferType === "CASH_TO_BANK" || transferType === "PETTI_TO_BANK"
          ? bankAccountId
          : ""
    );
    const resolvedDestinationId = isBankToBank
      ? destinationBankAccountId
      : transferType === "CASH_TO_BANK" || transferType === "PETTI_TO_BANK"
        ? bankAccountId
        : "";
    const resolvedSourceId =
      transferType === "BANK_TO_CASH" ||
      transferType === "BANK_TO_PETTI" ||
      isBankToBank
        ? bankAccountId
        : transferType === "CASH_TO_BANK" || transferType === "PETTI_TO_BANK"
          ? bankAccountId
          : "";
    const transferRef = doc(collection(db, "internal_transfers"));
    const transactionRef = doc(collection(db, "transactions"));
    const shiftRef = doc(db, "shifts", activeShift.id);

    setSaving(true);
    try {
      await runTransaction(db, async (transaction) => {
        const shiftSnapshot = await transaction.get(shiftRef);
        if (
          !shiftSnapshot.exists() ||
          shiftSnapshot.data()?.clientId !== activeClientId ||
          shiftSnapshot.data()?.status !== "OPEN"
        ) {
          throw new Error("The selected shift is no longer open.");
        }

        transaction.set(transferRef, {
          schemaVersion: 1,
          clientId: activeClientId,
          transferType,
          amount: parsedAmount,
          note: String(note || "").trim(),
          bankAccountId: resolvedSourceId || bankAccountId || "",
          bankAccountName: selectedBankName,
          destinationBankAccountId: resolvedDestinationId,
          destinationBankAccountName: selectedDestinationName,
          paymentMode: transferDocPaymentMode(transferType),
          businessDate,
          businessDateAt: toBusinessDate(businessDate),
          shiftId: activeShift.id,
          transactionId: transactionRef.id,
          status: "POSTED",
          createdBy: user.uid,
          createdAt: serverTimestamp(),
          createdAtMs: Date.now(),
        });

        transaction.set(transactionRef, {
          ...buildTransferTxnFields({
            activeClientId,
            businessDate,
            transferType,
            amount: parsedAmount,
            note,
            shiftId: activeShift.id,
            transferId: transferRef.id,
            bankAccountId: resolvedSourceId || bankAccountId || "",
            bankAccountName: selectedBankName,
            destinationBankAccountId: resolvedDestinationId,
            destinationBankAccountName: selectedDestinationName,
          }),
          createdBy: user.uid,
          createdAt: serverTimestamp(),
        });
      });

      setAmount("");
      setNote("");
      clearDraft();
      setMessage("Internal transfer recorded successfully.");
    } catch (reason) {
      setError(reason?.message || "Failed to record internal transfer.");
    } finally {
      setSaving(false);
    }
  }

  function openEdit(entry) {
    setEditingEntry(entry);
    setEditForm({
      transferType: entry.transferType || "CASH_TO_BANK",
      amount: String(entry.amount ?? ""),
      note: entry.note || "",
      businessDate: entry.businessDate || transferDate || todayYYYYMMDD(),
      bankAccountId: entry.bankAccountId || "",
      destinationBankAccountId: entry.destinationBankAccountId || "",
    });
    setError("");
  }

  function closeEdit() {
    setEditingEntry(null);
    setEditForm(null);
  }

  async function saveEdit(event) {
    event.preventDefault();
    if (!editingEntry || !editForm) return;

    setError("");
    setMessage("");
    const parsedAmount = roundMoney(editForm.amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError("Amount must be greater than zero.");
      return;
    }
    if (!TRANSFER_TYPES.some(([value]) => value === editForm.transferType)) {
      setError("Select a valid transfer type.");
      return;
    }
    if (!editForm.businessDate) {
      setError("Transfer date is required.");
      return;
    }

    const oldAmount = Number(editingEntry.amount) || 0;
    const oldType = editingEntry.transferType || "CASH_TO_BANK";
    const creditedCash =
      oldType === "CASH_TO_BANK" || oldType === "CASH_TO_PETTI"
        ? oldAmount
        : 0;
    const creditedFloating =
      oldType === "CASH_TO_LOCKER" ? oldAmount : 0;
    const creditedLocker =
      oldType === "LOCKER_TO_CASH" ? oldAmount : 0;
    const creditedBank =
      oldType === "BANK_TO_CASH" || oldType === "BANK_TO_PETTI" ? oldAmount : 0;
    const editNeedsBank = transferNeedsBankAccount(editForm.transferType);

    if (editForm.transferType === "BANK_TO_BANK") {
      if (!editForm.bankAccountId || !editForm.destinationBankAccountId) {
        setError("Select both source and destination bank accounts.");
        return;
      }
      if (editForm.bankAccountId === editForm.destinationBankAccountId) {
        setError("Source and destination bank accounts must be different.");
        return;
      }
    } else if (editNeedsBank && !editForm.bankAccountId) {
      setError("Select a bank account for this transfer.");
      return;
    }

    if (
      editForm.transferType === "CASH_TO_BANK" ||
      editForm.transferType === "CASH_TO_PETTI"
    ) {
      const available =
        cashBalance === null ? null : cashBalance + creditedCash;
      if (available === null) {
        setError("Cash balance is still loading. Try again in a moment.");
        return;
      }
      if (available < parsedAmount) {
        setError(
          `Insufficient cash (available ${formatMoney(available)}, need ${formatMoney(parsedAmount)}). Record a Loan Receipt first.`
        );
        return;
      }
    } else if (editForm.transferType === "CASH_TO_LOCKER") {
      const available =
        floatingCash === null ? null : floatingCash + creditedFloating;
      if (available === null) {
        setError(
          "Previous cash balance is still loading. Try again in a moment."
        );
        return;
      }
      if (available < parsedAmount) {
        setError(
          `Insufficient previous cash for locker (available ${formatMoney(available)}, need ${formatMoney(parsedAmount)}). Locker transfers use previous balance only, not today's sales.`
        );
        return;
      }
    } else if (editForm.transferType === "LOCKER_TO_CASH") {
      const available =
        lockerBalance === null ? null : lockerBalance + creditedLocker;
      if (available === null) {
        setError("Locker balance is still loading. Try again in a moment.");
        return;
      }
      if (available < parsedAmount) {
        setError(
          `Insufficient locker funds (available ${formatMoney(available)}, need ${formatMoney(parsedAmount)}).`
        );
        return;
      }
    } else if (
      editForm.transferType === "BANK_TO_CASH" ||
      editForm.transferType === "BANK_TO_PETTI"
    ) {
      const available =
        bankBalance === null ? null : bankBalance + creditedBank;
      if (available === null) {
        setError("Bank balance is still loading. Try again in a moment.");
        return;
      }
      if (available < parsedAmount) {
        setError(
          `Insufficient bank funds (available ${formatMoney(available)}, need ${formatMoney(parsedAmount)}). Record a Loan Receipt first.`
        );
        return;
      }
    }

    const canReuseShift =
      editingEntry.shiftId &&
      editingEntry.businessDate === editForm.businessDate;
    let targetShiftId = "";
    if (canReuseShift) {
      targetShiftId = editingEntry.shiftId;
    } else if (
      activeShift?.id &&
      activeShift.status === "OPEN" &&
      activeShift.businessDate === editForm.businessDate
    ) {
      targetShiftId = activeShift.id;
    } else {
      setError(
        "Open a shift matching the transfer date before changing this entry."
      );
      return;
    }

    const transferRef = doc(db, "internal_transfers", editingEntry.id);
    const transactionRef = doc(db, "transactions", editingEntry.transactionId);
    const shiftRef = doc(db, "shifts", targetShiftId);

    setSavingEdit(true);
    try {
      await runTransaction(db, async (transaction) => {
        const [transferSnap, txnSnap, shiftSnap] = await Promise.all([
          transaction.get(transferRef),
          transaction.get(transactionRef),
          transaction.get(shiftRef),
        ]);

        if (
          !transferSnap.exists() ||
          transferSnap.data()?.clientId !== activeClientId
        ) {
          throw new Error("Transfer no longer exists.");
        }
        if (
          !txnSnap.exists() ||
          txnSnap.data()?.clientId !== activeClientId ||
          txnSnap.data()?.refId !== transferRef.id
        ) {
          throw new Error("The linked ledger transaction is invalid.");
        }
        if (
          !shiftSnap.exists() ||
          shiftSnap.data()?.clientId !== activeClientId ||
          (!canReuseShift && shiftSnap.data()?.status !== "OPEN")
        ) {
          throw new Error("The selected cash shift is invalid.");
        }

        const editBankName = findBankAccountName(
          bankAccounts,
          editForm.bankAccountId
        );
        const editIsBankToBank = editForm.transferType === "BANK_TO_BANK";
        const editNeedsBank = transferNeedsBankAccount(editForm.transferType);
        const editDestinationId = editIsBankToBank
          ? editForm.destinationBankAccountId
          : editForm.transferType === "CASH_TO_BANK" ||
              editForm.transferType === "PETTI_TO_BANK"
            ? editForm.bankAccountId
            : "";
        const editDestinationName = findBankAccountName(
          bankAccounts,
          editDestinationId
        );

        transaction.update(transferRef, {
          transferType: editForm.transferType,
          amount: parsedAmount,
          note: String(editForm.note || "").trim(),
          bankAccountId: editForm.bankAccountId || "",
          bankAccountName: editBankName,
          destinationBankAccountId: editDestinationId,
          destinationBankAccountName: editDestinationName,
          paymentMode: transferDocPaymentMode(editForm.transferType),
          businessDate: editForm.businessDate,
          businessDateAt: toBusinessDate(editForm.businessDate),
          shiftId: targetShiftId,
          updatedBy: user.uid,
          updatedAt: serverTimestamp(),
          updatedAtMs: Date.now(),
        });

        transaction.update(transactionRef, {
          ...buildTransferTxnFields({
            activeClientId,
            businessDate: editForm.businessDate,
            transferType: editForm.transferType,
            amount: parsedAmount,
            note: editForm.note,
            shiftId: targetShiftId,
            transferId: transferRef.id,
            bankAccountId: editForm.bankAccountId || "",
            bankAccountName: editBankName,
            destinationBankAccountId: editDestinationId,
            destinationBankAccountName: editDestinationName,
          }),
          updatedBy: user.uid,
          updatedAt: serverTimestamp(),
        });
      });

      closeEdit();
      setMessage("Transfer updated successfully.");
    } catch (reason) {
      setError(reason?.message || "Failed to update transfer.");
    } finally {
      setSavingEdit(false);
    }
  }

  if (!activeClientId) {
    return (
      <div className="text-slate-300">Select a shop to record transfers.</div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-white">
                Internal Transfer
              </h1>
              <p className="mt-1 text-sm text-slate-400">
                {activeClientData?.name || activeClientId}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ModuleHelpButton moduleId="internal-transfers" />
              <ModuleExitButton ariaLabel="Close internal transfer entry" />
            </div>
          </div>
        </div>

        <div className={`${LABEL_CLASS} shrink-0 sm:text-right`}>
          Transfer Date
          <div className="mt-1.5 w-[150px]">
            {isDateUnlocked ? (
              <DateInput
                required
                form="internal-transfer-form"
                value={transferDate}
                onChange={(event) => setTransferDate(event.target.value)}
                className="h-[42px] w-full rounded-lg border border-amber-700/60 bg-slate-950 text-right text-white"
              />
            ) : (
              <div className="rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-right text-white">
                {formatIsoDate(transferDate)}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setIsDateUnlocked((current) => {
                  const next = !current;
                  if (!next && activeShift?.businessDate) {
                    setTransferDate(activeShift.businessDate);
                  }
                  return next;
                });
              }}
              className={`mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-medium transition-colors ${
                isDateUnlocked
                  ? "text-amber-400 hover:text-amber-300"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {isDateUnlocked ? <Unlock size={12} /> : <Lock size={12} />}
              {isDateUnlocked
                ? "Date Unlocked (Manual Override)"
                : "Locked to active shift"}
            </button>
          </div>
        </div>
      </div>

      {shiftError || error ? (
        <div className="rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
          {error || shiftError}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-200">
          {message}
        </div>
      ) : null}
      {showFundsBlock ? (
        <div className="rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
          {fundsError}
        </div>
      ) : null}

      <form
        id="internal-transfer-form"
        onSubmit={handleSubmit}
        className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 sm:p-6"
      >
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <label className={`${LABEL_CLASS} min-w-0`}>
            Transfer Type
            <select
              value={transferType}
              onChange={(event) => {
                const nextType = event.target.value;
                setTransferType(nextType);
                setDestinationBankAccountId("");
                if (!transferNeedsBankAccount(nextType)) {
                  setBankAccountId("");
                }
              }}
              className={`${CONTROL_CLASS} max-w-full`}
            >
              {TRANSFER_TYPES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className={`${LABEL_CLASS} min-w-0`}>
            Amount
            <input
              required
              type="number"
              min="0.01"
              step={moneyInputStep()}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className={`${CONTROL_CLASS} max-w-full`}
              placeholder="0.00"
            />
          </label>

          {isBankToBank ? (
            <>
              <div className="sm:col-span-1">
                <BankAccountSearchSelect
                  accounts={bankAccounts}
                  value={bankAccountId}
                  onChange={setBankAccountId}
                  excludeId={destinationBankAccountId}
                  label="From Bank Account"
                  placeholder="Search source bank…"
                  required
                  balanceText={formatAccountBalance(bankAccountId)}
                />
              </div>
              <div className="sm:col-span-1">
                <BankAccountSearchSelect
                  accounts={bankAccounts}
                  value={destinationBankAccountId}
                  onChange={setDestinationBankAccountId}
                  excludeId={bankAccountId}
                  label="To Bank Account"
                  placeholder="Search destination bank…"
                  required
                  balanceText={formatAccountBalance(destinationBankAccountId)}
                />
              </div>
            </>
          ) : needsBankPicker ? (
            <>
              {activeCashSide ? (
                <div className="sm:col-span-1">
                  <div className="mb-1.5 text-sm font-medium text-gray-300">
                    {transferType === "CASH_TO_BANK" ||
                    transferType === "CASH_TO_PETTI"
                      ? "From"
                      : transferType === "BANK_TO_CASH" ||
                          transferType === "BANK_TO_PETTI"
                        ? "To"
                        : "Cash"}
                  </div>
                  <RailBalanceCard
                    label={activeCashSide.label}
                    balanceText={activeCashSide.balanceText}
                  />
                </div>
              ) : null}
              <div
                className={activeCashSide ? "sm:col-span-1" : "sm:col-span-2"}
              >
                <BankAccountSearchSelect
                  accounts={bankAccounts}
                  value={bankAccountId}
                  onChange={setBankAccountId}
                  label={bankPickerLabel}
                  placeholder="Search bank account…"
                  required
                  balanceText={formatAccountBalance(bankAccountId)}
                />
              </div>
            </>
          ) : isLockerTransfer(transferType) ? (
            <div className="sm:col-span-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <RailBalanceCard
                label={
                  transferType === "CASH_TO_LOCKER"
                    ? "From · Cash (Previous)"
                    : "From · Locker"
                }
                balanceText={
                  transferType === "CASH_TO_LOCKER"
                    ? formatMoneyBalance(floatingCash)
                    : formatMoneyBalance(lockerBalance)
                }
              />
              <RailBalanceCard
                label={
                  transferType === "CASH_TO_LOCKER"
                    ? "To · Locker"
                    : "To · Cash (Hand)"
                }
                balanceText={
                  transferType === "CASH_TO_LOCKER"
                    ? formatMoneyBalance(lockerBalance)
                    : formatMoneyBalance(cashBalance)
                }
              />
            </div>
          ) : (
            <div className="sm:col-span-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {activeCashSide ? (
                <RailBalanceCard
                  label={activeCashSide.label}
                  balanceText={activeCashSide.balanceText}
                />
              ) : null}
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-3 text-sm text-slate-400">
                Petti cash transfer — no bank account required.
              </div>
            </div>
          )}

          <label className={`${LABEL_CLASS} sm:col-span-2`}>
            Note
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              className={`${FIELD_CLASS} resize-y`}
              placeholder="Optional note for this transfer"
            />
          </label>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="submit"
            disabled={saving || loadingShift || showFundsBlock}
            className="rounded-lg bg-blue-600 px-5 py-2.5 font-semibold text-white transition-all hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : "Record Transfer"}
          </button>
        </div>
      </form>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-white">Transfer History</h2>
            <p className="mt-1 text-sm text-slate-400">
              Entries saved on {formatIsoDate(transferDate, "-")}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
                Day Total
              </p>
              <p className="text-lg font-bold text-white">
                {formatMoney(historyTotal)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowHistory((current) => !current)}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              {showHistory ? <EyeOff size={16} /> : <Eye size={16} />}
              {showHistory ? "Hide History" : "Show History"}
            </button>
          </div>
        </div>

        {showHistory ? (
          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-950/80 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Banks</th>
                  <th className="px-4 py-3">Note</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {loadingHistory ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center text-slate-500"
                    >
                      Loading history…
                    </td>
                  </tr>
                ) : historyEntries.length ? (
                  historyEntries.map((entry) => (
                    <tr
                      key={entry.id}
                      className="border-t border-slate-800 text-slate-300 hover:bg-slate-800/25"
                    >
                      <td className="whitespace-nowrap px-4 py-3">
                        {formatIsoDate(entry.businessDate, "-")}
                      </td>
                      <td className="px-4 py-3 text-white">
                        {transferTypeLabel(entry.transferType)}
                      </td>
                      <td className="max-w-[220px] px-4 py-3 text-slate-300">
                        {entry.transferType === "BANK_TO_BANK"
                          ? `${entry.bankAccountName || "From"} → ${entry.destinationBankAccountName || "To"}`
                          : entry.transferType === "CASH_TO_PETTI" ||
                              entry.transferType === "PETTI_TO_CASH"
                            ? "Petti"
                            : entry.transferType === "CASH_TO_LOCKER" ||
                                entry.transferType === "LOCKER_TO_CASH"
                              ? "Locker"
                              : entry.bankAccountName
                                ? `Bank: ${entry.bankAccountName}`
                                : entry.destinationBankAccountName
                                  ? `Bank: ${entry.destinationBankAccountName}`
                                  : "—"}
                      </td>
                      <td className="max-w-[240px] truncate px-4 py-3">
                        {entry.note || "-"}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-white">
                        {formatMoney(entry.amount || 0)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => openEdit(entry)}
                          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-slate-300 hover:border-blue-500 hover:text-blue-300"
                        >
                          <Pencil size={14} />
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center text-slate-500"
                    >
                      No transfers found for this date.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {editingEntry && editForm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={saveEdit}
            className="max-h-[90vh] w-full max-w-xl overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <div>
                <h2 className="font-semibold text-white">Edit Transfer</h2>
                <p className="mt-1 text-xs text-slate-400">
                  Updates the transfer and accounting ledger atomically.
                </p>
              </div>
              <button
                type="button"
                onClick={closeEdit}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"
                aria-label="Close edit transfer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <label className={LABEL_CLASS}>
                Date
                <DateInput
                  value={editForm.businessDate}
                  onChange={(event) =>
                    setEditForm((current) => ({
                      ...current,
                      businessDate: event.target.value,
                    }))
                  }
                  className="mt-1.5 h-[42px] w-full rounded-lg border border-slate-700 bg-slate-950 text-white"
                  required
                />
              </label>

              <label className={LABEL_CLASS}>
                Transfer Type
                <select
                  value={editForm.transferType}
                  onChange={(event) =>
                    setEditForm((current) => ({
                      ...current,
                      transferType: event.target.value,
                      destinationBankAccountId: "",
                    }))
                  }
                  className={CONTROL_CLASS}
                >
                  {TRANSFER_TYPES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label className={LABEL_CLASS}>
                Amount
                <input
                  type="number"
                  min="0.01"
                  step={moneyInputStep()}
                  value={editForm.amount}
                  onChange={(event) =>
                    setEditForm((current) => ({
                      ...current,
                      amount: event.target.value,
                    }))
                  }
                  className={CONTROL_CLASS}
                  required
                />
              </label>

              {editForm.transferType === "BANK_TO_BANK" ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <BankAccountSearchSelect
                    accounts={bankAccounts}
                    value={editForm.bankAccountId || ""}
                    excludeId={editForm.destinationBankAccountId || ""}
                    onChange={(nextId) =>
                      setEditForm((current) => ({
                        ...current,
                        bankAccountId: nextId,
                      }))
                    }
                    label="From Bank Account"
                    placeholder="Search source bank…"
                    required
                    balanceText={formatAccountBalance(editForm.bankAccountId)}
                  />
                  <BankAccountSearchSelect
                    accounts={bankAccounts}
                    value={editForm.destinationBankAccountId || ""}
                    excludeId={editForm.bankAccountId || ""}
                    onChange={(nextId) =>
                      setEditForm((current) => ({
                        ...current,
                        destinationBankAccountId: nextId,
                      }))
                    }
                    label="To Bank Account"
                    placeholder="Search destination bank…"
                    required
                    balanceText={formatAccountBalance(
                      editForm.destinationBankAccountId
                    )}
                  />
                </div>
              ) : transferNeedsBankAccount(editForm.transferType) ? (
                <BankAccountSearchSelect
                  accounts={bankAccounts}
                  value={editForm.bankAccountId || ""}
                  onChange={(nextId) =>
                    setEditForm((current) => ({
                      ...current,
                      bankAccountId: nextId,
                    }))
                  }
                  label={
                    editForm.transferType === "CASH_TO_BANK" ||
                    editForm.transferType === "PETTI_TO_BANK"
                      ? "To Bank Account"
                      : "From Bank Account"
                  }
                  placeholder="Search bank account…"
                  required
                  balanceText={formatAccountBalance(editForm.bankAccountId)}
                />
              ) : isLockerTransfer(editForm.transferType) ? null : (
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-3 text-sm text-slate-400">
                  Petti cash transfer — no bank account required.
                </div>
              )}

              <label className={LABEL_CLASS}>
                Note
                <textarea
                  rows={3}
                  value={editForm.note}
                  onChange={(event) =>
                    setEditForm((current) => ({
                      ...current,
                      note: event.target.value,
                    }))
                  }
                  className={`${FIELD_CLASS} resize-y`}
                />
              </label>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-4">
              <button
                type="button"
                onClick={closeEdit}
                className="rounded-lg border border-slate-700 px-4 py-2.5 text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingEdit}
                className="rounded-lg bg-blue-600 px-5 py-2.5 font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {savingEdit ? "Updating…" : "Update Transfer"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
