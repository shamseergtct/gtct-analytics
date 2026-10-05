import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
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
} from "../../utils/money.js";
import {
  buildPaymentModeOptions,
  findBankAccountName,
  parsePaymentModeSelection,
  paymentModeSelectionFromSaved,
} from "../../utils/paymentModes.js";
import {
  DELIVERY_ACCOUNT_PAYMENT,
  EXTERNAL_ENTRY_SOURCE_MANUAL,
  EXTERNAL_SALE_TYPES,
  EXTERNAL_SALES_SOURCE,
  calculateDeliveryCommission,
  externalPaymentModeLabel,
  externalSaleTypeLabel,
  externalSalesBillDocId,
  isDeliverySaleType,
  normalizeBillNumber,
  normalizeExternalSaleType,
  resolveDeliveryBoyCommission,
} from "../../utils/externalSales.js";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD_CLASS,
  FIELD_NUMBER_CLASS,
  LABEL_CLASS,
} from "./externalSalesUi.js";

function TerminalBillForm({
  clientId,
  currency,
  currencyDecimals,
  businessDate,
  terminal,
  deliveryBoys,
  customers,
  paymentModeOptions,
  bankAccounts,
  onMessage,
  onError,
}) {
  const { user } = useAuth();
  const billNumberRef = useRef(null);
  const lookupTokenRef = useRef(0);

  const [billNumber, setBillNumber] = useState("");
  const [billAmount, setBillAmount] = useState("");
  const [saleType, setSaleType] = useState("DELIVERY");
  const [paymentMode, setPaymentMode] = useState(DELIVERY_ACCOUNT_PAYMENT);
  const [customerId, setCustomerId] = useState("");
  const [customerLocation, setCustomerLocation] = useState("");
  const [deliveryBoyId, setDeliveryBoyId] = useState("");
  const [deliveryCharge, setDeliveryCharge] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [existingMeta, setExistingMeta] = useState(null);
  const [localError, setLocalError] = useState("");
  const [localMessage, setLocalMessage] = useState("");

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
  const effectivePaymentOptions = useMemo(() => {
    if (!deliveryMode) return paymentModeOptions;
    return [
      {
        value: DELIVERY_ACCOUNT_PAYMENT,
        label: "Delivery Boy Account",
      },
      ...paymentModeOptions,
    ];
  }, [deliveryMode, paymentModeOptions]);
  const resolvedPayment = parsePaymentModeSelection(paymentMode);
  const isCredit = resolvedPayment.paymentMode === "CREDIT";
  const selectedBoy = useMemo(
    () => boyOptions.find((row) => row.id === deliveryBoyId) || null,
    [boyOptions, deliveryBoyId]
  );
  const commission = resolveDeliveryBoyCommission(selectedBoy);

  useEffect(() => {
    if (!localMessage) return undefined;
    const timeoutId = window.setTimeout(() => setLocalMessage(""), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [localMessage]);

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

  function clearBillFields({ keepDeliveryBoy = false } = {}) {
    setBillNumber("");
    setBillAmount("");
    setCustomerLocation("");
    setDeliveryCharge("");
    setNotes("");
    setCustomerId("");
    setPaymentMode(DELIVERY_ACCOUNT_PAYMENT);
    setSaleType("DELIVERY");
    resetEditState();
    setLocalError("");
    if (!keepDeliveryBoy) setDeliveryBoyId("");
    window.setTimeout(() => billNumberRef.current?.focus(), 0);
  }

  function applyExistingBill(bill) {
    setBillNumber(bill.billNumber || "");
    setBillAmount(
      bill.billAmount === 0 || bill.billAmount
        ? formatMoney(bill.billAmount, currencyDecimals)
        : ""
    );
    const type = normalizeExternalSaleType(bill.saleType) || "DELIVERY";
    setSaleType(type);
    const savedMode = String(bill.paymentMode || "").trim();
    if (type === "DELIVERY" && (!savedMode || savedMode === DELIVERY_ACCOUNT_PAYMENT)) {
      setPaymentMode(DELIVERY_ACCOUNT_PAYMENT);
    } else {
      setPaymentMode(
        paymentModeSelectionFromSaved(
          savedMode || "CASH",
          bill.bankAccountId || ""
        )
      );
    }
    setCustomerId(bill.customerId || "");
    setCustomerLocation(bill.customerLocation || "");
    setDeliveryBoyId(bill.deliveryBoyId || "");
    setDeliveryCharge(
      bill.deliveryCharge === 0 || bill.deliveryCharge
        ? formatMoney(bill.deliveryCharge, currencyDecimals)
        : ""
    );
    setNotes(bill.notes || "");
    setExistingMeta({
      createdAt: bill.createdAt || null,
      createdAtMs: bill.createdAtMs || null,
      createdBy: bill.createdBy || null,
    });
    setEditMode(true);
  }

  async function lookupExistingBill() {
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
      setLocalError("Bill number is required.");
      return;
    }
    if (!/^[\w./#-]+(?:\s[\w./#-]+)*$/i.test(billNo) || billNo.length > 40) {
      setLocalError("Bill number format is invalid.");
      return;
    }

    if (billAmount === "" || billAmount === null || billAmount === undefined) {
      setLocalError("Bill amount is required.");
      return;
    }
    const amountNum = numMoney(billAmount);
    if (!Number.isFinite(Number(billAmount)) || amountNum < 0) {
      setLocalError("Bill amount must be a non-negative number.");
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

    if (type === "DELIVERY" && paymentMode === DELIVERY_ACCOUNT_PAYMENT) {
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
          "Payment mode must be Delivery Boy Account, Cash, a bank account, or Credit."
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

    const boyCommission = resolveDeliveryBoyCommission(boy);
    const commissionSnap = calculateDeliveryCommission({
      saleType: type,
      deliveryCharge: chargeNum,
      commissionEnabled: boyCommission.enabled,
      commissionRate: boyCommission.rate,
      decimals: currencyDecimals,
    });

    const docId = externalSalesBillDocId({
      clientId,
      businessDate: date,
      terminalId: terminal.id,
      billNumber: billNo,
    });

    setSaving(true);
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "external_sales_bills", docId);
        const existing = await tx.get(ref);
        const existsActive =
          existing.exists() && existing.data()?.voided !== true;

        if (existsActive && !editMode) {
          throw new Error(
            `Bill ${billNo} already exists for ${terminal.name}. Leave the bill number field to load it for editing.`
          );
        }
        if (editMode && !existsActive) {
          throw new Error(
            `Bill ${billNo} is no longer available to edit. Clear and enter again.`
          );
        }

        const nowMs = Date.now();
        const wasVoided = existing.exists() && existing.data()?.voided === true;
        const preserveCreated =
          editMode || wasVoided
            ? {
                createdAt:
                  existing.data()?.createdAt ||
                  existingMeta?.createdAt ||
                  serverTimestamp(),
                createdAtMs:
                  existing.data()?.createdAtMs ||
                  existingMeta?.createdAtMs ||
                  nowMs,
                createdBy:
                  existing.data()?.createdBy ||
                  existingMeta?.createdBy ||
                  user.uid,
              }
            : {
                createdAt: serverTimestamp(),
                createdAtMs: nowMs,
                createdBy: user.uid,
              };

        const payload = {
          clientId,
          businessDate: date,
          terminalId: terminal.id,
          terminalNameSnapshot: terminal.name || "",
          billNumber: billNo,
          billAmount: roundMoney(amountNum, currencyDecimals),
          saleType: type,
          paymentMode: savedPaymentMode,
          bankAccountId,
          bankAccountNameSnapshot,
          customerId: customerPartyId,
          customerName,
          customerLocation: String(customerLocation || "").trim(),
          deliveryBoyId: type === "DELIVERY" ? boy.id : "",
          deliveryBoyNameSnapshot: type === "DELIVERY" ? boy.name || "" : "",
          deliveryCharge:
            type === "DELIVERY"
              ? roundMoney(chargeNum, currencyDecimals)
              : 0,
          commissionEnabled: commissionSnap.commissionEnabled,
          commissionRate: commissionSnap.commissionRate,
          commissionAmount: commissionSnap.commissionAmount,
          notes: String(notes || "").trim(),
          salesSource: EXTERNAL_SALES_SOURCE,
          entrySource: EXTERNAL_ENTRY_SOURCE_MANUAL,
          voided: false,
          currency: currency || "",
          ...preserveCreated,
          updatedAt: serverTimestamp(),
          updatedAtMs: nowMs,
          updatedBy: user.uid,
        };

        tx.set(ref, payload);
      });

      const ok = editMode
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
      onSubmit={handleSave}
      className={`flex h-full min-w-0 flex-col space-y-3 rounded-2xl border p-3 sm:space-y-4 sm:p-4 ${
        editMode
          ? "border-amber-700/70 bg-amber-950/10"
          : "border-slate-800 bg-slate-900/40"
      }`}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-slate-800 pb-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-white sm:text-lg">
            {terminal.name}
          </h2>
          {editMode ? (
            <p className="text-xs text-amber-300">Editing existing bill</p>
          ) : null}
        </div>
      </div>

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
            value={billNumber}
            onChange={(event) => {
              setBillNumber(event.target.value);
              if (editMode) resetEditState();
            }}
            onBlur={() => {
              void lookupExistingBill();
            }}
            className={FIELD_CLASS}
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
            min="0"
            step={moneyInputStep(currencyDecimals)}
            value={billAmount}
            onChange={(event) => setBillAmount(event.target.value)}
            className={FIELD_NUMBER_CLASS}
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
            className={FIELD_CLASS}
          >
            {EXTERNAL_SALE_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label className={LABEL_CLASS}>
          Payment Mode
          <select
            required
            value={paymentMode}
            onChange={(event) => {
              const next = event.target.value;
              setPaymentMode(next);
              if (
                next === DELIVERY_ACCOUNT_PAYMENT ||
                parsePaymentModeSelection(next).paymentMode !== "CREDIT"
              ) {
                setCustomerId("");
              }
            }}
            className={FIELD_CLASS}
          >
            {effectivePaymentOptions.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        {isCredit ? (
          <label className={`${LABEL_CLASS} sm:col-span-2`}>
            Customer Name
            <select
              required
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
              className={FIELD_CLASS}
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
              Customer / Location
              <input
                value={customerLocation}
                onChange={(event) => setCustomerLocation(event.target.value)}
                className={FIELD_CLASS}
                placeholder="Optional delivery location"
              />
            </label>
            <label className={LABEL_CLASS}>
              Delivery Boy
              <select
                required
                value={deliveryBoyId}
                onChange={(event) => setDeliveryBoyId(event.target.value)}
                className={FIELD_CLASS}
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
            <label className={LABEL_CLASS}>
              Delivery Charge {currency ? `(${currency})` : ""}
              <input
                type="number"
                min="0"
                step={moneyInputStep(currencyDecimals)}
                value={deliveryCharge}
                onChange={(event) => setDeliveryCharge(event.target.value)}
                className={FIELD_NUMBER_CLASS}
                placeholder={formatMoney(0, currencyDecimals)}
              />
            </label>
          </>
        ) : null}

        <label className={`${LABEL_CLASS} sm:col-span-2`}>
          Notes
          <input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className={FIELD_CLASS}
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
          disabled={saving || lookingUp || (isCredit && !customers.length)}
          className={`${BTN_PRIMARY} w-full sm:w-auto`}
        >
          {saving
            ? editMode
              ? "Updating…"
              : "Saving…"
            : editMode
              ? "Update Bill"
              : "Save Bill"}
        </button>
        <button
          type="button"
          onClick={() => clearBillFields({ keepDeliveryBoy: deliveryMode })}
          className="w-full py-2 text-center text-sm font-medium text-slate-400 hover:text-slate-200 sm:w-auto sm:py-0 sm:text-left"
        >
          Clear
        </button>
      </div>
    </form>
  );
}

export default function ExternalSalesForm({
  clientId,
  currency,
  currencyDecimals,
  businessDate,
  terminals,
  deliveryBoys,
  onMessage,
  onError,
}) {
  const { accounts: bankAccounts } = useBankAccounts(clientId);
  const [customers, setCustomers] = useState([]);
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

  if (!activeTerminals.length) {
    return (
      <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-4 text-sm text-amber-100">
        Add at least one active billing terminal in Setup before entering bills.
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {activeTerminals.map((terminal) => (
          <TerminalBillForm
            key={terminal.id}
            clientId={clientId}
            currency={currency}
            currencyDecimals={currencyDecimals}
            businessDate={effectiveBusinessDate}
            terminal={terminal}
            deliveryBoys={deliveryBoys}
            customers={customers}
            paymentModeOptions={paymentModeOptions}
            bankAccounts={bankAccounts}
            onMessage={onMessage}
            onError={onError}
          />
        ))}
      </div>
    </div>
  );
}
