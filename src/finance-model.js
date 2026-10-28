const n=x=>Number(x)||0,round=x=>Math.round(x*100)/100;
export const BUSINESS_DAYS_TABLE='tblTal86WnbzQLKF3';
const netAmounts=value=>({'Sales Net':value,'Net Sales Contribution':value,'Estimated Profit':value,'Cash Flow':value});
export function buildBusinessDays(ledger,orders,paypal,economics,now=new Date(),labels=[],settlements=[]){
 const rows=new Map(),byOrder=new Map(orders.map(r=>[r.fields['Order Key'],r.fields])),orderUrls=new Map(orders.filter(r=>r.id).map(r=>[r.fields['Order Key'],'https://airtable.com/app7b0v3wEXudVmkD/tblJF93j14JRV8d5y/'+r.id])),pp=new Map(paypal.map(r=>[r.fields['Transaction Key'],r.fields]));
 const economicsBySale=new Map();for(const e of economics){const key=e['Economics Key'].split('|')[0];if(!economicsBySale.has(key))economicsBySale.set(key,[]);economicsBySale.get(key).push(e);}
 const get=date=>{date=String(date).slice(0,10);if(!rows.has(date))rows.set(date,{Date:date,'Gross Sales':0,'Sales Net':0,'Estimated COGS':0,'Net Sales Contribution':0,'Operating Expenses':0,'Inventory Purchased':0,'Estimated Profit':0,'Cash Flow':0,'Selling Fees':0,Shipping:0,channels:{},ownership:{},expenses:{},expenseTransactions:[],details:[]});return rows.get(date);};
 let sequence=0;const add=(day,entry)=>day.details.push({date:day.Date,...entry,key:entry.key||'ENTRY:'+sequence++});
 const saleGross=new Map(),matchedLabels=labels.map(r=>r.fields||r).filter(f=>f.Status==='Matched'||f.Status==='Unmatched / ambiguous order'),matchedShipping=matchedLabels.length>0;
 for(const f of ledger){if(!f.Date)continue;const d=get(f.Date);
  if(f.Type==='Sale'&&n(f.Sales)!==0){
   const order=byOrder.get(f.Description),activity=f['Reporting Key'].startsWith('PP-SALE:')?pp.get(f['Reporting Key'].slice(8)):null;
   const gross=n(f.Sales)>0?(activity?Math.max(0,n(activity['Gross Amount'])):order?n(order['Items Subtotal'])+n(order['Shipping Charged'])+n(order['Tax Collected']):n(f.Sales)):0;
   d['Gross Sales']+=gross;d['Sales Net']+=n(f.Sales);const channel=f['Sales Channel']||'Other';d.channels[channel]=n(d.channels[channel])+gross;saleGross.set(f['Reporting Key'],{gross,revenue:n(f.Sales)});
   const items=economicsBySale.get(f['Reporting Key'])||[];const description=items.length?items.slice(0,3).map(e=>[e.Item,e.SKU].filter(Boolean).join(' · ')).join('; ')+(items.length>3?` (+${items.length-3} items)`:''):f.Description||'Sale';
   add(d,{key:f['Reporting Key'],kind:n(f.Sales)<0?'Refund':'Sale',description,source:f.Source||channel,channel,orderKey:f.Description||'',url:orderUrls.get(f.Description)||'',amounts:{'Gross Sales':gross,...netAmounts(n(f.Sales))}});
  }
  const labelFunding=matchedShipping&&f.Type==='Bank'&&/shipstation|stamps\.com|stamps add funds|endicia/i.test(f.Description||'');
  const spend=labelFunding?0:n(f.Spending),category=f['Expense Category']||'Other Expenses';let kind,amounts;
  if(category==='Commissions and fees'){d['Selling Fees']+=spend;d['Sales Net']-=spend;kind='Selling fees';amounts={'Selling Fees':spend,...netAmounts(-spend)};}
  else if(category==='Shipping'){d.Shipping+=spend;d['Sales Net']-=spend;kind='Shipping';amounts={Shipping:spend,...netAmounts(-spend)};}
  else if(category==='Inventory (COGS)'){d['Inventory Purchased']+=spend;kind='Inventory purchase';amounts={'Inventory Purchased':spend,'Cash Flow':-spend};}
  else {d['Operating Expenses']+=spend;d.expenses[category]=n(d.expenses[category])+spend;kind='Operating expense';amounts={'Operating Expenses':spend,'Estimated Profit':-spend,'Cash Flow':-spend};if(spend)d.expenseTransactions.push({key:f['Reporting Key'],date:String(f.Date).slice(0,10),category,description:f.Description||'Business expense',source:f.Source||f.Type||'',amount:round(spend)});}
  if(spend)add(d,{key:'SPEND:'+f['Reporting Key'],kind,category,description:f.Description||category,source:f.Source||f.Type||'',url:orderUrls.get(f.Description)||'',amounts});
 }
 for(const label of matchedLabels){const order=byOrder.get(label['Matched Order Key']),d=get(order?.['Order Date']||label.Date),cost=n(label['Total Cost']);d.Shipping+=cost;d['Sales Net']-=cost;if(cost)add(d,{key:'LABEL:'+(label['Label Key']||label['Shipment ID']||sequence++),kind:'Shipping',description:label['Order Number']||label['Matched Order Key']||'Shipping label',source:'ShipStation',url:orderUrls.get(label['Matched Order Key'])||'',amounts:{Shipping:cost,...netAmounts(-cost)}});}
 for(const row of settlements){const f=row.fields||row,fee=n(f['Fee Amount']);if(!fee)continue;const order=byOrder.get(f['Order Key']),d=get(f['Transaction Type']==='charge'&&order?order['Order Date']:f.Date);d['Selling Fees']+=fee;d['Sales Net']-=fee;add(d,{key:f['Fee Key']||'SETTLEMENT:'+sequence++,kind:'Selling fees',description:f['Order Key']||'Payment settlement adjustment',source:f.Source||'Shopify Payments',url:orderUrls.get(f['Order Key'])||'',amounts:{'Selling Fees':fee,...netAmounts(-fee)}});}
 for(const e of economics){const d=get(e.Date),cost=n(e['Known COGS']);d['Estimated COGS']+=cost;const key=e['Economics Key'].split('|')[0],sale=saleGross.get(key),gross=sale&&sale.revenue>0?sale.gross*n(e['Net Sales'])/sale.revenue:0;d.ownership[e.Ownership||'Unassigned']=n(d.ownership[e.Ownership||'Unassigned'])+gross;
  add(d,{key:e['Economics Key'],kind:'Item cost',description:e.Item||e.SKU||'Item cost',sku:e.SKU||'',ownership:e.Ownership||'Unassigned',channel:e['Sales Channel']||'Other',source:e['Cost Basis']||'Item cost',url:orderUrls.get(e['Order Key'])||'',ownershipGross:gross,amounts:{'Estimated COGS':cost,'Net Sales Contribution':-cost,'Estimated Profit':-cost}});
 }
 for(const d of rows.values()){
  d['Net Sales Contribution']=d['Sales Net']-d['Estimated COGS'];d['Estimated Profit']=d['Net Sales Contribution']-d['Operating Expenses'];d['Cash Flow']=d['Sales Net']-d['Operating Expenses']-d['Inventory Purchased'];
  for(const k of Object.keys(d))if(typeof d[k]==='number')d[k]=round(d[k]);
  // Allocate rounding cents to an existing contributing row, preserving exact displayed totals.
  for(const metric of ['Gross Sales','Sales Net','Estimated COGS','Net Sales Contribution','Operating Expenses','Inventory Purchased','Estimated Profit','Cash Flow','Selling Fees','Shipping']){const entries=d.details.filter(e=>Object.hasOwn(e.amounts,metric));for(const e of entries)e.amounts[metric]=round(e.amounts[metric]);if(entries.length){const residual=round(d[metric]-entries.reduce((s,e)=>s+e.amounts[metric],0));const last=entries.findLast(e=>e.amounts[metric]!==0)||entries.at(-1);last.amounts[metric]=round(last.amounts[metric]+residual);}}
  for(const [owner,value]of Object.entries(d.ownership)){const entries=d.details.filter(e=>e.ownership===owner);for(const e of entries)e.ownershipGross=round(e.ownershipGross);if(entries.length)entries.at(-1).ownershipGross=round(entries.at(-1).ownershipGross+round(value)-entries.reduce((s,e)=>s+e.ownershipGross,0));}
  for(const [key,out] of [['channels','Sales by Channel'],['ownership','Sales by Ownership'],['expenses','Expenses by Category']]){d[out]=JSON.stringify(Object.fromEntries(Object.entries(d[key]).filter(([,v])=>v!==0).map(([k,v])=>[k,round(v)])));delete d[key];}
  d['Expense Transactions']=JSON.stringify(d.expenseTransactions);delete d.expenseTransactions;d['Report Details']=JSON.stringify(d.details);delete d.details;d.Updated=now.toISOString();
 }
 return [...rows.values()].sort((a,b)=>a.Date.localeCompare(b.Date));
}
export async function syncBusinessDays(at,ledger,orders,paypal,economics){
 const labels=await at.all('tbltb5iyUiHH0pSPI'),settlements=await at.all('tblhTTbD4ezGKfLhc'),days=buildBusinessDays(ledger,orders,paypal,economics,new Date(),labels,settlements),old=await at.all(BUSINESS_DAYS_TABLE),index=new Map(old.map(r=>[r.fields.Date,r.fields]));
 const changes=days.filter(f=>Object.entries(f).some(([k,v])=>k!=='Updated'&&JSON.stringify(v)!==JSON.stringify(index.get(f.Date)?.[k]??(typeof v==='number'?0:''))));
 const active=new Set(days.map(d=>d.Date));for(const {fields:f} of old)if(!active.has(f.Date))changes.push({Date:f.Date,...Object.fromEntries(['Gross Sales','Sales Net','Estimated COGS','Net Sales Contribution','Operating Expenses','Inventory Purchased','Estimated Profit','Cash Flow','Selling Fees','Shipping'].map(k=>[k,0])),'Sales by Channel':'{}','Sales by Ownership':'{}','Expenses by Category':'{}','Expense Transactions':'[]','Report Details':'[]',Updated:new Date().toISOString()});
 await at.upsert(BUSINESS_DAYS_TABLE,'Date',changes);return {days:days.length,written:changes.length};
}
