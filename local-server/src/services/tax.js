/**
 * Shop tax engine — Phase 1.7 + 1.8 mixed taxable / non-taxable components.
 *
 * Rounding policy (documented):
 *   All monetary results are integer minor units.
 *   Intermediate products use BigInt.
 *   Division uses half-up rounding away from zero on the quotient.
 *   Tax is rounded once on the order-level taxable goods total
 *   (not per-line), then combined with non-taxable goods.
 *
 * Tax rate is stored as basis points (bps): 1% = 100 bps, 10% = 1000 bps.
 *
 * Modes:
 *   disabled  — tax=0; customer total = goods
 *   exclusive — tax = round(taxable * bps / 10000); total = goods + tax
 *   inclusive — extract tax only from taxable gross;
 *               total = taxable + nontaxable (selling prices unchanged)
 *
 * Negative taxable or non-taxable buckets are rejected (not clamped).
 */

export const TAX_MODES = Object.freeze(["exclusive", "inclusive"]);

/** Half-up integer division of (a * b) / d using BigInt. */
export function mulDivRoundHalfUp(a, b, d) {
  const aa = BigInt(a);
  const bb = BigInt(b);
  const dd = BigInt(d);
  if (dd === 0n) throw new Error("Division by zero");
  const prod = aa * bb;
  if (prod >= 0n) {
    return Number((prod + dd / 2n) / dd);
  }
  return Number((prod - dd / 2n) / dd);
}

export function assertTaxRateBps(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || !Number.isFinite(n) || n < 0 || n > 100_000) {
    throw Object.assign(
      new Error("taxRateBps must be an integer from 0 to 100000 (0%–1000%)"),
      { status: 400 }
    );
  }
  return n;
}

export function parseTaxPercentInput(raw) {
  const text = String(raw ?? "").trim().replace(/,/g, "");
  if (!text) {
    throw Object.assign(new Error("Tax percentage is required"), { status: 400 });
  }
  if (!/^\d+(\.\d{1,4})?$/.test(text)) {
    throw Object.assign(
      new Error("Tax percentage must be non-negative with at most 4 decimal places"),
      { status: 400 }
    );
  }
  const [whole, frac = ""] = text.split(".");
  const padded = (frac + "0000").slice(0, 4);
  const micros = Number(whole) * 10000 + Number(padded);
  const bps = mulDivRoundHalfUp(micros, 1, 100);
  return assertTaxRateBps(bps);
}

