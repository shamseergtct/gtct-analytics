// src/utils/accountingV2/constants.js

export const PARTY_TYPES = Object.freeze([
  "customer",
  "supplier",
  "both",
  "employee",
  "owner_partner",
  "other",
]);

export const DISCOUNT_TYPES = Object.freeze(["invoice", "settlement"]);
export const DISCOUNT_SIDES = Object.freeze(["customer", "supplier"]);

export const DEFAULTS = Object.freeze({
  currency: "INR",
});
