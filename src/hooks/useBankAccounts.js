import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";

/**
 * Live list of bank accounts for the active client.
 * By default only returns isActive !== false.
 */
export function useBankAccounts(clientId, { activeOnly = true } = {}) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!clientId) {
      setAccounts([]);
      setLoading(false);
      setError("");
      return undefined;
    }

    setLoading(true);
    const accountsQuery = query(
      collection(db, "bank_accounts"),
      where("clientId", "==", clientId)
    );

    return onSnapshot(
      accountsQuery,
      (snapshot) => {
        const rows = snapshot.docs
          .map((item) => ({ id: item.id, ...item.data() }))
          .filter((account) => (activeOnly ? account.isActive !== false : true))
          .sort((a, b) =>
            String(a.accountName || "").localeCompare(String(b.accountName || ""))
          );
        setAccounts(rows);
        setLoading(false);
        setError("");
      },
      (reason) => {
        console.error("bank_accounts listener failed:", reason);
        setAccounts([]);
        setLoading(false);
        setError(reason?.message || "Failed to load bank accounts.");
      }
    );
  }, [clientId, activeOnly]);

  return { accounts, loading, error };
}
