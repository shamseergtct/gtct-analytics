/** Static TEST UI/API contract verification; runtime SQLite test is accept:split-payment. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../../', import.meta.url);
const read=(p)=>fs.readFileSync(new URL(p,root),'utf8');
const app=read('public/app.js');
const html=read('public/index.html');
const service=read('src/services/paymentAllocations.js');
const migration=read('src/db/migrations/035_credit_customer_binding.js');
const view=read('src/services/settlements.js');
let passed=0;
function ok(v,label){assert.ok(v,label);passed++;console.log('PASS '+label);}
for (const id of ['payment-credit-customer-wrap','payment-credit-search','payment-credit-selected','payment-credit-results',
  'payment-credit-create-save','payment-credit-new-name','payment-credit-new-phone']) {
  ok(html.includes(`id="${id}"`),`credit UI ${id}`);
}
ok(app.includes('creditSelectionNeeded()'),'dynamic credit visibility');
ok(app.includes('searchPaymentCreditCustomers()'),'customer lookup');
ok(app.includes('/v1/customers?q='),'existing directory search');
ok(app.includes('selectPaymentCreditCustomer('),'explicit customer selection');
ok(app.includes('(!creditRequired || state.payment.creditCustomer?.customerId)'),'credit disabled without customer');
ok(app.includes('creditCustomerId: creditCustomerId || undefined'),'credit customer sent to server');
ok(app.includes('bankAccountId, creditCustomerId, view.currencyCode'),'idempotency signature includes credit customer');
ok(service.includes("'CREDIT_CUSTOMER_REQUIRED'"),'server requires customer');
ok(service.includes("'CREDIT_CUSTOMER_INVALID'"),'server verifies customer belongs to shop');
ok(service.includes("'ORDER_CUSTOMER_MISMATCH'"),'existing order customer enforced');
ok(service.includes('credit_customer_id,created_by_user_id'),'credit customer saved to allocation');
ok(view.includes('creditCustomerId: creditOwner?.customer_id'),'payment summary exposes customer');
ok(migration.includes('ALTER TABLE order_payment_allocations'),'additive migration');
ok(app.includes('createPaymentCreditCustomer()'),'quick-create customer');
console.log(`Credit customer UI checks ${passed} passed (static; use Mac runtime for integration)`);
