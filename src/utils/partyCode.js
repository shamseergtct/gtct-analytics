/** Simple human party codes like C001, C002 for retail customer search. */

export function getPartyCode(party) {
  return String(party?.partyCode || party?.code || "").trim();
}

/** Collapse whitespace + lowercase for customer name uniqueness checks. */
export function normalizePartyName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Find another Customer/Both party with the same name (case-insensitive).
 * @returns {object|null} matching party, or null if free
 */
export function findDuplicateCustomerName(
  parties = [],
  name,
  { excludeId = "" } = {}
) {
  const key = normalizePartyName(name);
  if (!key) return null;
  const skip = String(excludeId || "").trim();
  return (
    (Array.isArray(parties) ? parties : []).find((party) => {
      if (skip && String(party?.id || "") === skip) return false;
      const type = String(party?.type || "").trim();
      if (type !== "Customer" && type !== "Both") return false;
      return normalizePartyName(party?.name) === key;
    }) || null
  );
}

export function nextPartyCode(parties = [], prefix = "C") {
  const re = new RegExp(`^${prefix}(\\d+)$`, "i");
  let max = 0;
  for (const party of parties) {
    const match = getPartyCode(party).match(re);
    if (match) max = Math.max(max, Number(match[1]) || 0);
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

export function partyMatchesQuery(party, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const phone = String(
    party?.phone || party?.mobile || party?.contact || ""
  )
    .toLowerCase()
    .replace(/\s+/g, "");
  const phoneDigits = phone.replace(/\D/g, "");
  const qPhone = q.replace(/\s+/g, "");
  const qDigits = q.replace(/\D/g, "");
  const location = [
    party?.houseOrBuilding,
    party?.landmark,
    party?.flat,
    party?.roadOrPost,
    party?.blockOrPin,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const hay = `${getPartyCode(party)} ${party?.name || ""} ${phone} ${location} ${
    party?.id || ""
  }`.toLowerCase();
  return (
    hay.includes(q) ||
    (qPhone.length > 0 && phone.includes(qPhone)) ||
    (qDigits.length >= 3 && phoneDigits.includes(qDigits))
  );
}
