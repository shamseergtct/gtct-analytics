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
import { Eye, EyeOff, Lock, Pencil, Plus, Unlock, X } from "lucide-react";
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

const CATEGORIES = ["SETTLEMENT", "ADVANCE", "LOAN", "OTHER"];
const ENTRY_DATE_KEY = "gtct_payment_receipt_entry_date";
const LABEL_CLASS = "block text-sm font-medium text-gray-300";
const FIELD_CLASS =
  "mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white transition-all focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60";

function todayYYYYMMDD() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export default function PaymentReceiptEntry() {
  const { user } = useAuth();
  const { activeClientId, activeClientData } = useClient();
  const { activeShift, loadingShift, shiftError } = useShift();
  const partySelectorRef = useRef(null);
  const draftKey = `payments:${activeClientId || "none"}`;
  const { initialDraft, syncDraft, clearDraft } = useFormDraft(draftKey);
  const draft = initialDraft || {};
  const { accounts: bankAccounts } = useBankAccounts(activeClientId);

  const [entryMode, setEntryMode] = useState(() => draft.entryMode ?? "receipt");
  const [entryDate, setEntryDate] = useState(
    () =>
      draft.entryDate ||
      localStorage.getItem(ENTRY_DATE_KEY) ||
      todayYYYYMMDD()
  );
  const { cashBalance, bankBalance } = useEstimatedLiquidity(
    activeClientId,
    entryDate || activeShift?.businessDate || todayYYYYMMDD()
  );
  const [isDateUnlocked, setIsDateUnlocked] = useState(
    () => Boolean(draft.isDateUnlocked)
  );
  const [amount, setAmount] = useState(() => draft.amount ?? "");
  const [category, setCategory] = useState(() => draft.category ?? "SETTLEMENT");
  const [paymentMode, setPaymentMode] = useState(
    () => draft.paymentMode ?? "CASH"
  );
  const [note, setNote] = useState(() => draft.note ?? "");

  const [parties, setParties] = useState([]);
  const [loadingParties, setLoadingParties] = useState(false);
  const [selectedPartyId, setSelectedPartyId] = useState(
    () => draft.selectedPartyId ?? ""
  );
  const [partySearch, setPartySearch] = useState(() => draft.partySearch ?? "");
  const [partyDropdownOpen, setPartyDropdownOpen] = useState(false);

  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [newPartyName, setNewPartyName] = useState("");
  const [newPartyContact, setNewPartyContact] = useState("");
  const [savingParty, setSavingParty] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [historyEntries, setHistoryEntries] = useState([]);
  const [historyMode, setHistoryMode] = useState("receipt");
  const [showHistory, setShowHistory] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [editingSavedEntry, setEditingSavedEntry] = useState(null);
  const [savedEdit, setSavedEdit] = useState(null);
  const [savingHistory, setSavingHistory] = useState(false);

  const selectedParty = useMemo(
    () => parties.find((party) => party.id === selectedPartyId) || null,
    [parties, selectedPartyId]
  );

  const filteredParties = useMemo(() => {
    const search = partySearch.trim().toLowerCase();
    return parties
      .filter((party) => {
        if (!search) return true;
        return `${party.name || ""} ${party.type || ""} ${party.contact || ""}`
          .toLowerCase()
          .includes(search);
      })
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
      .slice(0, 25);
  }, [parties, partySearch]);

  const resolvedPayment = parsePaymentModeSelection(paymentMode);
  const paymentModeOptions = useMemo(
    () =>
      buildPaymentModeOptions({
        bankAccounts,
        includePettyCash: true,
        ...legacyPaymentModeFlags(paymentMode),
      }),
    [bankAccounts, paymentMode]
  );
  const cashShiftUnavailable =
    isCashTenderMode(resolvedPayment.paymentMode) &&
    (!activeShift || activeShift.status !== "OPEN");
  const quickAddPartyType = entryMode === "receipt" ? "Customer" : "Supplier";
  const hasUnsavedPaymentWork = Boolean(
    String(amount || "").trim() ||
      String(note || "").trim() ||
      selectedPartyId ||
      partySearch.trim() ||
      editingSavedEntry
  );
  useUnsavedWork(
    "payments",
    "Payments & Receipts",
    hasUnsavedPaymentWork
  );
  const fundsError =
    entryMode === "payment"
      ? getInsufficientFundsError({
          mode: paymentMode,
          amount,
          cashBalance,
          bankBalance,
        })
      : null;
  const showFundsBlock = Boolean(fundsError);

  useEffect(() => {
    syncDraft({
      entryMode,
      entryDate,
      isDateUnlocked,
      amount,
      category,
      paymentMode,
      note,
      selectedPartyId,
      partySearch,
    });
  }, [
    syncDraft,
    entryMode,
    entryDate,
    isDateUnlocked,
    amount,
    category,
    paymentMode,
    note,
    selectedPartyId,
    partySearch,
  ]);

  useEffect(() => {
    function closePartyDropdown(event) {
      if (!partySelectorRef.current?.contains(event.target)) {
        setPartyDropdownOpen(false);
      }
    }
    document.addEventListener("pointerdown", closePartyDropdown);
    return () => document.removeEventListener("pointerdown", closePartyDropdown);
  }, []);

  useEffect(() => {
    if (!message) return undefined;
    const timeoutId = window.setTimeout(() => setMessage(""), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [message]);

  useEffect(() => {
    if (!isDateUnlocked && activeShift?.businessDate) {
      setEntryDate(activeShift.businessDate);
    }
  }, [activeShift?.businessDate, isDateUnlocked]);

  useEffect(() => {
    if (entryDate) localStorage.setItem(ENTRY_DATE_KEY, entryDate);
  }, [entryDate]);

  useEffect(() => {
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
          snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        );
        setLoadingParties(false);
      },
      (reason) => {
        setLoadingParties(false);
        setError(reason?.message || "Failed to load parties.");
      }
    );
  }, [activeClientId]);

  useEffect(() => {
    if (!activeClientId || !entryDate || !showHistory) return undefined;
    setLoadingHistory(true);
    const historyQuery = query(
      collection(db, "payment_receipts"),
      where("clientId", "==", activeClientId),
      where("businessDate", "==", entryDate),
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
        setError(reason?.message || "Failed to load payment history.");
      }
    );
  }, [activeClientId, entryDate, showHistory]);

  const filteredHistory = useMemo(
    () => historyEntries.filter((entry) => entry.entryType === historyMode),
    [historyEntries, historyMode]
  );

  function selectParty(party) {
    setSelectedPartyId(party.id);
    setPartySearch(party.name || "");
    setPartyDropdownOpen(false);
  }

  async function handleQuickAddParty(event) {
    event.preventDefault();
    setError("");
    const cleanName = newPartyName.trim();
    const cleanContact = newPartyContact.trim();

    if (!activeClientId || !user?.uid) {
      setError("Select a shop and sign in before adding a party.");
      return;
    }
    if (!cleanName) {
      setError("Party name is required.");
      return;
    }

    setSavingParty(true);
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
      setNewPartyName("");
      setNewPartyContact("");
      setQuickAddOpen(false);
    } catch (reason) {
      setError(reason?.message || "Failed to create party.");
    } finally {
      setSavingParty(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setMessage("");

    const parsedAmount = Number(amount);
    const cleanPartyName = String(selectedParty?.name || "").trim();
    const cleanNote = note.trim();

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
    if (!selectedPartyId || !cleanPartyName) {
      setError("Select a party.");
      return;
    }
    if (!CATEGORIES.includes(category)) {
      setError("Select a valid category.");
      return;
    }
    if (!paymentModeOptions.some((option) => option.value === paymentMode)) {
      setError("Select a valid payment mode.");
      return;
    }
    if (resolvedPayment.paymentMode === "BANK" && !resolvedPayment.bankAccountId) {
      setError("Select a bank account for bank payments.");
      return;
    }
    if (!entryDate && !activeShift?.businessDate) {
      setError("Entry date is required.");
      return;
    }
    if (cashShiftUnavailable) {
      setError(
        `Open a shift before recording a cash ${entryMode}.`
      );
      return;
    }
    if (entryMode === "payment") {
      const fundsIssue = getInsufficientFundsError({
        mode: resolvedPayment.paymentMode,
        amount: parsedAmount,
        cashBalance,
        bankBalance,
      });
      if (fundsIssue) {
        setError(fundsIssue);
        return;
      }
    }

    const businessDate = isDateUnlocked
      ? entryDate
      : activeShift?.businessDate || entryDate;
    if (
      isCashTenderMode(resolvedPayment.paymentMode) &&
      activeShift?.businessDate &&
      businessDate !== activeShift.businessDate
    ) {
      setError(
        `Cash ${entryMode}s must use the active shift date. Unlock is for non-cash corrections only.`
      );
      return;
    }

    setSaving(true);
    try {
      const sourceRef = doc(collection(db, "payment_receipts"));
      const transactionRef = doc(collection(db, "transactions"));
      const shiftRef =
        isCashTenderMode(resolvedPayment.paymentMode)
          ? doc(db, "shifts", activeShift.id)
          : null;
      const shiftId = shiftRef ? activeShift.id : "";
      const amountIn = entryMode === "receipt" ? parsedAmount : 0;
      const amountOut = entryMode === "payment" ? parsedAmount : 0;

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

        transaction.set(sourceRef, {
          schemaVersion: 1,
          clientId: activeClientId,
          entryType: entryMode,
          amount: parsedAmount,
          partyId: selectedPartyId,
          partyName: cleanPartyName,
          category,
          paymentMode: resolvedPayment.paymentMode,
          bankAccountId: resolvedPayment.bankAccountId || "",
          bankAccountName: findBankAccountName(
            bankAccounts,
            resolvedPayment.bankAccountId
          ),
          liabilityType: category === "LOAN" ? "LOAN" : "",
          note: cleanNote,
          shiftId,
          businessDate,
          businessDateAt: toBusinessDate(businessDate),
          transactionId: transactionRef.id,
          status: "POSTED",
          createdBy: user.uid,
          createdAt: serverTimestamp(),
          createdAtMs: Date.now(),
        });

        transaction.set(transactionRef, {
          ...buildTransactionPayload({
            clientId: activeClientId,
            date: businessDate,
            type: entryMode,
            category,
            mode: resolvedPayment.paymentMode,
            bankAccountId: resolvedPayment.bankAccountId || "",
            bankAccountName: findBankAccountName(
              bankAccounts,
              resolvedPayment.bankAccountId
            ),
            partyType: selectedParty?.type || quickAddPartyType,
            partyId: selectedPartyId,
            partyName: cleanPartyName,
            description: cleanNote || `${category} ${entryMode}`,
            amountBeforeTax: parsedAmount,
            totalAmount: parsedAmount,
            amountIn,
            amountOut,
            status: "POSTED",
            source: "payment_receipt",
            refType: "payment_receipt",
            refId: sourceRef.id,
            shiftId,
          }),
          liabilityType: category === "LOAN" ? "LOAN" : "",
          createdBy: user.uid,
          createdAt: serverTimestamp(),
        });
      });

      setAmount("");
      setSelectedPartyId("");
      setPartySearch("");
      setNote("");
      clearDraft();
      setMessage(
        `${entryMode === "receipt" ? "Receipt" : "Payment"} recorded successfully.`
      );
    } catch (reason) {
      setError(reason?.message || `Failed to record ${entryMode}.`);
    } finally {
      setSaving(false);
    }
  }

  function openSavedEdit(entry) {
    setEditingSavedEntry(entry);
    setSavedEdit({
      entryType: entry.entryType || "receipt",
      amount: String(entry.amount ?? ""),
      partyId: entry.partyId || "",
      category: entry.category || "SETTLEMENT",
      paymentMode: paymentModeSelectionFromSaved(
        entry.paymentMode || "CASH",
        entry.bankAccountId
      ),
      note: entry.note || "",
      businessDate: entry.businessDate || entryDate || todayYYYYMMDD(),
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
    const parsedAmount = Number(savedEdit.amount);
    const selectedEditParty = parties.find(
      (party) => party.id === savedEdit.partyId
    );

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError("Amount must be greater than zero.");
      return;
    }
    if (!selectedEditParty) {
      setError("Select a valid party.");
      return;
    }
    if (!CATEGORIES.includes(savedEdit.category)) {
      setError("Select a valid category.");
      return;
    }
    const editPayment = parsePaymentModeSelection(savedEdit.paymentMode);
    const editOptions = buildPaymentModeOptions({
      bankAccounts,
      includePettyCash: true,
      ...legacyPaymentModeFlags(savedEdit.paymentMode),
    });
    if (!editOptions.some((option) => option.value === savedEdit.paymentMode)) {
      setError("Select a valid payment mode.");
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

    if (savedEdit.entryType === "payment") {
      const wasPayment = editingSavedEntry.entryType === "payment";
      const creditedCash =
        wasPayment && isCashTenderMode(editingSavedEntry.paymentMode)
          ? Number(editingSavedEntry.amount) || 0
          : 0;
      const creditedBank =
        wasPayment && isBankTenderMode(editingSavedEntry.paymentMode)
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

    const sourceRef = doc(db, "payment_receipts", editingSavedEntry.id);
    const transactionRef = doc(
      db,
      "transactions",
      editingSavedEntry.transactionId
    );
    const shiftRef = targetShiftId ? doc(db, "shifts", targetShiftId) : null;
    const amountIn = savedEdit.entryType === "receipt" ? parsedAmount : 0;
    const amountOut = savedEdit.entryType === "payment" ? parsedAmount : 0;
    const liabilityType = savedEdit.category === "LOAN" ? "LOAN" : "";

    setSavingHistory(true);
    try {
      await runTransaction(db, async (transaction) => {
        const [sourceSnap, txnSnap, shiftSnap] = await Promise.all([
          transaction.get(sourceRef),
          transaction.get(transactionRef),
          shiftRef ? transaction.get(shiftRef) : Promise.resolve(null),
        ]);

        if (
          !sourceSnap.exists() ||
          sourceSnap.data()?.clientId !== activeClientId
        ) {
          throw new Error("Payment/receipt entry no longer exists.");
        }
        if (
          !txnSnap.exists() ||
          txnSnap.data()?.clientId !== activeClientId ||
          txnSnap.data()?.refId !== sourceRef.id
        ) {
          throw new Error("The linked ledger transaction is invalid.");
        }
        if (
          shiftSnap &&
          (!shiftSnap.exists() ||
            shiftSnap.data()?.clientId !== activeClientId ||
            (!canReuseCashShift && shiftSnap.data()?.status !== "OPEN"))
        ) {
          throw new Error("The selected cash shift is invalid.");
        }

        transaction.update(sourceRef, {
          entryType: savedEdit.entryType,
          amount: parsedAmount,
          partyId: selectedEditParty.id,
          partyName: String(selectedEditParty.name || "").trim(),
          category: savedEdit.category,
          paymentMode: editPayment.paymentMode,
          bankAccountId: editPayment.bankAccountId || "",
          bankAccountName: findBankAccountName(
            bankAccounts,
            editPayment.bankAccountId
          ),
          liabilityType,
          note: String(savedEdit.note || "").trim(),
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
            bankAccountName: findBankAccountName(
              bankAccounts,
              editPayment.bankAccountId
            ),
            partyType: selectedEditParty.type || "Other",
            partyId: selectedEditParty.id,
            partyName: String(selectedEditParty.name || "").trim(),
            description:
              String(savedEdit.note || "").trim() ||
              `${savedEdit.category} ${savedEdit.entryType}`,
            amountBeforeTax: parsedAmount,
            totalAmount: parsedAmount,
            amountIn,
            amountOut,
            status: "POSTED",
            source: "payment_receipt",
            refType: "payment_receipt",
            refId: sourceRef.id,
            shiftId: targetShiftId,
          }),
          liabilityType,
          updatedBy: user.uid,
          updatedAt: serverTimestamp(),
        });
      });

      closeSavedEdit();
      setMessage("Saved payment/receipt entry updated successfully.");
    } catch (reason) {
      setError(reason?.message || "Failed to update the saved entry.");
    } finally {
      setSavingHistory(false);
    }
  }

  if (!activeClientId) {
    return <div className="text-slate-300">Select a shop to enter payments.</div>;
  }

  const isReceipt = entryMode === "receipt";

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-white">
                {isReceipt ? "Receipt (Money In)" : "Payment (Money Out)"}
              </h1>
              <p className="mt-1 text-sm text-slate-400">
                {activeClientData?.name || activeClientId}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ModuleHelpButton moduleId="payments-receipts" />
              <ModuleExitButton ariaLabel="Close payment and receipt entry" />
            </div>
          </div>
        </div>

        <div className={`${LABEL_CLASS} shrink-0 sm:text-right`}>
          {isReceipt ? "Receipt Date" : "Payment Date"}
          <div className="mt-1.5 w-[150px]">
            {isDateUnlocked ? (
              <DateInput
                required
                form="payment-receipt-entry-form"
                value={entryDate}
                onChange={(event) => setEntryDate(event.target.value)}
                className="h-[42px] w-full rounded-lg border border-amber-700/60 bg-slate-950 text-right text-white"
                aria-label={isReceipt ? "Receipt date" : "Payment date"}
              />
            ) : (
              <div className="rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-right text-white">
                {formatIsoDate(entryDate)}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setIsDateUnlocked((current) => {
                  const next = !current;
                  if (!next && activeShift?.businessDate) {
                    setEntryDate(activeShift.businessDate);
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
        id="payment-receipt-entry-form"
        onSubmit={handleSubmit}
        className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 sm:p-6"
      >
        <div className="mb-5 inline-flex rounded-full border border-slate-700 bg-slate-950 p-1">
          {[
            ["receipt", "Receipt"],
            ["payment", "Payment"],
          ].map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => {
                setEntryMode(mode);
                setSelectedPartyId("");
                setPartySearch("");
                setPartyDropdownOpen(false);
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
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className={FIELD_CLASS}
              placeholder="0.00"
            />
          </label>

          <div ref={partySelectorRef} className="relative">
            <label htmlFor="payment-receipt-party" className={LABEL_CLASS}>
              {isReceipt ? "Received From (Party)" : "Paid To (Party)"}
            </label>
            <div className="mt-1.5 flex gap-2">
              <div className="relative min-w-0 flex-1">
                <input
                  id="payment-receipt-party"
                  required
                  autoComplete="off"
                  value={partySearch}
                  onFocus={() => setPartyDropdownOpen(true)}
                  onChange={(event) => {
                    setPartySearch(event.target.value);
                    setSelectedPartyId("");
                    setPartyDropdownOpen(true);
                  }}
                  className={`${FIELD_CLASS} mt-0`}
                  placeholder={
                    loadingParties ? "Loading parties…" : "Search party"
                  }
                />

                {partyDropdownOpen ? (
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
                        No matching parties.
                      </div>
                    )}
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                onClick={() => {
                  setQuickAddOpen((current) => !current);
                  setPartyDropdownOpen(false);
                  setError("");
                }}
                className="inline-flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-white transition-all hover:border-blue-500 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
                aria-label="Quick add party"
                title="Quick add party"
              >
                <Plus className="h-5 w-5" />
              </button>
            </div>

            {quickAddOpen ? (
              <div className="absolute z-30 mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-white">Quick Add Party</div>
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
                      value={newPartyName}
                      onChange={(event) => setNewPartyName(event.target.value)}
                      className={FIELD_CLASS}
                      placeholder="Party name"
                    />
                  </label>
                  <label className={LABEL_CLASS}>
                    Contact
                    <input
                      value={newPartyContact}
                      onChange={(event) => setNewPartyContact(event.target.value)}
                      className={FIELD_CLASS}
                      placeholder="Phone or email"
                    />
                  </label>
                  <div className="text-xs text-slate-500">
                    Type: {quickAddPartyType}
                  </div>
                  <button
                    type="button"
                    disabled={savingParty}
                    onClick={handleQuickAddParty}
                    className="rounded-lg bg-white px-4 py-2 font-semibold text-slate-950 disabled:opacity-50"
                  >
                    {savingParty ? "Saving…" : "Save Party"}
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
              {CATEGORIES.map((value) => (
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
                setPaymentMode(event.target.value);
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
            Note
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              className={`${FIELD_CLASS} resize-y`}
              placeholder="Reference or payment details"
            />
          </label>

          <div className="col-span-full flex justify-end">
            <button
              type="submit"
              disabled={saving || loadingShift || showFundsBlock}
              className="rounded-lg bg-white px-5 py-2.5 font-semibold text-slate-950 transition-all hover:bg-blue-50 hover:shadow-lg hover:shadow-blue-950/20 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving
                ? "Saving…"
                : isReceipt
                  ? "Record Receipt"
                  : "Record Payment"}
            </button>
          </div>
        </div>
      </form>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-white">Saved Entry History</h2>
            <p className="mt-1 text-sm text-slate-400">
              Entries saved on {formatIsoDate(entryDate, "-")}
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
                ["receipt", "Receipt History"],
                ["payment", "Payment History"],
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
                      <td
                        colSpan={6}
                        className="px-4 py-8 text-center text-slate-500"
                      >
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
                          {entry.partyName || "-"}
                        </td>
                        <td className="px-4 py-3">{entry.category || "-"}</td>
                        <td className="whitespace-nowrap px-4 py-3">
                          {String(entry.paymentMode || "-").replaceAll("_", " ")}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-white">
                          {Number(entry.amount || 0).toFixed(2)}
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
                      <td
                        colSpan={6}
                        className="px-4 py-8 text-center text-slate-500"
                      >
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
                    onChange={(event) =>
                      setSavedEdit((current) => ({
                        ...current,
                        entryType: event.target.value,
                      }))
                    }
                    className={FIELD_CLASS}
                  >
                    <option value="receipt">Receipt</option>
                    <option value="payment">Payment</option>
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
                    step="0.01"
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
                    {parties.map((party) => (
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
                    {CATEGORIES.map((value) => (
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
                      ...legacyPaymentModeFlags(savedEdit.paymentMode),
                    }).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={`${LABEL_CLASS} sm:col-span-2`}>
                  Note
                  <textarea
                    rows={3}
                    value={savedEdit.note}
                    onChange={(event) =>
                      setSavedEdit((current) => ({
                        ...current,
                        note: event.target.value,
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
