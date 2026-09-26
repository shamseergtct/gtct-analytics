import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function loadReportInputs(clientId) {
  if (!clientId) return null;

  const ref = doc(db, "client_settings", String(clientId));
  const snap = await getDoc(ref);

  if (!snap.exists()) return null;

  const d = snap.data() || {};
  const r = d.reportDefaults || {};

  return {
    openingCash: num(r.openingCash),
    openingBank: num(r.openingBank),
  };
}

export async function saveReportInputs(clientId, { openingCash, openingBank }) {
  if (!clientId) return;

  const ref = doc(db, "client_settings", String(clientId));

  await setDoc(
    ref,
    {
      clientId: String(clientId), // 🔴 RULE REQUIRES THIS
      reportDefaults: {
        openingCash: num(openingCash),
        openingBank: num(openingBank),
      },
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}
