/**
 * Client money formatter — mirrors server util/money.js.
 * Uses integer minor units (price_cents). Never floats for arithmetic.
 */

export function createMoneyFormatter(shop = {}) {
  const decimals = Number(shop.currencyDecimals ?? shop.currency_decimals ?? 2);
  const label = String(
    shop.currencyLabel ?? shop.currency_label ?? shop.currencyCode ?? ""
  ).trim();
  const factor = 10 ** decimals;

  function format(minorUnits) {
    const n = Number(minorUnits || 0);
    const negative = n < 0;
    const abs = Math.abs(Math.trunc(n));
    const whole = Math.floor(abs / factor);
    const frac = abs % factor;
    const wholeStr = whole.toLocaleString("en-US");
    const fracStr =
      decimals > 0 ? `.${String(frac).padStart(decimals, "0")}` : "";
    const amount = `${negative ? "-" : ""}${wholeStr}${fracStr}`;
    return label ? `${label} ${amount}` : amount;
  }

  function formatPlain(minorUnits) {
    const n = Number(minorUnits || 0);
    const negative = n < 0;
    const abs = Math.abs(Math.trunc(n));
    const whole = Math.floor(abs / factor);
    const frac = abs % factor;
    const fracStr =
      decimals > 0 ? `.${String(frac).padStart(decimals, "0")}` : "";
    return `${negative ? "-" : ""}${whole}${fracStr}`;
  }

  function parse(raw) {
    let text = String(raw ?? "").trim().replace(/,/g, "");
    if (text.startsWith(".")) text = `0${text}`;
    else if (text.startsWith("-.")) text = `-0${text.slice(1)}`;
    if (!text) throw new Error("Price is required");
    if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error("Invalid price format");
    const parts = text.replace(/^-/, "").split(".");
    if (parts[1] && parts[1].length > decimals) {
      throw new Error(`Price allows at most ${decimals} decimal place(s)`);
    }
    const whole = Number(parts[0] || "0");
    const frac = parts[1] ? Number(parts[1].padEnd(decimals, "0")) : 0;
    let minor = whole * factor + frac;
    if (text.startsWith("-")) minor = -minor;
    return minor;
  }

  function step() {
    if (decimals <= 0) return "1";
    return `0.${"0".repeat(decimals - 1)}1`;
  }

  return {
    decimals,
    label,
    format,
    formatPlain,
    parse,
    step,
  };
}

/** Half-up integer division — mirrors server tax.js */
export function mulDivRoundHalfUp(a, b, d) {
  const aa = BigInt(a);
  const bb = BigInt(b);
  const dd = BigInt(d);
  if (dd === 0n) throw new Error("Division by zero");
  const prod = aa * bb;
  if (prod >= 0n) return Number((prod + dd / 2n) / dd);
  return Number((prod - dd / 2n) / dd);
}

/**
 * Client estimate of order tax using the same bucket rules as the server.
 * Marked as estimate until the server validates the order.
 */
export function estimateOrderTax(lines = [], shop = {}) {
  let taxable = 0;
  let nontaxable = 0;
  for (const line of lines) {
    const qty = Number(line.quantity || 1);
    const base = Number(line.priceCents || line.unitBasePriceCents || 0);
    const itemTax = line.taxApplicable !== false;
    if (itemTax) taxable += base * qty;
    else nontaxable += base * qty;
    for (const a of line.addons || []) {
      const unit = Number(
        a.unitPriceCents ?? a.priceCents ?? a.effectivePriceCents ?? 0
      );
      const aQty = Number(a.quantity || 1);
      const linePrice = unit * aQty * qty;
      if (a.taxApplicable !== false) taxable += linePrice;
      else nontaxable += linePrice;
    }
  }
  const goods = taxable + nontaxable;
  const enabled = Boolean(shop.taxEnabled);
  if (!enabled) {
    return {
      estimate: true,
      taxEnabled: false,
      taxMode: "",
      taxRateBps: 0,
      taxName: "",
      goodsCents: goods,
      taxableGoodsCents: taxable,
      nontaxableGoodsCents: nontaxable,
      netCents: goods,
      taxCents: 0,
      totalCents: goods,
    };
  }
  const mode = String(shop.taxMode || "exclusive").toLowerCase();
  const bps = Number(shop.taxRateBps || 0);
  const taxName = String(shop.taxName || "Tax").trim() || "Tax";
  if (mode === "inclusive") {
    const taxableNet =
      bps === 0 || taxable === 0
        ? taxable
        : mulDivRoundHalfUp(taxable, 10000, 10000 + bps);
    const tax = taxable - taxableNet;
    return {
      estimate: true,
      taxEnabled: true,
      taxMode: "inclusive",
      taxRateBps: bps,
      taxName,
      goodsCents: goods,
      taxableGoodsCents: taxable,
      nontaxableGoodsCents: nontaxable,
      netCents: taxableNet + nontaxable,
      taxCents: tax,
      totalCents: goods,
    };
  }
  const tax = mulDivRoundHalfUp(taxable, bps, 10000);
  return {
    estimate: true,
    taxEnabled: true,
    taxMode: "exclusive",
    taxRateBps: bps,
    taxName,
    goodsCents: goods,
    taxableGoodsCents: taxable,
    nontaxableGoodsCents: nontaxable,
    netCents: goods,
    taxCents: tax,
    totalCents: goods + tax,
  };
}

/** Same delivery-charge tax rules as the server. */
export function estimateDeliveryFeeTax(chargeCents, applicable, shop = {}) {
  const charge = Number(chargeCents || 0);
  if (!applicable || !Number.isInteger(charge) || charge <= 0 || !shop.taxEnabled) {
    return { taxCents: 0, addedCents: 0, treatment: "not_applied" };
  }
  const result = estimateOrderTax(
    [{ priceCents: charge, quantity: 1, taxApplicable: true, addons: [] }],
    shop
  );
  if (!result.taxEnabled || result.taxCents <= 0) {
    return { taxCents: 0, addedCents: 0, treatment: "not_applied" };
  }
  if (result.taxMode === "exclusive") {
    return { taxCents: result.taxCents, addedCents: result.taxCents, treatment: "added" };
  }
  return { taxCents: result.taxCents, addedCents: 0, treatment: "included" };
}

export function formatTaxPercentFromBps(bps) {
  const n = Number(bps || 0);
  const whole = Math.floor(n / 100);
  const frac = n % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0+$/, "")}`;
}
