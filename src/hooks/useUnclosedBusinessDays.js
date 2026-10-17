import { useEffect, useMemo, useState } from "react";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";

const LOOKBACK_DAYS = 45;
const TXN_SAMPLE_LIMIT = 800;

function todayYYYYMMDD() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function addDaysYYYYMMDD(yyyyMMdd, deltaDays) {
  const date = new Date(`${yyyyMMdd}T12:00:00`);
  date.setDate(date.getDate() + deltaDays);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function toDateKey(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const clean = value.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(clean) ? clean : "";
  }
  if (typeof value?.toDate === "function") {
    const d = value.toDate();
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${month}-${day}`;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${value.getFullYear()}-${month}-${day}`;
  }
  const ms = Number(value);
  if (Number.isFinite(ms) && ms > 0) {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${month}-${day}`;
  }
  return "";
}

/**
 * Past business days that have activity (txns / bills / Z) but no closed End of Day.
 * Excludes today and re-opened reports (those use a separate notification).
 */
export function useUnclosedBusinessDays(clientId) {
  const shop = String(clientId || "").trim();
  const [activityDates, setActivityDates] = useState(() => new Set());
  const [closedDates, setClosedDates] = useState(() => new Set());
  const [reopenedDates, setReopenedDates] = useState(() => new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!shop) {
      setActivityDates(new Set());
      setClosedDates(new Set());
      setReopenedDates(new Set());
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const today = todayYYYYMMDD();
    const fromDate = addDaysYYYYMMDD(today, -LOOKBACK_DAYS);
    const fromMs = new Date(`${fromDate}T00:00:00`).getTime();
    const todayStartMs = new Date(`${today}T00:00:00`).getTime();

    const buckets = {
      txn: new Set(),
      bills: new Set(),
      z: new Set(),
      shifts: new Set(),
    };
    let reportsReady = false;
    let txnReady = false;
    let billsReady = false;
    let zReady = false;
    let shiftsReady = false;

    function mergeActivity() {
      const next = new Set();
      for (const set of Object.values(buckets)) {
        for (const date of set) {
          if (date && date < today) next.add(date);
        }
      }
      setActivityDates(next);
      if (reportsReady && txnReady && billsReady && zReady && shiftsReady) {
        setLoading(false);
      }
    }

    const reportsQuery = query(
      collection(db, "daily_reports"),
      where("clientId", "==", shop),
      orderBy("date", "desc"),
      limit(90)
    );

    const txnQuery = query(
      collection(db, "transactions"),
      where("clientId", "==", shop),
      where("dateMs", ">=", fromMs),
      where("dateMs", "<", todayStartMs),
      orderBy("dateMs", "desc"),
      limit(TXN_SAMPLE_LIMIT)
    );

    const billsQuery = query(
      collection(db, "external_sales_bills"),
      where("clientId", "==", shop),
      where("businessDate", ">=", fromDate),
      where("businessDate", "<", today),
      orderBy("businessDate", "asc"),
      limit(500)
    );

    const zQuery = query(
      collection(db, "z_reports"),
      where("clientId", "==", shop),
      where("businessDate", ">=", fromDate),
      where("businessDate", "<", today),
      orderBy("businessDate", "asc"),
      limit(200)
    );

    const shiftsQuery = query(
      collection(db, "shifts"),
      where("clientId", "==", shop),
      where("businessDate", ">=", fromDate),
      where("businessDate", "<", today),
      orderBy("businessDate", "asc"),
      limit(200)
    );

    const unsubReports = onSnapshot(
      reportsQuery,
      (snap) => {
        const closed = new Set();
        const reopened = new Set();
        for (const docSnap of snap.docs) {
          const data = docSnap.data() || {};
          const date = String(data.date || "").slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
          const status = String(data.status || "").toLowerCase();
          if (status === "closed") closed.add(date);
          if (status === "re-opened") reopened.add(date);
        }
        setClosedDates(closed);
        setReopenedDates(reopened);
        reportsReady = true;
        mergeActivity();
      },
      () => {
        setClosedDates(new Set());
        setReopenedDates(new Set());
        reportsReady = true;
        mergeActivity();
      }
    );

    const unsubTxn = onSnapshot(
      txnQuery,
      (snap) => {
        const next = new Set();
        for (const docSnap of snap.docs) {
          const data = docSnap.data() || {};
          const key =
            toDateKey(data.date) ||
            toDateKey(data.businessDate) ||
            toDateKey(data.dateMs);
          if (key && key < today) next.add(key);
        }
        buckets.txn = next;
        txnReady = true;
        mergeActivity();
      },
      () => {
        buckets.txn = new Set();
        txnReady = true;
        mergeActivity();
      }
    );

    const unsubBills = onSnapshot(
      billsQuery,
      (snap) => {
        const next = new Set();
        for (const docSnap of snap.docs) {
          const key = toDateKey(docSnap.data()?.businessDate);
          if (key && key < today) next.add(key);
        }
        buckets.bills = next;
        billsReady = true;
        mergeActivity();
      },
      () => {
        buckets.bills = new Set();
        billsReady = true;
        mergeActivity();
      }
    );

    const unsubZ = onSnapshot(
      zQuery,
      (snap) => {
        const next = new Set();
        for (const docSnap of snap.docs) {
          const key = toDateKey(docSnap.data()?.businessDate);
          if (key && key < today) next.add(key);
        }
        buckets.z = next;
        zReady = true;
        mergeActivity();
      },
      () => {
        buckets.z = new Set();
        zReady = true;
        mergeActivity();
      }
    );

    const unsubShifts = onSnapshot(
      shiftsQuery,
      (snap) => {
        const next = new Set();
        for (const docSnap of snap.docs) {
          const key = toDateKey(docSnap.data()?.businessDate);
          if (key && key < today) next.add(key);
        }
        buckets.shifts = next;
        shiftsReady = true;
        mergeActivity();
      },
      () => {
        buckets.shifts = new Set();
        shiftsReady = true;
        mergeActivity();
      }
    );

    return () => {
      unsubReports();
      unsubTxn();
      unsubBills();
      unsubZ();
      unsubShifts();
    };
  }, [shop]);

  const days = useMemo(() => {
    const list = [];
    for (const date of activityDates) {
      if (closedDates.has(date)) continue;
      if (reopenedDates.has(date)) continue;
      list.push({
        id: `unclosed-${date}`,
        date,
        href: `/reports/end-of-day?date=${encodeURIComponent(date)}`,
      });
    }
    list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return list;
  }, [activityDates, closedDates, reopenedDates]);

  return { days, loading, count: days.length };
}
