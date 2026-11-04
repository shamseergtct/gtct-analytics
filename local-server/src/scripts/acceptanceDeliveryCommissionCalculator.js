/** No database, network, env or production side effects. Runs on Node 24. */
import assert from 'node:assert/strict';
import { evaluateDeliveryCommission as calc } from '../services/deliveryCommission.js';

const facts = (totalBillMinor=80000, deliveryChargeMinor=4000, eligibleDeliveryCount=10) =>
  ({currencyDecimals:3,totalBillMinor,deliveryChargeMinor,eligibleDeliveryCount});
const base = {method:'TIERED_FIXED',period:'DAILY',basis:'TOTAL_BILL',tiers:[
  {thresholdMinor:50000,rewardMinor:500},
  {thresholdMinor:80000,rewardMinor:1000},
]};
let tests=0;
const test=(name,fn)=>{fn(); tests++; console.log('PASS '+name);};
test('below-target-commission-zero',()=>assert.equal(calc(base,facts(49999,2000)).commissionMinor,0));
test('first-target-50-bhd-gives-0-500-bhd',()=>assert.equal(calc(base,facts(50000,2000)).commissionMinor,500));
test('between-tiers-uses-highest-eligible-reward-not-sum',()=>assert.equal(calc(base,facts(79999,2000)).commissionMinor,500));
test('80-bhd-target-gives-1-000-not-1-500',()=>assert.equal(calc(base,facts()).commissionMinor,1000));
test('fixed-per-delivery-multiplied-once-by-eligible-count',()=>assert.equal(calc({method:'FIXED_PER_DELIVERY',amountMinor:100},facts()).commissionMinor,1000));
test('percentage-of-total-5-percent',()=>assert.equal(calc({method:'PERCENTAGE',basis:'TOTAL_BILL',rateBps:500},facts()).commissionMinor,4000));
test('percentage-of-delivery-charge-5-percent',()=>assert.equal(calc({method:'PERCENTAGE',basis:'DELIVERY_CHARGE',rateBps:500},facts()).commissionMinor,200));
test('percentage-half-up-at-one-fils',()=>assert.equal(calc({method:'PERCENTAGE',basis:'DELIVERY_CHARGE',rateBps:500},facts(101,11,1)).commissionMinor,1));
test('manual-bhd-three-decimal',()=>assert.equal(calc({method:'MANUAL',amountMinor:750},facts()).commissionMinor,750));
test('no-commission',()=>assert.equal(calc({method:'NONE'},facts()).commissionMinor,0));
test('no-eligible-delivery-no-commission',()=>assert.equal(calc(base,facts(0,0,0)).commissionMinor,0));
test('shift-target-config-accepted',()=>assert.equal(calc({...base,period:'SHIFT'},facts()).period,'SHIFT'));
test('duplicate-threshold-rejected',()=>assert.throws(()=>calc({...base,tiers:[base.tiers[0],base.tiers[0]]},facts())));
test('floating-fils-rejected',()=>assert.throws(()=>calc({method:'MANUAL',amountMinor:0.5},facts())));
test('negative-reward-rejected',()=>assert.throws(()=>calc({method:'MANUAL',amountMinor:-1},facts())));
test('over-100-percent-rejected',()=>assert.throws(()=>calc({method:'PERCENTAGE',basis:'TOTAL_BILL',rateBps:10001},facts())));
test('safe-integer-overflow-rejected',()=>assert.throws(()=>calc({method:'FIXED_PER_DELIVERY',amountMinor:Number.MAX_SAFE_INTEGER},facts())));
test('tiered-delivery-charge-basis',()=>assert.equal(calc({...base,basis:'DELIVERY_CHARGE'},facts(80000,60000)).commissionMinor,500));
console.log(`Commission evaluator ${tests} passed (pure functions; NO DB or money posting).`);
