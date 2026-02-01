// src/utils/txnReportsApi.js
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";

// Accepts "YYYY-MM-DD" OR "DD-MM-YYYY"
function parseYYYYMMDD_or_DDMMYYYY(s) {
  const x = String(s || "").trim();
  if (!x) return null;

  const parts = x.split("-").map((p) => p.trim());
  if (parts.length !== 3) return null;

  // Detect format
  // If first part has 4 digits => YYYY-MM-DD
  if (parts[0].length === 4) {
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if (!y || !m || !d) return null;
    return { y, m, d };
  }

  // Otherwise treat as DD-MM-YYYY
  const d = Number(parts[0]);
  const m = Number(parts[1]);
  const y = Number(parts[2]);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

function startOfDay(dateStr) {
  const p = parseYYYYMMDD_or_DDMMYYYY(dateStr);
  if (!p) return null;
  return new Date(p.y, p.m - 1, p.d, 0, 0, 0, 0);
}

function endOfDay(dateStr) {
  const p = parseYYYYMMDD_or_DDMMYYYY(dateStr);
  if (!p) return null;
  return new Date(p.y, p.m - 1, p.d, 23, 59, 59, 999);
}

function normType(t) {
  const x = String(t || "").trim().toLowerCase();
  if (!x) return "";
  if (x.startsWith("sal")) return "sales";
  if (x.startsWith("pur")) return "purchase";
  if (x.startsWith("rec")) return "receipt";
  if (x.startsWith("pay")) return "payment";
  if (x.startsWith("exp")) return "expense";
  if (x.startsWith("inc")) return "income";
  if (x.startsWith("tra")) return "transfer";
  if (x.startsWith("ref")) return "refill";
  return x;
}

function normMode(m) {
  const x = String(m || "").trim().toLowerCase();
  if (!x) return "";
  if (x.startsWith("cas")) return "cash";
  if (x.startsWith("ban")) return "bank";
  if (x.startsWith("upi")) return "bank";
  if (x.startsWith("car")) return "bank";
  if (x.startsWith("cre")) return "credit";
  if (x.includes("petti") || x.includes("petty")) return "petti cash";
  return x;
}

function isExcludedTxn(t) {
  if (!t) return true;
  if (t?.internalTransfer === true) return true;

  const ty = normType(t?.type);
  if (ty === "transfer" || ty === "refill") return true;

  return false;
}

/**
 * Fetch txns by client + date range ONLY (no type/mode/party filters in Firestore)
 * Then filter in JS to avoid type mismatches and reduce index needs.
 */
export async function fetchTxnRange({
  clientId,
  fromDate,
  toDate,
  typeKey,     // "sales"|"purchase"|...
  mode,        // optional UI value: "Cash"|"Bank"|"Petti Cash"|"Credit"
  partyId,     // optional
}) {
  if (!clientId) throw new Error("No active client selected");
  if (!fromDate || !toDate) throw new Error("Select From and To dates");

  const from = startOfDay(fromDate);
  const to = endOfDay(toDate);

  if (!from || !to) throw new Error("Invalid date format. Use YYYY-MM-DD.");
  if (from > to) throw new Error("From date cannot be after To date.");

  const qy = query(
    collection(db, "transactions"),
    where("clientId", "==", clientId),
    where("date", ">=", from),
    where("date", "<=", to),
    orderBy("date", "desc")
  );

  const snap = await getDocs(qy);

  const wantType = String(typeKey || "").trim().toLowerCase();
  const wantMode = mode ? normMode(mode) : ""; // "" means ALL
  const wantPartyId = partyId ? String(partyId).trim() : "";

  const rows = [];
  snap.forEach((docSnap) => {
    const d = docSnap.data();
    if (isExcludedTxn(d)) return;

    // ✅ Type filter in JS (normalized)
    if (wantType && normType(d?.type) !== wantType) return;

    // ✅ Mode filter in JS (normalized)
    if (wantMode) {
      if (normMode(d?.mode) !== wantMode) return;
    }

    // ✅ Party filter
    if (wantPartyId) {
      if (String(d?.partyId || "") !== wantPartyId) return;
    }

    rows.push({ id: docSnap.id, ...d });
  });

  return rows;
}
