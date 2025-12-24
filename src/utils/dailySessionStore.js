// src/utils/dailySessionStore.js
import { db } from "../firebase";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";

export function sessionDocId(clientId, dateKey) {
  return `${clientId}__${dateKey}`;
}

/**
 * ✅ Important fix:
 * If the dailySessions doc does NOT exist yet, your Firestore rule blocks reads
 * (because resource.data.clientId can't be evaluated on a missing document).
 *
 * So we auto-create a minimal doc first, then read it.
 */
export async function fetchDailySession(clientId, dateKey) {
  if (!clientId || !dateKey) return null;

  const ref = doc(db, "dailySessions", sessionDocId(clientId, dateKey));

  try {
    const snap = await getDoc(ref);
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (e) {
    // Most common here: permission-denied on missing doc
    // Create a minimal placeholder session, then read again.
    try {
      await setDoc(
        ref,
        {
          clientId,
          dateKey,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      const snap2 = await getDoc(ref);
      return snap2.exists() ? { id: snap2.id, ...snap2.data() } : null;
    } catch (e2) {
      // If create also fails, throw the original error
      throw e;
    }
  }
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
    },
    { merge: true }
  );
}
