import { useEffect, useMemo, useState } from "react";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { Banknote, Plus, Trash2 } from "lucide-react";
import { db } from "../../firebase";
import { useAuth } from "../../context/AuthContext";
import { useDeliveryChargeSettings } from "../../hooks/useDeliveryChargeSettings.js";
import {
  DEFAULT_DELIVERY_CHARGE,
  DEFAULT_DELIVERY_CHARGE_OPTIONS,
  buildDeliveryChargeSelectOptions,
  deliveryChargeSelectValue,
  formatDeliveryChargeDefaultLabel,
  normalizeDeliveryChargeSettings,
  parseDeliveryChargeSelectValue,
} from "../../utils/deliveryCharges.js";
import { formatMoney, moneyInputStep, numMoney, roundMoney } from "../../utils/money.js";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD_CLASS,
  FIELD_NUMBER_CLASS,
  LABEL_CLASS,
} from "./externalSalesUi.js";

export default function DeliveryChargeSettings({
  clientId,
  currency = "",
  currencyDecimals = 3,
  onMessage,
  onError,
}) {
  const { user } = useAuth();
  const { loading, options: liveOptions, defaultCharge: liveDefault } =
    useDeliveryChargeSettings(clientId, currencyDecimals);

  const [options, setOptions] = useState(DEFAULT_DELIVERY_CHARGE_OPTIONS);
  const [defaultCharge, setDefaultCharge] = useState(DEFAULT_DELIVERY_CHARGE);
  const [newAmount, setNewAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (loading) return;
    setOptions(liveOptions);
    setDefaultCharge(liveDefault);
    setHydrated(true);
  }, [loading, liveOptions, liveDefault]);

  const selectOptions = useMemo(
    () =>
      buildDeliveryChargeSelectOptions({
        options,
        currencyDecimals,
        currency,
      }),
    [options, currencyDecimals, currency]
  );

  const dirty = useMemo(() => {
    if (!hydrated) return false;
    const live = normalizeDeliveryChargeSettings(
      {
        deliveryChargeOptions: liveOptions,
        defaultDeliveryCharge: liveDefault,
      },
      currencyDecimals
    );
    const current = normalizeDeliveryChargeSettings(
      {
        deliveryChargeOptions: options,
        defaultDeliveryCharge: defaultCharge,
      },
      currencyDecimals
    );
    const optKey = (list) =>
      list.map((n) => formatMoney(n, currencyDecimals)).join("|");
    return (
      optKey(live.options) !== optKey(current.options) ||
      formatMoney(live.defaultCharge, currencyDecimals) !==
        formatMoney(current.defaultCharge, currencyDecimals)
    );
  }, [
    hydrated,
    liveOptions,
    liveDefault,
    options,
    defaultCharge,
    currencyDecimals,
  ]);

  function addAmount(event) {
    event.preventDefault();
    onError?.("");
    if (newAmount === "" || newAmount == null) {
      onError?.("Enter a delivery charge amount.");
      return;
    }
    const amount = roundMoney(numMoney(newAmount), currencyDecimals);
    if (!Number.isFinite(Number(newAmount)) || amount <= 0) {
      onError?.("Delivery charge must be greater than zero.");
      return;
    }
    const key = formatMoney(amount, currencyDecimals);
    if (options.some((row) => formatMoney(row, currencyDecimals) === key)) {
      onError?.(`Charge ${key} is already in the list.`);
      return;
    }
    setOptions(
      [...options, amount].sort((a, b) => a - b)
    );
    setNewAmount("");
  }

  function removeAmount(amount) {
    const key = formatMoney(amount, currencyDecimals);
    const next = options.filter(
      (row) => formatMoney(row, currencyDecimals) !== key
    );
    setOptions(next);
    if (formatMoney(defaultCharge, currencyDecimals) === key) {
      setDefaultCharge(next[0] != null ? next[0] : 0);
    }
  }

  async function saveSettings() {
    onError?.("");
    if (!clientId) {
      onError?.("Select an active shop first.");
      return;
    }
    if (!user?.uid) {
      onError?.("You must be signed in.");
      return;
    }

    const normalized = normalizeDeliveryChargeSettings(
      {
        deliveryChargeOptions: options,
        defaultDeliveryCharge: defaultCharge,
      },
      currencyDecimals
    );

    setSaving(true);
    try {
      await setDoc(
        doc(db, "client_settings", clientId),
        {
          clientId,
          deliveryChargeOptions: normalized.options,
          defaultDeliveryCharge: normalized.defaultCharge,
          updatedAt: serverTimestamp(),
          updatedBy: user.uid,
        },
        { merge: true }
      );
      onMessage?.(
        `Delivery charges saved. Default: ${formatDeliveryChargeDefaultLabel(
          normalized.defaultCharge,
          currencyDecimals,
          currency
        )}.`
      );
    } catch (reason) {
      onError?.(reason?.message || "Failed to save delivery charges.");
    } finally {
      setSaving(false);
    }
  }

  function resetToBuiltIn() {
    setOptions([...DEFAULT_DELIVERY_CHARGE_OPTIONS]);
    setDefaultCharge(DEFAULT_DELIVERY_CHARGE);
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:p-5">
      <div className="mb-3 flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-950 text-slate-300">
          <Banknote size={15} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-white">Delivery charges</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Preset amounts for Bill Entry and Delivery Entry. “None” is always
            available. Set which charge is selected by default on new bills.
          </p>
        </div>
      </div>

      {loading && !hydrated ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div>
            <div className={LABEL_CLASS}>Charge amounts</div>
            <ul className="mt-2 space-y-1.5">
              <li className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-300">
                <span>None</span>
                <span className="text-[11px] text-slate-500">always available</span>
              </li>
              {options.map((amount) => {
                const label = formatMoney(amount, currencyDecimals);
                return (
                  <li
                    key={label}
                    className="flex items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-white"
                  >
                    <span>
                      {label}
                      {currency ? (
                        <span className="ml-1 text-slate-500">{currency}</span>
                      ) : null}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAmount(amount)}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-rose-300 hover:bg-rose-950/40 hover:text-rose-200"
                      aria-label={`Remove ${label}`}
                    >
                      <Trash2 size={13} />
                      Remove
                    </button>
                  </li>
                );
              })}
              {!options.length ? (
                <li className="rounded-xl border border-dashed border-slate-700 px-3 py-2 text-xs text-slate-500">
                  No amounts yet — only “None” will appear until you add some.
                </li>
              ) : null}
            </ul>
          </div>

          <form
            onSubmit={addAmount}
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
          >
            <label className={`${LABEL_CLASS} min-w-0 flex-1`}>
              Add amount {currency ? `(${currency})` : ""}
              <input
                type="number"
                min="0"
                step={moneyInputStep(currencyDecimals)}
                value={newAmount}
                onChange={(event) => setNewAmount(event.target.value)}
                className={FIELD_NUMBER_CLASS}
                placeholder={formatMoney(0.1, currencyDecimals)}
              />
            </label>
            <button type="submit" className={BTN_SECONDARY}>
              <Plus size={15} />
              Add
            </button>
          </form>

          <label className={LABEL_CLASS}>
            Default delivery charge
            <select
              value={deliveryChargeSelectValue(defaultCharge, currencyDecimals)}
              onChange={(event) =>
                setDefaultCharge(
                  parseDeliveryChargeSelectValue(event.target.value)
                )
              }
              className={FIELD_CLASS}
            >
              {selectOptions.map((row) => (
                <option key={row.value || "none"} value={row.value}>
                  {row.label}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={saving || !dirty}
              onClick={saveSettings}
              className={`${BTN_PRIMARY} disabled:opacity-50`}
            >
              {saving ? "Saving…" : "Save delivery charges"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={resetToBuiltIn}
              className={BTN_SECONDARY}
            >
              Reset to 0.100 / 0.200 / 0.300
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
