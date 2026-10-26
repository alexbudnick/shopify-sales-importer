const n=x=>Number(x)||0,round=x=>Math.round(x*100)/100;
export const BUSINESS_DAYS_TABLE='tblTal86WnbzQLKF3';
export function buildBusinessDays(ledger,orders,paypal,economics,now=new Date(),labels=[]){
 const rows=new Map(),byOrder=new Map(orders.map(r=>[r.fields['Order Key'],r.fields])),pp=new Map(paypal.map(r=>[r.fields['Transaction Key'],r.fields]));
 const get=date=>{date=String(date).slice(0,10);if(!rows.has(date))rows.set(date,{Date:date,'Gross Sales':0,'Sales Net':0,'Estimated COGS':0,'Net Sales Contribution':0,'Operating Expenses':0,'Inventory Purchased':0,'Estimated Profit':0,'Cash Flow':0,'Selling Fees':0,Shipping:0,channels:{},ownership:{},expenses:{}});return rows.get(date);};
 const saleGross=new Map();const matchedLabels=labels.map(r=>r.fields||r).filter(f=>f.Status==='Matched'||f.Status==='Unmatched / ambiguous order');
 const matchedShipping=matchedLabels.length>0;
 for(const f of ledger){if(!f.Date)continue;const d=get(f.Date);
  if(f.Type==='Sale'&&n(f.Sales)!==0){
   const order=byOrder.get(f.Description),activity=f['Reporting Key'].startsWith('PP-SALE:')?pp.get(f['Reporting Key'].slice(8)):null;
   const gross=n(f.Sales)>0?(activity?Math.max(0,n(activity['Gross Amount'])):order?n(order['Items Subtotal'])+n(order['Shipping Charged'])+n(order['Tax Collected']):n(f.Sales)):0;
   d['Gross Sales']+=gross;d['Sales Net']+=n(f.Sales);const channel=f['Sales Channel']||'Other';d.channels[channel]=n(d.channels[channel])+gross;saleGross.set(f['Reporting Key'],{gross,revenue:n(f.Sales)});
  }
  const labelFunding=matchedShipping&&f.Type==='Bank'&&/shipstation|stamps\.com|stamps add funds|endicia/i.test(f.Description||'');
  const spend=labelFunding?0:n(f.Spending),category=f['Expense Category']||'Other Expenses';
  if(category==='Commissions and fees'){d['Selling Fees']+=spend;d['Sales Net']-=spend;}
  else if(category==='Shipping'){d.Shipping+=spend;d['Sales Net']-=spend;}
  else if(category==='Inventory (COGS)')d['Inventory Purchased']+=spend;
  else {d['Operating Expenses']+=spend;d.expenses[category]=n(d.expenses[category])+spend;}
 }
 for(const label of matchedLabels){const order=byOrder.get(label['Matched Order Key']);const d=get(order?.['Order Date']||label.Date);d.Shipping+=n(label['Total Cost']);d['Sales Net']-=n(label['Total Cost']);}
 for(const e of economics){const d=get(e.Date),cost=n(e['Known COGS']);d['Estimated COGS']+=cost;const key=e['Economics Key'].split('|')[0],sale=saleGross.get(key),gross=sale&&sale.revenue>0?sale.gross*n(e['Net Sales'])/sale.revenue:0;d.ownership[e.Ownership||'Unassigned']=n(d.ownership[e.Ownership||'Unassigned'])+gross;}
 for(const d of rows.values()){
  d['Net Sales Contribution']=d['Sales Net']-d['Estimated COGS'];d['Estimated Profit']=d['Net Sales Contribution']-d['Operating Expenses'];
  d['Cash Flow']=d['Sales Net']-d['Operating Expenses']-d['Inventory Purchased'];
  for(const k of Object.keys(d))if(typeof d[k]==='number')d[k]=round(d[k]);
  for(const [key,out] of [['channels','Sales by Channel'],['ownership','Sales by Ownership'],['expenses','Expenses by Category']]){const obj=Object.fromEntries(Object.entries(d[key]).filter(([,v])=>v!==0).map(([k,v])=>[k,round(v)]));d[out]=JSON.stringify(obj);delete d[key];}
  d.Updated=now.toISOString();
 }
 return [...rows.values()].sort((a,b)=>a.Date.localeCompare(b.Date));
}
export async function syncBusinessDays(at,ledger,orders,paypal,economics){
 const labels=await at.all('tbltb5iyUiHH0pSPI'),days=buildBusinessDays(ledger,orders,paypal,economics,new Date(),labels),old=await at.all(BUSINESS_DAYS_TABLE),index=new Map(old.map(r=>[r.fields.Date,r.fields]));
 const changes=days.filter(f=>Object.entries(f).some(([k,v])=>k!=='Updated'&&JSON.stringify(v)!==JSON.stringify(index.get(f.Date)?.[k]??(typeof v==='number'?0:''))));
 const active=new Set(days.map(d=>d.Date));for(const {fields:f} of old)if(!active.has(f.Date))changes.push({Date:f.Date,...Object.fromEntries(['Gross Sales','Sales Net','Estimated COGS','Net Sales Contribution','Operating Expenses','Inventory Purchased','Estimated Profit','Cash Flow','Selling Fees','Shipping'].map(k=>[k,0])),'Sales by Channel':'{}','Sales by Ownership':'{}','Expenses by Category':'{}',Updated:new Date().toISOString()});
 await at.upsert(BUSINESS_DAYS_TABLE,'Date',changes);return {days:days.length,written:changes.length};
}
