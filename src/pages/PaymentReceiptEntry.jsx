import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import {
  Eye,
  EyeOff,
  Lock,
  Pencil,
  Plus,
  Printer,
  Unlock,
  X,
} from "lucide-react";
import { db } from "../firebase";
import { useAuth } from "../context/AuthContext";
import { useClient } from "../context/ClientContext";
import { useShift, useUnsavedWork } from "../context/shift-context";
import {
  buildTransactionPayload,
  toBusinessDate,
} from "../utils/transactionContract";
import { openHtmlPrintWindow } from "../utils/openPrintWindow.js";
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
import { assertOperationalBankAccount } from "../utils/bankAccountTypes.js";
import {
  buildPaymentModeOptions,
  findBankAccountName,
  legacyPaymentModeFlags,
  parsePaymentModeSelection,
  paymentModeSelectionFromSaved,
} from "../utils/paymentModes.js";
import { formatMoney, moneyInputStep, roundMoney } from "../utils/money.js";
import { partyAllowedForPaymentReceipt } from "../utils/partyEntryFilters.js";
import {
  computePartyBalances,
  resolveFormPartyBalance,
} from "../utils/partyBalance.js";

const CATEGORIES = ["SETTLEMENT", "ADVANCE", "LOAN", "OTHER"];
const ENTRY_DATE_KEY = "gtct_payment_receipt_entry_date";
const LABEL_CLASS = "block text-xs font-medium uppercase tracking-wide text-slate-400";
const FIELD_CLASS =
  "mt-1.5 h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-50";
