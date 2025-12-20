import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  where,
  documentId,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "./AuthContext";

const ClientContext = createContext(null);

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function ClientProvider({ children }) {
  const { user, role, assignedShops, authLoading, isSuperAdmin } = useAuth();

  // ✅ per-user LS key
  const LS_KEY = user?.uid
    ? `gtct_active_client_id__${user.uid}`
    : "gtct_active_client_id__guest";

  const [clients, setClients] = useState([]);
  const [activeClientId, setActiveClientId] = useState(() => localStorage.getItem(LS_KEY) || "");
  const [activeClientData, setActiveClientData] = useState(null);
  const [loadingClients, setLoadingClients] = useState(true);

  // ✅ Realtime clients list (RBAC safe)
  useEffect(() => {
    // wait until auth/profile loaded
    if (authLoading) return;

    // if not logged in or no role, clear
    if (!user || !role) {
      setClients([]);
      setLoadingClients(false);
      return;
    }

    setLoadingClients(true);

    // ---- Super Admin: can read all clients
    if (isSuperAdmin) {
      const qAll = query(collection(db, "clients"), orderBy("name", "asc"));
      const unsub = onSnapshot(
        qAll,
        (snap) => {
          const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          setClients(rows);
          setLoadingClients(false);

          // auto-pick first if no saved
          if (!localStorage.getItem(LS_KEY) && rows.length > 0) {
            setActiveClient(rows[0].id);
          }
        },
        (err) => {
          console.error("Clients snapshot error:", err);
          setClients([]);
          setLoadingClients(false);
        }
      );

      return () => unsub();
    }

    // ---- Admin/Partner: only assigned shops
    const shopIds = Array.isArray(assignedShops) ? assignedShops.filter(Boolean) : [];

    // if none assigned
    if (shopIds.length === 0) {
      setClients([]);
      setLoadingClients(false);
      // also clear active
      setActiveClient("");
      setActiveClientData(null);
      return;
    }

    // Firestore "in" supports max 10 items -> chunk
    const chunks = chunkArray(shopIds, 10);

    let isFirstEmission = true;
    const merged = new Map(); // id -> client

    const unsubs = chunks.map((ids) => {
      const qChunk = query(
        collection(db, "clients"),
        where(documentId(), "in", ids)
      );

      return onSnapshot(
        qChunk,
        (snap) => {
          snap.docs.forEach((d) => {
            merged.set(d.id, { id: d.id, ...d.data() });
          });

          // On first emission of any chunk, we will set loading false once
          // and always set sorted merged list
          const rows = Array.from(merged.values()).sort((a, b) =>
            String(a.name || "").localeCompare(String(b.name || ""))
          );

          setClients(rows);

          if (isFirstEmission) {
            isFirstEmission = false;
            setLoadingClients(false);

            // if no saved active, pick first
            if (!localStorage.getItem(LS_KEY) && rows.length > 0) {
              setActiveClient(rows[0].id);
            }
          }
        },
        (err) => {
          console.error("Clients snapshot error:", err);
          setLoadingClients(false);
        }
      );
    });

    // If chunks exist but no snapshot comes immediately, still stop loading after a moment is not needed;
    // snapshots will fire quickly normally.
    return () => unsubs.forEach((fn) => fn && fn());
  }, [authLoading, user, role, isSuperAdmin, assignedShops, LS_KEY]);

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
    localStorage.setItem(LS_KEY, clientId);
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
