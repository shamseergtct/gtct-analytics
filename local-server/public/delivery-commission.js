/* P2-E3C1: admin-only rider policy form / read-only estimates. */
const $=id=>document.getElementById(id);
let model=null,selectedId=null,pendingId=null;
function msg(s,type=''){$('message').textContent=s;$('message').className=`comm-message ${type}`;}
async function api(path,method='GET',body){const r=await fetch(path,{method,credentials:'same-origin',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(`${d.code||r.status}: ${d.error||'Request failed'}`);return d;}
function decimalToMinor(s,d){s=String(s||'').trim();const m=s.match(/^(\d{1,10})(?:\.(\d+))?$/);if(!m||((m[2]||'').length>d))throw Error(`Use a valid nonnegative amount with at most ${d} decimal places`);const n=Number(m[1])*10**d+Number((m[2]||'').padEnd(d,'0')||0);if(!Number.isSafeInteger(n))throw Error('Amount is too large');return n;}
function percentageBps(s){const m=String(s||'').trim().match(/^(\d{1,3})(?:\.(\d{1,2}))?$/);if(!m)throw Error('Enter a percentage up to two decimals');const n=Number(m[1])*100+Number((m[2]||'').padEnd(2,'0')||0);if(n>10000)throw Error('Percentage must be 100% or less');return n;}
function display(n){if(n===null||n===undefined)return '—';const d=model.currencyDecimals;return `${(n/10**d).toFixed(d)} ${model.currencyCode}`;}
function formatted(n){return (Number(n||0)/10**model.currencyDecimals).toFixed(model.currencyDecimals);}
function safeText(tag,text,cls){const a=document.createElement(tag);a.textContent=String(text);if(cls)a.className=cls;return a;}
function tiersAdd(t=null){const box=document.createElement('div');box.className='tier-row';const l1=safeText('label','Target amount');const x=document.createElement('input');x.placeholder='50.000';x.inputMode='decimal';x.value=t?formatted(t.thresholdMinor):'';x.className='tier-threshold';l1.append(x);const l2=safeText('label','Commission');const y=document.createElement('input');y.placeholder='0.500';y.inputMode='decimal';y.value=t?formatted(t.rewardMinor):'';y.className='tier-reward';l2.append(y);const b=safeText('button','×','btn ghost');b.type='button';b.title='Remove tier';b.addEventListener('click',()=>box.remove());box.append(l1,l2,b);$('tiers').append(box);}
function methodChange(){const m=$('method').value;$('fixed-box').hidden=m!=='FIXED_PER_DELIVERY';$('basis-box').hidden=!['TIERED_FIXED','PERCENTAGE'].includes(m);$('percentage-box').hidden=m!=='PERCENTAGE';$('tier-box').hidden=m!=='TIERED_FIXED';$('manual-box').hidden=m!=='MANUAL';}
function fillPolicy(p){p=p||{method:'NONE'};$('method').value=p.method;$('basis').value=p.basis||'TOTAL_BILL';$('rate').value=((p.rateBps||0)/100).toFixed(2);$('fixed-amount').value=formatted(p.amountMinor);$('manual-amount').value=formatted(p.amountMinor);$('tiers').replaceChildren();for(const t of p.tiers||[])tiersAdd(t);if(!(p.tiers||[]).length){tiersAdd();tiersAdd();}methodChange();}
function buildPolicy(){const m=$('method').value,p={method:m,period:'DAILY'},d=model.currencyDecimals;if(m==='FIXED_PER_DELIVERY')p.amountMinor=decimalToMinor($('fixed-amount').value,d);if(m==='MANUAL')p.amountMinor=decimalToMinor($('manual-amount').value,d);if(m==='PERCENTAGE'){p.basis=$('basis').value;p.rateBps=percentageBps($('rate').value);}if(m==='TIERED_FIXED'){p.basis=$('basis').value;p.tiers=[...$('tiers').children].map(el=>({thresholdMinor:decimalToMinor(el.querySelector('.tier-threshold').value,d),rewardMinor:decimalToMinor(el.querySelector('.tier-reward').value,d)}));if(!p.tiers.length)throw Error('Add at least one tier');for(let i=1;i<p.tiers.length;i++)if(p.tiers[i].thresholdMinor<=p.tiers[i-1].thresholdMinor)throw Error('Targets must be in increasing order');}return p;}
function roster(){const host=$('riders');host.replaceChildren();const q=$('search').value.trim().toLocaleLowerCase();for(const r of model.riders.filter(x=>x.fullName.toLocaleLowerCase().includes(q))){const b=document.createElement('button');b.type='button';b.className='rider-option';b.setAttribute('aria-pressed',String(selectedId===r.userId));const left=document.createElement('span');left.append(safeText('strong',r.fullName),safeText('small',r.activePolicy?`${r.activePolicy.policy.method} · v${r.activePolicy.version}`:'No rule saved'));b.append(left,safeText('span',r.isActive?'Active':'Inactive','tag'));b.addEventListener('click',()=>selectRider(r.userId));host.append(b);}if(!host.children.length)host.append(safeText('p','No matching riders','subtle'));$('rider-count').textContent=`${model.riders.length} riders`;}
async function selectRider(id){selectedId=id;pendingId=null;const r=model.riders.find(x=>x.userId===id);roster();$('rider-name').textContent=r.fullName;$('rule-status').textContent=r.activePolicy?`Current rule v${r.activePolicy.version} from ${r.activePolicy.effectiveBusinessDate}`:'No active rule for today';$('save').disabled=!r.isActive;$('effective-date').value=model.businessDate;fillPolicy(r.activePolicy?.policy);await preview();await refreshAccounting();}
async function preview(){if(!selectedId||!$('preview-date').value)return;try{const d=await api(`/v1/delivery-commissions/${encodeURIComponent(selectedId)}/preview?businessDate=${encodeURIComponent($('preview-date').value)}`);$('order-count').textContent=String(d.eligibleDeliveryCount);$('bill-total').textContent=display(d.totalBillMinor);$('charge-total').textContent=display(d.deliveryChargeMinor);$('estimate').textContent=display(d.estimatedCommissionMinor);$('preview-status').textContent=`Policy ${d.activePolicy?`v${d.activePolicy.version}`:'not configured'} · ${d.skippedOrders} currency/invalid rows skipped. PROVISIONAL — not payable or posted.`;}catch(e){$('preview-status').textContent=e.message;}}
async function refresh(){try{model=await api('/v1/delivery-commissions');$('preview-date').value ||=model.businessDate;document.querySelectorAll('.currency-unit').forEach(x=>x.textContent=model.currencyCode);roster();if(selectedId&&model.riders.some(x=>x.userId===selectedId))await selectRider(selectedId);else if(model.riders.length)await selectRider(model.riders[0].userId);else msg('No delivery riders found.','bad');if(model.riders.length)msg('Rider settings loaded. Values are estimates, not expense postings.');}catch(e){msg(`Could not load. ${e.message}`,'bad');$('save').disabled=true;}}
$('method').addEventListener('change',methodChange);$('add-tier').addEventListener('click',()=>{if($('tiers').children.length<20)tiersAdd()});$('search').addEventListener('input',()=>{if(model)roster()});$('refresh').addEventListener('click',()=>void refresh());$('preview-date').addEventListener('change',()=>{void preview();void refreshAccounting();});
$('policy-form').addEventListener('submit',async e=>{e.preventDefault();if(!selectedId)return;const save=$('save');try{const policy=buildPolicy(),body={effectiveBusinessDate:$('effective-date').value,policy,submissionId:pendingId||`comm_${crypto.randomUUID().replaceAll('-','')}`};pendingId=body.submissionId;if(!confirm('Save a new immutable TEST commission rule version? Existing versions stay unchanged. No accounting will post.')){pendingId=null;return;}save.disabled=true;const result=await api(`/v1/delivery-commissions/${encodeURIComponent(selectedId)}/policy`,'POST',body);pendingId=null;msg(`Commission rule v${result.version} saved for rider.`, 'good');await refresh();}catch(err){msg(err.message,'bad');}finally{save.disabled=false;}});
void refresh();

// P2-E3C3. Commission accounting is a separate, immutable TEST subledger.
let closingSnapshot=null,accrualSubmission=null;
async function refreshAccounting(){
  if(!selectedId||!model||!$('preview-date').value)return;
  closingSnapshot=null;$('approve-accrual').disabled=true;
  try{
    const rider=encodeURIComponent(selectedId),day=encodeURIComponent($('preview-date').value);
    const [p,list]=await Promise.all([
      api(`/v1/delivery-commissions/${rider}/closing-preview?businessDate=${day}`),
      api(`/v1/delivery-commissions/${rider}/accruals`)
    ]);
    closingSnapshot=p;
    $('closing-amount').textContent=display(p.estimatedCommissionMinor);
    const totals=list.totals.filter(x=>x.currencyCode===model.currencyCode&&x.currencyDecimals===model.currencyDecimals);
    $('closing-payable').textContent=display(totals.reduce((n,x)=>n+x.payableMinor,0));
    $('approve-accrual').disabled=!p.canAccrue;
    const why=p.alreadyAccrued?'Already approved for this rider/day.':
      p.businessDate>=p.currentBusinessDate?'Only past business dates can be approved.':
      !p.activePolicy?'No configured policy for this business date.':
      p.skippedOrders?'Invalid or cross-currency orders require review.':
      !p.eligibleDeliveryCount?'No completed eligible deliveries.':
      !p.estimatedCommissionMinor?'No positive commission to accrue.':
      'Ready for Staff Admin approval. This will create an immutable expense/payable SUBLEDGER entry.';
    $('closing-status').textContent=why;
    const area=$('accrual-history');area.replaceChildren();
    for(const a of list.accruals){const el=document.createElement('div');el.className='accrual-row';
      const left=document.createElement('span');left.textContent=`${a.businessDate} · v${a.policyVersion} · ${a.deliveryCount} deliveries`;
      const right=document.createElement('strong');right.textContent=`${(a.amountMinor/10**a.currencyDecimals).toFixed(a.currencyDecimals)} ${a.currencyCode}`;
      el.append(left,right);area.append(el);}
    if(!area.children.length)area.textContent='No accruals yet.';
  }catch(err){$('closing-status').textContent=err.message;$('closing-amount').textContent='—';
    $('approve-accrual').disabled=true;}
}
$('approve-accrual').addEventListener('click',async()=>{
  if(!closingSnapshot?.canAccrue||!selectedId)return;
  const button=$('approve-accrual'),day=$('preview-date').value;
  if(!confirm(`Approve ${display(closingSnapshot.estimatedCommissionMinor)} for ${day}?\nCreates an immutable commission-only Expense/Payable subledger entry. Does not pay the rider or change shop cash.`))return;
  const submissionId=accrualSubmission||`cacc_${crypto.randomUUID().replaceAll('-','')}`;
  accrualSubmission=submissionId;button.disabled=true;
  try{
    const d=await api(`/v1/delivery-commissions/${encodeURIComponent(selectedId)}/accruals`,'POST',
      {submissionId,businessDate:day,expectedFactsHash:closingSnapshot.factsHash,approved:true});
    accrualSubmission=null;msg(`Commission subledger accrual approved: ${display(d.amountMinor)} · ${day}. No payout made.`,'good');
    await refreshAccounting();
  }catch(e){msg(`Accrual not posted: ${e.message}`,'bad');await refreshAccounting();}
});
