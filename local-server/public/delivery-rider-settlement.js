/** P2-E3C4: isolated TEST UI. Financial rules are all enforced server-side. */
const $=(id)=>document.getElementById(id);
let data=null, closing=null, selected='', date='', pendingSubmission=null;
const url='/v1/delivery-rider-settlements';
const fmt=(minor,dec,cur)=>minor==null?'—':`${(Number(minor)/10**Number(dec??3)).toFixed(Number(dec??3))} ${cur||''}`;
const money=(n)=>fmt(n,data?.preview?.currencyDecimals,data?.preview?.currencyCode);
function text(id,v){$(id).textContent=String(v);}
function msg(s,kind=''){const el=$('message');el.className='rs-notice '+kind;el.textContent=s;}
async function api(path,method='GET',body){const res=await fetch(path,{method,credentials:'same-origin',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const json=await res.json().catch(()=>({}));if(!res.ok)throw Error(`${json.code||res.status}: ${json.error||'Request failed'}`);return json;}
function clearPreview(){closing=null;data={...data,preview:null};render();}
async function load(){
  selected=$('rider').value;date=$('day').value;pendingSubmission=null;
  if(selected&&!date){clearPreview();return;}
  try{
    msg('Refreshing rider collection…');
    data=await api(url+(selected&&date?`?riderUserId=${encodeURIComponent(selected)}&businessDate=${encodeURIComponent(date)}`:''));
    const current=$('rider').value;
    $('rider').replaceChildren(new Option('Select a rider',''));
    for(const r of data.riders)$('rider').add(new Option(`${r.fullName}${r.isActive?'':' (Inactive)'}`,r.userId));
    $('rider').value=selected||current;
    closing=null;
    if(data.preview){
      try{closing=await api(`/v1/delivery-commissions/${encodeURIComponent(selected)}/closing-preview?businessDate=${encodeURIComponent(date)}`);}
      catch(e){closing={error:e.message};}
    }
    $('pay-commission').checked=false;$('approve-accrual').checked=false;
    render();msg('Rider cash list refreshed.','good');
  }catch(e){msg(e.message,'bad');clearPreview();}
}
function displayHistory(){const host=$('history');host.replaceChildren();const records=data?.history||[];if(!records.length){host.textContent='No recent settlements.';return;}
  for(const r of records){const div=document.createElement('div');div.className='rs-history-item';const meta=document.createElement('div');const label=document.createElement('strong');label.textContent=`${r.businessDate} · ${r.riderUserId}`;const sub=document.createElement('small');sub.textContent=`${r.invoiceCount} invoices · gross ${fmt(r.grossMinor,r.currencyDecimals,r.currencyCode)} · commission ${fmt(r.commissionMinor,r.currencyDecimals,r.currencyCode)}`;meta.append(label,sub);const amount=document.createElement('strong');amount.textContent=fmt(r.shopCashMinor,r.currencyDecimals,r.currencyCode);div.append(meta,amount);host.append(div);}}
function render(){const p=data?.preview;displayHistory();
  text('total-bills',p?.overview?.totalDeliveredBills??'—');
  text('total-amount',p?money(p.overview.totalDeliveredMinor):'—');
  text('shop-paid',p?money(p.overview.directShopPaidMinor):'—');
  text('credit',p?money(p.overview.customerCreditAllocatedMinor):'—');text('invoices',p?.invoiceCount??'—');text('gross',p?money(p.grossMinor):'—');
  const accrued=p?.accrual;
  const eligibleAccrual=(!accrued&&closing?.canAccrue&&closing?.factsHash&&closing?.estimatedCommissionMinor>0);
  const available=accrued&&!accrued.paid?accrued.amountMinor:eligibleAccrual?closing.estimatedCommissionMinor:0;
  text('commission',p?money(available):'—');
  if(!p){$('commission-detail').textContent='Select a rider and business date to review commission.';}
  else if(accrued?.paid)$('commission-detail').textContent='Commission already paid for this date; cannot deduct it again.';
  else if(accrued)$('commission-detail').textContent=`Approved payable ${money(accrued.amountMinor)}; selecting Pay Commission settles this payable.`;
  else if(eligibleAccrual)$('commission-detail').textContent=`Unapproved estimate ${money(available)}. To deduct, approve accrual and expense recording now.`;
  else $('commission-detail').textContent=`No payable commission available for this date. ${closing?.error||closing?.note||'No eligible approved accrual.'}`;
  const pay=$('pay-commission');pay.disabled=!p?.invoiceCount||!available||available>p.grossMinor;
  if(pay.disabled)pay.checked=false;
  const showAuto=Boolean(pay.checked&&eligibleAccrual);$('auto-accrual').hidden=!showAuto;
  const approved=!showAuto||$('approve-accrual').checked;
  const comm=pay.checked?available:0;
  text('net',p?money(p.grossMinor-comm):'—');text('summary-gross',p?money(p.grossMinor):'—');text('summary-commission',p?money(comm):'—');text('summary-net',p?money(p.grossMinor-comm):'—');
  const host=$('order-list');host.replaceChildren();if(!p?.orders?.length)host.textContent='No eligible pending rider cash invoices.';
  else for(const o of p.orders){const row=document.createElement('div');row.className='rs-order';const left=document.createElement('strong');left.textContent=o.orderNumber;const right=document.createElement('span');right.textContent=money(o.amountMinor);row.append(left,right);host.append(row);}
  $('confirm').disabled=!p?.invoiceCount||!selected||!date||!approved;
}
async function confirmPayment(){const p=data?.preview;if(!p?.invoiceCount)return;const pay=$('pay-commission').checked;
  const auto=pay&&!p.accrual;
  const commission=pay?(p.accrual?.amountMinor??closing?.estimatedCommissionMinor??0):0;
  if(!Number.isSafeInteger(commission)||commission<0||commission>p.grossMinor){msg('Invalid commission or currency.','bad');return;}
  if(auto&&(!$('approve-accrual').checked||!closing?.canAccrue)){msg('Approve the expense accrual first.','bad');return;}
  if(!window.confirm(`Confirm physical shop cash received: ${money(p.grossMinor-commission)}\nGross customer collections: ${money(p.grossMinor)}\nCommission paid by cash offset: ${money(commission)}\n\nThis will mark ${p.invoiceCount} invoices paid and post immutable entries. Continue?`))return;
  const body={riderUserId:selected,businessDate:date,payCommission:pay,approveAccrual:auto,
    expectedFactsHash:auto?closing.factsHash:'',expectedSnapshotHash:p.snapshotHash,
    expectedGrossMinor:p.grossMinor,expectedCommissionMinor:commission,
    submissionId:pendingSubmission||`net_${crypto.randomUUID().replaceAll('-','')}`};
  pendingSubmission=body.submissionId;$('confirm').disabled=true;
  try{const result=await api(url,'POST',body);pendingSubmission=null;msg(`Confirmed: net shop cash ${fmt(result.shopCashMinor,result.currencyDecimals,result.currencyCode)}; commission paid ${fmt(result.commissionMinor,result.currencyDecimals,result.currencyCode)}.`,'good');
    await load();msg(`Settlement confirmed · ${result.settlementId}`,'good');
  }catch(e){msg(e.message+' Retry with unchanged inputs if network uncertain.','bad');render();}
}
const yesterday=new Date(); yesterday.setDate(yesterday.getDate()-1);
$('day').value=`${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`;
$('rider').addEventListener('change',()=>{pendingSubmission=null;void load();});
$('day').addEventListener('change',()=>{pendingSubmission=null;void load();});
$('refresh').addEventListener('click',()=>void load());
$('pay-commission').addEventListener('change',()=>{pendingSubmission=null;render();});
$('approve-accrual').addEventListener('change',()=>{pendingSubmission=null;render();});
$('confirm').addEventListener('click',()=>void confirmPayment());
void load();
