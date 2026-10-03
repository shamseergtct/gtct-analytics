import { useEffect, useMemo, useState } from "react";
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
import { Pencil } from "lucide-react";
import { db } from "../../firebase";
import { useAuth } from "../../context/AuthContext";
import { useBankAccounts } from "../../hooks/useBankAccounts.js";
import DateInput from "../DateInput.jsx";
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
  deliveryBoyOutstandingPayable,
  resolveDeliveryBoyCommission,
} from "../../utils/externalSales.js";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD_CLASS,
  FIELD_NUMBER_CLASS,
  LABEL_CLASS,
} from "./externalSalesUi.js";

export default function DeliveryBoyCollection({
  clientId,
  currency,
  currencyDecimals,
  defaultBusinessDate,
  deliveryBoys,
  onMessage,
  onError,
}) {
  const { user } = useAuth();
  const { accounts: bankAccounts } = useBankAccounts(clientId);

  const [businessDate, setBusinessDate] = useState("");
  const effectiveDate = businessDate || defaultBusinessDate || "";
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

  const commissionAmount = editingId
    ? numMoney(editSnapshots?.commissionAmount)
    : suggested.commissionAmount;
  const showCommission =
    Boolean(deliveryBoyId) &&
    (boyCommission.enabled || commissionAmount > 0);
  const fullyCollected =
    Boolean(deliveryBoyId) &&
    !editingId &&
    suggested.remainingPayable <= 0 &&
    suggested.alreadyCollected > 0;

  const currencyPrefix = currency ? `${currency} ` : "";

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
    setBusinessDate(row.businessDate || "");
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
        ? editSnapshots?.billCountSnapshot ?? suggested.billCount
        : suggested.billCount,
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
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-white">
          Collect from Delivery Boy
        </h2>
        <p className="text-sm text-slate-400">
          Bill amount already includes delivery charge. Payable = bill amount
          minus commission (when enabled). Balance = Payable − Cash − Bank.
        </p>
      </div>

      <form
        onSubmit={handleSave}
        className={`space-y-4 rounded-2xl border p-4 ${
          editingId
            ? "border-amber-700/70 bg-amber-950/10"
            : "border-slate-800 bg-slate-900/40"
        }`}
      >
        {editingId ? (
          <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 p-2.5 text-sm text-amber-100">
            Editing collection. Update the amounts below, then click{" "}
            <span className="font-semibold">Update Collection</span>.
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <label className={LABEL_CLASS}>
            Business Date
            <DateInput
              value={effectiveDate}
              onChange={(event) => setBusinessDate(event.target.value)}
              className={`${FIELD_CLASS} mt-1.5`}
              required
              disabled={Boolean(editingId)}
            />
          </label>

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

          {showCommission ? (
            <label className={LABEL_CLASS}>
              Commission {currency ? `(${currency})` : ""}
              <input
                readOnly
                value={formatMoney(commissionAmount, currencyDecimals)}
                className={`${FIELD_NUMBER_CLASS} border-slate-700 text-amber-200`}
                tabIndex={-1}
              />
              <span className="mt-1 block text-[11px] text-slate-500">
                Deducted from payable
              </span>
            </label>
          ) : null}

          <label className={LABEL_CLASS}>
            {editingId ? "Payable Amount" : "Balance to Collect"}{" "}
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
            {deliveryBoyId && !editingId ? (
              <span className="mt-1 block text-[11px] text-slate-500">
                Total after commission: {currencyPrefix}
                {formatMoney(
                  suggested.grossAmount - suggested.commissionAmount,
                  currencyDecimals
                )}
                {suggested.alreadyCollected > 0
                  ? ` · Already collected: ${currencyPrefix}${formatMoney(suggested.alreadyCollected, currencyDecimals)}`
                  : ""}
                {" · Remaining: "}
                {currencyPrefix}
                {formatMoney(suggested.remainingPayable, currencyDecimals)}
              </span>
            ) : null}
          </label>

          {fullyCollected ? (
            <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-200 md:col-span-2 xl:col-span-3">
              Fully collected for this delivery boy today. Remaining balance is{" "}
              {currencyPrefix}
              {formatMoney(0, currencyDecimals)}.
            </div>
          ) : null}

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
            Balance {currency ? `(${currency})` : ""}
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
            <span className="mt-1 block text-[11px] text-slate-500">
              {overpaid
                ? "Cash + Bank exceeds payable"
                : "Payable − Cash − Bank"}
            </span>
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
              placeholder="Optional"
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
          {editingId ? (
            <button
              type="button"
              onClick={() => clearForm()}
              className={BTN_SECONDARY}
            >
              Cancel edit
            </button>
          ) : null}
        </div>
      </form>

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
        <div className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-white">
          Collections · {effectiveDate || "—"}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Delivery Boy</th>
                <th className="px-4 py-2">Commission</th>
                <th className="px-4 py-2">Payable</th>
                <th className="px-4 py-2">Cash</th>
                <th className="px-4 py-2">Bank</th>
                <th className="px-4 py-2">Balance</th>
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
                      <td className="px-4 py-2 text-white">
                        {row.deliveryBoyNameSnapshot || "—"}
                      </td>
                      <td className="px-4 py-2">
                        {currencyPrefix}
                        {formatMoney(row.commissionAmount, currencyDecimals)}
                      </td>
                      <td className="px-4 py-2">
                        {currencyPrefix}
                        {formatMoney(row.payableAmount, currencyDecimals)}
                      </td>
                      <td className="px-4 py-2">
                        {currencyPrefix}
                        {formatMoney(row.paidCash, currencyDecimals)}
                      </td>
                      <td className="px-4 py-2">
                        {currencyPrefix}
                        {formatMoney(row.paidBank, currencyDecimals)}
                      </td>
                      <td className="px-4 py-2">
                        {currencyPrefix}
                        {formatMoney(rowBalance, currencyDecimals)}
                      </td>
                      <td className="px-4 py-2">
                        {row.bankAccountNameSnapshot || "—"}
                      </td>
                      <td className="px-4 py-2">{row.notes || "—"}</td>
                      <td className="px-4 py-2 text-right">
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
                    No collections recorded for this date.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
