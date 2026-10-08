import { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { normalizeDeliveryChargeSettings } from "../utils/deliveryCharges.js";

/**
 * Live delivery-charge presets for a shop (client_settings).
 */
export function useDeliveryChargeSettings(clientId, currencyDecimals = 3) {
  const [raw, setRaw] = useState(null);
  const [loading, setLoading] = useState(Boolean(clientId));

  useEffect(() => {
    if (!clientId) {
      setRaw(null);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    return onSnapshot(
      doc(db, "client_settings", clientId),
      (snap) => {
        setRaw(snap.exists() ? snap.data() : null);
        setLoading(false);
      },
      () => {
        setRaw(null);
        setLoading(false);
      }
    );
  }, [clientId]);

  const settings = useMemo(
    () => normalizeDeliveryChargeSettings(raw, currencyDecimals),
    [raw, currencyDecimals]
  );

  return {
    loading,
    options: settings.options,
    defaultCharge: settings.defaultCharge,
  };
}
