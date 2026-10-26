import { syncProfit } from './finance-pnl.js';
const T={ledger:'tblqJdpBfUuewMpOy',snapshots:'tblDLIpjp2IOpL2JN',months:'tblQlmnTA9be5P5jZ'};
const n=x=>Number(x)||0;
const round=x=>Math.round(x*100)/100;
export function buildReporting(bank,orders,paypal,receipts=[]){
 const result=[];
 const add=f=>result.push({'Sales':0,'Spending':0,'Checking In':0,'Checking Out':0,'Checking Net':0,'Needs Review':0,'Sales Channel':'','Expense Category':'','Reporting Note':'',...f,Month:String(f.Date||'').slice(0,7)});
 for(const {fields:f} of bank){
  if(!f.ID||!f.Date||f['Is Pending?'])continue;
  add({'Reporting Key':'BANK:'+f.ID,Date:f.Date,Type:'Bank',Source:'Chase / Amex',Description:f.Summary||'',Spending:n(f['Preliminary Spending']),'Expense Category':f['Reporting Expense Category']||'Needs review','Checking In':n(f['Checking Cash In']),'Checking Out':n(f['Checking Cash Out']),'Checking Net':n(f['Checking Cash Movement']),'Needs Review':f['Reporting Expense Category']==='Needs review'?1:0});
 }
 const ppChannels={'Invoice payment':'PayPal — Invoices','Show POS sale':'PayPal — Show POS','Direct PayPal sale':'PayPal — Direct','Bricklink sale':'Bricklink','Customer refund':'PayPal — Refunds'};
 const activityIndex=new Map(paypal.map(r=>[r.fields['Transaction ID'],r.fields]));
 for(const {fields:f} of paypal){
  const originalClass=f['Activity Class']==='Customer refund'?activityIndex.get(f['Reference ID'])?.['Activity Class']:null;
  const channel=ppChannels[originalClass||f['Activity Class']];
  if(!channel||f.Currency!=='USD'||!f.Date)continue;
  const verified=String(f['Report Match']||'').startsWith('Matched');
  add({'Reporting Key':'PP-SALE:'+f['Transaction Key'],Date:f.Date,Type:'Sale','Sales Channel':channel,Source:'PayPal',Description:f['Report Counterparty']||'PayPal receipt',Sales:verified?round(n(f['Gross Amount'])-Math.sign(n(f['Gross Amount']))*Math.abs(n(f['Report Tax']))):0,'Needs Review':verified?0:1,'Reporting Note':verified?'Payment date; reported tax excluded; before fees.':'Unverified PayPal tax/source details; held out of sales.'});
 }
 for(const {fields:f} of orders){
  if(String(f['Order Key']).startsWith('PAYPAL-')||String(f['Order Key']).startsWith('BRICKLINK:'))continue;
  if(!f['Order Date'])continue;
  const excluded=/Duplicate|Unpaid|Cancelled/.test(f['Report Status']||'');
  const validStatus=/^(paid|shipped|received|completed|delivered|picked_up|Payout Complete|Delivered|Awaiting Shipping)$/.test(f.Status||'');
  const amounts=typeof f['Items Subtotal']==='number'&&typeof f['Shipping Charged']==='number';
  const currency=f.Currency==='USD';
  const knownChannel=!!f['Sales Channel'];
  const gxe=f['Import Source']==='Gear Exchange API';
  const blocked=gxe?/amounts do not reconcile/.test(f['Import Warnings']||''):!!f['Import Warnings'];
  const include=!excluded&&validStatus&&amounts&&currency&&knownChannel&&!blocked;
  add({'Reporting Key':'SALE:'+f['Order Key'],Date:f['Order Date'],Type:'Sale','Sales Channel':f['Sales Channel']||'Unverified channel',Source:f['Import Source']||'',Description:f['Order Key'],Sales:include?round(n(f['Items Subtotal'])+n(f['Shipping Charged'])-n(f['Refund Amount'])):0,'Needs Review':!excluded&&!include?1:/refund/i.test(f.Status||'')?1:0,'Reporting Note':include?'Paid source order; tax excluded, before fees.':'Held out: '+(f['Import Warnings']||f['Report Status']||f.Status)});
  if(include&&String(f['Order Key']).startsWith('REVERB-')){
   const fees=round(n(f['Platform Fees'])+n(f['Processing Fees']));
   if(fees)add({'Reporting Key':'FEES:'+f['Order Key'],Date:f['Order Date'],Type:'Marketplace fees','Expense Category':'Commissions and fees',Source:f['Import Source'],Description:f['Order Key'],Spending:fees,'Reporting Note':'Source-reported fees deducted from marketplace settlement; order-date basis.'});
   if(n(f['Shipping Label Fees']))add({'Reporting Key':'LABEL:'+f['Order Key'],Date:f['Order Date'],Type:'Marketplace shipping','Expense Category':'Shipping',Source:f['Import Source'],Description:f['Order Key'],Spending:n(f['Shipping Label Fees']),'Reporting Note':'Source-reported marketplace label charge; order-date basis.'});
  }
 }
 const index=new Map(paypal.map(r=>[r.fields['Transaction ID'],r.fields]));
 const funded=new Set(paypal.filter(r=>(r.fields['Report Description']==='BML Credit - Transfer from BML'||r.fields['Event Code']==='T1601')&&n(r.fields['Gross Amount'])>0).map(r=>r.fields['Reference ID']));
 // Only credit-funded purchases: bank-funded PayPal purchases already appear in the bank ledger.
 for(const {fields:f} of paypal){
  const purchase=funded.has(f['Transaction ID']);
  const refund=f['Activity Class']==='Purchase refund'&&funded.has(f['Reference ID']);
  if(!purchase&&!refund)continue;
  const original=refund?index.get(f['Reference ID']):f;
  const vendor=String(original?.['Report Counterparty']||'').toLowerCase();
  const category=f['Expense Category Override']||(/reverb|tenso|buyee/.test(vendor)?'Inventory (COGS)':'Needs review');
  const verified=f.Currency==='USD'&&(f.Status==='S'||String(f['Report Match']||'').startsWith('Matched'));
  add({'Reporting Key':'PP-CREDIT:'+f['Transaction Key'],Date:f.Date,Type:'PayPal Credit purchase','Expense Category':category,Source:'PayPal Credit',Description:f['Report Counterparty']||original?.['Report Counterparty']||'',Spending:verified?-n(f['Gross Amount']):0,'Needs Review':!verified||category==='Needs review'?1:0,'Reporting Note':refund?'Refund of a credit-funded purchase; reduces spending.':'Credit-funded purchase; funding and repayments excluded. Category/tax treatment is separate from cash flow.'});
 }
 for(const {fields:f} of paypal){
  if(f.Currency==='USD'&&f.Status==='S'&&n(f['Fee Amount'])<0)add({'Reporting Key':'PP-FEE:'+f['Transaction Key'],Date:f.Date,Type:'Payment processing fees','Expense Category':'Commissions and fees',Source:'PayPal',Description:f['Report Counterparty']||f['Transaction ID'],Spending:-n(f['Fee Amount']),'Reporting Note':'Source-reported PayPal fee, separate from gross sales and credit funding.'});
 }
 for(const {fields:f} of receipts){
  if(!/cash/i.test(f['Payment Account']||'')||!f['Purchase Date']||/personal/i.test(f['Business / Personal']||''))continue;
  const amount=typeof f['Settled USD']==='number'?f['Settled USD']:f.Currency==='USD'&&typeof f['Original Amount']==='number'?f['Original Amount']:null;
  const category=/inventory/i.test(f['Expense Category']||'')?'Inventory (COGS)':/travel|taxi|train/i.test(f['Expense Category']||'')?'Travel':'Needs review';
  add({'Reporting Key':'CASH-RECEIPT:'+f['Purchase ID'],Date:f['Purchase Date'],Type:'Cash purchase','Expense Category':category,Source:'Sourcing cash receipt',Description:f.Vendor||'',Spending:amount||0,'Needs Review':amount===null||category==='Needs review'?1:0,'Reporting Note':amount===null?'USD cost not settled; estimated exchange values excluded.':'Cash purchase, counted once; not a bank withdrawal.'});
 }
 return result;
}
export function monthlyReporting(ledger,snapshots=[],now=new Date()){
 const months=new Map();
 for(const f of ledger){if(!/^\d{4}-\d{2}$/.test(f.Month))continue;let m=months.get(f.Month);if(!m){m={Month:f.Month,Sales:0,Spending:0,'Checking In':0,'Checking Out':0,'Checking Net':0,'Sales Exceptions':0,'Beginning Owned Inventory':null,'Ending Owned Inventory':null,'Inventory Coverage':'No historical snapshot available',Updated:now.toISOString()};months.set(f.Month,m);}for(const k of ['Sales','Spending','Checking In','Checking Out','Checking Net'])m[k]=round(m[k]+n(f[k]));if(f.Type==='Sale')m['Sales Exceptions']+=n(f['Needs Review']);}
 const snaps=snapshots.map(r=>r.fields||r).sort((a,b)=>a['Snapshot Date'].localeCompare(b['Snapshot Date']));
 for(const m of months.values()){
  const first=m.Month+'-01',previous=new Date(first+'T12:00:00Z');previous.setUTCDate(0);const prev=previous.toISOString().slice(0,10);
  const opening=snaps.find(s=>s['Snapshot Date']===prev),inMonth=snaps.filter(s=>s['Snapshot Date'].startsWith(m.Month));
  if(opening)m['Beginning Owned Inventory']=opening['Owned Inventory Cost'];
  if(inMonth.length){const end=inMonth.at(-1);m['Ending Owned Inventory']=end['Owned Inventory Cost'];m['Inventory Coverage']=(opening?'Beginning: prior-day snapshot. ':'Beginning unavailable. ')+'Ending observed as of '+end['Snapshot Date']+'; known costs only, missing costs not estimated.';}
 }
 return [...months.values()];
}
export function inventorySnapshot(rows,date,now=new Date()){
 const f={'Snapshot Date':date,'Captured At':now.toISOString(),'Units On Hand':0,'Owned Units':0,'Missing Cost Units':0,'Owned Inventory Cost':0,'Inventory List Value':0,Coverage:'Observed stock; owned cost excludes consignments. Missing costs not estimated.'};
 for(const {fields:r}of rows){const qty=Math.max(0,n(r['Qty On Hand']));if(!qty)continue;f['Units On Hand']+=qty;f['Inventory List Value']+=qty*n(r.Price);const owner=String(r.Owner||'');if(/^(FF|FF Owned|A Flash Flood)/i.test(owner)){f['Owned Units']+=qty;if(typeof r.Cost==='number')f['Owned Inventory Cost']+=qty*r.Cost;else f['Missing Cost Units']+=qty;}}
 f['Owned Inventory Cost']=round(f['Owned Inventory Cost']);f['Inventory List Value']=round(f['Inventory List Value']);return f;
}
export async function syncFinanceReporting(at,inventory,now=new Date()){
 const bank=await at.all('tbllyk6vCuaP2wYiF'),orders=await at.all('tblJF93j14JRV8d5y'),paypal=await at.all('tblLfxT9f4TQmXYWw');
 const receipts=await at.all('tblblwbHmUit1mg3Z');
 const ledger=buildReporting(bank,orders,paypal,receipts),existing=await at.all(T.ledger),map=new Map(existing.map(r=>[r.fields['Reporting Key'],r.fields]));
 const changed=ledger.filter(f=>JSON.stringify(f)!==JSON.stringify(Object.fromEntries(Object.keys(f).map(k=>[k,map.get(f['Reporting Key'])?.[k]??(typeof f[k]==='number'?0:'')]))));
 // Upsert stable keys; zero stale rows rather than leave outdated totals visible.
 const active=new Set(ledger.map(f=>f['Reporting Key']));for(const r of existing)if(!active.has(r.fields['Reporting Key']))changed.push({'Reporting Key':r.fields['Reporting Key'],Sales:0,Spending:0,'Checking In':0,'Checking Out':0,'Checking Net':0,'Needs Review':0,'Reporting Note':'Source no longer eligible'});
 await at.upsert(T.ledger,'Reporting Key',changed);
 let inventoryCoverage='Not available',inventoryRows=null,profitCoverage='Inventory access required';
 try{const rows=await inventory.all('tbljh3I54QsvFDoZe');inventoryRows=rows;const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(now);const snap=inventorySnapshot(rows,date,now);await at.upsert(T.snapshots,'Snapshot Date',[snap]);inventoryCoverage='Daily snapshots active';}catch{inventoryCoverage='Inventory read access unavailable; existing snapshots retained';}
 const snapshots=await at.all(T.snapshots);await at.upsert(T.months,'Month',monthlyReporting(ledger,snapshots,now));
 if(inventoryRows)profitCoverage=await syncProfit(at,ledger,orders,paypal,inventoryRows);
 return {read:bank.length+orders.length+paypal.length,written:changed.length,inventoryCoverage,profitCoverage};
}