export function formatTaxPercentFromBps(bps) {
  const n = Number(bps || 0);
  const whole = Math.floor(n / 100);
  const frac = n % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0+$/, "")}`;
}

function assertNonNegBucket(n, label) {
  const v = Number(n || 0);
  if (!Number.isInteger(v) || !Number.isFinite(v)) {
    throw Object.assign(new Error(`${label} must be a finite integer`), {
      status: 400,
    });
  }
  if (v < 0) {
    throw Object.assign(
      new Error(
        `${label} cannot be negative (${v}). Check signed add-on tax flags.`
      ),
      { status: 400 }
    );
  }
  return v;
}

/**
 * Split unit-level amounts into taxable / non-taxable buckets.
 * @param {number} unitBaseCents
 * @param {boolean} itemTaxApplicable
 * @param {Array<{ linePriceCents: number, taxApplicable?: boolean }>} addons
 */
export function splitUnitTaxBuckets(unitBaseCents, itemTaxApplicable, addons = []) {
  const base = Number(unitBaseCents || 0);
  let taxable = 0;
  let nontaxable = 0;
  if (itemTaxApplicable) taxable += base;
  else nontaxable += base;
  for (const a of addons || []) {
    const p = Number(a.linePriceCents || 0);
    if (a.taxApplicable !== false) taxable += p;
    else nontaxable += p;
  }
  return { taxableUnitCents: taxable, nontaxableUnitCents: nontaxable };
}

/**
 * @param {{ taxableCents: number, nontaxableCents: number }} buckets
 * @param {{ taxEnabled: boolean, taxMode: string, taxRateBps: number, taxName?: string }} shopTax
 */
export function computeOrderTaxFromBuckets(buckets = {}, shopTax = {}) {
  const taxable = assertNonNegBucket(buckets.taxableCents, "Taxable goods");
  const nontaxable = assertNonNegBucket(
    buckets.nontaxableCents,
    "Non-taxable goods"
  );
  const goods = taxable + nontaxable;

  const enabled = Boolean(shopTax.taxEnabled);
  if (!enabled) {
    return {
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

  const mode = String(shopTax.taxMode || "exclusive").toLowerCase();
  if (!TAX_MODES.includes(mode)) {
    throw Object.assign(
      new Error(`Unsupported tax mode: ${shopTax.taxMode}`),
      { status: 400 }
    );
  }
  const bps = assertTaxRateBps(shopTax.taxRateBps ?? 0);
  const taxName = String(shopTax.taxName || "Tax").trim() || "Tax";

  if (mode === "exclusive") {
    const tax = mulDivRoundHalfUp(taxable, bps, 10000);
    return {
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

  // inclusive — extract tax only from taxable gross
  const taxableNet =
    bps === 0 || taxable === 0
      ? taxable
      : mulDivRoundHalfUp(taxable, 10000, 10000 + bps);
  const tax = taxable - taxableNet;
  return {
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

/**
 * Backward-compatible: treat entire goods amount as taxable.
 */
/**
 * Tax on a delivery charge, using the shop rate.
 * Inclusive: the entered charge already includes tax (customer pays that amount).
 * Exclusive: tax is added on top of the entered charge.
 * A charge that is not marked taxable, or a shop with tax off, stays untaxed.
 */
export function computeDeliveryFeeTax(chargeCents, applicable, shopTax = {}) {
  const charge = Number(chargeCents || 0);
  if (!applicable || !Number.isInteger(charge) || charge <= 0 || !shopTax.taxEnabled) {
    return { taxCents: 0, addedCents: 0, treatment: "not_applied" };
  }
  const result = computeOrderTaxFromBuckets(
    { taxableCents: charge, nontaxableCents: 0 },
    shopTax
  );
  if (!result.taxEnabled || result.taxCents <= 0) {
    return { taxCents: 0, addedCents: 0, treatment: "not_applied" };
  }
  if (result.taxMode === "exclusive") {
    return { taxCents: result.taxCents, addedCents: result.taxCents, treatment: "added" };
  }
  return { taxCents: result.taxCents, addedCents: 0, treatment: "included" };
}

export function computeOrderTax(goodsCents, shopTax = {}) {
  const goods = Number(goodsCents || 0);
  return computeOrderTaxFromBuckets(
    { taxableCents: goods, nontaxableCents: 0 },
    shopTax
  );
}

/** Synthetic preview samples for Shop Settings receipt UI. */
export function buildTaxPreviewSamples(shop) {
  const decimals = Number(shop.currencyDecimals ?? 2);
  const factor = 10 ** decimals;
  const sampleGoods = 10 * factor;
  const base = {
    taxEnabled: Boolean(shop.taxEnabled),
    taxMode: shop.taxMode || "exclusive",
    taxRateBps: Number(shop.taxRateBps || 0),
    taxName: shop.taxName || "VAT",
  };
  return {
    disabled: computeOrderTax(sampleGoods, { ...base, taxEnabled: false }),
    exclusive: computeOrderTax(sampleGoods, {
      ...base,
      taxEnabled: true,
      taxMode: "exclusive",
      taxRateBps: base.taxRateBps || 1000,
    }),
    inclusive: computeOrderTax(sampleGoods, {
      ...base,
      taxEnabled: true,
      taxMode: "inclusive",
      taxRateBps: base.taxRateBps || 1000,
    }),
    active: computeOrderTax(sampleGoods, base),
  };
}
