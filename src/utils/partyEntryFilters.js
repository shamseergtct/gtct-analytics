/**
 * Party-type filters for purchase / expense / payment / receipt pickers.
 */

function normType(party) {
  return String(party?.type || "").trim().toLowerCase();
}

export function isVendorParty(party) {
  const type = normType(party);
  return type === "supplier" || type === "vendor";
}

export function isEmployeeParty(party) {
  return normType(party) === "employee";
}

export function isCustomerParty(party) {
  return normType(party) === "customer";
}

export function isBothParty(party) {
  return normType(party) === "both";
}

export function isLenderParty(party) {
  return normType(party) === "lender";
}

export function isOwnerOrPartnerParty(party) {
  const type = normType(party);
  return type === "owner" || type === "partner";
}

/** Purchase / expense entry modes */
export function partyAllowedForPurchaseExpense(party, entryMode) {
  const vendor = isVendorParty(party);
  const employee = isEmployeeParty(party);
  const both = isBothParty(party);
  const lender = isLenderParty(party);
  const owner = isOwnerOrPartnerParty(party);
  if (entryMode === "purchase") {
    return vendor || both || lender || owner;
  }
  // expense
  return vendor || employee || both || lender || owner;
}

/** Payment / receipt entry modes */
export function partyAllowedForPaymentReceipt(party, entryMode) {
  const vendor = isVendorParty(party);
  const employee = isEmployeeParty(party);
  const customer = isCustomerParty(party);
  const both = isBothParty(party);
  const lender = isLenderParty(party);
  const owner = isOwnerOrPartnerParty(party);
  if (entryMode === "receipt") {
    return customer || both || lender || owner;
  }
  // payment
  return vendor || employee || both || lender || owner;
}
