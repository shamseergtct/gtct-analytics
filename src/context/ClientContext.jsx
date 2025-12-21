// src/context/ClientContext.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  documentId,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "./AuthContext";

const ClientContext = createContext(null);
const LS_KEY = "gtct_active_client_id";

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function ClientProvider({ children }) {
  const { isSuperAdmin, assignedShops, authLoading } = useAuth();

  const [clients, setClients] = useState([]);
  const [activeClientId, setActiveClientId] = useState(
    () => localStorage.getItem(LS_KEY) || ""
  );
  const [activeClientData, setActiveClientData] = useState(null);
  const [loadingClients, setLoadingClients] = useState(true);

  // ✅ Realtime clients list (RBAC-safe)
  useEffect(() => {
    if (authLoading) return;

    setLoadingClients(true);
    setClients([]);

    // Cleanup unsubscribers
    const unsubs = [];

    // ✅ Super Admin → all clients
    if (isSuperAdmin) {
      const qy = query(collection(db, "clients"), orderBy("name", "asc"));
      const unsub = onSnapshot(
        qy,
        (snap) => {
          const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          setClients(rows);
          setLoadingClients(false);

          // keep active client valid
          const saved = localStorage.getItem(LS_KEY);
          if (!saved && rows.length > 0) setActiveClient(rows[0].id);
        },
        (err) => {
          console.error("Clients snapshot error:", err);
          setLoadingClients(false);
        }
      );
      unsubs.push(unsub);
      return () => unsubs.forEach((fn) => fn());
    }

    // ✅ Admin/Partner → only assigned shops
    const ids = Array.isArray(assignedShops) ? assignedShops.filter(Boolean) : [];
    if (ids.length === 0) {
      setClients([]);
      setLoadingClients(false);
      // also clear active client if not allowed
      setActiveClient("");
      return;
    }

    // Firestore "in" supports max 10
    const groups = chunk(ids, 10);
    const mapById = {};

    groups.forEach((group) => {
      const qy = query(
        collection(db, "clients"),
        where(documentId(), "in", group)
      );

      const unsub = onSnapshot(
        qy,
        (snap) => {
          snap.docs.forEach((d) => {
            mapById[d.id] = { id: d.id, ...d.data() };
          });

          // remove any ids not present anymore
          const next = Object.values(mapById).sort((a, b) =>
            String(a.name || a.id).localeCompare(String(b.name || b.id))
          );

          setClients(next);
          setLoadingClients(false);

          // if active client not allowed anymore, pick first allowed
          const allowed = new Set(ids);
          const current = localStorage.getItem(LS_KEY) || "";
          if (!current || !allowed.has(current)) {
            setActiveClient(next[0]?.id || "");
          }
        },
        (err) => {
          console.error("Clients snapshot error:", err);
          setLoadingClients(false);
        }
      );

      unsubs.push(unsub);
    });

    return () => unsubs.forEach((fn) => fn());
  }, [isSuperAdmin, assignedShops, authLoading]);

  // ✅ Realtime active client doc
  useEffect(() => {
    if (!activeClientId) {
      setActiveClientData(null);
      return;
    }

    const ref = doc(db, "clients", activeClientId);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setActiveClientData(null);
          return;
        }
        setActiveClientData({ id: snap.id, ...snap.data() });
      },
      (err) => console.error("Active client snapshot error:", err)
    );

    return () => unsub();
  }, [activeClientId]);

  const setActiveClient = (clientId) => {
    setActiveClientId(clientId);
    if (clientId) localStorage.setItem(LS_KEY, clientId);
    else localStorage.removeItem(LS_KEY);
  };

  const value = useMemo(
    () => ({
      clients,
      loadingClients,
      activeClientId,
      activeClientData,
      setActiveClient,
    }),
    [clients, loadingClients, activeClientId, activeClientData]
  );

  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

export function useClient() {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error("useClient must be used inside <ClientProvider />");
  return ctx;
}
