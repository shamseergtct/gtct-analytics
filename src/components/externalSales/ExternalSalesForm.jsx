import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../context/AuthContext";
import { useBankAccounts } from "../../hooks/useBankAccounts.js";
import {
  formatMoney,
  moneyInputStep,
  numMoney,
  roundMoney,
  toMinorUnits,
} from "../../utils/money.js";
import { assertOperationalBankAccount } from "../../utils/bankAccountTypes.js";
import {
  buildPaymentModeOptions,
  findBankAccountName,
  parsePaymentModeSelection,
  paymentModeSelectionFromSaved,
} from "../../utils/paymentModes.js";
import {
  DELIVERY_ACCOUNT_PAYMENT,
  EXTERNAL_ENTRY_SOURCE_DELIVERY_APP,
  EXTERNAL_ENTRY_SOURCE_MANUAL,
  EXTERNAL_SALE_TYPES,
  SPLIT_PAYMENT,
  calculateDeliveryCommission,
  externalPaymentModeLabel,
  externalSaleTypeLabel,
  externalSalesBillDocId,
  getTerminalTheme,
  isDeliveryBoyAccountPayment,
  isDeliverySaleType,
  isValidTerminalColorId,
  normalizeBillNumber,
  normalizeExternalSaleType,
  sanitizeBillNumberInput,
  pickNextTerminalColorId,
  resolveDeliveryBoyCommission,
} from "../../utils/externalSales.js";
import { writeExternalSalesBill } from "../../utils/externalSalesBillWrite.js";
import { markDeliveryBillSubmissionApproved } from "../../utils/deliveryBillSubmissions.js";
import {
  buildDeliveryChargeSelectOptions,
  deliveryChargeSelectValue,
} from "../../utils/deliveryCharges.js";
import { useDeliveryChargeSettings } from "../../hooks/useDeliveryChargeSettings.js";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD_CLASS,
  FIELD_NUMBER_CLASS,
  LABEL_CLASS,
} from "./externalSalesUi.js";
import PaymentModeSearchSelect from "./PaymentModeSearchSelect.jsx";

const THEMED_FIELD_CLASS =
  "mt-1.5 h-11 w-full min-w-0 scroll-mt-52 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-[var(--term-accent)] focus:ring-2 focus:ring-[var(--term-ring)] disabled:cursor-not-allowed disabled:opacity-50";
const THEMED_FIELD_NUMBER_CLASS = `${THEMED_FIELD_CLASS} [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`;

function externalSalesStickyBottomOffset() {
  const sticky = document.querySelector("[data-external-sales-sticky]");
  if (sticky) {
    const rect = sticky.getBoundingClientRect();
    return rect.bottom + 12;
  }
  return 64 + 140;
}

function scrollBillFieldIntoView(element) {
  if (!element || typeof window === "undefined") return;
  const topInset = externalSalesStickyBottomOffset();
  const bottomInset = 16;
  const rect = element.getBoundingClientRect();
  if (rect.top < topInset) {
    window.scrollBy({
      top: rect.top - topInset,
      behavior: "smooth",
    });
  } else if (rect.bottom > window.innerHeight - bottomInset) {
    window.scrollBy({
      top: rect.bottom - window.innerHeight + bottomInset,
      behavior: "smooth",
    });
  }
}

