const STORAGE_PREFIX = "gtct_day_summary_unlocked:";

export function daySummaryUnlockStorageKey(clientId) {
  return `${STORAGE_PREFIX}${String(clientId || "").trim()}`;
}

export function isDaySummarySessionUnlocked(clientId) {
  if (!clientId || typeof sessionStorage === "undefined") return false;
  return sessionStorage.getItem(daySummaryUnlockStorageKey(clientId)) === "1";
}

export function setDaySummarySessionUnlocked(clientId, unlocked) {
  if (!clientId || typeof sessionStorage === "undefined") return;
  const key = daySummaryUnlockStorageKey(clientId);
  if (unlocked) sessionStorage.setItem(key, "1");
  else sessionStorage.removeItem(key);
}

/** SHA-256 hex digest for a summary PIN/password. */
export async function hashDaySummaryPassword(value) {
  const text = String(value || "");
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyDaySummaryPassword(plain, storedHash) {
  const expected = String(storedHash || "").trim();
  if (!expected) return true;
  const actual = await hashDaySummaryPassword(plain);
  return actual === expected;
}
