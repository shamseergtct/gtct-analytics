import { useEffect, useMemo, useState, Fragment } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { ChevronDown, Pencil, Printer } from "lucide-react";
import { db } from "../../firebase";
import { useAuth } from "../../context/AuthContext";
import { useClient } from "../../context/ClientContext.jsx";
import { useBankAccounts } from "../../hooks/useBankAccounts.js";
import { formatIsoDate } from "../../utils/dateFormat.js";
import {
  formatMoney,
  moneyInputStep,
  numMoney,
  roundMoney,
  toMinorUnits,
} from "../../utils/money.js";
import {
  buildPaymentModeOptions,
  findBankAccountName,
  parsePaymentModeSelection,
  paymentModeSelectionFromSaved,
} from "../../utils/paymentModes.js";
import {
  compareBillingTerminals,
  deliveryBoyOutstandingPayable,
  isDeliveryBoyAccountPayment,
  normalizeExternalSaleType,
  parseBillSequence,
  resolveDeliveryBoyCommission,
  summarizeDeliveryBoysForCollection,
} from "../../utils/externalSales.js";
import {
  buildDeliveryBoyCollectionPrintHtml,
  groupDeliveryBoyPrintBillsByTerminal,
  listDeliveryBoyPrintBills,
  openDeliveryBoyCollectionPrint,
} from "../../utils/deliveryBoyPrint.js";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD_CLASS,
  FIELD_NUMBER_CLASS,
  LABEL_CLASS,
} from "./externalSalesUi.js";

function compareBillNumberAsc(a, b) {
  const seqA = parseBillSequence(a?.billNumber);
  const seqB = parseBillSequence(b?.billNumber);
  if (seqA != null && seqB != null && seqA !== seqB) return seqA - seqB;
  if (seqA != null && seqB == null) return -1;
  if (seqA == null && seqB != null) return 1;
  return String(a?.billNumber || "").localeCompare(
    String(b?.billNumber || ""),
    undefined,
    { numeric: true, sensitivity: "base" }
  );
}

function paymentAccountMeta(bill) {
  if (isDeliveryBoyAccountPayment(bill)) {
    return {
      key: "DELIVERY_ACCOUNT",
      label: "Delivery Boy Account",
      sort: 0,
    };
  }
  const mode = String(bill?.paymentMode || "")
    .trim()
    .toUpperCase();
  if (mode === "CREDIT") {
    return { key: "CREDIT", label: "Credit", sort: 90 };
  }
  if (mode === "BANK") {
    const accountId = String(bill?.bankAccountId || "").trim() || "_bank";
    const accountName =
      String(bill?.bankAccountNameSnapshot || "").trim() || "Bank";
    return {
      key: `BANK:${accountId}`,
      label: `Bank: ${accountName}`,
      sort: 50,
    };
  }
  return { key: "CASH", label: "Cash", sort: 20 };
}

function groupBillsByPaymentAccount(bills = []) {
  const groups = new Map();

  for (const bill of bills) {
    const meta = paymentAccountMeta(bill);
    if (!groups.has(meta.key)) {
      groups.set(meta.key, {
        ...meta,
        bills: [],
        amountTotal: 0,
        commissionTotal: 0,
      });
    }
    const group = groups.get(meta.key);
    group.bills.push(bill);
    group.amountTotal += numMoney(bill.billAmount);
    group.commissionTotal += numMoney(bill.commissionAmount);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      bills: [...group.bills].sort(compareBillNumberAsc),
      amountTotal: roundMoney(group.amountTotal),
      commissionTotal: roundMoney(group.commissionTotal),
    }))
    .sort(
      (a, b) =>
        a.sort - b.sort ||
        String(a.label).localeCompare(String(b.label))
    );
}

function groupDeliveryBillsByTerminal(bills = [], deliveryBoyId) {
  const boyId = String(deliveryBoyId || "").trim();
  const groups = new Map();

  for (const bill of bills) {
    if (!boyId || bill?.voided === true) continue;
    if (normalizeExternalSaleType(bill.saleType) !== "DELIVERY") continue;
    if (bill.deliveryBoyId !== boyId) continue;

    const terminalId = bill.terminalId || "_unknown";
    if (!groups.has(terminalId)) {
      groups.set(terminalId, {
        terminalId: bill.terminalId || "",
        terminalName: bill.terminalNameSnapshot || "Unknown terminal",
        sortOrder: bill.terminalSortOrder,
        bills: [],
      });
    }
    groups.get(terminalId).bills.push(bill);
  }

  return [...groups.values()]
    .map((group) => {
      const billsSorted = [...group.bills].sort(compareBillNumberAsc);
      const paymentGroups = groupBillsByPaymentAccount(billsSorted);
      const amountTotal = roundMoney(
        paymentGroups.reduce((sum, row) => sum + numMoney(row.amountTotal), 0)
      );
      const commissionTotal = roundMoney(
        paymentGroups.reduce(
          (sum, row) => sum + numMoney(row.commissionTotal),
          0
        )
      );
      return {
        ...group,
        bills: billsSorted,
        paymentGroups,
        amountTotal,
        commissionTotal,
      };
    })
    .sort((a, b) =>
      compareBillingTerminals(
        { name: a.terminalName, sortOrder: a.sortOrder },
        { name: b.terminalName, sortOrder: b.sortOrder }
      )
    );
}