const FIELD_NUMBER_CLASS = `${FIELD_CLASS} [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`;

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
  const {
    initialDraft,
    syncDraft,
    clearDraft,
    readDraft,
    markDraftHydrated,
  } = useFormDraft(draftKey, {
    label: "Payments & Receipts",
    path: "/payments-receipts",
    moduleId: "payments",
  });
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
  const [partyBalances, setPartyBalances] = useState(null);
  const [loadingPartyBalance, setLoadingPartyBalance] = useState(false);

  const selectedParty = useMemo(
    () => parties.find((party) => party.id === selectedPartyId) || null,
    [parties, selectedPartyId]
  );

  const formPartyBalance = useMemo(
    () =>
      resolveFormPartyBalance({
        balances: partyBalances,
        entryMode,
        category,
        amount,
      }),
    [partyBalances, entryMode, category, amount]
  );

  const filteredParties = useMemo(() => {
    const search = partySearch.trim().toLowerCase();
    return parties
      .filter((party) => {
        if (!partyAllowedForPaymentReceipt(party, entryMode)) return false;
        if (!search) return true;
        return `${party.name || ""} ${party.type || ""} ${party.contact || ""}`
          .toLowerCase()
          .includes(search);
      })
      .sort((a, b) => {
        const preferredTypes =
          entryMode === "receipt"
            ? new Set(["customer", "both", "lender", "owner", "partner"])
            : new Set([
                "employee",
                "supplier",
                "vendor",
                "both",
                "lender",
                "owner",
                "partner",
              ]);
        const aRank = preferredTypes.has(String(a.type || "").toLowerCase())
          ? 0
          : 1;
        const bRank = preferredTypes.has(String(b.type || "").toLowerCase())
          ? 0
          : 1;
        return (
          aRank - bRank ||
          String(a.name || "").localeCompare(String(b.name || ""))
        );
      })
      .slice(0, 25);
  }, [entryMode, parties, partySearch]);

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

  const paymentDraftKeyRef = useRef(null);
  useLayoutEffect(() => {
    const isFirst = paymentDraftKeyRef.current === null;
    const keyChanged = paymentDraftKeyRef.current !== draftKey;
    paymentDraftKeyRef.current = draftKey;
    if (isFirst) {
      markDraftHydrated();
      return;
    }
    if (!keyChanged) return;
    const d = readDraft() || {};
    setEntryMode(d.entryMode ?? "receipt");
    setEntryDate(
      d.entryDate || localStorage.getItem(ENTRY_DATE_KEY) || todayYYYYMMDD()
    );
    setIsDateUnlocked(Boolean(d.isDateUnlocked));
    setAmount(d.amount ?? "");
    setCategory(d.category ?? "SETTLEMENT");
    setPaymentMode(d.paymentMode ?? "CASH");
    setNote(d.note ?? "");
    setSelectedPartyId(d.selectedPartyId ?? "");
    setPartySearch(d.partySearch ?? "");
    setQuickAddOpen(false);
    markDraftHydrated();
  }, [draftKey, readDraft, markDraftHydrated]);

  useEffect(() => {
    syncDraft(
      {
        entryMode,
        entryDate,
        isDateUnlocked,
        amount,
        category,
        paymentMode,
        note,
        selectedPartyId,
        partySearch,
      },
      { dirty: hasUnsavedPaymentWork }
    );
  }, [
    syncDraft,
    hasUnsavedPaymentWork,
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
    if (!activeClientId || !selectedPartyId) {
      setPartyBalances(null);
      setLoadingPartyBalance(false);
      return undefined;
    }

    setLoadingPartyBalance(true);
    const partyTxnQuery = query(
      collection(db, "transactions"),
      where("clientId", "==", activeClientId),
      where("partyId", "==", selectedPartyId),
      orderBy("date", "desc"),
      limit(1000)
    );

    return onSnapshot(
      partyTxnQuery,
      (snapshot) => {
        const rows = snapshot.docs.map((item) => ({
          id: item.id,
          ...item.data(),
        }));
        setPartyBalances(computePartyBalances(rows));
        setLoadingPartyBalance(false);
      },
      () => {
        setPartyBalances({ receivable: 0, payable: 0, loanOutstanding: 0 });
        setLoadingPartyBalance(false);
      }
    );
  }, [activeClientId, selectedPartyId]);

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

  function printPaymentReceiptSlip({
    businessDate,
    parsedAmount,
    partyName,
    modeLabel,
    balanceBefore,
    balanceAfter,
    balanceLabel,
  }) {
    const escapeHtml = (value) =>
      String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    const shopName = escapeHtml(activeClientData?.name || activeClientId || "Shop");
    const title = entryMode === "receipt" ? "Receipt" : "Payment";
    const currency = escapeHtml(
      String(activeClientData?.currency || "").toUpperCase()
    );
    const noteText = note.trim();
    const html = `<!doctype html>
<html>
  <head>
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; color: #111; margin: 24px; }
      h1 { font-size: 18px; margin: 0 0 4px; }
      .muted { color: #555; font-size: 12px; margin-bottom: 16px; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      td { padding: 6px 0; vertical-align: top; }
      td:last-child { text-align: right; font-weight: 600; }
      .line { border-top: 1px dashed #999; margin: 14px 0; }
      .total { font-size: 16px; font-weight: 800; }
    </style>
  </head>
  <body>
    <h1>${shopName}</h1>
    <div class="muted">${title} · ${escapeHtml(formatIsoDate(businessDate) || businessDate)}</div>
    <table>
      <tr><td>Party</td><td>${escapeHtml(partyName)}</td></tr>
      <tr><td>Category</td><td>${escapeHtml(category)}</td></tr>
      <tr><td>Mode</td><td>${escapeHtml(modeLabel)}</td></tr>
      <tr><td>${escapeHtml(balanceLabel)} (before)</td><td>${formatMoney(balanceBefore)} ${currency}</td></tr>
      <tr class="total"><td>Amount</td><td>${formatMoney(parsedAmount)} ${currency}</td></tr>
      <tr><td>${escapeHtml(balanceLabel)} (after)</td><td>${formatMoney(balanceAfter)} ${currency}</td></tr>
    </table>
    ${noteText ? `<div class="line"></div><div class="muted">Note: ${escapeHtml(noteText)}</div>` : ""}
    <div class="line"></div>
    <div class="muted">Thank you</div>
    <script>
      window.onload = function () {
        window.focus();
        window.print();
      };
    </script>
  </body>
</html>`;
    try {
      openHtmlPrintWindow(html, { width: 480, height: 720, autoPrint: true });
    } catch {
      setError("Pop-up blocked. Allow pop-ups to print the receipt.");
    }
  }

  async function saveEntry({ doPrint = false } = {}) {
    setError("");
    setMessage("");

    const parsedAmount = roundMoney(amount);
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
    if (resolvedPayment.paymentMode === "BANK" && resolvedPayment.bankAccountId) {
      const bankCheck = assertOperationalBankAccount(
        bankAccounts,
        resolvedPayment.bankAccountId
      );
      if (!bankCheck.ok) {
        setError(bankCheck.message);
        return;
      }
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

    const balanceBefore = formPartyBalance.current;
    const balanceAfter = formPartyBalance.after;
    const balanceLabel = formPartyBalance.label;
    const modeLabel =
      paymentModeOptions.find((option) => option.value === paymentMode)?.label ||
      paymentMode;

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

      if (doPrint) {
        printPaymentReceiptSlip({
          businessDate,
          parsedAmount,
          partyName: cleanPartyName,
          modeLabel,
          balanceBefore,
          balanceAfter,
          balanceLabel,
        });
      }

      setAmount("");
      setSelectedPartyId("");
      setPartySearch("");
      setNote("");
      clearDraft();
      setMessage(
        `${entryMode === "receipt" ? "Receipt" : "Payment"} ${
          doPrint ? "saved and sent to print." : "saved successfully."
        }`
      );
    } catch (reason) {
      setError(reason?.message || `Failed to record ${entryMode}.`);
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    await saveEntry({ doPrint: false });
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
    const parsedAmount = roundMoney(savedEdit.amount);
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
    if (editPayment.paymentMode === "BANK" && editPayment.bankAccountId) {
      const bankCheck = assertOperationalBankAccount(
        bankAccounts,
        editPayment.bankAccountId
      );
      if (!bankCheck.ok) {
        setError(bankCheck.message);
        return;
      }
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
                {isReceipt ? "Receipt" : "Payment"}
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
                className="h-11 w-full rounded-xl border border-amber-700/60 bg-slate-950 text-right text-sm text-white"
                aria-label={isReceipt ? "Receipt date" : "Payment date"}
              />
            ) : (
              <div className="flex h-11 items-center justify-end rounded-xl border border-slate-700 bg-slate-950/80 px-3 text-sm text-white">
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
        className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 sm:p-6"
      >
        <div className="mb-6 inline-flex rounded-full border border-slate-700 bg-slate-950 p-1">
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

        <div className="space-y-5">
          {/* Party search + add + current balance — one aligned row */}
          <div ref={partySelectorRef} className="relative">
            <div className="grid grid-cols-1 gap-x-2 gap-y-1 sm:grid-cols-[minmax(0,1fr)_2.75rem_minmax(12rem,0.85fr)] sm:items-end">
              <label
                htmlFor="payment-receipt-party"
                className={`${LABEL_CLASS} sm:col-start-1`}
              >
                {isReceipt ? "Received from" : "Paid to"}
              </label>
              <span className="hidden sm:col-start-2 sm:block" aria-hidden />
              <p className={`${LABEL_CLASS} sm:col-start-3`}>Current balance</p>

              <div className="relative min-w-0 sm:col-start-1 sm:row-start-2">
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
                  className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/40"
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
                          className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-slate-800"
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
                      <div className="px-3 py-2 text-sm text-slate-500">
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
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center self-end rounded-xl border border-slate-700 bg-slate-950 text-slate-200 transition-colors hover:border-blue-500 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 sm:col-start-2 sm:row-start-2 sm:w-full"
                aria-label="Quick add party"
                title="Quick add party"
              >
                <Plus className="h-5 w-5" />
              </button>

              <div
                className={`flex h-11 min-w-0 items-center justify-between gap-3 rounded-xl border px-3 sm:col-start-3 sm:row-start-2 ${
                  selectedPartyId
                    ? "border-slate-700 bg-slate-950"
                    : "border-dashed border-slate-700 bg-slate-950/40"
                }`}
              >
                {!selectedPartyId ? (
                  <span className="truncate text-sm text-slate-500">
                    Select a party
                  </span>
                ) : loadingPartyBalance || !partyBalances ? (
                  <span className="text-sm text-slate-400">Loading…</span>
                ) : (
                  <>
                    <span className="min-w-0 truncate text-xs text-slate-400">
                      {formPartyBalance.label}
                    </span>
                    <span className="shrink-0 tabular-nums text-base font-semibold text-white">
                      {formatMoney(formPartyBalance.current)}
                      <span className="ml-1 text-xs font-medium text-slate-400">
                        {activeClientData?.currency || ""}
                      </span>
                    </span>
                  </>
                )}
              </div>
            </div>

            {quickAddOpen ? (
              <div className="absolute z-30 mt-2 w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-white">
                    Quick add party
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

                <div className="mt-3 grid grid-cols-1 gap-3">
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
                      onChange={(event) =>
                        setNewPartyContact(event.target.value)
                      }
                      className={FIELD_CLASS}
                      placeholder="Phone or email"
                    />
                  </label>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-slate-500">
                      Type: {quickAddPartyType}
                    </span>
                    <button
                      type="button"
                      disabled={savingParty}
                      onClick={handleQuickAddParty}
                      className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
                    >
                      {savingParty ? "Saving…" : "Save party"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* Amount, mode, category, note */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className={LABEL_CLASS}>
              Amount
              <input
                required
                type="number"
                min="0.01"
                step={moneyInputStep()}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                disabled={!selectedPartyId}
                className={FIELD_NUMBER_CLASS}
                placeholder="0.000"
              />
            </label>

            <label className={LABEL_CLASS}>
              Payment mode
              <select
                value={paymentMode}
                onChange={(event) => {
                  setPaymentMode(event.target.value);
                  setError("");
                  setMessage("");
                }}
                disabled={!selectedPartyId}
                className={FIELD_CLASS}
              >
                {paymentModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className={LABEL_CLASS}>
              Category
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                disabled={!selectedPartyId}
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
              Note
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                disabled={!selectedPartyId}
                className={FIELD_CLASS}
                placeholder="Reference or details"
              />
            </label>
          </div>

          {/* Balance after */}
          <div
            className={`flex min-h-11 items-center justify-between gap-3 rounded-xl border px-3 py-2.5 ${
              selectedPartyId && Number(amount) > 0
                ? "border-emerald-800/60 bg-emerald-950/25"
                : "border-slate-800 bg-slate-950/40"
            }`}
          >
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Balance after {isReceipt ? "receipt" : "payment"}
              </p>
              {selectedPartyId && Number(amount) > 0 ? (
                <p className="mt-0.5 truncate text-xs text-slate-400">
                  {formatMoney(formPartyBalance.current)} →{" "}
                  {formatMoney(formPartyBalance.after)}
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-slate-500">
                  Enter an amount to preview the new balance
                </p>
              )}
            </div>
            <p
              className={`shrink-0 tabular-nums text-lg font-semibold ${
                selectedPartyId && Number(amount) > 0
                  ? "text-emerald-100"
                  : "text-slate-600"
              }`}
            >
              {selectedPartyId && Number(amount) > 0
                ? formatMoney(formPartyBalance.after)
                : "—"}
              {selectedPartyId && Number(amount) > 0 ? (
                <span className="ml-1 text-xs font-medium text-emerald-300/70">
                  {activeClientData?.currency || ""}
                </span>
              ) : null}
            </p>
          </div>

          {/* Actions */}
          <div className="flex flex-col-reverse gap-2 border-t border-slate-800 pt-4 sm:flex-row sm:items-center sm:justify-end">
            <button
              type="submit"
              disabled={
                saving || loadingShift || showFundsBlock || !selectedPartyId
              }
              className="inline-flex h-11 items-center justify-center rounded-xl border border-slate-600 bg-slate-950 px-5 text-sm font-semibold text-slate-100 transition-colors hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving
                ? "Saving…"
                : isReceipt
                  ? "Save receipt"
                  : "Save payment"}
            </button>
            <button
              type="button"
              disabled={
                saving || loadingShift || showFundsBlock || !selectedPartyId
              }
              onClick={() => saveEntry({ doPrint: true })}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-white px-5 text-sm font-semibold text-slate-950 transition-colors hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Printer className="h-4 w-4" />
              {saving
                ? "Saving…"
                : isReceipt
                  ? "Print receipt"
                  : "Print payment"}
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
                      .filter((party) =>
                        partyAllowedForPaymentReceipt(
                          party,
                          savedEdit.entryType || entryMode
                        )
                      )
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
