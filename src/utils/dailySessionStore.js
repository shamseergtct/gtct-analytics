// src/utils/dailySessionStore.js
import { db } from "../firebase";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";

/**
 * Daily report closings are stored in:
 *   client_settings/{clientId}.dailyClosings["YYYY-MM-DD"]
 *
 * (Uses the same collection as opening inputs — avoids permission issues
 *  with clients/{clientId}/dailySessions subcollection.)
 */

function cleanDateKey(dateKey) {
  return String(dateKey || "").trim();
}

function clientSettingsRef(clientId) {
  return doc(db, "client_settings", String(clientId));
}

/** Legacy path — kept for read fallback only */
function legacySessionRef(clientId, dateKey) {
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

  const key = cleanDateKey(dateKey);

  try {
    const snap = await getDoc(clientSettingsRef(clientId));
    if (snap.exists()) {
      const closings = snap.data()?.dailyClosings || {};
      const session = closings[key];
      if (session) {
        return { id: key, dateKey: key, clientId: String(clientId), ...session };
      }
    }
  } catch (e) {
    console.error("fetchDailySession (client_settings) error:", e);
  }

  // Legacy fallback (may fail if rules block subcollection)
  try {
    const snap = await getDoc(legacySessionRef(clientId, key));
    if (snap.exists()) {
      return { id: snap.id, ...snap.data() };
    }
  } catch (e) {
    console.warn("fetchDailySession legacy path unavailable:", e?.message || e);
  }

  return null;
}

export async function upsertDailySession(clientId, dateKey, patch = {}) {
  if (!clientId || !dateKey) return;

  const key = cleanDateKey(dateKey);

  try {
    const ref = clientSettingsRef(clientId);
    const snap = await getDoc(ref);
    const allClosings = snap.exists() ? { ...(snap.data()?.dailyClosings || {}) } : {};
    const existing = allClosings[key] || {};

    allClosings[key] = {
      ...existing,
      ...patch,
      dateKey: key,
    };

    await setDoc(
      ref,
      {
        clientId: String(clientId),
        dailyClosings: allClosings,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (e) {
    console.error("upsertDailySession error:", e);
    throw e;
  }
}
