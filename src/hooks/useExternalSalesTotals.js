import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import {
  summarizeDeliveryBoyCollections,
  summarizeExternalBillTenders,
} from "../utils/externalSales.js";
import { roundMoney } from "../utils/money.js";

/**
 * Live External Sales bill tenders + delivery-boy Collect for a business date.
 * Collect cash/bank is shop tender (sale settled into drawer/bank).
 */
export function useExternalSalesTotals({ clientId, businessDate }) {
  const [bills, setBills] = useState([]);
  const [collections, setCollections] = useState([]);
  const [loadingBills, setLoadingBills] = useState(false);
  const [loadingCollections, setLoadingCollections] = useState(false);

  useEffect(() => {
    if (!clientId || !businessDate) {
      setBills([]);
      setCollections([]);
      setLoadingBills(false);
      setLoadingCollections(false);
      return undefined;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setLoadingBills(true);
        setLoadingCollections(true);
      }
    });

    const billsQuery = query(
      collection(db, "external_sales_bills"),
      where("clientId", "==", clientId),
      where("businessDate", "==", businessDate)
    );
    const collectionsQuery = query(
      collection(db, "delivery_boy_collections"),
      where("clientId", "==", clientId),
      where("businessDate", "==", businessDate)
    );

    const unsubBills = onSnapshot(
      billsQuery,
      (snapshot) => {
        if (cancelled) return;
        setBills(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
        setLoadingBills(false);
      },
      () => {
        if (cancelled) return;
        setBills([]);
        setLoadingBills(false);
      }
    );

    const unsubCollections = onSnapshot(
      collectionsQuery,
      (snapshot) => {
        if (cancelled) return;
        setCollections(
          snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        );
        setLoadingCollections(false);
      },
      () => {
        if (cancelled) return;
        setCollections([]);
        setLoadingCollections(false);
      }
    );

    return () => {
      cancelled = true;
      unsubBills();
      unsubCollections();
    };
  }, [clientId, businessDate]);

  return useMemo(() => {
    const billTenders = summarizeExternalBillTenders(bills);
    const collectTenders = summarizeDeliveryBoyCollections(collections);
    const loading = loadingBills || loadingCollections;

    // Shop cash/bank for Z = counter tenders + money collected from delivery boys.
    const shopCashTotal = roundMoney(
      billTenders.cashTotal + collectTenders.cashTotal
    );
    const shopBankTotal = roundMoney(
      billTenders.bankTotal + collectTenders.bankTotal
    );

    const bankByAccountMap = new Map();
    for (const row of [
      ...billTenders.bankByAccount,
      ...collectTenders.bankByAccount,
    ]) {
      const key = row.bankAccountId || "_unassigned";
      const existing = bankByAccountMap.get(key);
      if (existing) {
        existing.amount = roundMoney(existing.amount + row.amount);
      } else {
        bankByAccountMap.set(key, { ...row });
      }
    }

    const deliveryOutstanding = Math.max(
      0,
      roundMoney(
        billTenders.deliveryAccountTotal - collectTenders.settledTotal
      )
    );

    return {
      loading,
      ...billTenders,
      collectionCash: collectTenders.cashTotal,
      collectionBank: collectTenders.bankTotal,
      collectionSettled: collectTenders.settledTotal,
      collectionCount: collections.length,
      shopCashTotal,
      shopBankTotal,
      shopCreditTotal: billTenders.creditTotal,
      bankByAccount: Array.from(bankByAccountMap.values()),
      deliveryOutstanding,
    };
  }, [bills, collections, loadingBills, loadingCollections]);
}
