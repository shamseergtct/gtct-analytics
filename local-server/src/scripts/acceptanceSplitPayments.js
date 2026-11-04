/** P2-E2C3A — temporary, loopback, TEST-only cashier payment allocation acceptance. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ensureDataDirs } from '../config.js';
import { openDatabase,runMigrations,closeDatabase,getDb } from '../db/db.js';
import { seedSampleData } from '../seed/sampleData.js';
import { initLogger } from '../util/logger.js';
import { createServer } from '../http/server.js';
import { httpJson,openRoleSessions } from './testHttp.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'gtct-p2e2c3a-'));
process.env.GTCT_LOCAL_DATA_DIR=root;
process.env.GTCT_LOCAL_HOST='127.0.0.1';
process.env.GTCT_LOCAL_PORT='19042';
for (const x of ['GTCT_TLS_CERT_FILE','GTCT_TLS_KEY_FILE','GTCT_ALLOW_LAN_BIND',
  'GTCT_ENABLE_LAN_LISTENER','GTCT_LAN_BIND_ADDRESS','GTCT_ENABLE_PHYSICAL_PRINT',
  'GTCT_LOCAL_OPERATING_MODE','GTCT_TEST_BACKUP_DIR','GTCT_ENABLE_TEST_AUTO_BACKUP']) delete process.env[x];
let passed=0;
function must(value,message) {if(!value) throw new Error(message || 'assert failed');}
function pass(message) {console.log(`PASS ${message}`);passed++;}
const config=loadConfig({mode:'http'});
const port=config.port;
let server;
const api=(method,endpoint,cookie,body)=>httpJson(port,method,endpoint,cookie,body);
function snap(id){return getDb().prepare(`SELECT total_cents,tax_cents,goods_cents,status,is_test
  FROM orders WHERE order_id=?`).get(id);}
async function order(cookie,key){
  const r=await api('POST','/v1/test-orders',cookie,{
    submissionId:`sub-split-${key}`,orderType:'TAKEAWAY',
    lines:[{itemId:'item_orange_juice',quantity:1}],
  });
  must(r.status===201,`order ${key}: ${r.status} ${r.json?.error}`);
  return {id:r.json.order.order_id,total:r.json.order.total_cents,currency:r.json.order.currency_code};
}
let creditCustomerId = '';
async function post(cookie,ord,key,cash,bank,credit,bankAccountId){
  return api('POST',`/v1/orders/${ord.id}/payment-allocations`,cookie,{
    submissionId:`split-${key}-req`,cashCents:cash,bankCents:bank,creditCents:credit,
    currencyCode:ord.currency,...(bankAccountId?{bankAccountId}:{}),
    ...(credit?{creditCustomerId}:{})
  });
}
try {
  must(config.operatingMode==='TEST' && config.loopback && !config.physicalPrintEnabled &&
    path.resolve(config.dbPath).startsWith(path.resolve(root)+path.sep),'safe TEST mode');
  pass('isolated-loopback-temporary-TEST');
  ensureDataDirs(config);initLogger(config.logDir);openDatabase(config.dbPath);
  await runMigrations(getDb());seedSampleData(config);
  const schema=getDb().prepare(`SELECT name FROM sqlite_master WHERE name='order_payment_allocations'`).get();
  must(!!schema,'migration table missing');pass('additive-migration-applied');
  server=createServer(config);
  await new Promise((ok,err)=>{server.once('error',err);server.listen(port,config.host,ok);});
  const {admin,device:cashier}=await openRoleSessions(port,config.testTenantId);
  pass('admin-cashier-authenticated');
  const ops=await api('POST','/v1/bank-accounts',admin,{
    displayName:'TEST Operating',bankName:'TEST Bank',accountType:'OPERATIONAL',isActive:true,
  });
  must(ops.status===201,`bank: ${ops.json?.error}`);const bankId=ops.json.account.accountId;
  pass('test-operational-bank');
  const reserve=await api('POST','/v1/bank-accounts',admin,{
    displayName:'TEST Reserve',bankName:'TEST Bank',accountType:'RESERVE',isActive:true,
  });
  must(reserve.status===201,'reserve');pass('test-reserve-bank');
  const customer = await api('POST','/v1/customers',admin,{name:'TEST Credit Customer',phone:'35555444'});
  must(customer.status===201 && customer.json?.customer?.customerId,'credit customer create');
  creditCustomerId = customer.json.customer.customerId;
  pass('credit-customer-created-in-test-shop');
  const first=await order(cashier,'one');const before=snap(first.id);
  must(first.total>10,'nonzero sale');pass('unaltered-order-created');
  const guest=await post(null,first,'guest',1,0,0);
  must(guest.status===401,'guest wrote allocation');pass('guest-cannot-post');
  const empty=await post(cashier,first,'zero',0,0,0);
  must(empty.status===400,'empty written');pass('zero-allocation-rejected');
  const badNegative=await post(cashier,first,'negative',-1,0,0);
  must(badNegative.status===400,'negative written');pass('negative-allocation-rejected');
  const badFloat=await post(cashier,first,'float',1.5,0,0);
  must(badFloat.status===400,'float written');pass('fractional-minor-unit-rejected');
  const missingBank=await post(cashier,first,'missingbank',0,1,0);
  must(missingBank.status===400,'missing bank allowed');pass('bank-account-required');
  const reserved=await post(cashier,first,'reserve',0,1,0,reserve.json.account.accountId);
  must(reserved.status===400,'reserve used');pass('reserve-bank-rejected');
  const over=await post(cashier,first,'over',first.total+1,0,0);
  must(over.status===409,'overpay posted');pass('overpayment-prevented');
  const cash=10;
  const partial=await post(cashier,first,'initialcash',cash,0,0);
  must(partial.status===201 && partial.json.summary.paidCents===cash &&
    partial.json.summary.unallocatedCents===first.total-cash,'cash partial');
  pass('partial-cash-recorded');
  const payment=await api('GET',`/v1/orders/${first.id}/settlements`,cashier);
  must(payment.status===200 && payment.json.paymentStatus==='PARTIAL' &&
    payment.json.cashCents===cash && payment.json.balanceCents===first.total-cash,'payment view');
  pass('shop-payment-read-is-authoritative');
  const same=await post(cashier,first,'initialcash',cash,0,0);
  must(same.status===200 && same.json.replayed && !same.json.created,'duplicate posted');
  pass('same-submission-idempotent');
  const changed=await post(cashier,first,'initialcash',cash+1,0,0);
  must(changed.status===409 && changed.json.code==='SUBMISSION_CONFLICT','submission changed');
  pass('changed-submission-rejected');
  const legacy=await api('POST',`/v1/orders/${first.id}/settlements`,cashier,{
    submissionId:'split-old-full-x',tender:'CASH',amountCents:first.total,currencyCode:first.currency,
  });
  must(legacy.status===409 && legacy.json.code==='SPLIT_PAYMENT_EXISTS','old full post accepted');
  pass('legacy-full-payment-blocked-after-split');
  const remaining=first.total-cash;
  const bankAmount=Math.floor(remaining/2);
  const creditAmount=remaining-bankAmount;
  const creditMissing=await api('POST',`/v1/orders/${first.id}/payment-allocations`,cashier,{
    submissionId:'split-credit-missing-customer',cashCents:0,bankCents:0,creditCents:creditAmount,
    currencyCode:first.currency
  });
  must(creditMissing.status===400 && creditMissing.json.code==='CREDIT_CUSTOMER_REQUIRED','credit without customer accepted');
  pass('customer-required-server-side-for-credit');
  const creditUnknown=await api('POST',`/v1/orders/${first.id}/payment-allocations`,cashier,{
    submissionId:'split-credit-unknown-customer',cashCents:0,bankCents:0,creditCents:creditAmount,
    creditCustomerId:'cust_not_a_real_customer',currencyCode:first.currency
  });
  must(creditUnknown.status===400 && creditUnknown.json.code==='CREDIT_CUSTOMER_INVALID','unknown customer accepted');
  pass('credit-customer-must-exist-in-shop');
  const mixed=await post(cashier,first,'mixed',0,bankAmount,creditAmount,bankId);
  must(mixed.status===201 && mixed.json.summary.unallocatedCents===0,'mixed allocation');
  pass('mixed-bank-plus-credit-authorized');
  const final=await api('GET',`/v1/orders/${first.id}/settlements`,cashier);
  must(final.json.paymentStatus==='PARTIAL' && final.json.creditCents===creditAmount &&
    final.json.bankCents===bankAmount && final.json.paidCents===cash+bankAmount,'mixed read');
  pass('split-status-and-credit-not-misclassified-paid');
  const extra=await post(cashier,first,'extra',1,0,0);
  must(extra.status===409,'allocation over full amount');pass('fully-allocated-not-double-posted');
  const register=await api('GET',`/v1/order-register/${first.id}`,cashier);
  must(register.status===200 && register.json.order?.paymentStatus==='PARTIAL' &&
    register.json.order?.hasAllocations===true,'register mismatch');
  pass('orders-register-reflects-splits');
  const frozen=snap(first.id);
  must(JSON.stringify(frozen)===JSON.stringify(before),'order total/tax mutated');
  pass('order-total-tax-status-untouched');
  const allocations=await api('GET',`/v1/orders/${first.id}/payment-allocations`,cashier);
  must(allocations.status===200 && allocations.json.allocations.length===2,'allocation count');
  pass('immutable-auditable-allocation-events');
  must(allocations.json.allocations[1].creditCustomerId===creditCustomerId,
    'credit allocation did not store customer id');
  pass('credit-customer-id-persisted');
  const paymentWithCustomer=await api('GET',`/v1/orders/${first.id}/settlements`,cashier);
  must(paymentWithCustomer.json.creditCustomerId===creditCustomerId &&
    paymentWithCustomer.json.creditCustomerName==='TEST Credit Customer','payment customer missing');
  pass('payment-view-displays-credit-customer');
  const audit=getDb().prepare(`SELECT COUNT(*) n FROM audit_events WHERE action='payment.split.allocate'`).get();
  must(audit.n===2,'audit entries');pass('audit-entry-for-each-new-allocation');
  const second=await order(cashier,'two');
  const creditOnly=await post(cashier,second,'creditonly',0,0,second.total);
  must(creditOnly.status===201 && creditOnly.json.summary.paymentStatus==='CREDIT' &&
    creditOnly.json.summary.paidCents===0,'credit incorrectly paid');
  pass('full-credit-approved-without-cash-posting');
  const creditRepeat=await post(cashier,second,'creditonly',0,0,second.total);
  must(creditRepeat.status===200 && creditRepeat.json.replayed,'credit replay missing');
  pass('credit-payment-idempotent-with-customer');
  const pending=await api('GET','/v1/pending-payments',cashier);
  must(!(pending.json.orders||[]).some(o=>o.orderId===second.id),'credit in unallocated queue');
  pass('authorized-credit-not-in-unallocated-queue');
  const third=await order(cashier,'three');
  const wrongCashCustomer=await api('POST',`/v1/orders/${third.id}/payment-allocations`,cashier,{
    submissionId:'split-noncredit-customer',cashCents:third.total,bankCents:0,creditCents:0,
    creditCustomerId,currencyCode:third.currency
  });
  must(wrongCashCustomer.status===400 && wrongCashCustomer.json.code==='CREDIT_CUSTOMER_NOT_APPLICABLE',
    'customer persisted against cash-only');
  pass('credit-binding-not-applicable-to-cash-only');
  const fullCash=await post(cashier,third,'fullcash',third.total,0,0);
  must(fullCash.status===201 && fullCash.json.summary.paymentStatus==='PAID','full cash');
  pass('full-cash-allocation-becomes-paid');
  const fourth=await order(cashier,'four');
  const oldPaid=await api('POST',`/v1/orders/${fourth.id}/settlements`,cashier,{
    submissionId:'legacy-paid-c3-a',tender:'CASH',amountCents:fourth.total,currencyCode:fourth.currency,
  });
  must(oldPaid.status===201,'legacy full payment');pass('legacy-full-payment-remains-working');
  const cannotSplit=await post(cashier,fourth,'alreadyold',1,0,0);
  must(cannotSplit.status===409,'split after legacy accepted');pass('split-blocked-on-historical-full-payment');
  const unauthorized=await post(null,third,'unauth',1,0,0);
  must(unauthorized.status===401,'anonymous write');pass('anonymous-write-denied');
  const fifth=await order(cashier,'five');
  const wrongCurrency=await api('POST',`/v1/orders/${fifth.id}/payment-allocations`,cashier,{
    submissionId:'split-wrong-currency',cashCents:1,bankCents:0,creditCents:0,currencyCode:'OTHER',
  });
  must(wrongCurrency.status===400 && wrongCurrency.json.code==='CURRENCY_MISMATCH','currency mismatch');
  pass('currency-mismatch-blocked');
  const validSecond=await post(cashier,fifth,'correct-currency',1,0,0);
  must(validSecond.status===201,'other order allocation');pass('second-order-isolated');
  const totalSettlements=getDb().prepare(`SELECT COUNT(*) n FROM order_settlements WHERE order_id=?`).get(first.id).n;
  must(totalSettlements===0,'new allocation silently duplicated legacy sale');pass('no-duplicate-legacy-payment-row');
  console.log(`Split payment allocations ${passed} passed (temporary TEST SQLite, no real financial or Firebase writes)`);
} finally {
  if (server) await new Promise(ok=>server.close(ok));
  closeDatabase();
  fs.rmSync(root,{recursive:true,force:true});
}
