import { useEffect, useMemo, useRef, useState } from "react";
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
import { Eye, EyeOff, Lock, Pencil, Plus, Save, Trash2, Unlock, X } from "lucide-react";
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
import {
  getInsufficientFundsError,
  isBankTenderMode,
  isCashTenderMode,
  sumReservedSpend,
  useEstimatedLiquidity,
} from "../hooks/useEstimatedBankBalance.js";
import { useFormDraft } from "../hooks/useFormDraft.js";
import { useBankAccounts } from "../hooks/useBankAccounts.js";
import {
  buildPaymentModeOptions,
  findBankAccountName,
  legacyPaymentModeFlags,
  parsePaymentModeSelection,
  paymentModeSelectionFromSaved,
} from "../utils/paymentModes.js";
import { formatMoney, moneyInputStep, roundMoney } from "../utils/money.js";

const PURCHASE_CATEGORIES = ["COMMODITY", "CONSUMABLES", "ASSET"];
const EXPENSE_CATEGORIES = [
  "UTILITY BILL",
  "WAGE",
  "SALARY",
  "RENT",
  "MAINTENANCE",
  "OTHER",
];
const PURCHASE_DATE_KEY = "gtct_purchase_entry_date";
const LABEL_CLASS = "block text-sm font-medium text-gray-300";
const FIELD_CLASS =
  "mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white transition-all focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60";

