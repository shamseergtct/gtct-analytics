/**
 * Unit checks for Delivery customer single-source-of-truth helpers
 * (mirrors app.js customerContactPhone / selectedCustomerId / hasValidDeliveryCustomer).
 * Run: node local-server/public/customer-truth.test.mjs
 */

function customerContactPhone(source) {
  if (!source || typeof source !== "object") return "";
  return String(
    source.customerPhone ??
      source.phone ??
      source.contactPhone ??
      source.contact_number ??
      source.contact ??
      source.mobile ??
      ""
  ).trim();
}

function selectedCustomerId(f = {}) {
  return String(f?.customerId || f?.customer_id || "").trim();
}

function hasValidDeliveryCustomer(f = {}) {
  return Boolean(selectedCustomerId(f) && customerContactPhone(f));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Phone field variants
assert(customerContactPhone({ phone: " 999 " }) === "999", "phone");
assert(customerContactPhone({ mobile: "111" }) === "111", "mobile");
assert(customerContactPhone({ contact: "222" }) === "222", "contact");
assert(customerContactPhone({ customerPhone: "333", phone: "x" }) === "333", "customerPhone wins");
assert(customerContactPhone({}) === "", "empty");

// Id variants + draft-shaped fulfillment
assert(selectedCustomerId({ customerId: "c1" }) === "c1", "customerId");
assert(selectedCustomerId({ customer_id: "c2" }) === "c2", "customer_id");
assert(
  hasValidDeliveryCustomer({ customerId: "c1", customerPhone: "555", customerName: "Ada" }),
  "draft with phone is valid"
);
assert(
  !hasValidDeliveryCustomer({ customerId: "c1", customerName: "Ada" }),
  "customer without phone is invalid"
);
assert(!hasValidDeliveryCustomer({ customerPhone: "555" }), "phone without id is invalid");
assert(!hasValidDeliveryCustomer({}), "empty fulfillment invalid");

function formatCustomerAddressLine(f) {
  const label = String(f?.addressLabel || "").trim();
  const building = String(f?.buildingNumber || "").trim();
  const road = String(f?.roadNumber || "").trim();
  const block = String(f?.blockNumber || "").trim();
  const buildingPart = building ? `Building ${building}` : "";
  const labelLower = label.toLowerCase();
  const labelDuplicatesBuilding =
    Boolean(building) &&
    (labelLower === building.toLowerCase() || labelLower === buildingPart.toLowerCase());
  const parts = [];
  if (label && !labelDuplicatesBuilding) parts.push(label);
  if (buildingPart) parts.push(buildingPart);
  if (road) parts.push(`Road ${road}`);
  if (block) parts.push(`Block ${block}`);
  return parts.join(" · ");
}

assert(
  formatCustomerAddressLine({ addressLabel: "628", buildingNumber: "628", roadNumber: "12" }) ===
    "Building 628 · Road 12",
  "dedupe label==building"
);
assert(
  formatCustomerAddressLine({ addressLabel: "Home", buildingNumber: "628" }) === "Home · Building 628",
  "keep distinct label"
);

console.log("customer-truth.test.mjs: ok");