export default function DeliveryBoyCollection({
  clientId,
  currency,
  currencyDecimals,
  businessDate,
  deliveryBoys,
  onDateLockChange,
  onMessage,
  onError,
}) {
  const { user } = useAuth();
  const { activeClientData, activeClientId } = useClient();
  const { accounts: bankAccounts } = useBankAccounts(clientId);

  const effectiveDate = businessDate || "";
  const shopName = activeClientData?.name || activeClientId || "Shop";
  const [deliveryBoyId, setDeliveryBoyId] = useState("");
  const [payableAmount, setPayableAmount] = useState("");
  const [paidCash, setPaidCash] = useState("");
  const [paidBank, setPaidBank] = useState("");
  const [bankSelection, setBankSelection] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [existingMeta, setExistingMeta] = useState(null);
  const [editSnapshots, setEditSnapshots] = useState(null);
  const [dayBills, setDayBills] = useState([]);
  const [collections, setCollections] = useState([]);
  const [loadingCollections, setLoadingCollections] = useState(false);
  const [expandedBoyId, setExpandedBoyId] = useState("");
  const [printPreview, setPrintPreview] = useState(null);
  const [printMode, setPrintMode] = useState("THERMAL");

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

  const bankOptions = useMemo(
    () =>
      buildPaymentModeOptions({ bankAccounts }).filter((option) =>
        String(option.value).startsWith("BANK:")
      ),
    [bankAccounts]
  );

  const selectedBoy = useMemo(
    () => boyOptions.find((row) => row.id === deliveryBoyId) || null,
    [boyOptions, deliveryBoyId]
  );
  const boyCommission = resolveDeliveryBoyCommission(selectedBoy);

  const suggested = useMemo(
    () =>
      deliveryBoyOutstandingPayable({
        bills: dayBills,
        collections,
        deliveryBoyId,
        excludeCollectionId: editingId || "",
      }),
    [dayBills, collections, deliveryBoyId, editingId]
  );

  const displayCommission = editingId
    ? numMoney(editSnapshots?.commissionAmount)
    : suggested.totalCommissionAmount;
  const showCommission =
    Boolean(deliveryBoyId) &&
    (boyCommission.enabled || displayCommission > 0);
  const fullyCollected =
    Boolean(deliveryBoyId) &&
    !editingId &&
    suggested.remainingPayable <= 0 &&
    suggested.alreadyCollected > 0;

  const boySummaryRows = useMemo(
    () =>
      summarizeDeliveryBoysForCollection({
        bills: dayBills,
        collections,
      }),
    [dayBills, collections]
  );

  const expandedTerminalGroups = useMemo(
    () =>
      expandedBoyId
        ? groupDeliveryBillsByTerminal(dayBills, expandedBoyId)
        : [],
    [dayBills, expandedBoyId]
  );

  const printPreviewBills = useMemo(() => {
    if (!printPreview?.deliveryBoyId) return [];
    return listDeliveryBoyPrintBills(dayBills, printPreview.deliveryBoyId);
  }, [dayBills, printPreview?.deliveryBoyId]);

  const printPreviewTerminalGroups = useMemo(
    () => groupDeliveryBoyPrintBillsByTerminal(printPreviewBills),
    [printPreviewBills]
  );

  const currencyPrefix = currency ? `${currency} ` : "";

  function openPrintPreview(row) {
    if (!row?.deliveryBoyId) return;
    setPrintMode("THERMAL");
    setPrintPreview({
      deliveryBoyId: row.deliveryBoyId,
      deliveryBoyName: row.deliveryBoyName || "Delivery Boy",
      bills: row.bills || 0,
      totalAmount: row.totalAmount,
      shopPaidAmount: row.shopCollectionAmount ?? row.shopPaidAmount,
      creditAmount: row.creditAmount,
      commission: row.commission,
      payableAmount: row.balance,
    });
  }

  function handleConfirmPrint() {
    if (!printPreview) return;
    try {
      const html = buildDeliveryBoyCollectionPrintHtml({
        mode: printMode,
        shopName,
        boyName: printPreview.deliveryBoyName,
        businessDate: effectiveDate,
        bills: printPreviewBills,
        summary: {
          bills: printPreview.bills,
          totalAmount: printPreview.totalAmount,
          shopPaidAmount: printPreview.shopPaidAmount,
          creditAmount: printPreview.creditAmount,
          commission: printPreview.commission,
          payableAmount: printPreview.payableAmount,
        },
        currency,
        currencyDecimals,
      });
      openDeliveryBoyCollectionPrint(html);
      setPrintPreview(null);
    } catch (reason) {
      onError?.(reason?.message || "Failed to open print preview.");
    }
  }

  const payableNum = numMoney(payableAmount);
  const cashNum = numMoney(paidCash || 0);
  const bankNum = numMoney(paidBank || 0);
  const settledNum = roundMoney(cashNum + bankNum, currencyDecimals);
  const balanceNum = roundMoney(
    Math.max(0, payableNum - settledNum),
    currencyDecimals
  );
  const overpaid =
    toMinorUnits(settledNum, currencyDecimals) >
    toMinorUnits(payableNum, currencyDecimals);

  useEffect(() => {
    if (!deliveryBoyId || editingId) return;
    setPayableAmount(
      formatMoney(suggested.remainingPayable, currencyDecimals)
    );
    setPaidCash("");
    setPaidBank("");
    setBankSelection("");
  }, [
    deliveryBoyId,
    suggested.remainingPayable,
    currencyDecimals,
    editingId,
  ]);

  useEffect(() => {
    if (!clientId || !effectiveDate) return undefined;
    const billsQuery = query(
      collection(db, "external_sales_bills"),
      where("clientId", "==", clientId),
      where("businessDate", "==", effectiveDate)
    );
    return onSnapshot(
      billsQuery,
      (snapshot) => {
        setDayBills(
          snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        );
      },
      () => setDayBills([])
    );
  }, [clientId, effectiveDate]);

  useEffect(() => {
    if (!clientId || !effectiveDate) return undefined;
    const q = query(
      collection(db, "delivery_boy_collections"),
      where("clientId", "==", clientId),
      where("businessDate", "==", effectiveDate),
      orderBy("createdAtMs", "desc")
    );
    return onSnapshot(
      q,
      (snapshot) => {
        setCollections(
          snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        );
        setLoadingCollections(false);
      },
      () => {
        setCollections([]);
        setLoadingCollections(false);
      }
    );
  }, [clientId, effectiveDate]);

  useEffect(() => {
    onDateLockChange?.(Boolean(editingId));
    return () => onDateLockChange?.(false);
  }, [editingId, onDateLockChange]);

  function clearForm({ keepBoy = false } = {}) {
    setEditingId(null);
    setExistingMeta(null);
    setEditSnapshots(null);
    setPaidCash("");
    setPaidBank("");
    setBankSelection("");
    setNotes("");
    if (!keepBoy) {
      setDeliveryBoyId("");
      setPayableAmount("");
    } else {
      setPayableAmount(
        formatMoney(suggested.remainingPayable, currencyDecimals)
      );
    }
  }

  function startEdit(row) {
    onError?.("");
    setEditingId(row.id);
    setExistingMeta({
      createdAt: row.createdAt || null,
      createdAtMs: row.createdAtMs || null,
      createdBy: row.createdBy || null,
    });
    setEditSnapshots({
      grossAmount: row.grossAmount,
      commissionAmount: row.commissionAmount,
      billCountSnapshot: row.billCountSnapshot,
      commissionEnabled: row.commissionEnabled,
    });
    setDeliveryBoyId(row.deliveryBoyId || "");
    setPayableAmount(
      formatMoney(row.payableAmount, currencyDecimals)
    );
    setPaidCash(
      row.paidCash === 0 || row.paidCash
        ? formatMoney(row.paidCash, currencyDecimals)
        : ""
    );
    setPaidBank(
      row.paidBank === 0 || row.paidBank
        ? formatMoney(row.paidBank, currencyDecimals)
        : ""
    );
    setBankSelection(
      row.bankAccountId
        ? paymentModeSelectionFromSaved("BANK", row.bankAccountId)
        : ""
    );
    setNotes(row.notes || "");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleSave(event) {
    event.preventDefault();
    onError?.("");

    if (!clientId) {
      onError?.("Select an active shop first.");
      return;
    }
    if (!user?.uid) {
      onError?.("You must be signed in.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
      onError?.("Business date is required.");
      return;
    }

    const boy = boyOptions.find((row) => row.id === deliveryBoyId);
    if (!boy) {
      onError?.("Select a delivery boy.");
      return;
    }

    if (payableAmount === "" || !Number.isFinite(Number(payableAmount)) || payableNum < 0) {
      onError?.("Payable amount is required and cannot be negative.");
      return;
    }
    if (paidCash !== "" && (!Number.isFinite(Number(paidCash)) || cashNum < 0)) {
      onError?.("Pay by cash must be a non-negative number.");
      return;
    }
    if (paidBank !== "" && (!Number.isFinite(Number(paidBank)) || bankNum < 0)) {
      onError?.("Pay by bank must be a non-negative number.");
      return;
    }
    if (settledNum <= 0) {
      onError?.("Enter an amount in Pay by Cash and/or Pay by Bank.");
      return;
    }
    if (overpaid) {
      onError?.(
        `Cash + Bank cannot exceed payable (${currencyPrefix}${formatMoney(payableNum, currencyDecimals)}).`
      );
      return;
    }

    let bankAccountId = "";
    let bankAccountNameSnapshot = "";
    if (bankNum > 0) {
      const parsed = parsePaymentModeSelection(bankSelection);
      bankAccountId = String(parsed.bankAccountId || "").trim();
      if (!bankAccountId) {
        onError?.("Select a bank account for bank payment.");
        return;
      }
      bankAccountNameSnapshot = findBankAccountName(bankAccounts, bankAccountId);
      if (!bankAccountNameSnapshot) {
        onError?.("Selected bank account is not available.");
        return;
      }
    }

    const nowMs = Date.now();
    const payload = {
      clientId,
      businessDate: effectiveDate,
      deliveryBoyId: boy.id,
      deliveryBoyNameSnapshot: boy.name || "",
      givenChange: 0,
      grossAmount: roundMoney(
        editingId
          ? editSnapshots?.grossAmount != null
            ? editSnapshots.grossAmount
            : suggested.grossAmount
          : suggested.grossAmount,
        currencyDecimals
      ),
      commissionAmount: roundMoney(
        editingId
          ? editSnapshots?.commissionAmount != null
            ? editSnapshots.commissionAmount
            : suggested.commissionAmount
          : suggested.commissionAmount,
        currencyDecimals
      ),
      commissionEnabled: editingId
        ? Boolean(editSnapshots?.commissionEnabled ?? boyCommission.enabled)
        : boyCommission.enabled,
      payableAmount: roundMoney(payableNum, currencyDecimals),
      paidCash: roundMoney(cashNum, currencyDecimals),
      paidBank: roundMoney(bankNum, currencyDecimals),
      balanceAmount: balanceNum,
      bankAccountId,
      bankAccountNameSnapshot,
      billCountSnapshot: editingId
        ? editSnapshots?.billCountSnapshot ?? suggested.totalBills
        : suggested.totalBills,
      notes: String(notes || "").trim(),
      updatedAt: serverTimestamp(),
      updatedAtMs: nowMs,
      updatedBy: user.uid,
    };

    setSaving(true);
    try {
      if (editingId) {
        await updateDoc(doc(db, "delivery_boy_collections", editingId), {
          ...payload,
          createdAt: existingMeta?.createdAt || serverTimestamp(),
          createdAtMs: existingMeta?.createdAtMs || nowMs,
          createdBy: existingMeta?.createdBy || user.uid,
        });
        onMessage?.(`Collection updated for ${boy.name}.`);
      } else {
        await addDoc(collection(db, "delivery_boy_collections"), {
          ...payload,
          createdAt: serverTimestamp(),
          createdAtMs: nowMs,
          createdBy: user.uid,
        });
        onMessage?.(`Collection saved for ${boy.name}.`);
      }
      clearForm();
    } catch (reason) {
      onError?.(
        reason?.message ||
          (editingId
            ? "Failed to update collection."
            : "Failed to save collection.")
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
        <div className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-white">
          Delivery Boy Summary
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[720px] w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Delivery Boy</th>
                <th className="px-4 py-2 text-right">Total Amount</th>
                <th className="px-4 py-2 text-right">Shop Paid</th>
                <th className="px-4 py-2 text-right">Credit</th>
                <th className="px-4 py-2 text-right">Commission</th>
                <th className="px-4 py-2 text-right">Balance</th>
                <th className="w-10 px-3 py-2" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {boySummaryRows.length ? (
                boySummaryRows.map((row) => {
                  const isExpanded = expandedBoyId === row.deliveryBoyId;
                  const isSelected = deliveryBoyId === row.deliveryBoyId;
                  return (
                    <Fragment key={row.deliveryBoyId}>
                      <tr
                        className={`border-t border-slate-800/80 ${
                          isSelected ? "bg-blue-950/30" : ""
                        }`}
                      >
                        <td className="px-4 py-2.5">
                          <button
                            type="button"
                            disabled={Boolean(editingId)}
                            onClick={() => {
                              setExpandedBoyId((prev) =>
                                prev === row.deliveryBoyId
                                  ? ""
                                  : row.deliveryBoyId
                              );
                              if (!editingId) {
                                setDeliveryBoyId(row.deliveryBoyId);
                              }
                            }}
                            className="font-medium text-white hover:text-blue-300 disabled:cursor-default disabled:hover:text-white"
                          >
                            {row.deliveryBoyName}
                          </button>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {currencyPrefix}
                          {formatMoney(row.totalAmount, currencyDecimals)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {currencyPrefix}
                          {formatMoney(
                            row.shopCollectionAmount ?? row.shopPaidAmount,
                            currencyDecimals
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {currencyPrefix}
                          {formatMoney(row.creditAmount, currencyDecimals)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {currencyPrefix}
                          {formatMoney(row.commission, currencyDecimals)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {currencyPrefix}
                          {formatMoney(row.balance, currencyDecimals)}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <button
                            type="button"
                            aria-expanded={isExpanded}
                            aria-label={
                              isExpanded
                                ? `Hide bills for ${row.deliveryBoyName}`
                                : `Show bills for ${row.deliveryBoyName}`
                            }
                            onClick={() => {
                              setExpandedBoyId((prev) =>
                                prev === row.deliveryBoyId
                                  ? ""
                                  : row.deliveryBoyId
                              );
                              if (!editingId) {
                                setDeliveryBoyId(row.deliveryBoyId);
                              }
                            }}
                            className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                          >
                            <ChevronDown
                              className={`h-4 w-4 transition-transform ${
                                isExpanded ? "rotate-180" : ""
                              }`}
                            />
                          </button>
                        </td>
                      </tr>
                      {isExpanded ? (
                        <tr className="border-t border-slate-800/60 bg-slate-950/40">
                          <td colSpan={7} className="px-4 py-3">
                            {expandedTerminalGroups.length ? (
                              <div className="space-y-3">
                                {expandedTerminalGroups.map((group) => (
                                  <div
                                    key={group.terminalId || group.terminalName}
                                    className="overflow-hidden rounded-xl border border-slate-800"
                                  >
                                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/60 px-3 py-2">
                                      <div className="text-sm font-semibold text-white">
                                        {group.terminalName}
                                      </div>
                                      <div className="text-xs tabular-nums text-slate-400">
                                        {group.bills.length} bill
                                        {group.bills.length === 1 ? "" : "s"}
                                        {" · "}
                                        {currencyPrefix}
                                        {formatMoney(
                                          group.amountTotal,
                                          currencyDecimals
                                        )}
                                      </div>
                                    </div>

                                    <div className="space-y-3 p-3">
                                      {group.paymentGroups.map((payment) => (
                                        <div
                                          key={payment.key}
                                          className="overflow-hidden rounded-lg border border-slate-800/80"
                                        >
                                          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 bg-slate-950/50 px-3 py-2">
                                            <div className="text-xs font-semibold uppercase tracking-wide text-slate-200">
                                              {payment.label}
                                            </div>
                                            <div className="text-xs tabular-nums text-slate-400">
                                              {payment.bills.length} bill
                                              {payment.bills.length === 1
                                                ? ""
                                                : "s"}
                                              {" · "}
                                              {currencyPrefix}
                                              {formatMoney(
                                                payment.amountTotal,
                                                currencyDecimals
                                              )}
                                            </div>
                                          </div>
                                          <div className="overflow-x-auto">
                                            <table className="min-w-[640px] w-full text-left text-sm text-slate-300">
                                              <thead className="bg-slate-950/70 text-[11px] uppercase tracking-wide text-slate-500">
                                                <tr>
                                                  <th className="px-3 py-2">
                                                    Bill No.
                                                  </th>
                                                  <th className="px-3 py-2 text-right">
                                                    Amount
                                                  </th>
                                                  <th className="px-3 py-2 text-right">
                                                    Commission
                                                  </th>
                                                  <th className="px-3 py-2">
                                                    Location
                                                  </th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {payment.bills.map((bill) => (
                                                  <tr
                                                    key={bill.id}
                                                    className="border-t border-slate-800/70"
                                                  >
                                                    <td className="px-3 py-2 font-medium tabular-nums text-white">
                                                      {bill.billNumber}
                                                    </td>
                                                    <td className="px-3 py-2 text-right tabular-nums">
                                                      {currencyPrefix}
                                                      {formatMoney(
                                                        bill.billAmount,
                                                        currencyDecimals
                                                      )}
                                                    </td>
                                                    <td className="px-3 py-2 text-right tabular-nums">
                                                      {currencyPrefix}
                                                      {formatMoney(
                                                        bill.commissionAmount,
                                                        currencyDecimals
                                                      )}
                                                    </td>
                                                    <td className="px-3 py-2">
                                                      {bill.customerLocation ||
                                                        bill.customerName ||
                                                        "—"}
                                                    </td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                              <tfoot>
                                                <tr className="border-t border-slate-700 bg-slate-900/70 font-semibold text-white">
                                                  <td className="px-3 py-2">
                                                    Total
                                                  </td>
                                                  <td className="px-3 py-2 text-right tabular-nums">
                                                    {currencyPrefix}
                                                    {formatMoney(
                                                      payment.amountTotal,
                                                      currencyDecimals
                                                    )}
                                                  </td>
                                                  <td className="px-3 py-2 text-right tabular-nums">
                                                    {currencyPrefix}
                                                    {formatMoney(
                                                      payment.commissionTotal,
                                                      currencyDecimals
                                                    )}
                                                  </td>
                                                  <td className="px-3 py-2" />
                                                </tr>
                                              </tfoot>
                                            </table>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ))}

                                <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-700 bg-slate-900/70 p-3 sm:grid-cols-3 lg:grid-cols-6">
                                  <div>
                                    <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                                      Bills
                                    </div>
                                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                                      {row.bills || 0}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                                      Total Amount
                                    </div>
                                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                                      {currencyPrefix}
                                      {formatMoney(
                                        row.totalAmount,
                                        currencyDecimals
                                      )}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                                      Shop Paid
                                    </div>
                                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-sky-200">
                                      {currencyPrefix}
                                      {formatMoney(
                                        row.shopCollectionAmount ??
                                          row.shopPaidAmount,
                                        currencyDecimals
                                      )}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                                      Credit
                                    </div>
                                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-violet-200">
                                      {currencyPrefix}
                                      {formatMoney(
                                        row.creditAmount,
                                        currencyDecimals
                                      )}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                                      Commission
                                    </div>
                                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-amber-200">
                                      {currencyPrefix}
                                      {formatMoney(
                                        row.commission,
                                        currencyDecimals
                                      )}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                                      Payable
                                    </div>
                                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-emerald-300">
                                      {currencyPrefix}
                                      {formatMoney(
                                        row.balance,
                                        currencyDecimals
                                      )}
                                    </div>
                                  </div>
                                  {numMoney(row.alreadyCollected) > 0 ? (
                                    <div className="col-span-2 sm:col-span-3 lg:col-span-6">
                                      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                                        Already Collected
                                      </div>
                                      <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-200">
                                        {currencyPrefix}
                                        {formatMoney(
                                          row.alreadyCollected,
                                          currencyDecimals
                                        )}
                                      </div>
                                    </div>
                                  ) : null}
                                </div>

                                <div className="flex flex-wrap justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={() => openPrintPreview(row)}
                                    className={`${BTN_SECONDARY} text-xs`}
                                  >
                                    <Printer className="h-3.5 w-3.5" />
                                    Print
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="py-4 text-center text-sm text-slate-500">
                                No delivery bills for this boy on this date.
                              </div>
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })
              ) : (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-6 text-center text-slate-500"
                  >
                    No delivery boy activity for this date.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <form
        onSubmit={handleSave}
        className={`space-y-4 rounded-2xl border p-4 ${
          editingId
            ? "border-amber-700/70 bg-amber-950/10"
            : "border-slate-800 bg-slate-900/40"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-white">
            {editingId ? "Edit Collection" : "New Collection"}
          </h3>
          {editingId ? (
            <button
              type="button"
              onClick={() => clearForm()}
              className="text-xs font-medium text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          ) : null}
        </div>

        {fullyCollected ? (
          <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-200">
            Fully collected · remaining {currencyPrefix}
            {formatMoney(0, currencyDecimals)}
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <label className={LABEL_CLASS}>
            Delivery Boy
            <select
              required
              value={deliveryBoyId}
              onChange={(event) => setDeliveryBoyId(event.target.value)}
              className={FIELD_CLASS}
              disabled={Boolean(editingId)}
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

          {deliveryBoyId ? (
            <>
              <label className={LABEL_CLASS}>
                Total Bills
                <input
                  readOnly
                  value={String(suggested.totalBills || 0)}
                  className={`${FIELD_NUMBER_CLASS} border-slate-700 text-slate-200`}
                  tabIndex={-1}
                />
              </label>

              <label className={LABEL_CLASS}>
                Total Amount {currency ? `(${currency})` : ""}
                <input
                  readOnly
                  value={formatMoney(suggested.totalAmount, currencyDecimals)}
                  className={`${FIELD_NUMBER_CLASS} border-slate-700 text-slate-200`}
                  tabIndex={-1}
                />
              </label>

              <label className={LABEL_CLASS}>
                Shop Paid {currency ? `(${currency})` : ""}
                <input
                  readOnly
                  value={formatMoney(
                    suggested.shopCollectionAmount ?? suggested.shopPaidAmount,
                    currencyDecimals
                  )}
                  className={`${FIELD_NUMBER_CLASS} border-slate-700 text-sky-200`}
                  tabIndex={-1}
                />
              </label>

              <label className={LABEL_CLASS}>
                Credit {currency ? `(${currency})` : ""}
                <input
                  readOnly
                  value={formatMoney(suggested.creditAmount, currencyDecimals)}
                  className={`${FIELD_NUMBER_CLASS} border-slate-700 text-violet-200`}
                  tabIndex={-1}
                />
              </label>
            </>
          ) : null}

          {showCommission ? (
            <label className={LABEL_CLASS}>
              Commission {currency ? `(${currency})` : ""}
              <input
                readOnly
                value={formatMoney(displayCommission, currencyDecimals)}
                className={`${FIELD_NUMBER_CLASS} border-slate-700 text-amber-200`}
                tabIndex={-1}
              />
            </label>
          ) : null}

          <label className={LABEL_CLASS}>
            {editingId ? "Payable Amount" : "Balance"}{" "}
            {currency ? `(${currency})` : ""}
            <input
              required
              type="number"
              min="0"
              step={moneyInputStep(currencyDecimals)}
              value={payableAmount}
              onChange={(event) => setPayableAmount(event.target.value)}
              className={FIELD_NUMBER_CLASS}
              placeholder={formatMoney(0, currencyDecimals)}
              readOnly={fullyCollected}
            />
          </label>

          <label className={LABEL_CLASS}>
            Pay by Cash {currency ? `(${currency})` : ""}
            <input
              type="number"
              min="0"
              step={moneyInputStep(currencyDecimals)}
              value={paidCash}
              onChange={(event) => setPaidCash(event.target.value)}
              className={FIELD_NUMBER_CLASS}
              placeholder={formatMoney(0, currencyDecimals)}
            />
          </label>

          <label className={LABEL_CLASS}>
            Pay by Bank {currency ? `(${currency})` : ""}
            <input
              type="number"
              min="0"
              step={moneyInputStep(currencyDecimals)}
              value={paidBank}
              onChange={(event) => {
                setPaidBank(event.target.value);
                if (numMoney(event.target.value) <= 0) setBankSelection("");
                else if (!bankSelection && bankOptions[0]) {
                  setBankSelection(bankOptions[0].value);
                }
              }}
              className={FIELD_NUMBER_CLASS}
              placeholder={formatMoney(0, currencyDecimals)}
            />
          </label>

          <label className={LABEL_CLASS}>
            Remaining {currency ? `(${currency})` : ""}
            <input
              readOnly
              value={formatMoney(overpaid ? 0 : balanceNum, currencyDecimals)}
              className={`${FIELD_NUMBER_CLASS} ${
                overpaid
                  ? "border-red-700 text-red-300"
                  : balanceNum > 0
                    ? "border-amber-700 text-amber-200"
                    : "border-emerald-800 text-emerald-300"
              }`}
              tabIndex={-1}
            />
          </label>

          {bankNum > 0 ? (
            <label className={`${LABEL_CLASS} md:col-span-2 xl:col-span-3`}>
              Bank Account
              <select
                required
                value={bankSelection}
                onChange={(event) => setBankSelection(event.target.value)}
                className={FIELD_CLASS}
              >
                <option value="">Select bank account…</option>
                {bankOptions.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className={`${LABEL_CLASS} md:col-span-2 xl:col-span-3`}>
            Notes
            <input
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className={FIELD_CLASS}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={
              saving ||
              !boyOptions.length ||
              overpaid ||
              fullyCollected ||
              (!editingId && suggested.remainingPayable <= 0)
            }
            className={BTN_PRIMARY}
          >
            {saving
              ? editingId
                ? "Updating…"
                : "Saving…"
              : editingId
                ? "Update Collection"
                : "Save Collection"}
          </button>
        </div>
      </form>

      <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
        <div className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-white">
          Collections
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Delivery Boy</th>
                <th className="px-4 py-2 text-right">Commission</th>
                <th className="px-4 py-2 text-right">Payable</th>
                <th className="px-4 py-2 text-right">Cash</th>
                <th className="px-4 py-2 text-right">Bank</th>
                <th className="px-4 py-2 text-right">Balance</th>
                <th className="px-4 py-2">Bank Account</th>
                <th className="px-4 py-2">Notes</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loadingCollections ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                    Loading…
                  </td>
                </tr>
              ) : collections.length ? (
                collections.map((row) => {
                  const rowBalance =
                    row.balanceAmount != null
                      ? numMoney(row.balanceAmount)
                      : Math.max(
                          0,
                          numMoney(row.payableAmount) -
                            numMoney(row.paidCash) -
                            numMoney(row.paidBank)
                        );
                  return (
                    <tr
                      key={row.id}
                      className={`border-t border-slate-800/80 ${
                        editingId === row.id ? "bg-amber-950/20" : ""
                      }`}
                    >
                      <td className="px-4 py-2.5 text-white">
                        {row.deliveryBoyNameSnapshot || "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {currencyPrefix}
                        {formatMoney(row.commissionAmount, currencyDecimals)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {currencyPrefix}
                        {formatMoney(row.payableAmount, currencyDecimals)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {currencyPrefix}
                        {formatMoney(row.paidCash, currencyDecimals)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {currencyPrefix}
                        {formatMoney(row.paidBank, currencyDecimals)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {currencyPrefix}
                        {formatMoney(rowBalance, currencyDecimals)}
                      </td>
                      <td className="px-4 py-2.5">
                        {row.bankAccountNameSnapshot || "—"}
                      </td>
                      <td className="max-w-[12rem] truncate px-4 py-2.5">
                        {row.notes || "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => startEdit(row)}
                          className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:border-blue-500 hover:text-blue-300"
                          aria-label="Edit collection"
                        >
                          <Pencil size={15} />
                        </button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                    No collections for this date.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {printPreview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
              <div>
                <h3 className="text-base font-semibold text-white">
                  Print Preview
                </h3>
                <p className="mt-0.5 text-sm text-slate-400">
                  {printPreview.deliveryBoyName} ·{" "}
                  {formatIsoDate(effectiveDate) || effectiveDate || "—"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPrintPreview(null)}
                className="text-sm font-medium text-slate-400 hover:text-white"
              >
                Close
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Printer
              </span>
              <button
                type="button"
                onClick={() => setPrintMode("THERMAL")}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${
                  printMode === "THERMAL"
                    ? "bg-blue-600 text-white"
                    : "border border-slate-700 text-slate-300 hover:bg-slate-800"
                }`}
              >
                Thermal
              </button>
              <button
                type="button"
                onClick={() => setPrintMode("A4")}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${
                  printMode === "A4"
                    ? "bg-blue-600 text-white"
                    : "border border-slate-700 text-slate-300 hover:bg-slate-800"
                }`}
              >
                Other / A4
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {printPreviewBills.length ? (
                printMode === "THERMAL" ? (
                  <div className="mx-auto w-full max-w-[20rem] space-y-3 rounded-xl border border-dashed border-slate-600 bg-white p-3 text-slate-900 shadow-inner">
                    <div className="text-center text-sm font-bold">
                      {shopName}
                    </div>
                    <div className="text-center text-xs text-slate-600">
                      <div className="font-semibold text-slate-900">
                        {printPreview.deliveryBoyName}
                      </div>
                      <div>
                        {formatIsoDate(effectiveDate) || effectiveDate || "—"}
                      </div>
                    </div>
                    <div className="border-t border-dashed border-slate-400" />

                    {printPreviewTerminalGroups.map((terminal) => (
                      <div key={terminal.terminalId || terminal.terminalName}>
                        <div className="mb-1 flex items-center justify-between gap-2 border-b border-slate-800 pb-1 text-[11px] font-bold">
                          <span>{terminal.terminalName}</span>
                          <span className="tabular-nums">
                            {terminal.bills.length} · {currencyPrefix}
                            {formatMoney(
                              terminal.amountTotal,
                              currencyDecimals
                            )}
                          </span>
                        </div>
                        {terminal.paymentGroups.map((payment) => (
                          <div key={payment.key} className="mb-2">
                            <div className="mb-0.5 flex items-center justify-between gap-2 border-b border-dashed border-slate-400 pb-0.5 text-[10px] font-semibold">
                              <span>{payment.label}</span>
                              <span className="tabular-nums">
                                {payment.bills.length} · {currencyPrefix}
                                {formatMoney(
                                  payment.amountTotal,
                                  currencyDecimals
                                )}
                              </span>
                            </div>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-left">
                                  <th className="py-0.5">Bill</th>
                                  <th className="py-0.5">Location</th>
                                  <th className="py-0.5 text-right">Amount</th>
                                </tr>
                              </thead>
                              <tbody>
                                {payment.bills.map((bill) => (
                                  <tr key={bill.id}>
                                    <td className="py-0.5 tabular-nums">
                                      {bill.billNumber}
                                    </td>
                                    <td className="py-0.5">
                                      {bill.customerLocation ||
                                        bill.customerName ||
                                        "—"}
                                    </td>
                                    <td className="py-0.5 text-right tabular-nums">
                                      {currencyPrefix}
                                      {formatMoney(
                                        bill.billAmount,
                                        currencyDecimals
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr className="border-t border-dashed border-slate-400 font-bold">
                                  <td className="pt-1" colSpan={2}>
                                    Total
                                  </td>
                                  <td className="pt-1 text-right tabular-nums">
                                    {currencyPrefix}
                                    {formatMoney(
                                      payment.amountTotal,
                                      currencyDecimals
                                    )}
                                  </td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        ))}
                      </div>
                    ))}

                    <div className="border-t border-dashed border-slate-400 pt-2 text-xs font-bold">
                      <div className="flex justify-between gap-2">
                        <span>Bills</span>
                        <span>{printPreview.bills || 0}</span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span>Total Amount</span>
                        <span className="tabular-nums">
                          {currencyPrefix}
                          {formatMoney(
                            printPreview.totalAmount,
                            currencyDecimals
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span>Shop Paid</span>
                        <span className="tabular-nums">
                          {currencyPrefix}
                          {formatMoney(
                            printPreview.shopPaidAmount,
                            currencyDecimals
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span>Credit</span>
                        <span className="tabular-nums">
                          {currencyPrefix}
                          {formatMoney(
                            printPreview.creditAmount,
                            currencyDecimals
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span>Commission</span>
                        <span className="tabular-nums">
                          {currencyPrefix}
                          {formatMoney(
                            printPreview.commission,
                            currencyDecimals
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span>Payable</span>
                        <span className="tabular-nums">
                          {currencyPrefix}
                          {formatMoney(
                            printPreview.payableAmount,
                            currencyDecimals
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                    {printPreviewTerminalGroups.map((terminal) => (
                      <div
                        key={terminal.terminalId || terminal.terminalName}
                        className="overflow-hidden rounded-lg border border-slate-800"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-950/70 px-3 py-2 text-sm font-semibold text-white">
                          <span>{terminal.terminalName}</span>
                          <span className="text-xs tabular-nums text-slate-400">
                            {terminal.bills.length} · {currencyPrefix}
                            {formatMoney(
                              terminal.amountTotal,
                              currencyDecimals
                            )}
                          </span>
                        </div>
                        <div className="space-y-2 p-2">
                          {terminal.paymentGroups.map((payment) => (
                            <div
                              key={payment.key}
                              className="overflow-hidden rounded-md border border-slate-800/80"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 bg-slate-950/40 px-3 py-1.5 text-xs">
                                <span className="font-semibold uppercase tracking-wide text-slate-200">
                                  {payment.label}
                                </span>
                                <span className="tabular-nums text-slate-400">
                                  {payment.bills.length} · {currencyPrefix}
                                  {formatMoney(
                                    payment.amountTotal,
                                    currencyDecimals
                                  )}
                                </span>
                              </div>
                              <table className="min-w-full text-sm text-slate-300">
                                <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                                  <tr>
                                    <th className="px-3 py-2 text-left">
                                      Bill No.
                                    </th>
                                    <th className="px-3 py-2 text-left">
                                      Location
                                    </th>
                                    <th className="px-3 py-2 text-right">
                                      Amount
                                    </th>
                                    <th className="px-3 py-2 text-right">
                                      Commission
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {payment.bills.map((bill) => (
                                    <tr
                                      key={bill.id}
                                      className="border-t border-slate-800/70"
                                    >
                                      <td className="px-3 py-2 tabular-nums text-white">
                                        {bill.billNumber}
                                      </td>
                                      <td className="px-3 py-2">
                                        {bill.customerLocation ||
                                          bill.customerName ||
                                          "—"}
                                      </td>
                                      <td className="px-3 py-2 text-right tabular-nums">
                                        {currencyPrefix}
                                        {formatMoney(
                                          bill.billAmount,
                                          currencyDecimals
                                        )}
                                      </td>
                                      <td className="px-3 py-2 text-right tabular-nums">
                                        {currencyPrefix}
                                        {formatMoney(
                                          bill.commissionAmount,
                                          currencyDecimals
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-700 bg-slate-950/50 p-3 sm:grid-cols-3">
                      <div>
                        <div className="text-[10px] uppercase text-slate-500">
                          Bills
                        </div>
                        <div className="font-semibold text-white">
                          {printPreview.bills || 0}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase text-slate-500">
                          Total
                        </div>
                        <div className="font-semibold tabular-nums text-white">
                          {currencyPrefix}
                          {formatMoney(
                            printPreview.totalAmount,
                            currencyDecimals
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase text-slate-500">
                          Shop Paid
                        </div>
                        <div className="font-semibold tabular-nums text-sky-200">
                          {currencyPrefix}
                          {formatMoney(
                            printPreview.shopPaidAmount,
                            currencyDecimals
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase text-slate-500">
                          Credit
                        </div>
                        <div className="font-semibold tabular-nums text-violet-200">
                          {currencyPrefix}
                          {formatMoney(
                            printPreview.creditAmount,
                            currencyDecimals
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase text-slate-500">
                          Commission
                        </div>
                        <div className="font-semibold tabular-nums text-amber-200">
                          {currencyPrefix}
                          {formatMoney(
                            printPreview.commission,
                            currencyDecimals
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase text-slate-500">
                          Payable
                        </div>
                        <div className="font-semibold tabular-nums text-emerald-300">
                          {currencyPrefix}
                          {formatMoney(
                            printPreview.payableAmount,
                            currencyDecimals
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              ) : (
                <div className="rounded-xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-500">
                  No bills to print for this delivery boy.
                </div>
              )}
            </div>

            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-800 px-4 py-3">
              <button
                type="button"
                onClick={() => setPrintPreview(null)}
                className={BTN_SECONDARY}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmPrint}
                disabled={!printPreviewBills.length}
                className={BTN_PRIMARY}
              >
                <Printer className="h-4 w-4" />
                Print
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