function todayYYYYMMDD() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export default function PurchaseExpenseEntry() {
  const { user } = useAuth();
  const { activeClientId, activeClientData } = useClient();
  const { activeShift, loadingShift, shiftError } = useShift();
  const vendorSelectorRef = useRef(null);
  const draftKey = `purchases:${activeClientId || "none"}`;
  const { initialDraft, syncDraft, clearDraft } = useFormDraft(draftKey);
  const draft = initialDraft || {};
  const { accounts: bankAccounts } = useBankAccounts(activeClientId);

  const [amount, setAmount] = useState(() => draft.amount ?? "");
  const [parties, setParties] = useState([]);
  const [loadingParties, setLoadingParties] = useState(false);
  const [selectedPartyId, setSelectedPartyId] = useState(
    () => draft.selectedPartyId ?? ""
  );
  const [partySearch, setPartySearch] = useState(() => draft.partySearch ?? "");
  const [vendorDropdownOpen, setVendorDropdownOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");
  const [newVendorContact, setNewVendorContact] = useState("");
  const [savingVendor, setSavingVendor] = useState(false);
  const [entryMode, setEntryMode] = useState(() => draft.entryMode ?? "purchase");
  const [category, setCategory] = useState(() => draft.category ?? "COMMODITY");
  const [paymentMode, setPaymentMode] = useState(
    () => draft.paymentMode ?? "CASH"
  );
  const [purchaseDate, setPurchaseDate] = useState(
    () =>
      draft.purchaseDate ||
      localStorage.getItem(PURCHASE_DATE_KEY) ||
      todayYYYYMMDD()
  );
  const { cashBalance, bankBalance } = useEstimatedLiquidity(
    activeClientId,
    purchaseDate || activeShift?.businessDate || todayYYYYMMDD()
  );
  const [isDateUnlocked, setIsDateUnlocked] = useState(
    () => Boolean(draft.isDateUnlocked)
  );
  const [receiptNote, setReceiptNote] = useState(() => draft.receiptNote ?? "");
  const [queuedEntries, setQueuedEntries] = useState(
    () => draft.queuedEntries ?? []
  );
  const [editingEntryId, setEditingEntryId] = useState(
    () => draft.editingEntryId ?? ""
  );
  const [historyEntries, setHistoryEntries] = useState([]);
  const [historyMode, setHistoryMode] = useState("purchase");
  const [showHistory, setShowHistory] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [editingSavedEntry, setEditingSavedEntry] = useState(null);
  const [savedEdit, setSavedEdit] = useState(null);
  const [savingHistory, setSavingHistory] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const cashRequiresShift = isCashTenderMode(paymentMode);
  const resolvedPayment = parsePaymentModeSelection(paymentMode);
  const paymentModeOptions = useMemo(
    () =>
      buildPaymentModeOptions({
        bankAccounts,
        includePettyCash: true,
        includeCredit: entryMode !== "expense",
        ...legacyPaymentModeFlags(paymentMode),
        includeLegacyBankTransfer:
          legacyPaymentModeFlags(paymentMode).includeLegacyBankTransfer ||
          historyEntries.some((entry) => entry.paymentMode === "BANK_TRANSFER"),
      }),
    [bankAccounts, entryMode, paymentMode, historyEntries]
  );
  const cashShiftUnavailable =
    cashRequiresShift && (!activeShift || activeShift.status !== "OPEN");
  const categories =
    entryMode === "purchase" ? PURCHASE_CATEGORIES : EXPENSE_CATEGORIES;
  const quickAddPartyType = entryMode === "purchase" ? "Supplier" : "Employee";
  const hasUnsavedPurchaseWork = Boolean(
    queuedEntries.length ||
      editingEntryId ||
      editingSavedEntry ||
      String(amount || "").trim() ||
      String(receiptNote || "").trim() ||
      selectedPartyId ||
      String(partySearch || "").trim()
  );
  useUnsavedWork(
    "purchases",
    "Purchases & Expenses",
    hasUnsavedPurchaseWork
  );
  const reservedSpend = sumReservedSpend(queuedEntries, editingEntryId);
  const fundsError = getInsufficientFundsError({
    mode: paymentMode,
    amount,
    cashBalance,
    bankBalance,
    reservedCash: reservedSpend.cash,
    reservedBank: reservedSpend.bank,
  });
  const showFundsBlock = Boolean(fundsError);

  useEffect(() => {
    syncDraft({
      amount,
      selectedPartyId,
      partySearch,
      entryMode,
      category,
      paymentMode,
      purchaseDate,
      isDateUnlocked,
      receiptNote,
      queuedEntries,
      editingEntryId,
    });
  }, [
    syncDraft,
    amount,
    selectedPartyId,
    partySearch,
    entryMode,
    category,
    paymentMode,
    purchaseDate,
    isDateUnlocked,
    receiptNote,
    queuedEntries,
    editingEntryId,
  ]);

  useEffect(() => {
    function closeVendorDropdown(event) {
      if (!vendorSelectorRef.current?.contains(event.target)) {
        setVendorDropdownOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeVendorDropdown);
    return () => document.removeEventListener("pointerdown", closeVendorDropdown);
  }, []);

  useEffect(() => {
    if (!message) return undefined;
    const timeoutId = window.setTimeout(() => setMessage(""), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [message]);

  useEffect(() => {
    if (!isDateUnlocked && activeShift?.businessDate) {
      setPurchaseDate(activeShift.businessDate);
    }
  }, [activeShift?.businessDate, isDateUnlocked]);

  useEffect(() => {
    if (purchaseDate) localStorage.setItem(PURCHASE_DATE_KEY, purchaseDate);
  }, [purchaseDate]);

  useEffect(() => {
    setSelectedPartyId("");
    setPartySearch("");
    setQuickAddOpen(false);
    setQueuedEntries([]);
    setEditingEntryId("");
    if (!activeClientId) {
      setParties([]);
      setLoadingParties(false);
      return undefined;
    }

    setLoadingParties(true);
    const partiesQuery = query(
      collection(db, "parties"),
      where("clientId", "==", activeClientId)
    );
    return onSnapshot(
      partiesQuery,
      (snapshot) => {
        setParties(
          snapshot.docs
            .map((item) => ({ id: item.id, ...item.data() }))
            .sort((a, b) =>
              String(a.name || "").localeCompare(String(b.name || ""))
            )
        );
        setLoadingParties(false);
      },
      (reason) => {
        setLoadingParties(false);
        setError(reason?.message || "Failed to load vendors.");
      }
    );
  }, [activeClientId]);

  useEffect(() => {
    if (!activeClientId || !purchaseDate || !showHistory) return undefined;
    setLoadingHistory(true);
    const historyQuery = query(
      collection(db, "purchases"),
      where("clientId", "==", activeClientId),
      where("businessDate", "==", purchaseDate),
      limit(500)
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
        setError(reason?.message || "Failed to load history for the selected date.");
      }
    );
  }, [activeClientId, purchaseDate, showHistory]);

  const selectedParty = useMemo(
    () => parties.find((party) => party.id === selectedPartyId) || null,
    [parties, selectedPartyId]
  );

  const filteredParties = useMemo(() => {
    const search = partySearch.trim().toLowerCase();
    return parties
      .filter((party) => {
        const partyType = String(party.type || "").trim().toLowerCase();
        const isVendor = ["supplier", "vendor"].includes(partyType);
        const isAvailableForMode =
          entryMode === "purchase"
            ? isVendor || partyType === "both"
            : !isVendor;
        if (!isAvailableForMode) return false;
        if (!search) return true;
        return `${party.name || ""} ${party.type || ""} ${party.contact || ""}`
          .toLowerCase()
          .includes(search);
      })
      .sort((a, b) => {
        const preferredTypes =
          entryMode === "purchase"
            ? new Set(["supplier", "vendor", "both"])
            : new Set(["employee", "supplier", "vendor", "both"]);
        const aRank = preferredTypes.has(String(a.type || "").toLowerCase()) ? 0 : 1;
        const bRank = preferredTypes.has(String(b.type || "").toLowerCase()) ? 0 : 1;
        return aRank - bRank || String(a.name || "").localeCompare(String(b.name || ""));
      })
      .slice(0, 25);
  }, [entryMode, parties, partySearch]);

  const filteredHistory = useMemo(
    () =>
      historyEntries.filter((entry) => entry.entryType === historyMode),
    [historyEntries, historyMode]
  );

  function selectParty(party) {
    setSelectedPartyId(party.id);
    setPartySearch(party.name || "");
    setVendorDropdownOpen(false);
  }

  async function handleQuickAddVendor(event) {
    event.preventDefault();
    setError("");
    const cleanName = newVendorName.trim();
    const cleanContact = newVendorContact.trim();

    if (!activeClientId || !user?.uid) {
      setError("Select a shop and sign in before adding a vendor.");
      return;
    }
    if (!cleanName) {
      setError("Vendor name is required.");
      return;
    }

    setSavingVendor(true);
    try {
      const partyRef = doc(collection(db, "parties"));
      await runTransaction(db, async (transaction) => {
        transaction.set(partyRef, {
          clientId: activeClientId,
          name: cleanName,
          contact: cleanContact,
          type: quickAddPartyType,
          taxNumber: "",
          createdBy: user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      });

      const createdParty = {
        id: partyRef.id,
        name: cleanName,
        contact: cleanContact,
        type: quickAddPartyType,
      };
      setParties((current) =>
        current.some((party) => party.id === partyRef.id)
          ? current
          : [...current, createdParty]
      );
      selectParty(createdParty);
      setNewVendorName("");
      setNewVendorContact("");
      setQuickAddOpen(false);
    } catch (reason) {
      setError(reason?.message || "Failed to create vendor.");
    } finally {
      setSavingVendor(false);
    }
  }

  function buildCurrentEntry() {
    const parsedAmount = roundMoney(amount);
    const cleanPartyName = String(selectedParty?.name || "").trim();
    const cleanReceiptNote = receiptNote.trim();

    if (!activeClientId) throw new Error("Select an active shop first.");
    if (!user?.uid) throw new Error("You must be signed in.");
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new Error("Amount must be greater than zero.");
    }
    if (!selectedPartyId || !cleanPartyName) {
      throw new Error(
        paymentMode === "CREDIT"
          ? "Select or create a vendor before recording a credit purchase."
          : "Select a party."
      );
    }
    if (!categories.includes(category)) {
      throw new Error("Select a valid category.");
    }
    if (!paymentModeOptions.some((option) => option.value === paymentMode)) {
      throw new Error("Select a valid payment mode.");
    }
    if (resolvedPayment.paymentMode === "CREDIT" && entryMode !== "purchase") {
      throw new Error("Credit is available only for supplier purchases.");
    }
    if (
      resolvedPayment.paymentMode === "BANK" &&
      !resolvedPayment.bankAccountId
    ) {
      throw new Error("Select a bank account for bank payments.");
    }
    if (!purchaseDate) throw new Error("Entry date is required.");
    if (cashShiftUnavailable) {
      throw new Error("Open a shift before recording a register cash payment.");
    }
    if (
      isCashTenderMode(resolvedPayment.paymentMode) &&
      activeShift?.businessDate &&
      purchaseDate !== activeShift.businessDate
    ) {
      throw new Error(
        "Cash purchases must use the active shift date. Unlock is for non-cash corrections only."
      );
    }

    return {
      id: editingEntryId || crypto.randomUUID(),
      entryType: entryMode,
      amount: parsedAmount,
      partyId: selectedPartyId,
      partyName: cleanPartyName,
      partyType: selectedParty?.type || quickAddPartyType,
      category,
      paymentMode: resolvedPayment.paymentMode,
      bankAccountId: resolvedPayment.bankAccountId || "",
      bankAccountName: findBankAccountName(
        bankAccounts,
        resolvedPayment.bankAccountId
      ),
      receiptNote: cleanReceiptNote,
      businessDate: isDateUnlocked
        ? purchaseDate
        : activeShift?.businessDate || purchaseDate,
    };
  }

  function resetEntryFields() {
    setAmount("");
    setSelectedPartyId("");
    setPartySearch("");
    setReceiptNote("");
    setEditingEntryId("");
    setVendorDropdownOpen(false);
  }

  function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setMessage("");
    try {
      const nextEntry = buildCurrentEntry();
      if (!editingEntryId && queuedEntries.length >= 8) {
        throw new Error("Save the current batch before adding more than 8 entries.");
      }
      const reserved = sumReservedSpend(queuedEntries, editingEntryId);
      const fundsIssue = getInsufficientFundsError({
        mode: nextEntry.paymentMode,
        amount: nextEntry.amount,
        cashBalance,
        bankBalance,
        reservedCash: reserved.cash,
        reservedBank: reserved.bank,
      });
      if (fundsIssue) throw new Error(fundsIssue);
      setQueuedEntries((current) =>
        editingEntryId
          ? current.map((entry) =>
              entry.id === editingEntryId ? nextEntry : entry
            )
          : [...current, nextEntry]
      );
      setMessage(editingEntryId ? "Entry updated in the batch." : "Entry added to the batch.");
      resetEntryFields();
    } catch (reason) {
      setError(reason?.message || "Failed to add entry.");
    }
  }

  function editQueuedEntry(entry) {
    setEntryMode(entry.entryType);
    setAmount(String(entry.amount));
    setSelectedPartyId(entry.partyId);
    setPartySearch(entry.partyName);
    setCategory(entry.category);
    setPaymentMode(
      paymentModeSelectionFromSaved(entry.paymentMode, entry.bankAccountId)
    );
    setPurchaseDate(entry.businessDate);
    setReceiptNote(entry.receiptNote);
    setEditingEntryId(entry.id);
    setError("");
    setMessage("Editing queued entry.");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function removeQueuedEntry(entryId) {
    setQueuedEntries((current) =>
      current.filter((entry) => entry.id !== entryId)
    );
    if (editingEntryId === entryId) resetEntryFields();
  }

  async function saveBatch() {
    setError("");
    setMessage("");
    if (!queuedEntries.length) {
      setError("Add at least one entry to the batch.");
      return;
    }
    const batchReserved = sumReservedSpend([]);
    for (const entry of queuedEntries) {
      const fundsIssue = getInsufficientFundsError({
        mode: entry.paymentMode,
        amount: entry.amount,
        cashBalance,
        bankBalance,
        reservedCash: batchReserved.cash,
        reservedBank: batchReserved.bank,
      });
      if (fundsIssue) {
        setError(fundsIssue);
        return;
      }
      if (isCashTenderMode(entry.paymentMode)) {
        batchReserved.cash += Number(entry.amount) || 0;
      }
      if (isBankTenderMode(entry.paymentMode)) {
        batchReserved.bank += Number(entry.amount) || 0;
      }
    }
    const cashEntries = queuedEntries.filter((entry) =>
      isCashTenderMode(entry.paymentMode)
    );
    if (
      cashEntries.length &&
      (!activeShift?.id || activeShift.status !== "OPEN")
    ) {
      setError("Open a shift before saving register cash entries.");
      return;
    }
    if (
      cashEntries.some(
        (entry) => entry.businessDate !== activeShift?.businessDate
      )
    ) {
      setError(
        "Cash entries must use the active shift date. Unlock is for non-cash corrections only."
      );
      return;
    }

    const refs = queuedEntries.map(() => ({
      purchaseRef: doc(collection(db, "purchases")),
      transactionRef: doc(collection(db, "transactions")),
    }));
    const shiftRef = cashEntries.length
      ? doc(db, "shifts", activeShift.id)
      : null;
    const createdAtMs = Date.now();

    setSaving(true);
    try {
      await runTransaction(db, async (transaction) => {
        if (shiftRef) {
          const shiftSnapshot = await transaction.get(shiftRef);
          if (
            !shiftSnapshot.exists() ||
            shiftSnapshot.data()?.status !== "OPEN" ||
            shiftSnapshot.data()?.clientId !== activeClientId
          ) {
            throw new Error(
              "The selected shift is no longer open. Refresh and try again."
            );
          }
        }

        queuedEntries.forEach((entry, index) => {
          const { purchaseRef, transactionRef } = refs[index];
          const shiftId =
            isCashTenderMode(entry.paymentMode) ? activeShift.id : "";
          const liabilityType =
            entry.paymentMode === "CREDIT" ? "ACCOUNTS_PAYABLE" : "";

          transaction.set(purchaseRef, {
            schemaVersion: 1,
            clientId: activeClientId,
            entryType: entry.entryType,
            amount: entry.amount,
            partyId: entry.partyId,
            vendorName: entry.partyName,
            category: entry.category,
            paymentMode: entry.paymentMode,
            bankAccountId: entry.bankAccountId || "",
            bankAccountName: entry.bankAccountName || "",
            liabilityType,
            receiptNote: entry.receiptNote,
            shiftId,
            businessDate: entry.businessDate,
            businessDateAt: toBusinessDate(entry.businessDate),
            transactionId: transactionRef.id,
            status: "POSTED",
            batchId: createdAtMs,
            createdBy: user.uid,
            createdAt: serverTimestamp(),
            createdAtMs: createdAtMs + index,
          });

          transaction.set(transactionRef, {
            ...buildTransactionPayload({
              clientId: activeClientId,
              date: entry.businessDate,
              type: entry.entryType,
              category: entry.category,
              mode: entry.paymentMode,
              bankAccountId: entry.bankAccountId || "",
              bankAccountName: entry.bankAccountName || "",
              partyType: entry.partyType,
              partyId: entry.partyId,
              partyName: entry.partyName,
              description:
                entry.receiptNote || `${entry.category} payment`,
              amountBeforeTax: entry.amount,
              totalAmount: entry.amount,
              amountIn: 0,
              amountOut: entry.amount,
              status: "POSTED",
              source: "purchase_expense",
              refType: "purchase",
              refId: purchaseRef.id,
              shiftId,
            }),
            liabilityType,
            batchId: createdAtMs,
            createdBy: user.uid,
            createdAt: serverTimestamp(),
          });
        });
      });

      const savedCount = queuedEntries.length;
      setQueuedEntries([]);
      resetEntryFields();
      clearDraft();
      setMessage(`${savedCount} purchase/expense entries saved successfully.`);
    } catch (reason) {
      setError(reason?.message || "Failed to save the batch.");
    } finally {
      setSaving(false);
    }
  }

  function openSavedEdit(entry) {
    setEditingSavedEntry(entry);
    setSavedEdit({
      entryType: entry.entryType || "purchase",
      amount: String(entry.amount ?? ""),
      partyId: entry.partyId || "",
      category: entry.category || "",
      paymentMode: paymentModeSelectionFromSaved(
        entry.paymentMode || "CASH",
        entry.bankAccountId
      ),
      bankAccountId: entry.bankAccountId || "",
      receiptNote: entry.receiptNote || "",
      businessDate: entry.businessDate || todayYYYYMMDD(),
    });
    setError("");
  }

  function closeSavedEdit() {
    setEditingSavedEntry(null);
    setSavedEdit(null);
  }

  async function updateSavedEntry(event) {
    event.preventDefault();
    if (!editingSavedEntry || !savedEdit) return;

    setError("");
    setMessage("");
    const parsedAmount = roundMoney(savedEdit.amount);
    const selectedEditParty = parties.find(
      (party) => party.id === savedEdit.partyId
    );
    const editCategories =
      savedEdit.entryType === "purchase"
        ? PURCHASE_CATEGORIES
        : EXPENSE_CATEGORIES;

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError("Amount must be greater than zero.");
      return;
    }
    if (!selectedEditParty) {
      setError("Select a valid party.");
      return;
    }
    if (!editCategories.includes(savedEdit.category)) {
      setError("Select a valid category.");
      return;
    }
    const editPayment = parsePaymentModeSelection(savedEdit.paymentMode);
    if (
      editPayment.paymentMode === "CREDIT" &&
      savedEdit.entryType !== "purchase"
    ) {
      setError("Credit is available only for supplier purchases.");
      return;
    }
    if (editPayment.paymentMode === "BANK" && !editPayment.bankAccountId) {
      setError("Select a bank account for bank payments.");
      return;
    }
    if (!savedEdit.businessDate) {
      setError("Entry date is required.");
      return;
    }

    const creditedCash = isCashTenderMode(editingSavedEntry.paymentMode)
      ? Number(editingSavedEntry.amount) || 0
      : 0;
    const creditedBank = isBankTenderMode(editingSavedEntry.paymentMode)
      ? Number(editingSavedEntry.amount) || 0
      : 0;
    const fundsIssue = getInsufficientFundsError({
      mode: editPayment.paymentMode,
      amount: parsedAmount,
      cashBalance:
        cashBalance === null ? null : cashBalance + creditedCash,
      bankBalance:
        bankBalance === null ? null : bankBalance + creditedBank,
    });
    if (fundsIssue) {
      setError(fundsIssue);
      return;
    }

    const canReuseCashShift =
      isCashTenderMode(editingSavedEntry.paymentMode) &&
      isCashTenderMode(editPayment.paymentMode) &&
      editingSavedEntry.shiftId &&
      editingSavedEntry.businessDate === savedEdit.businessDate;
    let targetShiftId = "";
    if (isCashTenderMode(editPayment.paymentMode)) {
      if (canReuseCashShift) {
        targetShiftId = editingSavedEntry.shiftId;
      } else if (
        activeShift?.id &&
        activeShift.status === "OPEN" &&
        activeShift.businessDate === savedEdit.businessDate
      ) {
        targetShiftId = activeShift.id;
      } else {
        setError(
          "Open a shift matching the entry date before changing this entry to cash."
        );
        return;
      }
    }

    const purchaseRef = doc(db, "purchases", editingSavedEntry.id);
    const transactionRef = doc(
      db,
      "transactions",
      editingSavedEntry.transactionId
    );
    const shiftRef = targetShiftId
      ? doc(db, "shifts", targetShiftId)
      : null;
    const liabilityType =
      editPayment.paymentMode === "CREDIT" ? "ACCOUNTS_PAYABLE" : "";
    const editBankAccountName = findBankAccountName(
      bankAccounts,
      editPayment.bankAccountId
    );

    setSavingHistory(true);
    try {
      await runTransaction(db, async (transaction) => {
        const [purchaseSnapshot, transactionSnapshot, shiftSnapshot] =
          await Promise.all([
            transaction.get(purchaseRef),
            transaction.get(transactionRef),
            shiftRef ? transaction.get(shiftRef) : Promise.resolve(null),
          ]);

        if (
          !purchaseSnapshot.exists() ||
          purchaseSnapshot.data()?.clientId !== activeClientId
        ) {
          throw new Error("Purchase entry no longer exists.");
        }
        if (
          !transactionSnapshot.exists() ||
          transactionSnapshot.data()?.clientId !== activeClientId ||
          transactionSnapshot.data()?.refId !== purchaseRef.id
        ) {
          throw new Error("The linked ledger transaction is invalid.");
        }
        if (
          shiftSnapshot &&
          (!shiftSnapshot.exists() ||
            shiftSnapshot.data()?.clientId !== activeClientId ||
            (!canReuseCashShift &&
              shiftSnapshot.data()?.status !== "OPEN"))
        ) {
          throw new Error("The selected cash shift is invalid.");
        }

        transaction.update(purchaseRef, {
          entryType: savedEdit.entryType,
          amount: parsedAmount,
          partyId: selectedEditParty.id,
          vendorName: String(selectedEditParty.name || "").trim(),
          category: savedEdit.category,
          paymentMode: editPayment.paymentMode,
          bankAccountId: editPayment.bankAccountId || "",
          bankAccountName: editBankAccountName,
          liabilityType,
          receiptNote: String(savedEdit.receiptNote || "").trim(),
          shiftId: targetShiftId,
          businessDate: savedEdit.businessDate,
          businessDateAt: toBusinessDate(savedEdit.businessDate),
          updatedBy: user.uid,
          updatedAt: serverTimestamp(),
          updatedAtMs: Date.now(),
        });

        transaction.update(transactionRef, {
          ...buildTransactionPayload({
            clientId: activeClientId,
            date: savedEdit.businessDate,
            type: savedEdit.entryType,
            category: savedEdit.category,
            mode: editPayment.paymentMode,
            bankAccountId: editPayment.bankAccountId || "",
            bankAccountName: editBankAccountName,
            partyType: selectedEditParty.type || "Other",
            partyId: selectedEditParty.id,
            partyName: String(selectedEditParty.name || "").trim(),
            description:
              String(savedEdit.receiptNote || "").trim() ||
              `${savedEdit.category} payment`,
            amountBeforeTax: parsedAmount,
            totalAmount: parsedAmount,
            amountIn: 0,
            amountOut: parsedAmount,
            status: "POSTED",
            source: "purchase_expense",
            refType: "purchase",
            refId: purchaseRef.id,
            shiftId: targetShiftId,
          }),
          liabilityType,
          updatedBy: user.uid,
          updatedAt: serverTimestamp(),
        });
      });

      closeSavedEdit();
      setMessage("Saved purchase/expense entry updated successfully.");
    } catch (reason) {
      setError(reason?.message || "Failed to update the saved entry.");
    } finally {
      setSavingHistory(false);
    }
  }

  if (!activeClientId) {
    return <div className="text-slate-300">Select a shop to enter purchases.</div>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-white">
                Purchase &amp; Expense Entry
              </h1>
              <p className="mt-1 text-sm text-slate-400">
                {activeClientData?.name || activeClientId}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ModuleHelpButton moduleId="purchases" />
              <ModuleExitButton ariaLabel="Close purchase and expense entry" />
            </div>
          </div>
        </div>

        <div className={`${LABEL_CLASS} shrink-0 sm:text-right`}>
          {entryMode === "purchase" ? "Purchase Date" : "Expense Date"}
          <div className="mt-1.5 w-[150px]">
            {isDateUnlocked ? (
              <DateInput
                required
                form="purchase-entry-form"
                value={purchaseDate}
                onChange={(event) => setPurchaseDate(event.target.value)}
                className="h-[42px] w-full rounded-lg border border-amber-700/60 bg-slate-950 text-right text-white"
                aria-label="Purchase date"
              />
            ) : (
              <div className="rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-right text-white">
                {formatIsoDate(purchaseDate)}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setIsDateUnlocked((current) => {
                  const next = !current;
                  if (!next && activeShift?.businessDate) {
                    setPurchaseDate(activeShift.businessDate);
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
        id="purchase-entry-form"
        onSubmit={handleSubmit}
        className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 sm:p-6"
      >
        <div className="mb-5 inline-flex rounded-full border border-slate-700 bg-slate-950 p-1">
          {[
            ["purchase", "Purchase"],
            ["expense", "Expense"],
          ].map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => {
                setEntryMode(mode);
                if (mode === "expense" && paymentMode === "CREDIT") {
                  setPaymentMode("CASH");
                }
                setCategory(
                  mode === "purchase"
                    ? PURCHASE_CATEGORIES[0]
                    : EXPENSE_CATEGORIES[0]
                );
                setSelectedPartyId("");
                setPartySearch("");
                setVendorDropdownOpen(false);
                setQuickAddOpen(false);
                setError("");
                setMessage("");
              }}
              className={[
                "rounded-full px-5 py-2 text-sm font-semibold transition-all",
                entryMode === mode
                  ? "bg-blue-600 text-white shadow-sm shadow-blue-950"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <label className={LABEL_CLASS}>
            Amount
            <input
              required
              type="number"
              min="0.01"
              step={moneyInputStep()}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className={FIELD_CLASS}
              placeholder="0.00"
            />
          </label>

          <div ref={vendorSelectorRef} className="relative">
            <label htmlFor="purchase-vendor" className={LABEL_CLASS}>
              {entryMode === "purchase"
                ? "Vendor Party"
                : "Party Name (Payee/Employee)"}
            </label>
            <div className="mt-1.5 flex gap-2">
              <div className="relative min-w-0 flex-1">
                <input
                  id="purchase-vendor"
                  required
                  autoComplete="off"
                  value={partySearch}
                  onFocus={() => setVendorDropdownOpen(true)}
                  onChange={(event) => {
                    setPartySearch(event.target.value);
                    setSelectedPartyId("");
                    setVendorDropdownOpen(true);
                  }}
                  className={`${FIELD_CLASS} mt-0`}
                  placeholder={
                    loadingParties
                      ? "Loading parties…"
                      : entryMode === "purchase"
                        ? "Search vendor or party"
                        : "Search payee or employee"
                  }
                />

                {vendorDropdownOpen ? (
                  <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-1 shadow-2xl">
                    {filteredParties.length ? (
                      filteredParties.map((party) => (
                        <button
                          key={party.id}
                          type="button"
                          onClick={() => selectParty(party)}
                          className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-slate-800"
                        >
                          <span className="truncate text-slate-100">
                            {party.name || "Unnamed party"}
                          </span>
                          <span className="shrink-0 text-xs text-slate-500">
                            {party.type || "Party"}
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className="px-3 py-2 text-slate-500">
                        {entryMode === "purchase"
                          ? "No matching vendors."
                          : "No matching payees or employees."}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                onClick={() => {
                  setQuickAddOpen((current) => !current);
                  setVendorDropdownOpen(false);
                  setError("");
                }}
                className="inline-flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-white transition-all hover:border-blue-500 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
                aria-label="Quick add vendor"
                title="Quick add vendor"
              >
                <Plus className="h-5 w-5" />
              </button>
            </div>

            {quickAddOpen ? (
              <div className="absolute z-30 mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-white">
                    Quick Add {entryMode === "purchase" ? "Vendor" : "Employee"}
                  </div>
                  <button
                    type="button"
                    onClick={() => setQuickAddOpen(false)}
                    className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                    aria-label="Close quick add"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-3 space-y-3">
                  <label className={LABEL_CLASS}>
                    Name
                    <input
                      required
                      value={newVendorName}
                      onChange={(event) => setNewVendorName(event.target.value)}
                      className={FIELD_CLASS}
                      placeholder="Vendor name"
                    />
                  </label>
                  <label className={LABEL_CLASS}>
                    Contact
                    <input
                      value={newVendorContact}
                      onChange={(event) => setNewVendorContact(event.target.value)}
                      className={FIELD_CLASS}
                      placeholder="Phone or email"
                    />
                  </label>
                  <div className="text-xs text-slate-500">
                    Type: {quickAddPartyType}
                  </div>
                  <button
                    type="button"
                    disabled={savingVendor}
                    onClick={handleQuickAddVendor}
                    className="rounded-lg bg-white px-4 py-2 font-semibold text-slate-950 disabled:opacity-50"
                  >
                    {savingVendor ? "Saving…" : "Save Vendor"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <label className={LABEL_CLASS}>
            Category
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className={FIELD_CLASS}
            >
              {categories.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className={LABEL_CLASS}>
            Payment Mode
            <select
              value={paymentMode}
              onChange={(event) => {
                const nextMode = event.target.value;
                setPaymentMode(nextMode);
                setError("");
                setMessage("");
              }}
              className={FIELD_CLASS}
            >
              {paymentModeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className={`${LABEL_CLASS} col-span-full`}>
            Receipt Note
            <textarea
              value={receiptNote}
              onChange={(event) => setReceiptNote(event.target.value)}
              rows={2}
              className={`${FIELD_CLASS} resize-y`}
              placeholder="Receipt number or payment details"
            />
          </label>

          <div className="col-span-full flex justify-end gap-2">
            {editingEntryId ? (
              <button
                type="button"
                onClick={resetEntryFields}
                className="rounded-lg border border-slate-700 px-5 py-2.5 font-semibold text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
              >
                Cancel Edit
              </button>
            ) : null}
            <button
              type="submit"
              disabled={saving || loadingShift || showFundsBlock}
              className="rounded-lg bg-blue-600 px-5 py-2.5 font-semibold text-white transition-all hover:bg-blue-500 hover:shadow-lg hover:shadow-blue-950/20 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {editingEntryId ? "Update Entry" : "Add Entry to List"}
            </button>
          </div>
        </div>
      </form>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-white">Purchase &amp; Expense Batch</h2>
            <p className="mt-1 text-sm text-slate-400">
              {queuedEntries.length} of 8 entries queued
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Batch Total
            </p>
            <p className="text-xl font-bold text-white">
              {formatMoney(
                queuedEntries.reduce(
                  (total, entry) => total + Number(entry.amount || 0),
                  0
                )
              )}
            </p>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-950/80 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Party</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Mode</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {queuedEntries.length ? (
                queuedEntries.map((entry) => (
                  <tr
                    key={entry.id}
                    className={`border-t border-slate-800 text-slate-300 ${
                      editingEntryId === entry.id ? "bg-blue-950/25" : ""
                    }`}
                  >
                    <td className="whitespace-nowrap px-4 py-3">
                      {formatIsoDate(entry.businessDate, "-")}
                    </td>
                    <td className="px-4 py-3 capitalize">{entry.entryType}</td>
                    <td className="px-4 py-3 text-white">{entry.partyName}</td>
                    <td className="px-4 py-3">{entry.category}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {entry.bankAccountName ? `Bank: ${entry.bankAccountName}` : String(entry.paymentMode || "").replaceAll("_", " ")}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-white">
                      {formatMoney(entry.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => editQueuedEntry(entry)}
                          className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:border-blue-500 hover:text-blue-300"
                          aria-label="Edit queued entry"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeQueuedEntry(entry.id)}
                          className="rounded-lg border border-rose-900/70 p-2 text-rose-300 hover:bg-rose-950/40"
                          aria-label="Remove queued entry"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    Add purchase or expense entries to build this batch.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={saveBatch}
            disabled={saving || !queuedEntries.length}
            className="inline-flex items-center gap-2 rounded-lg bg-white px-6 py-2.5 font-semibold text-slate-950 transition-all hover:bg-blue-50 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save size={17} />
            {saving
              ? "Saving Batch…"
              : `Save All ${queuedEntries.length || ""} Entries`}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-white">Saved Entry History</h2>
            <p className="mt-1 text-sm text-slate-400">
              Entries saved on {formatIsoDate(purchaseDate, "-")}
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

        {showHistory ? (
          <>
            <div className="mt-4 inline-flex rounded-full border border-slate-700 bg-slate-950 p-1">
              {[
                ["purchase", "Purchase History"],
                ["expense", "Expense History"],
              ].map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setHistoryMode(mode)}
                  className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                    historyMode === mode
                      ? "bg-blue-600 text-white"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-slate-950/80 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Party</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Mode</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingHistory ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                        Loading history…
                      </td>
                    </tr>
                  ) : filteredHistory.length ? (
                    filteredHistory.map((entry) => (
                      <tr
                        key={entry.id}
                        className="border-t border-slate-800 text-slate-300 hover:bg-slate-800/25"
                      >
                        <td className="whitespace-nowrap px-4 py-3">
                          {formatIsoDate(entry.businessDate, "-")}
                        </td>
                        <td className="px-4 py-3 text-white">
                          {entry.vendorName || "-"}
                        </td>
                        <td className="px-4 py-3">{entry.category || "-"}</td>
                        <td className="whitespace-nowrap px-4 py-3">
                          {String(entry.paymentMode || "-").replaceAll("_", " ")}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-white">
                          {formatMoney(entry.amount || 0)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => openSavedEdit(entry)}
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
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                        No saved {historyMode} entries found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </section>

      {editingSavedEntry && savedEdit ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={updateSavedEntry}
            className="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <div>
                <h2 className="font-semibold text-white">Edit Saved Entry</h2>
                <p className="mt-1 text-xs text-slate-400">
                  Updates the source record and accounting ledger atomically.
                </p>
              </div>
              <button
                type="button"
                onClick={closeSavedEdit}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"
                aria-label="Close edit entry"
              >
                <X size={18} />
              </button>
            </div>

            <div className="max-h-[calc(90vh-140px)] overflow-y-auto p-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className={LABEL_CLASS}>
                  Entry Type
                  <select
                    value={savedEdit.entryType}
                    onChange={(event) => {
                      const nextType = event.target.value;
                      setSavedEdit((current) => ({
                        ...current,
                        entryType: nextType,
                        category:
                          nextType === "purchase"
                            ? PURCHASE_CATEGORIES[0]
                            : EXPENSE_CATEGORIES[0],
                        paymentMode:
                          nextType === "expense" &&
                          current.paymentMode === "CREDIT"
                            ? "CASH"
                            : current.paymentMode,
                        partyId: "",
                      }));
                    }}
                    className={FIELD_CLASS}
                  >
                    <option value="purchase">Purchase</option>
                    <option value="expense">Expense</option>
                  </select>
                </label>

                <label className={LABEL_CLASS}>
                  Date
                  <DateInput
                    value={savedEdit.businessDate}
                    onChange={(event) =>
                      setSavedEdit((current) => ({
                        ...current,
                        businessDate: event.target.value,
                      }))
                    }
                    className="mt-1.5 h-[42px] w-full rounded-lg border border-slate-700 bg-slate-950 text-white"
                    required
                  />
                </label>

                <label className={LABEL_CLASS}>
                  Amount
                  <input
                    type="number"
                    min="0.01"
                    step={moneyInputStep()}
                    value={savedEdit.amount}
                    onChange={(event) =>
                      setSavedEdit((current) => ({
                        ...current,
                        amount: event.target.value,
                      }))
                    }
                    className={FIELD_CLASS}
                    required
                  />
                </label>

                <label className={LABEL_CLASS}>
                  Party
                  <select
                    value={savedEdit.partyId}
                    onChange={(event) =>
                      setSavedEdit((current) => ({
                        ...current,
                        partyId: event.target.value,
                      }))
                    }
                    className={FIELD_CLASS}
                    required
                  >
                    <option value="">Select party</option>
                    {parties
                      .filter((party) => {
                        const type = String(party.type || "").toLowerCase();
                        const vendor = ["supplier", "vendor", "both"].includes(type);
                        return savedEdit.entryType === "purchase"
                          ? vendor
                          : !["supplier", "vendor"].includes(type);
                      })
                      .map((party) => (
                        <option key={party.id} value={party.id}>
                          {party.name || "Unnamed party"}
                        </option>
                      ))}
                  </select>
                </label>

                <label className={LABEL_CLASS}>
                  Category
                  <select
                    value={savedEdit.category}
                    onChange={(event) =>
                      setSavedEdit((current) => ({
                        ...current,
                        category: event.target.value,
                      }))
                    }
                    className={FIELD_CLASS}
                  >
                    {(savedEdit.entryType === "purchase"
                      ? PURCHASE_CATEGORIES
                      : EXPENSE_CATEGORIES
                    ).map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={LABEL_CLASS}>
                  Payment Mode
                  <select
                    value={savedEdit.paymentMode}
                    onChange={(event) =>
                      setSavedEdit((current) => ({
                        ...current,
                        paymentMode: event.target.value,
                      }))
                    }
                    className={FIELD_CLASS}
                  >
                    {buildPaymentModeOptions({
                      bankAccounts,
                      includePettyCash: true,
                      includeCredit: savedEdit.entryType === "purchase",
                      ...legacyPaymentModeFlags(savedEdit.paymentMode),
                    }).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={`${LABEL_CLASS} sm:col-span-2`}>
                  Receipt Note
                  <textarea
                    rows={3}
                    value={savedEdit.receiptNote}
                    onChange={(event) =>
                      setSavedEdit((current) => ({
                        ...current,
                        receiptNote: event.target.value,
                      }))
                    }
                    className={`${FIELD_CLASS} resize-y`}
                  />
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-4">
              <button
                type="button"
                onClick={closeSavedEdit}
                className="rounded-lg border border-slate-700 px-4 py-2.5 text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingHistory}
                className="rounded-lg bg-blue-600 px-5 py-2.5 font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {savingHistory ? "Updating…" : "Update Saved Entry"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
