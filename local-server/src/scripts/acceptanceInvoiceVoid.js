/** P2-E2E: disposable TEST SQLite / 127.0.0.1 only; never touches operational data. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ensureDataDirs } from '../config.js';
import { openDatabase, runMigrations, closeDatabase, getDb } from '../db/db.js';
import { seedSampleData } from '../seed/sampleData.js';
import { initLogger } from '../util/logger.js';
import { createServer } from '../http/server.js';
import { httpJson, openRoleSessions } from './testHttp.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'gtct-void-invoice-'));
process.env.GTCT_LOCAL_DATA_DIR=root;
process.env.GTCT_LOCAL_HOST='127.0.0.1';
process.env.GTCT_LOCAL_PORT='19062';
for (const key of ['GTCT_TLS_CERT_FILE','GTCT_TLS_KEY_FILE','GTCT_ALLOW_LAN_BIND',
  'GTCT_ENABLE_LAN_LISTENER','GTCT_LAN_BIND_ADDRESS','GTCT_ENABLE_PHYSICAL_PRINT',
  'GTCT_LOCAL_OPERATING_MODE','GTCT_TEST_BACKUP_DIR','GTCT_ENABLE_TEST_AUTO_BACKUP']) delete process.env[key];
const config=loadConfig({mode:'http'});
let server;
let passed=0;
function must(ok,msg){if(!ok)throw Error(msg);}
function pass(name){console.log('PASS '+name);passed++;}
const api=(method,endpoint,cookie,body)=>httpJson(config.port,method,endpoint,cookie,body);
async function makeOrder(cookie,tag,type='TAKEAWAY') {
 const r=await api('POST','/v1/test-orders',cookie,{submissionId:`sub-void-${tag}-123`,orderType:type,
   lines:[{itemId:'item_orange_juice',quantity:1}]});
 must(r.status===201,`create ${tag} failed: ${r.status} ${r.json?.error}`);
 return r.json.order;
}
async function versionOf(id,cookie){
 const r=await api('GET',`/v1/order-register/${id}`,cookie);
 must(r.status===200,'detail unavailable');
 return r.json.order.updatedAt;
}
async function voidIt(id,cookie,reason,expectedUpdatedAt){
 return api('POST',`/v1/orders/${id}/void`,cookie,{reason,expectedUpdatedAt});
}
try {
 must(config.operatingMode==='TEST' && config.loopback && !config.physicalPrintEnabled &&
  path.resolve(config.dbPath).startsWith(path.resolve(root)+path.sep),'TEST isolation guard');
 pass('isolated-temporary-TEST-only');
 ensureDataDirs(config);initLogger(config.logDir);openDatabase(config.dbPath);
 await runMigrations(getDb());seedSampleData(config);
 must(!!getDb().prepare(`SELECT 1 FROM sqlite_master WHERE name='order_void_events'`).get(), 'void migration absent');
 pass('void-audit-migration');
 server=createServer(config);
 await new Promise((yes,no)=>{server.once('error',no);server.listen(config.port,config.host,yes);});
 const {admin,device:cashier}=await openRoleSessions(config.port,config.testTenantId);
 pass('admin-and-cashier-sessions');
 const order=await makeOrder(cashier,'one');
 const id=order.order_id;
 const initial=getDb().prepare(`SELECT total_cents,tax_cents,order_number,token_number FROM orders WHERE order_id=?`).get(id);
 const updatedAt=await versionOf(id,admin);
 pass('unpaid-order-created');
 must((await voidIt(id,null,'Wrong user',updatedAt)).status===401,'anonymous void allowed');pass('anonymous-rejected');
 must((await voidIt(id,cashier,'Wrong user',updatedAt)).status===403,'cashier void allowed');pass('cashier-rejected');
 must((await voidIt(id,admin,'bad',updatedAt)).status===400,'short reason accepted');pass('reason-required');
 must((await voidIt(id,admin,'Void for TEST','old-version')).status===409,'stale version accepted');pass('stale-request-rejected');
 const res=await voidIt(id,admin,'TEST wrong item',updatedAt);
 must(res.status===200 && res.json?.status==='VOID',`void request failed ${res.status} ${res.json?.error}`);pass('admin-void-accepted');
 const db=getDb();
 const after=db.prepare(`SELECT status,updated_at,total_cents,tax_cents,order_number,token_number FROM orders WHERE order_id=?`).get(id);
 must(after.status==='VOID','void status not committed');pass('void-status-persistent');
 for(const key of ['total_cents','tax_cents','order_number','token_number']) must(after[key]===initial[key],`${key} changed`);
 pass('invoice-token-and-finance-snapshot-preserved');
 const audit=db.prepare(`SELECT * FROM order_void_events WHERE order_id=?`).get(id);
 must(audit?.reason==='TEST wrong item','missing immutable void reason');pass('void-reason-recorded');
 must(db.prepare(`SELECT COUNT(*) n FROM audit_events WHERE entity_id=? AND action='sales.invoice.void'`).get(id).n===1,
   'missing/duplicate audit');pass('audit-event-single');
 must((await voidIt(id,admin,'Try to void twice',after.updated_at)).status===409,'second void allowed');pass('repeat-rejected');
 const detail=await api('GET',`/v1/order-register/${id}`,admin);
 must(detail.json.order.fulfillmentStatus==='VOID','register missing status');pass('void-in-history');
 must((await api('GET',`/v1/orders/${id}/edit-draft`,admin)).status!==200,'editing void allowed');pass('editing-void-rejected');
 must((await api('POST',`/v1/orders/${id}/payment-allocations`,cashier,
   {submissionId:'void-payment-123',cashCents:1,bankCents:0,creditCents:0,currencyCode:order.currency_code})).status!==201,
   'void got split payment');pass('split-payment-after-void-rejected');
 const second=await makeOrder(cashier,'two');
 const legacy=await api('POST',`/v1/orders/${second.order_id}/settlements`,cashier,
  {submissionId:'void-old-settlement-test',tender:'CASH',amountCents:second.total_cents,currencyCode:second.currency_code});
 must(legacy.status===201,'legacy settle failed');
 must((await voidIt(second.order_id,admin,'Paid bill not voidable',await versionOf(second.order_id,admin))).status===409,
   'paid order void allowed');pass('legacy-payment-protected');
 const third=await makeOrder(cashier,'three');
 const split=await api('POST',`/v1/orders/${third.order_id}/payment-allocations`,cashier,
   {submissionId:'void-partial-test-123',cashCents:1,bankCents:0,creditCents:0,currencyCode:third.currency_code});
 must(split.status===201,'split allocation setup failed');
 must((await voidIt(third.order_id,admin,'Partially paid invoice',await versionOf(third.order_id,admin))).status===409,
   'partial payment void allowed');pass('partial-payments-protected');
 const fourth=await makeOrder(cashier,'four');
 db.prepare(`UPDATE orders SET is_test=0 WHERE order_id=?`).run(fourth.order_id);
 must((await voidIt(fourth.order_id,admin,'Never production orders',await versionOf(fourth.order_id,admin))).status===403,
   'REAL order void allowed');pass('production-orders-blocked');
 const printRows=db.prepare(`SELECT COUNT(*) n FROM print_jobs WHERE order_id=? AND status='PENDING'`).get(id).n;
 must(printRows===0,'PENDING print jobs survived VOID');pass('pending-prints-not-dispatched');
 console.log(`Invoice void safety ${passed} passed (temporary TEST SQLite, no existing shop/Firebase writes)`);
} finally {
 if(server) await new Promise(ok=>server.close(ok));
 closeDatabase();
 fs.rmSync(root,{recursive:true,force:true});
}
