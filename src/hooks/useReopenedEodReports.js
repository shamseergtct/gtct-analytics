import { useEffect, useState } from "react";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";

/**
 * Live list of daily_reports with status "re-opened" for the active shop.
 */
export function useReopenedEodReports(clientId) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!clientId) {
      setReports([]);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    // Existing index: clientId + date desc. Filter re-opened locally.
    const reportsQuery = query(
      collection(db, "daily_reports"),
      where("clientId", "==", clientId),
      orderBy("date", "desc"),
      limit(90)
    );

    return onSnapshot(
      reportsQuery,
      (snapshot) => {
        const reopened = snapshot.docs
          .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
          .filter(
            (report) =>
              String(report?.status || "").toLowerCase() === "re-opened"
          );
        setReports(reopened);
        setLoading(false);
      },
      () => {
        setReports([]);
        setLoading(false);
      }
    );
  }, [clientId]);

  return { reports, loading, count: reports.length };
}
