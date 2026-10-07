import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { filterBankAccountsForPurpose } from "../utils/bankAccountTypes.js";

/**
 * Live list of bank accounts for the active client.
 * By default only returns isActive !== false and OPERATIONAL accounts
 * (missing accountType is treated as OPERATIONAL).
 *
 * purpose:
 * - "transaction" (default): Operational only — Sales, Receipt, Payment, etc.
 * - "transfer": Operational + Reserve — Internal Transfer
 * - "all": no accountType filter — report filters / admin views
 */
export function useBankAccounts(
  clientId,
  { activeOnly = true, purpose = "transaction" } = {}
) {
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
          .filter((account) => (activeOnly ? account.isActive !== false : true));
        const scoped = filterBankAccountsForPurpose(rows, purpose).sort((a, b) =>
          String(a.accountName || "").localeCompare(String(b.accountName || ""))
        );
        setAccounts(scoped);
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
  }, [clientId, activeOnly, purpose]);

  return { accounts, loading, error };
}
