import { useMemo } from "react";
import { useClient } from "../context/ClientContext.jsx";
import {
  formatMoney,
  formatMoneyLocale,
  moneyInputStep,
  moneyPreviewSample,
  resolveCurrencyDecimals,
  roundMoney,
  toMinorUnits,
} from "../utils/money.js";

/**
 * Bound money helpers for the active shop/client.
 */
export function useMoney() {
  const { activeClientData } = useClient();

  return useMemo(() => {
    const currency = String(activeClientData?.currency || "").trim().toUpperCase() || "AED";
    const decimals = resolveCurrencyDecimals(activeClientData, currency);

    return {
      currency,
      decimals,
      round: (value) => roundMoney(value, decimals),
      format: (value) => formatMoney(value, decimals),
      /** Alias used widely in sales UI */
      money: (value) => formatMoney(value, decimals),
      formatLocale: (value) => formatMoneyLocale(value, decimals),
      toMinor: (value) => toMinorUnits(value, decimals),
      step: moneyInputStep(decimals),
      sample: moneyPreviewSample(decimals),
    };
  }, [activeClientData]);
}
