/** Simple human party codes like C001, C002 for retail customer search. */

export function getPartyCode(party) {
  return String(party?.partyCode || party?.code || "").trim();
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
  const qPhone = q.replace(/\s+/g, "");
  const hay = `${getPartyCode(party)} ${party?.name || ""} ${phone} ${
    party?.id || ""
  }`.toLowerCase();
  return hay.includes(q) || (qPhone.length > 0 && phone.includes(qPhone));
}
