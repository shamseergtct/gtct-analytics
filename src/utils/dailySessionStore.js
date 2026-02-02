// src/utils/dailySessionStore.js
import { db } from "../firebase";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";

/**
 * Storage Path (matches rules):
 * clients/{clientId}/dailySessions/{dateKey}
 * dateKey format: YYYY-MM-DD
 */

function cleanDateKey(dateKey) {
  return String(dateKey || "").trim();
}

function sessionRef(clientId, dateKey) {
  return doc(
    db,
    "clients",
    String(clientId),
    "dailySessions",
    cleanDateKey(dateKey)
  );
}

export async function fetchDailySession(clientId, dateKey) {
  if (!clientId || !dateKey) return null;

  try {
    const snap = await getDoc(sessionRef(clientId, dateKey));
    if (!snap.exists()) return null;

    return { id: snap.id, ...snap.data() };
  } catch (e) {
    console.error("fetchDailySession error:", e);
    throw e;
  }
}

export async function upsertDailySession(clientId, dateKey, patch = {}) {
  if (!clientId || !dateKey) return;

  try {
    await setDoc(
      sessionRef(clientId, dateKey),
      {
        clientId: String(clientId), // 🔴 REQUIRED BY RULE
        dateKey: cleanDateKey(dateKey),
        ...patch,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (e) {
    console.error("upsertDailySession error:", e);
    throw e;
  }
}
