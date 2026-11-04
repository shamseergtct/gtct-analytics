/**
 * P2-E3A pure commission policy evaluator (TEST FOUNDATION ONLY).
 * NO persistence, accounting, payment posting, invoice updates or permissions.
 * All amounts use integer minor units at the shop's currency-decimal scale.
 * For BHD (3 decimals), 50.000 BHD is 50000 minor units.
 * Caller must select only eligible distinct completed deliveries and its period.
 * Historic accrued rewards must snapshot their policy at calculation time.
 */
const METHODS = new Set(['FIXED_PER_DELIVERY', 'TIERED_FIXED', 'PERCENTAGE', 'MANUAL', 'NONE']);
const PERIODS = new Set(['DAILY', 'SHIFT', 'MONTHLY', 'SETTLEMENT']);
const BASES = new Set(['TOTAL_BILL', 'DELIVERY_CHARGE']);

function inputError(label) {
  throw Object.assign(new Error(`Invalid ${label}.`), {code: 'INVALID_COMMISSION_POLICY',status:400});
}
function amount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) inputError(label);
  return value;
}
function checkedMultiply(a,b,label) {
  const out = a*b;
  if (!Number.isSafeInteger(out)) inputError(`${label} overflow`);
  return out;
}
function roundHalfUpDivision(numerator, divisor) {
  if (!Number.isSafeInteger(numerator) || numerator < 0 || !Number.isSafeInteger(divisor) || divisor <= 0) {
    inputError('percentage arithmetic');
  }
  return Math.floor(numerator / divisor) + (numerator % divisor >= divisor/2 ? 1 : 0);
}
/**
 * @param {object} policy - immutable policy snapshot
 * @param {object} facts - verified aggregates for a SINGLE period and currency
 * @returns {{commissionMinor:number,method:string,period:string,basis:string|null}}
 */
export function evaluateDeliveryCommission(policy, facts) {
  if (!policy || typeof policy !== 'object' || !facts || typeof facts !== 'object') inputError('configuration');
  const method = policy.method;
  const period = policy.period ?? 'DAILY';
  if (!METHODS.has(method) || !PERIODS.has(period)) inputError('method or period');
  const decimals = facts.currencyDecimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) inputError('currency decimals');
  const deliveryCount = amount(facts.eligibleDeliveryCount, 'eligible delivery count');
  const totalBillMinor = amount(facts.totalBillMinor, 'total bill amount');
  const deliveryChargeMinor = amount(facts.deliveryChargeMinor, 'delivery charge');
  if (deliveryCount === 0 && (totalBillMinor !== 0 || deliveryChargeMinor !== 0)) inputError('nonzero totals with zero eligible deliveries');
  if (deliveryCount > 0 && deliveryChargeMinor > totalBillMinor) inputError('delivery charge over total');
  if (deliveryCount === 0) return { commissionMinor:0, method, period, basis:null };
  let reward = 0;
  let basis = null;
  if (method === 'FIXED_PER_DELIVERY') {
    reward = checkedMultiply(amount(policy.amountMinor,'fixed amount'), deliveryCount,'fixed commission');
  } else if (method === 'TIERED_FIXED') {
    basis = policy.basis ?? 'TOTAL_BILL';
    if (!BASES.has(basis) || !Array.isArray(policy.tiers) || policy.tiers.length === 0 || policy.tiers.length > 100) inputError('tiers');
    const eligibleMinor = basis === 'TOTAL_BILL' ? totalBillMinor : deliveryChargeMinor;
    let previous = -1;
    for (const tier of policy.tiers) {
      if (!tier || typeof tier !== 'object') inputError('tier entry');
      const threshold = amount(tier.thresholdMinor,'tier threshold');
      const award = amount(tier.rewardMinor,'tier reward');
      if (threshold <= previous) inputError('tier ordering');
      previous = threshold;
      if (eligibleMinor >= threshold) reward = award;
    }
  } else if (method === 'PERCENTAGE') {
    basis = policy.basis;
    if (!BASES.has(basis)) inputError('percentage basis');
    const rateBps = amount(policy.rateBps,'percentage basis points');
    if (rateBps > 10000) inputError('percentage above 100%');
    const eligibleMinor = basis === 'TOTAL_BILL' ? totalBillMinor : deliveryChargeMinor;
    reward = roundHalfUpDivision(checkedMultiply(eligibleMinor, rateBps,'percentage'), 10000);
  } else if (method === 'MANUAL') {
    // Manager authorization MUST be enforced by the future posting layer.
    reward = amount(policy.amountMinor,'manual amount');
  }
  return { commissionMinor:reward, method, period, basis };
}