function TerminalBillForm({
  clientId,
  currency,
  currencyDecimals,
  businessDate,
  terminal,
  terminalIndex = 0,
  theme,
  deliveryBoys,
  customers,
  paymentModeOptions,
  bankAccounts,
  onMessage,
  onError,
  onDirtyChange,
  onEditingBillIdChange,
  billToApply = null,
  onBillApplied,
}) {
  const { user } = useAuth();
  const billNumberRef = useRef(null);
  const lookupTokenRef = useRef(0);
  const formRef = useRef(null);

  const [billNumber, setBillNumber] = useState("");
  const [billAmount, setBillAmount] = useState("");
  const [saleType, setSaleType] = useState("DELIVERY");
  const [paymentMode, setPaymentMode] = useState(DELIVERY_ACCOUNT_PAYMENT);
  const [multiPayment, setMultiPayment] = useState(false);
  const [splitCash, setSplitCash] = useState("");
  const [splitBank, setSplitBank] = useState("");
  const [splitBankAccountId, setSplitBankAccountId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [customerLocation, setCustomerLocation] = useState("");
  const [deliveryBoyId, setDeliveryBoyId] = useState("");
  const [deliveryCharge, setDeliveryCharge] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [existingMeta, setExistingMeta] = useState(null);
  const [pendingApprovalSubmissionId, setPendingApprovalSubmissionId] =
    useState("");
  const [pendingApprovalEntryLocalId, setPendingApprovalEntryLocalId] =
    useState("");
  const [pendingApprovalCreatedAtMs, setPendingApprovalCreatedAtMs] =
    useState(null);
  const [pendingApprovalApprovedBillId, setPendingApprovalApprovedBillId] =
    useState("");
  const [pendingApprovalIsEditReview, setPendingApprovalIsEditReview] =
    useState(false);
  const [localError, setLocalError] = useState("");
  const [localMessage, setLocalMessage] = useState("");
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [chargeReady, setChargeReady] = useState(false);
  /** Approval double-check: OK near payment / charge when non-default. */
  const [approvalPaymentOk, setApprovalPaymentOk] = useState(false);
  const [approvalChargeOk, setApprovalChargeOk] = useState(false);

  const approvalMode = Boolean(pendingApprovalSubmissionId);
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
    [
      deliveryChargeOptions,
      currencyDecimals,
      currency,
      deliveryCharge,
    ]
  );

  const activeBoys = useMemo(
    () => deliveryBoys.filter((row) => row.isActive !== false),
    [deliveryBoys]
  );
  const boyOptions = useMemo(() => {
    if (!deliveryBoyId) return activeBoys;
    if (activeBoys.some((row) => row.id === deliveryBoyId)) return activeBoys;
    const inactive = deliveryBoys.find((row) => row.id === deliveryBoyId);
    return inactive ? [...activeBoys, inactive] : activeBoys;
  }, [activeBoys, deliveryBoys, deliveryBoyId]);

  const deliveryMode = isDeliverySaleType(saleType);
  const selectedBoy = useMemo(
    () => boyOptions.find((row) => row.id === deliveryBoyId) || null,
    [boyOptions, deliveryBoyId]
  );
  const effectivePaymentOptions = useMemo(() => {
    if (!deliveryMode) return paymentModeOptions;
    const deliveryLabel =
      String(selectedBoy?.name || "").trim() || "Delivery";
    return [
      {
        value: DELIVERY_ACCOUNT_PAYMENT,
        label: deliveryLabel,
      },
      ...paymentModeOptions,
    ];
  }, [deliveryMode, paymentModeOptions, selectedBoy?.name]);
  const resolvedPayment = parsePaymentModeSelection(paymentMode);
  const isCredit = !multiPayment && resolvedPayment.paymentMode === "CREDIT";
  const needsApprovalPaymentOk =
    approvalMode &&
    deliveryMode &&
    (multiPayment || paymentMode !== DELIVERY_ACCOUNT_PAYMENT);
  const needsApprovalChargeOk =
    approvalMode &&
    deliveryMode &&
    String(deliveryCharge ?? "") !== String(defaultChargeValue ?? "");
  const approvalChecksReady =
    (!needsApprovalPaymentOk || approvalPaymentOk) &&
    (!needsApprovalChargeOk || approvalChargeOk);
  const splitCashNum = numMoney(splitCash);
  const splitBankNum = numMoney(splitBank);
  const splitRemaining = roundMoney(
    numMoney(billAmount) - splitCashNum - splitBankNum,
    currencyDecimals
  );
  const commission = resolveDeliveryBoyCommission(selectedBoy);
  const resolvedTheme = theme || getTerminalTheme(terminal, terminalIndex);
  const fieldClass = theme ? THEMED_FIELD_CLASS : FIELD_CLASS;
  const fieldNumberClass = theme ? THEMED_FIELD_NUMBER_CLASS : FIELD_NUMBER_CLASS;

  useEffect(() => {
    if (!localMessage) return undefined;
    const timeoutId = window.setTimeout(() => setLocalMessage(""), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [localMessage]);

  // Focus Bill Number whenever this terminal form mounts (terminal select / switch).
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      billNumberRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [terminal?.id]);

  // Keep focused fields visible below the sticky External Sales toolbar (mobile keyboards).
  useEffect(() => {
    const root = formRef.current;
    if (!root) return undefined;

    function onFocusIn(event) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.matches("input, select, textarea")) return;
      window.requestAnimationFrame(() => {
        scrollBillFieldIntoView(target);
        window.setTimeout(() => scrollBillFieldIntoView(target), 280);
      });
    }

    root.addEventListener("focusin", onFocusIn);
    return () => root.removeEventListener("focusin", onFocusIn);
  }, [terminal?.id]);

  useEffect(() => {
    if (chargeSettingsLoading || chargeReady) return;
    setDeliveryCharge(defaultChargeValue);
    setChargeReady(true);
  }, [chargeSettingsLoading, chargeReady, defaultChargeValue]);

  useEffect(() => {
    if (!onDirtyChange) return undefined;
    // Delivery boy is intentionally kept after a successful save for faster
    // next-bill entry — that alone must not count as unsaved work.
    const dirty = Boolean(
      String(billNumber || "").trim() ||
        String(billAmount || "").trim() ||
        String(customerLocation || "").trim() ||
        (chargeReady && deliveryCharge !== defaultChargeValue) ||
        String(notes || "").trim() ||
        String(customerId || "").trim() ||
        multiPayment ||
        editMode ||
        approvalMode ||
        saleType !== "DELIVERY" ||
        (isDeliverySaleType(saleType)
          ? paymentMode !== DELIVERY_ACCOUNT_PAYMENT
          : paymentMode !== "CASH")
    );
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [
    billNumber,
    billAmount,
    customerLocation,
    deliveryCharge,
    defaultChargeValue,
    chargeReady,
    notes,
    customerId,
    multiPayment,
    editMode,
    approvalMode,
    saleType,
    paymentMode,
    onDirtyChange,
  ]);

  const liveCommission = useMemo(() => {
    return calculateDeliveryCommission({
      saleType,
      deliveryCharge,
      commissionEnabled: commission.enabled,
      commissionRate: commission.rate,
      decimals: currencyDecimals,
    });
  }, [
    saleType,
    deliveryCharge,
    commission.enabled,
    commission.rate,
    currencyDecimals,
  ]);

  function resetEditState() {
    setEditMode(false);
    setExistingMeta(null);
  }

  function clearApprovalState() {
    setPendingApprovalSubmissionId("");
    setPendingApprovalEntryLocalId("");
    setPendingApprovalCreatedAtMs(null);
    setPendingApprovalApprovedBillId("");
    setPendingApprovalIsEditReview(false);
    setApprovalPaymentOk(false);
    setApprovalChargeOk(false);
  }

  useEffect(() => {
    setApprovalPaymentOk(false);
  }, [paymentMode, multiPayment]);

  useEffect(() => {
    setApprovalChargeOk(false);
  }, [deliveryCharge]);

  function clearBillFields({ keepDeliveryBoy = false } = {}) {
    setBillNumber("");
    setBillAmount("");
    setCustomerLocation("");
    setDeliveryCharge(defaultChargeValue);
    setNotes("");
    setCustomerId("");
    setPaymentMode(DELIVERY_ACCOUNT_PAYMENT);
    setMultiPayment(false);
    setSplitCash("");
    setSplitBank("");
    setSplitBankAccountId("");
    setSaleType("DELIVERY");
    resetEditState();
    clearApprovalState();
    setLocalError("");
    onEditingBillIdChange?.(null);
    if (!keepDeliveryBoy) setDeliveryBoyId("");
    window.setTimeout(() => billNumberRef.current?.focus(), 0);
  }

  function formHasClearableEntry() {
    return Boolean(
      String(billNumber || "").trim() ||
        String(billAmount || "").trim() ||
        String(customerLocation || "").trim() ||
        (chargeReady && deliveryCharge !== defaultChargeValue) ||
        String(notes || "").trim() ||
        String(customerId || "").trim() ||
        String(deliveryBoyId || "").trim() ||
        multiPayment ||
        editMode ||
        approvalMode ||
        saleType !== "DELIVERY" ||
        (isDeliverySaleType(saleType)
          ? paymentMode !== DELIVERY_ACCOUNT_PAYMENT
          : paymentMode !== "CASH")
    );
  }

  function requestClearForm() {
    if (!formHasClearableEntry()) {
      clearBillFields({ keepDeliveryBoy: deliveryMode });
      return;
    }
    setClearConfirmOpen(true);
  }

  function confirmClearForm() {
    clearBillFields({ keepDeliveryBoy: deliveryMode });
    setClearConfirmOpen(false);
  }

  function enableMultiPayment() {
    setMultiPayment(true);
    setCustomerId("");
    const amount = numMoney(billAmount);
    if (amount > 0 && !splitCash && !splitBank) {
      setSplitCash(formatMoney(amount, currencyDecimals));
      setSplitBank(formatMoney(0, currencyDecimals));
    }
    if (!splitBankAccountId && bankAccounts[0]?.id) {
      setSplitBankAccountId(bankAccounts[0].id);
    }
    if (
      paymentMode === DELIVERY_ACCOUNT_PAYMENT ||
      parsePaymentModeSelection(paymentMode).paymentMode === "CREDIT"
    ) {
      setPaymentMode("CASH");
    }
  }

  function disableMultiPayment() {
    setMultiPayment(false);
    setSplitCash("");
    setSplitBank("");
    setSplitBankAccountId("");
  }

  function applyExistingBill(bill, { asApproval = false } = {}) {
    setBillNumber(bill.billNumber || "");
    setBillAmount(
      bill.billAmount === 0 || bill.billAmount
        ? formatMoney(bill.billAmount, currencyDecimals)
        : ""
    );
    const type = normalizeExternalSaleType(bill.saleType) || "DELIVERY";
    setSaleType(type);
    const savedMode = String(bill.paymentMode || "").trim().toUpperCase();
    if (savedMode === SPLIT_PAYMENT || savedMode === "SPLIT") {
      setMultiPayment(true);
      setSplitCash(
        formatMoney(numMoney(bill.paidCash), currencyDecimals)
      );
      setSplitBank(
        formatMoney(numMoney(bill.paidBank), currencyDecimals)
      );
      setSplitBankAccountId(String(bill.bankAccountId || "").trim());
      setPaymentMode("CASH");
    } else if (
      type === "DELIVERY" &&
      (!savedMode || savedMode === DELIVERY_ACCOUNT_PAYMENT)
    ) {
      setMultiPayment(false);
      setSplitCash("");
      setSplitBank("");
      setSplitBankAccountId("");
      setPaymentMode(DELIVERY_ACCOUNT_PAYMENT);
    } else {
      setMultiPayment(false);
      setSplitCash("");
      setSplitBank("");
      setSplitBankAccountId("");
      setPaymentMode(
        paymentModeSelectionFromSaved(
          savedMode || "CASH",
          bill.bankAccountId || ""
        )
      );
    }
    setCustomerId(bill.customerId || "");
    setCustomerLocation(
      bill.customerLocation || bill.customerName || ""
    );
    setDeliveryBoyId(bill.deliveryBoyId || "");
    setDeliveryCharge(
      deliveryChargeSelectValue(bill.deliveryCharge, currencyDecimals)
    );
    setNotes(bill.notes || "");
    setLocalError("");
    setLocalMessage("");

    if (asApproval || bill.__approvalSubmissionId) {
      resetEditState();
      setApprovalPaymentOk(false);
      setApprovalChargeOk(false);
      setPendingApprovalSubmissionId(
        String(bill.__approvalSubmissionId || bill.id || "").trim()
      );
      setPendingApprovalEntryLocalId(
        String(bill.entryLocalId || "").trim()
      );
      setPendingApprovalCreatedAtMs(
        bill.createdAtMs != null ? Number(bill.createdAtMs) : null
      );
      setPendingApprovalApprovedBillId(
        String(bill.__approvedBillId || bill.approvedBillId || "").trim()
      );
      setPendingApprovalIsEditReview(Boolean(bill.__isEditReview));
      onEditingBillIdChange?.(null);
      return;
    }

    clearApprovalState();
    setExistingMeta({
      createdAt: bill.createdAt || null,
      createdAtMs: bill.createdAtMs || null,
      createdBy: bill.createdBy || null,
    });
    setEditMode(true);
    onEditingBillIdChange?.(bill.id || null);
  }

  useEffect(() => {
    if (!billToApply || billToApply.terminalId !== terminal?.id) return;
    applyExistingBill(billToApply, {
      asApproval: Boolean(billToApply.__approvalSubmissionId),
    });
    onBillApplied?.();
    window.setTimeout(() => {
      billNumberRef.current?.focus();
      if (formRef.current) scrollBillFieldIntoView(formRef.current);
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apply when parent sends bill once
  }, [billToApply, terminal?.id]);

  async function lookupExistingBill() {
    // During delivery-bill approval, keep the pending submission draft intact.
    if (approvalMode) return;

    setLocalError("");
    const date = String(businessDate || "").trim();
    const billNo = normalizeBillNumber(billNumber);
    if (!clientId || !terminal?.id || !date || !billNo) {
      if (editMode) resetEditState();
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;

    const token = ++lookupTokenRef.current;
    setLookingUp(true);
    try {
      const docId = externalSalesBillDocId({
        clientId,
        businessDate: date,
        terminalId: terminal.id,
        billNumber: billNo,
      });
      const snap = await getDoc(doc(db, "external_sales_bills", docId));
      if (token !== lookupTokenRef.current) return;

      if (!snap.exists() || snap.data()?.voided === true) {
        if (editMode) resetEditState();
        return;
      }

      const bill = { id: snap.id, ...snap.data() };
      const currencyPrefix = currency ? `${currency} ` : "";
      const summary = [
        `Bill ${bill.billNumber} already exists on ${terminal.name}.`,
        `Amount: ${currencyPrefix}${formatMoney(bill.billAmount, currencyDecimals)}`,
        `Type: ${externalSaleTypeLabel(bill.saleType)}`,
        `Payment: ${externalPaymentModeLabel(bill)}`,
        bill.customerName ? `Customer: ${bill.customerName}` : null,
        bill.deliveryBoyNameSnapshot
          ? `Delivery boy: ${bill.deliveryBoyNameSnapshot}`
          : null,
        "",
        "Load this bill for editing?",
      ]
        .filter((line) => line !== null)
        .join("\n");

      const accept = window.confirm(summary);
      if (token !== lookupTokenRef.current) return;
      if (!accept) {
        resetEditState();
        setBillNumber("");
        window.setTimeout(() => billNumberRef.current?.focus(), 0);
        return;
      }

      applyExistingBill(bill);
      setLocalMessage("Existing bill loaded. Edit details and save to update.");
    } catch (reason) {
      if (token !== lookupTokenRef.current) return;
      setLocalError(reason?.message || "Failed to check existing bill.");
    } finally {
      if (token === lookupTokenRef.current) setLookingUp(false);
    }
  }

  async function handleSave(event) {
    event.preventDefault();
    if (approvalMode && !approvalChecksReady) {
      return;
    }
    setLocalError("");
    onError?.("");

    if (!clientId) {
      setLocalError("Select an active shop first.");
      return;
    }
    if (!user?.uid) {
      setLocalError("You must be signed in.");
      return;
    }
    if (!terminal?.id) {
      setLocalError("Terminal is missing.");
      return;
    }

    const date = String(businessDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setLocalError("Business date is required.");
      return;
    }

    const billNo = normalizeBillNumber(billNumber);
    if (!billNo) {
      setLocalError("Bill number must be a whole number (e.g. 1, 2, 3).");
      return;
    }
    if (billNo !== billNumber) setBillNumber(billNo);

    if (billAmount === "" || billAmount === null || billAmount === undefined) {
      setLocalError("Bill amount is required.");
      return;
    }
    const amountNum = numMoney(billAmount);
    // Negative amounts are allowed for cash returns (e.g. bank overpay returned as cash).
    if (!Number.isFinite(Number(billAmount)) || !Number.isFinite(amountNum)) {
      setLocalError("Bill amount must be a valid number.");
      return;
    }

    const type = normalizeExternalSaleType(saleType);
    if (!type) {
      setLocalError("Sale type is required.");
      return;
    }

    let savedPaymentMode = resolvedPayment.paymentMode;
    let bankAccountId = "";
    let bankAccountNameSnapshot = "";
    let customerPartyId = "";
    let customerName = "";
    const freeCustomerName = String(customerLocation || "").trim();
    let paidCash = 0;
    let paidBank = 0;

    if (multiPayment) {
      if (amountNum <= 0) {
        setLocalError(
          "Multiple payment is only available for positive bill amounts."
        );
        return;
      }
      paidCash = roundMoney(splitCashNum, currencyDecimals);
      paidBank = roundMoney(splitBankNum, currencyDecimals);
      if (paidCash <= 0 || paidBank <= 0) {
        setLocalError(
          "Enter both cash and bank amounts greater than zero for multiple payment."
        );
        return;
      }
      if (
        toMinorUnits(paidCash + paidBank, currencyDecimals) !==
        toMinorUnits(amountNum, currencyDecimals)
      ) {
        setLocalError(
          `Cash + bank must equal bill amount (${formatMoney(
            amountNum,
            currencyDecimals
          )}).`
        );
        return;
      }
      bankAccountId = String(splitBankAccountId || "").trim();
      if (!bankAccountId) {
        setLocalError("Select a bank account for the bank portion.");
        return;
      }
      {
        const bankCheck = assertOperationalBankAccount(
          bankAccounts,
          bankAccountId
        );
        if (!bankCheck.ok) {
          setLocalError(bankCheck.message);
          return;
        }
      }
      bankAccountNameSnapshot = findBankAccountName(bankAccounts, bankAccountId);
      if (!bankAccountNameSnapshot) {
        setLocalError("Selected bank account is not available.");
        return;
      }
      savedPaymentMode = SPLIT_PAYMENT;
    } else if (type === "DELIVERY" && paymentMode === DELIVERY_ACCOUNT_PAYMENT) {
      savedPaymentMode = DELIVERY_ACCOUNT_PAYMENT;
    } else {
      if (
        !effectivePaymentOptions.some((option) => option.value === paymentMode)
      ) {
        setLocalError("Select a valid payment mode.");
        return;
      }
      if (resolvedPayment.paymentMode === "BANK") {
        bankAccountId = String(resolvedPayment.bankAccountId || "").trim();
        if (!bankAccountId) {
          setLocalError("Select a saved bank account.");
          return;
        }
        {
          const bankCheck = assertOperationalBankAccount(
            bankAccounts,
            bankAccountId
          );
          if (!bankCheck.ok) {
            setLocalError(bankCheck.message);
            return;
          }
        }
        bankAccountNameSnapshot = findBankAccountName(
          bankAccounts,
          bankAccountId
        );
        if (!bankAccountNameSnapshot) {
          setLocalError("Selected bank account is not available.");
          return;
        }
        savedPaymentMode = "BANK";
      } else if (resolvedPayment.paymentMode === "CREDIT") {
        const customer = customers.find((row) => row.id === customerId);
        if (!customer) {
          setLocalError("Credit requires selecting a customer.");
          return;
        }
        customerPartyId = customer.id;
        customerName = String(customer.name || "").trim();
        if (!customerName) {
          setLocalError("Selected customer has no name.");
          return;
        }
        savedPaymentMode = "CREDIT";
      } else if (resolvedPayment.paymentMode === "CASH") {
        savedPaymentMode = "CASH";
      } else {
        setLocalError(
          "Payment mode must be the delivery boy, Cash, a bank account, or Credit."
        );
        return;
      }
    }

    let boy = null;
    let chargeNum = 0;
    if (type === "DELIVERY") {
      boy = boyOptions.find((row) => row.id === deliveryBoyId);
      if (!boy) {
        setLocalError("Delivery boy is required for Delivery sales.");
        return;
      }
      if (
        deliveryCharge === "" ||
        deliveryCharge === null ||
        deliveryCharge === undefined
      ) {
        chargeNum = 0;
      } else {
        chargeNum = numMoney(deliveryCharge);
        if (!Number.isFinite(Number(deliveryCharge)) || chargeNum < 0) {
          setLocalError("Delivery charge must be a non-negative number.");
          return;
        }
      }
    }

    if (!customerName && type === "DELIVERY" && freeCustomerName) {
      customerName = freeCustomerName;
    }

    setSaving(true);
    try {
      const result = await writeExternalSalesBill({
        userUid: user.uid,
        clientId,
        currency: currency || "",
        currencyDecimals,
        businessDate: date,
        terminal,
        billNumber: billNo,
        billAmount: amountNum,
        saleType: type,
        paymentMode: savedPaymentMode,
        bankAccounts,
        bankAccountId,
        bankAccountNameSnapshot,
        paidCash,
        paidBank,
        customerId: customerPartyId,
        customerName,
        customerLocation: freeCustomerName,
        deliveryBoy: boy,
        deliveryCharge: chargeNum,
        notes: String(notes || "").trim(),
        entrySource: approvalMode
          ? EXTERNAL_ENTRY_SOURCE_DELIVERY_APP
          : EXTERNAL_ENTRY_SOURCE_MANUAL,
        entryLocalId: approvalMode ? pendingApprovalEntryLocalId : "",
        createdAtMs: approvalMode ? pendingApprovalCreatedAtMs : undefined,
        editMode: approvalMode
          ? Boolean(pendingApprovalApprovedBillId)
          : editMode,
        existingMeta: approvalMode
          ? pendingApprovalApprovedBillId
            ? {
                createdAtMs: pendingApprovalCreatedAtMs,
                createdBy: null,
              }
            : null
          : existingMeta,
      });

      if (approvalMode && pendingApprovalSubmissionId) {
        await markDeliveryBillSubmissionApproved({
          submissionId: pendingApprovalSubmissionId,
          userUid: user.uid,
          approvedBillId: result.docId || pendingApprovalApprovedBillId,
        });
      }

      const ok = approvalMode
        ? pendingApprovalIsEditReview
          ? `Re-checked & updated bill ${billNo} · ${terminal.name}`
          : `Approved & saved bill ${billNo} · ${terminal.name}`
        : editMode
          ? `Bill updated successfully · ${terminal.name}`
          : `Bill saved successfully · ${terminal.name}`;
      setLocalMessage(ok);
      onMessage?.(ok);
      clearBillFields({ keepDeliveryBoy: type === "DELIVERY" });
    } catch (reason) {
      const text = reason?.message || "Failed to save bill.";
      setLocalError(text);
      onError?.(text);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSave}
      style={{
        "--term-accent": resolvedTheme.accent,
        "--term-tint": resolvedTheme.tint,
        "--term-border": resolvedTheme.border,
        "--term-ring": resolvedTheme.ring,
        "--term-chip": resolvedTheme.chip,
        "--term-accent-soft": resolvedTheme.accentSoft,
      }}
      className={`flex h-full min-w-0 flex-col space-y-3 rounded-2xl border p-3 transition-[border-color,background-color,box-shadow] duration-200 sm:space-y-4 sm:p-4 ${
        editMode || approvalMode
          ? "border-amber-700/70 bg-[color:var(--term-tint)] shadow-[inset_0_0_0_1px_rgba(245,158,11,0.25)]"
          : "border-[color:var(--term-border)] bg-[color:var(--term-tint)] shadow-[0_0_0_1px_var(--term-chip)]"
      }`}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-[color:var(--term-border)] pb-3">
        <div className="min-w-0">
          <h2 className="flex min-w-0 items-center gap-2 truncate text-base font-semibold text-white sm:text-lg">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: resolvedTheme.accent }}
              aria-hidden="true"
            />
            <span className="truncate">{terminal.name}</span>
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Terminal {String(terminalIndex + 1).padStart(2, "0")}
            {approvalMode ? (
              <span className="text-amber-300">
                {pendingApprovalIsEditReview
                  ? " · Re-checking edited delivery bill"
                  : " · Approving delivery bill"}
              </span>
            ) : editMode ? (
              <span className="text-amber-300"> · Editing existing bill</span>
            ) : null}
          </p>
        </div>
        <span
          className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white"
          style={{ backgroundColor: resolvedTheme.accentSoft, color: resolvedTheme.accent }}
        >
          {approvalMode
            ? pendingApprovalIsEditReview
              ? "Re-check"
              : "Approve"
            : "Bill Entry"}
        </span>
      </div>

      {approvalMode ? (
        <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 p-2.5 text-sm text-amber-100">
          {pendingApprovalIsEditReview
            ? "Delivery boy edited this approved bill. Re-check amount, customer, payment mode, and delivery charge, then save."
            : "Review and edit amount, customer, payment mode, and delivery charge, then click Approve & Save."}
          <div className="mt-2">
            <button
              type="button"
              onClick={() => clearBillFields()}
              className={BTN_SECONDARY}
            >
              Cancel approval
            </button>
          </div>
        </div>
      ) : null}

      {editMode ? (
        <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 p-2.5 text-sm text-amber-100">
          Bill already exists. Review the details below, then click{" "}
          <span className="font-semibold">Update Bill</span>, or cancel editing.
          <div className="mt-2">
            <button
              type="button"
              onClick={() => clearBillFields()}
              className={BTN_SECONDARY}
            >
              Cancel edit
            </button>
          </div>
        </div>
      ) : null}

      {localError ? (
        <div className="rounded-xl border border-red-900 bg-red-950/30 p-2.5 text-sm text-red-200">
          {localError}
        </div>
      ) : null}
      {localMessage ? (
        <div className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-2.5 text-sm text-emerald-200">
          {localMessage}
        </div>
      ) : null}

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className={LABEL_CLASS}>
          Bill Number
          <input
            ref={billNumberRef}
            required
            inputMode="numeric"
            pattern="[0-9]*"
            value={billNumber}
            onChange={(event) => {
              setBillNumber(sanitizeBillNumberInput(event.target.value));
              if (editMode) resetEditState();
            }}
            onBlur={() => {
              const cleaned = normalizeBillNumber(billNumber);
              if (cleaned !== billNumber) setBillNumber(cleaned);
              void lookupExistingBill();
            }}
            className={fieldClass}
            placeholder="e.g. 1"
            autoComplete="off"
          />
          {lookingUp ? (
            <span className="mt-1 block text-[11px] text-slate-500">
              Checking bill number…
            </span>
          ) : null}
        </label>

        <label className={LABEL_CLASS}>
          Bill Amount {currency ? `(${currency})` : ""}
          <input
            required
            type="number"
            step={moneyInputStep(currencyDecimals)}
            value={billAmount}
            onChange={(event) => setBillAmount(event.target.value)}
            className={fieldNumberClass}
            placeholder={formatMoney(0, currencyDecimals)}
          />
        </label>

        <label className={LABEL_CLASS}>
          Sale Type
          <select
            required
            value={saleType}
            onChange={(event) => {
              const next = event.target.value;
              setSaleType(next);
              if (isDeliverySaleType(next)) {
                setPaymentMode(DELIVERY_ACCOUNT_PAYMENT);
              } else {
                setPaymentMode("CASH");
                setCustomerId("");
              }
            }}
            className={fieldClass}
          >
            {EXTERNAL_SALE_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <div className={LABEL_CLASS}>
          <span className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2">
              Payment Mode
              {needsApprovalPaymentOk && approvalPaymentOk ? (
                <span className="rounded-md bg-emerald-600/90 px-1.5 py-0.5 text-[10px] font-bold text-white">
                  ✓
                </span>
              ) : null}
            </span>
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-normal normal-case tracking-normal text-slate-400">
              <input
                type="checkbox"
                checked={multiPayment}
                onChange={(event) => {
                  if (event.target.checked) enableMultiPayment();
                  else disableMultiPayment();
                }}
                className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-500/40"
              />
              Multiple payment
            </label>
          </span>

          <div
            className={
              needsApprovalPaymentOk && !approvalPaymentOk
                ? "relative mt-1 rounded-xl ring-2 ring-amber-400/70"
                : "mt-1"
            }
          >
            {multiPayment ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">
                    Cash
                    <input
                      required
                      type="number"
                      min="0"
                      step={moneyInputStep(currencyDecimals)}
                      value={splitCash}
                      onChange={(event) => setSplitCash(event.target.value)}
                      className={fieldNumberClass}
                      placeholder={formatMoney(0, currencyDecimals)}
                    />
                  </label>
                  <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">
                    Bank
                    <input
                      required
                      type="number"
                      min="0"
                      step={moneyInputStep(currencyDecimals)}
                      value={splitBank}
                      onChange={(event) => setSplitBank(event.target.value)}
                      className={fieldNumberClass}
                      placeholder={formatMoney(0, currencyDecimals)}
                    />
                  </label>
                </div>
                <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">
                  Bank Account
                  <select
                    required
                    value={splitBankAccountId}
                    onChange={(event) =>
                      setSplitBankAccountId(event.target.value)
                    }
                    className={fieldClass}
                  >
                    <option value="">Select bank account…</option>
                    {bankAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.accountName || account.name || "Bank"}
                      </option>
                    ))}
                  </select>
                </label>
                <div
                  className={`text-[11px] ${
                    splitRemaining === 0
                      ? "text-emerald-400"
                      : "text-amber-300"
                  }`}
                >
                  Remaining: {currency ? `${currency} ` : ""}
                  {formatMoney(splitRemaining, currencyDecimals)}
                </div>
              </div>
            ) : (
              <PaymentModeSearchSelect
                required
                options={effectivePaymentOptions}
                value={paymentMode}
                onChange={(next) => {
                  setPaymentMode(next);
                  if (
                    next === DELIVERY_ACCOUNT_PAYMENT ||
                    parsePaymentModeSelection(next).paymentMode !== "CREDIT"
                  ) {
                    setCustomerId("");
                  }
                }}
                inputClassName={fieldClass}
                placeholder="Search cash, credit, bank…"
              />
            )}
            {needsApprovalPaymentOk && !approvalPaymentOk ? (
              <button
                type="button"
                onClick={() => setApprovalPaymentOk(true)}
                className="absolute -right-1 -top-3 z-10 rounded-full bg-amber-400 px-3 py-1 text-xs font-bold text-slate-950 shadow-lg ring-2 ring-amber-200"
              >
                OK
              </button>
            ) : null}
          </div>
        </div>

        {isCredit ? (
          <label className={`${LABEL_CLASS} sm:col-span-2`}>
            Customer Name
            <select
              required
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
              className={fieldClass}
            >
              <option value="">Select customer…</option>
              {customers.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                  {row.phone || row.mobile ? ` · ${row.phone || row.mobile}` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {deliveryMode ? (
          <>
            <label className={`${LABEL_CLASS} sm:col-span-2`}>
              Customer
              <input
                value={customerLocation}
                onChange={(event) => setCustomerLocation(event.target.value)}
                className={fieldClass}
                placeholder="Customer name or location"
              />
            </label>
            <label className={LABEL_CLASS}>
              Delivery Boy
              <select
                required
                value={deliveryBoyId}
                onChange={(event) => setDeliveryBoyId(event.target.value)}
                className={fieldClass}
              >
                <option value="">Select delivery boy…</option>
                {boyOptions.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                    {row.isActive === false ? " (inactive)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className={LABEL_CLASS}>
              <span className="inline-flex items-center gap-2">
                Delivery Charge {currency ? `(${currency})` : ""}
                {needsApprovalChargeOk && approvalChargeOk ? (
                  <span className="rounded-md bg-emerald-600/90 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    ✓
                  </span>
                ) : null}
              </span>
              <div
                className={
                  needsApprovalChargeOk && !approvalChargeOk
                    ? "relative mt-1 rounded-xl ring-2 ring-amber-400/70"
                    : "mt-1"
                }
              >
                <select
                  value={deliveryCharge}
                  onChange={(event) => setDeliveryCharge(event.target.value)}
                  className={fieldClass}
                >
                  {chargeSelectOptions.map((row) => (
                    <option key={row.value || "none"} value={row.value}>
                      {row.label}
                    </option>
                  ))}
                </select>
                {needsApprovalChargeOk && !approvalChargeOk ? (
                  <button
                    type="button"
                    onClick={() => setApprovalChargeOk(true)}
                    className="absolute -right-1 -top-3 z-10 rounded-full bg-amber-400 px-3 py-1 text-xs font-bold text-slate-950 shadow-lg ring-2 ring-amber-200"
                  >
                    OK
                  </button>
                ) : null}
              </div>
            </div>
          </>
        ) : null}

        <label className={`${LABEL_CLASS} sm:col-span-2`}>
          Notes
          <input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className={fieldClass}
            placeholder="Optional"
          />
        </label>
      </div>

      {deliveryMode ? (
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-xs text-slate-300">
          Commission
          {selectedBoy ? ` · ${selectedBoy.name}` : ""}:{" "}
          <span className="font-semibold text-white">
            {currency ? `${currency} ` : ""}
            {formatMoney(liveCommission.commissionAmount, currencyDecimals)}
          </span>
          {!selectedBoy
            ? " (select delivery boy)"
            : commission.enabled
              ? ` (${commission.rate}%)`
              : " (off)"}
        </div>
      ) : null}

      {isCredit && !customers.length ? (
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-2.5 text-xs text-amber-100">
          No customers found. Add a Customer party first to use Credit.
        </div>
      ) : null}

      <div className="mt-auto flex flex-col gap-2 pt-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <button
          type="submit"
          disabled={
            saving ||
            lookingUp ||
            (isCredit && !customers.length) ||
            (approvalMode && !approvalChecksReady)
          }
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:brightness-110 disabled:opacity-50 sm:w-auto"
          style={{ backgroundColor: resolvedTheme.accent }}
        >
          {saving
            ? approvalMode
              ? pendingApprovalIsEditReview
                ? "Updating…"
                : "Approving…"
              : editMode
                ? "Updating…"
                : "Saving…"
            : approvalMode
              ? pendingApprovalIsEditReview
                ? "Re-check & Save"
                : "Approve & Save"
              : editMode
                ? "Update Bill"
                : "Save Bill"}
        </button>
        <button
          type="button"
          onClick={requestClearForm}
          className="w-full py-2 text-center text-sm font-medium text-slate-400 hover:text-slate-200 sm:w-auto sm:py-0 sm:text-left"
        >
          Clear
        </button>
      </div>

      {clearConfirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="clear-bill-title"
            aria-describedby="clear-bill-desc"
            className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
          >
            <h3
              id="clear-bill-title"
              className="text-lg font-semibold text-white"
            >
              Clear bill entry?
            </h3>
            <p id="clear-bill-desc" className="mt-2 text-sm text-slate-300">
              This will remove the entered details for{" "}
              <span className="font-semibold text-white">
                {terminal.name}
              </span>
              . This cannot be undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setClearConfirmOpen(false)}
                className={BTN_SECONDARY}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmClearForm}
                className={BTN_PRIMARY}
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}

function billSortMs(bill) {
  const updated = Number(bill?.updatedAtMs);
  const created = Number(bill?.createdAtMs);
  if (Number.isFinite(updated) && updated > 0) return updated;
  if (Number.isFinite(created) && created > 0) return created;
  return 0;
}

function terminalDisplayForBill(bill, terminals) {
  const index = terminals.findIndex((row) => row.id === bill.terminalId);
  const row = index >= 0 ? terminals[index] : null;
  return {
    name: bill.terminalNameSnapshot || row?.name || "Terminal",
    theme: getTerminalTheme(row || {}, index >= 0 ? index : 0),
  };
}

/** Compact payment/party label for the recent-bills list (UI only). */
function recentBillPartyLabel(bill) {
  if (isDeliveryBoyAccountPayment(bill)) {
    return (
      String(bill?.deliveryBoyNameSnapshot || "").trim() || "Delivery"
    );
  }
  const mode = String(bill?.paymentMode || "")
    .trim()
    .toUpperCase();
  if (mode === SPLIT_PAYMENT || mode === "SPLIT") {
    const bankName = String(bill?.bankAccountNameSnapshot || "").trim();
    return bankName ? `Cash + ${bankName}` : "Cash + Bank";
  }
  if (mode === "BANK") {
    return String(bill?.bankAccountNameSnapshot || "").trim() || "Bank";
  }
  if (mode === "CREDIT") {
    return String(bill?.customerName || "").trim() || "Credit";
  }
  if (mode === "CASH" || !mode) return "Cash";
  return mode;
}

function submissionToBillDraft(submission) {
  if (!submission) return null;
  const edited =
    String(submission.status || "").trim() === "EDITED_PENDING";
  return {
    id: submission.id,
    terminalId: submission.terminalId,
    billNumber: submission.billNumber,
    billAmount: submission.billAmount,
    saleType: submission.saleType || "DELIVERY",
    paymentMode: submission.paymentMode,
    bankAccountId: submission.bankAccountId || "",
    bankAccountNameSnapshot: submission.bankAccountNameSnapshot || "",
    customerId: submission.customerId || "",
    customerName: submission.customerName || "",
    customerLocation: submission.customerLocation || "",
    deliveryBoyId: submission.deliveryBoyId || "",
    deliveryCharge: submission.deliveryCharge,
    notes: submission.notes || "",
    entryLocalId: submission.entryLocalId || "",
    createdAtMs: submission.createdAtMs || null,
    approvedBillId: submission.approvedBillId || "",
    __approvalSubmissionId: submission.id,
    __approvedBillId: submission.approvedBillId || "",
    __isEditReview: edited,
  };
}

export default function ExternalSalesForm({
  clientId,
  currency,
  currencyDecimals,
  businessDate,
  terminals,
  deliveryBoys,
  bills = [],
  loadingBills = false,
  toolbarPortalEl = null,
  approvalSubmission = null,
  onApprovalSubmissionConsumed,
  onMessage,
  onError,
}) {
  const { user } = useAuth();
  const { accounts: bankAccounts } = useBankAccounts(clientId);
  const [customers, setCustomers] = useState([]);
  const [selectedTerminalId, setSelectedTerminalId] = useState("");
  const [formDirty, setFormDirty] = useState(false);
  const [pendingTerminalId, setPendingTerminalId] = useState("");
  const [pendingListBill, setPendingListBill] = useState(null);
  const [billToApply, setBillToApply] = useState(null);
  const [editingBillId, setEditingBillId] = useState(null);
  const colorBackfillRef = useRef(new Set());
  const effectiveBusinessDate = businessDate || "";

  const activeTerminals = useMemo(
    () => terminals.filter((row) => row.isActive !== false),
    [terminals]
  );

  const paymentModeOptions = useMemo(
    () =>
      buildPaymentModeOptions({
        bankAccounts,
        includeCredit: true,
      }),
    [bankAccounts]
  );

  const selectedTerminal = useMemo(
    () =>
      activeTerminals.find((row) => row.id === selectedTerminalId) ||
      activeTerminals[0] ||
      null,
    [activeTerminals, selectedTerminalId]
  );

  const selectedTerminalIndex = useMemo(() => {
    if (!selectedTerminal) return 0;
    const index = activeTerminals.findIndex(
      (row) => row.id === selectedTerminal.id
    );
    return index >= 0 ? index : 0;
  }, [activeTerminals, selectedTerminal]);

  const selectedTheme = useMemo(
    () => getTerminalTheme(selectedTerminal, selectedTerminalIndex),
    [selectedTerminal, selectedTerminalIndex]
  );

  const recentBills = useMemo(() => {
    return bills
      .filter((bill) => bill?.voided !== true)
      .slice()
      .sort((a, b) => billSortMs(b) - billSortMs(a));
  }, [bills]);

  const currencyPrefix = currency ? `${currency} ` : "";

  useEffect(() => {
    if (!clientId) return undefined;
    const partiesQuery = query(
      collection(db, "parties"),
      where("clientId", "==", clientId),
      orderBy("name", "asc")
    );
    return onSnapshot(
      partiesQuery,
      (snapshot) => {
        const rows = snapshot.docs
          .map((item) => ({ id: item.id, ...item.data() }))
          .filter((party) => party.type === "Customer" || party.type === "Both");
        setCustomers(rows);
      },
      () => setCustomers([])
    );
  }, [clientId]);

  // Keep selection valid when terminals load / change.
  useEffect(() => {
    if (!activeTerminals.length) {
      setSelectedTerminalId("");
      return;
    }
    if (
      selectedTerminalId &&
      activeTerminals.some((row) => row.id === selectedTerminalId)
    ) {
      return;
    }
    setSelectedTerminalId(activeTerminals[0].id);
  }, [activeTerminals, selectedTerminalId]);

  // Approve from banner → open that terminal form with editable draft.
  useEffect(() => {
    if (!approvalSubmission?.id) return;
    const draft = submissionToBillDraft(approvalSubmission);
    if (!draft?.terminalId) {
      onError?.("This delivery bill has no terminal to open.");
      onApprovalSubmissionConsumed?.();
      return;
    }
    const terminalExists = activeTerminals.some(
      (row) => row.id === draft.terminalId
    );
    if (!terminalExists) {
      onError?.(
        `Terminal “${approvalSubmission.terminalNameSnapshot || draft.terminalId}” is not available.`
      );
      onApprovalSubmissionConsumed?.();
      return;
    }
    setFormDirty(false);
    setPendingListBill(null);
    setPendingTerminalId("");
    setSelectedTerminalId(draft.terminalId);
    setBillToApply(draft);
    onApprovalSubmissionConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apply once per submission handoff
  }, [approvalSubmission]);

  // Persist missing terminal colors once (backward compatible).
  useEffect(() => {
    if (!clientId || !user?.uid || !terminals.length) return undefined;

    const missing = terminals.filter(
      (row) =>
        row?.id &&
        !isValidTerminalColorId(row.color) &&
        !colorBackfillRef.current.has(row.id)
    );
    if (!missing.length) return undefined;

    let cancelled = false;
    const usedSeed = terminals.filter((row) => isValidTerminalColorId(row.color));

    (async () => {
      const assigned = [...usedSeed];
      for (const row of missing) {
        if (cancelled) return;
        colorBackfillRef.current.add(row.id);
        const color = pickNextTerminalColorId(assigned);
        assigned.push({ color });
        try {
          await updateDoc(doc(db, "billing_terminals", row.id), {
            clientId: row.clientId || clientId,
            name: row.name || "",
            isActive: row.isActive !== false,
            color,
            updatedAt: serverTimestamp(),
            updatedAtMs: Date.now(),
            updatedBy: user.uid,
          });
        } catch {
          colorBackfillRef.current.delete(row.id);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clientId, terminals, user?.uid]);

  function requestSelectTerminal(nextId) {
    if (!nextId || nextId === selectedTerminal?.id) return;
    if (!formDirty) {
      setSelectedTerminalId(nextId);
      setPendingTerminalId("");
      return;
    }
    setPendingTerminalId(nextId);
  }

  function confirmSwitchTerminal() {
    if (!pendingTerminalId) return;
    setSelectedTerminalId(pendingTerminalId);
    setPendingTerminalId("");
    setFormDirty(false);
  }

  function cancelSwitchTerminal() {
    setPendingTerminalId("");
  }

  function performLoadBillFromList(bill) {
    if (!bill?.id) return;
    setFormDirty(false);
    setPendingListBill(null);
    if (bill.terminalId && bill.terminalId !== selectedTerminal?.id) {
      setSelectedTerminalId(bill.terminalId);
    }
    setBillToApply(bill);
  }

  function requestLoadBillFromList(bill) {
    if (!bill?.id) return;
    if (formDirty) {
      setPendingListBill(bill);
      return;
    }
    performLoadBillFromList(bill);
  }

  // Alt+1 … Alt+9 selects terminals in Setup order (skips while typing in fields).
  useEffect(() => {
    function onKeyDown(event) {
      if (pendingTerminalId || pendingListBill) return;
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const match = String(event.code || "").match(/^Digit([1-9])$/);
      if (!match) return;
      const index = Number(match[1]) - 1;
      const terminal = activeTerminals[index];
      if (!terminal) return;
      event.preventDefault();
      requestSelectTerminal(terminal.id);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTerminals, pendingTerminalId, selectedTerminal?.id, formDirty]);

  if (!activeTerminals.length) {
    return (
      <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-4 text-sm text-amber-100">
        Add at least one active billing terminal in Setup before entering bills.
      </div>
    );
  }

  const pendingTerminal =
    activeTerminals.find((row) => row.id === pendingTerminalId) || null;

  const terminalSelector = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Terminal
        </div>
        <div className="text-[11px] text-slate-500">
          Shortcut: Alt+1…{Math.min(activeTerminals.length, 9)}
        </div>
      </div>
      <div
        className="flex min-w-0 gap-2 overflow-x-auto overscroll-x-contain pb-0.5"
        role="tablist"
        aria-label="Billing terminal"
      >
        {activeTerminals.map((terminal, index) => {
          const theme = getTerminalTheme(terminal, index);
          const selected = terminal.id === selectedTerminal?.id;
          const shortcut = index < 9 ? String(index + 1) : "";
          return (
            <button
              key={terminal.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-keyshortcuts={shortcut ? `Alt+${shortcut}` : undefined}
              title={
                shortcut
                  ? `${terminal.name} (Alt+${shortcut})`
                  : terminal.name
              }
              onClick={() => requestSelectTerminal(terminal.id)}
              className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold whitespace-nowrap transition-[border-color,background-color,color,box-shadow] duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--term-ring)] ${
                selected
                  ? "text-white shadow-sm"
                  : "border-slate-800 bg-slate-900/80 text-slate-300 hover:bg-slate-800"
              }`}
              style={
                selected
                  ? {
                      "--term-ring": theme.ring,
                      backgroundColor: theme.accentSoft,
                      borderColor: theme.border,
                      boxShadow: `inset 0 0 0 1px ${theme.chip}`,
                    }
                  : {
                      "--term-ring": theme.ring,
                    }
              }
            >
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: theme.accent }}
                aria-hidden="true"
              />
              <span className="truncate">{terminal.name}</span>
              {shortcut ? (
                <kbd className="rounded-md border border-slate-700/80 bg-slate-950/70 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400">
                  {shortcut}
                </kbd>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="mx-auto min-w-0 w-full max-w-3xl space-y-4">
      {toolbarPortalEl
        ? createPortal(terminalSelector, toolbarPortalEl)
        : null}

      {selectedTerminal ? (
        <TerminalBillForm
          key={selectedTerminal.id}
          clientId={clientId}
          currency={currency}
          currencyDecimals={currencyDecimals}
          businessDate={effectiveBusinessDate}
          terminal={selectedTerminal}
          terminalIndex={selectedTerminalIndex}
          theme={selectedTheme}
          deliveryBoys={deliveryBoys}
          customers={customers}
          paymentModeOptions={paymentModeOptions}
          bankAccounts={bankAccounts}
          onMessage={onMessage}
          onError={onError}
          onDirtyChange={setFormDirty}
          onEditingBillIdChange={setEditingBillId}
          billToApply={
            billToApply?.terminalId === selectedTerminal?.id ? billToApply : null
          }
          onBillApplied={() => setBillToApply(null)}
        />
      ) : null}

      <section
        className="rounded-2xl border border-slate-800 bg-slate-900/40 p-3 sm:p-4"
        aria-label="Bills entered today"
      >
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-white">
            Bills entered today
          </h3>
          <span className="text-xs text-slate-500">Newest first · tap to edit</span>
        </div>
        {loadingBills ? (
          <p className="py-4 text-center text-sm text-slate-500">Loading bills…</p>
        ) : recentBills.length ? (
          <ul className="max-h-64 space-y-1.5 overflow-y-auto overscroll-y-contain">
            {recentBills.map((bill) => {
              const { name: terminalName, theme } = terminalDisplayForBill(
                bill,
                terminals
              );
              const selected = bill.id === editingBillId;
              const deliveryChargeValue = numMoney(bill.deliveryCharge);
              return (
                <li key={bill.id}>
                  <button
                    type="button"
                    onClick={() => requestLoadBillFromList(bill)}
                    className={`flex w-full min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${
                      selected
                        ? "border-[color:var(--row-border)] bg-[color:var(--row-tint)]"
                        : "border-slate-800/80 bg-slate-950/50 hover:border-slate-700 hover:bg-slate-900/80"
                    }`}
                    style={
                      selected
                        ? {
                            "--row-border": theme.border,
                            "--row-tint": theme.tint,
                          }
                        : undefined
                    }
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: theme.accent }}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium text-white">
                      {terminalName}
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-300">
                      #{bill.billNumber}
                    </span>
                    <span className="shrink-0 tabular-nums font-semibold text-slate-200">
                      {currencyPrefix}
                      {formatMoney(bill.billAmount, currencyDecimals)}
                    </span>
                    <span className="shrink-0 tabular-nums text-xs text-slate-400">
                      DC {currencyPrefix}
                      {formatMoney(deliveryChargeValue, currencyDecimals)}
                    </span>
                    <span className="min-w-0 max-w-[9rem] shrink-0 truncate text-xs text-slate-400 sm:max-w-[12rem]">
                      {recentBillPartyLabel(bill)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="py-4 text-center text-sm text-slate-500">
            No bills saved for this business date yet.
          </p>
        )}
      </section>

      {pendingTerminal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="unsaved-terminal-title"
            aria-describedby="unsaved-terminal-desc"
            className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
          >
            <h3
              id="unsaved-terminal-title"
              className="text-lg font-semibold text-white"
            >
              Unsaved bill information
            </h3>
            <p id="unsaved-terminal-desc" className="mt-2 text-sm text-slate-300">
              You have unsaved information for{" "}
              <span className="font-semibold text-white">
                {selectedTerminal?.name || "this terminal"}
              </span>
              . Switch to{" "}
              <span className="font-semibold text-white">
                {pendingTerminal.name}
              </span>{" "}
              without saving?
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelSwitchTerminal}
                className={BTN_SECONDARY}
              >
                Stay
              </button>
              <button
                type="button"
                onClick={confirmSwitchTerminal}
                className={BTN_PRIMARY}
              >
                Switch
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingListBill ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="load-bill-title"
            aria-describedby="load-bill-desc"
            className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
          >
            <h3 id="load-bill-title" className="text-lg font-semibold text-white">
              Unsaved bill information
            </h3>
            <p id="load-bill-desc" className="mt-2 text-sm text-slate-300">
              You have unsaved information on{" "}
              <span className="font-semibold text-white">
                {selectedTerminal?.name || "this terminal"}
              </span>
              . Load bill{" "}
              <span className="font-semibold text-white">
                #{pendingListBill.billNumber}
              </span>{" "}
              for editing without saving?
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingListBill(null)}
                className={BTN_SECONDARY}
              >
                Stay
              </button>
              <button
                type="button"
                onClick={() => performLoadBillFromList(pendingListBill)}
                className={BTN_PRIMARY}
              >
                Load bill
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
