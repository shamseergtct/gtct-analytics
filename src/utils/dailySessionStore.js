// src/utils/dailySessionStore.js
import { db } from "../firebase";
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";

export function sessionDocId(clientId, dateKey) {
  return `${clientId}__${dateKey}`; // safe + direct lookup
}

export async function fetchDailySession(clientId, dateKey) {
  if (!clientId || !dateKey) return null;
  const ref = doc(db, "dailySessions", sessionDocId(clientId, dateKey));
  const snap = await getDoc(ref);
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function upsertDailySession(clientId, dateKey, patch) {
  if (!clientId || !dateKey) return;

  const ref = doc(db, "dailySessions", sessionDocId(clientId, dateKey));

  await setDoc(
    ref,
    {
      clientId,
      dateKey,
      ...patch,
      updatedAt: serverTimestamp(),
      // createdAt only set if it doesn't exist (merge keeps old)
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );
}
