import { syncBusinessDays } from './finance-model.js';
const n=x=>Number(x)||0,round=x=>Math.round(x*100)/100;
const ownerType=x=>!x||/^(unknown|other|\d+|INS_.+)$/i.test(x)?'Unknown':/^(ff|ff owned|owned|a flash flood)/i.test(x)?'Owned':/split|50\/50|shared/i.test(x)?'Shared / split':'Consigned';
export function saleEconomics(ledger,orders,lines,paypal,inventory,estimates=[]){
 const byKey=new Map(orders.map(r=>[r.fields['Order Key'],r])),byId=new Map(orders.map(r=>[r.id,r]));
 const pp=new Map(paypal.map(r=>[r.fields['Transaction Key'],r.fields]));
 const lineMap=new Map();for(const r of lines){const k=r.fields['Order Key'];if(!lineMap.has(k))lineMap.set(k,[]);lineMap.get(k).push(r.fields);}
 const inv=new Map();for(const r of inventory){const sku=String(r.fields.SKU||'').trim();if(!sku)continue;if(!inv.has(sku))inv.set(sku,[]);inv.get(sku).push(r);}
 const estimateMap=new Map();for(const r of estimates){const f=r.fields||r,sku=String(f.SKU||'').trim();if(!sku)continue;if(!estimateMap.has(sku))estimateMap.set(sku,[]);estimateMap.get(sku).push(f);}
 // Never repeat an item-total payout across multiple positive sale orders or quantities.
 const soldOrders=new Map();for(const r of lines){const f=r.fields,sku=String(f.SKU||'').trim();if(!sku)continue;if(!soldOrders.has(sku))soldOrders.set(sku,new Set());soldOrders.get(sku).add(f['Order Key']+'|'+f['Line Key']);}
 const result=[];
 for(const sale of ledger.filter(f=>f.Type==='Sale'&&f.Sales!==0)){
  let orderKey=sale.Description;
  if(sale['Reporting Key'].startsWith('PP-SALE:')){const activity=pp.get(sale['Reporting Key'].slice(8));orderKey=byId.get(activity?.['Related Sales Order']?.[0])?.fields['Order Key'];}
  const order=byKey.get(orderKey)?.fields,items=lineMap.get(orderKey)||[];
  const use=items.length?items:[{'Line Key':(orderKey||sale['Reporting Key'])+':unallocated',SKU:'',Item:'Sale requires item allocation',Quantity:1}];
  const total=use.reduce((s,f)=>s+Math.max(0,n(f['Sale Amount'])),0);
  const orderRevenue=order?n(order['Items Subtotal'])+n(order['Shipping Charged'])-n(order['Refund Amount']):0;
  const receiptFactor=orderRevenue>0?Math.max(0,sale.Sales)/orderRevenue:1;
  let allocated=0;
  for(let i=0;i<use.length;i++){
   const f=use[i],share=total>0?Math.max(0,n(f['Sale Amount']))/total:1/use.length;
   const revenue=i===use.length-1?round(sale.Sales-allocated):round(sale.Sales*share);allocated+=revenue;
   const matches=inv.get(String(f.SKU||'').trim())||[],match=matches.length===1?matches[0]:null;
   const candidates=estimateMap.get(String(f.SKU||'').trim())||[];
   const estimate=candidates.length===1&&typeof candidates[0]['Estimated Consignment Payout']==='number'&&!/conflict|missing/i.test(candidates[0]['Match Status']||'')?candidates[0]:null;
   const ownership=f['Sale Ownership Override']||ownerType(f['Owner at Sale']||estimate?.Owner||match?.fields.Owner);
   let cost=null,basis='Missing item cost';
   const qty=n(f.Quantity)||1;let estimatedPayout=0;
   const matchedCost=typeof match?.fields.Cost==='number'?round(match.fields.Cost*qty):null;
   if(sale.Sales<0){cost=0;basis='Refund: no automatic COGS reversal; review actual return/restock';}
   else if(typeof f['Confirmed Item COGS']==='number'){cost=round(f['Confirmed Item COGS']*receiptFactor);basis='Confirmed item cost / settlement';}
   else if(ownership==='Consigned'&&typeof f['Consignor Amount Owed']==='number'){cost=round(f['Consignor Amount Owed']*receiptFactor);basis='Recorded consignor obligation';}
   else if(ownership==='Owned'&&typeof f['Unit Cost at Sale']==='number'){cost=round(f['Unit Cost at Sale']*qty*receiptFactor);basis='Recorded sale-time cost';}
   else if(ownership==='Consigned'&&estimate&&qty===1&&soldOrders.get(String(f.SKU||'').trim())?.size===1){estimatedPayout=round(estimate['Estimated Consignment Payout']*receiptFactor);cost=estimatedPayout;basis='Management estimate: consignment payout; not tax-basis COGS';}
   else if(matchedCost!==null){cost=round(matchedCost*receiptFactor);basis='Provisional: matched current inventory cost';}
   if(cost===null){cost=0;basis='Item estimate not entered — $0';}
   const provisional=basis.startsWith('Management estimate')||basis.startsWith('Provisional')||sale.Sales<0||!f['Sale Ownership Override']&&!f['Owner at Sale'];
   result.push({'Economics Key':sale['Reporting Key']+'|'+f['Line Key'],Date:sale.Date,Month:sale.Month,'Order Key':orderKey||'','Line Key':f['Line Key'],SKU:f.SKU||'',Item:f.Item||'','Sales Channel':sale['Sales Channel'],Ownership:ownership,'Net Sales':revenue,'Known COGS':cost,'Estimated Consignment Payout':estimatedPayout,'Item Cost Excluding Estimates':cost===null?null:round(cost-estimatedPayout),'Gross Profit on Costed Sales':cost===null?null:round(revenue-cost),'Sales Missing Cost':cost===null?Math.max(0,revenue):0,'Matched Current Inventory Cost':matchedCost,'Cost Basis':basis+(provisional?' · historical ownership/cost review':''),'Needs Review':cost===null||provisional?1:0});
  }
 }
 return result;
}
export function monthlyProfit(ledger,economics){
 const map=new Map();const get=month=>{if(!map.has(month))map.set(month,{Month:month,'Period Start':month+'-01','Net Sales':0,'Owned Sales':0,'Consigned Sales':0,'Shared Sales':0,'Unassigned Sales':0,'Known COGS':0,'Estimated Consignment Payouts':0,'Item Costs Excluding Estimates':0,'Costed Net Sales':0,'Sales Missing Cost':0,'Gross Profit on Costed Sales':0,'Operating Expenses':0,'Interest Expense':0,'Gross Profit':null,'Profit Before Tax and Depreciation':null,'Profit Before Missing Costs':0,'COGS Coverage':0,'Items Missing Cost':0,Status:''});return map.get(month);};
 for(const f of ledger){const m=get(f.Month);if(f.Type==='Sale')m['Net Sales']+=n(f.Sales);const spend=n(f.Spending),cat=f['Expense Category'];if(cat==='Interest Expense')m['Interest Expense']+=spend;else if(!['Inventory (COGS)','Equipment'].includes(cat))m['Operating Expenses']+=spend;}
 const provisional=new Set();
 for(const f of economics){const m=get(f.Month),key=f.Ownership==='Owned'?'Owned Sales':f.Ownership==='Consigned'?'Consigned Sales':f.Ownership==='Shared / split'?'Shared Sales':'Unassigned Sales';m[key]+=f['Net Sales'];if(f['Known COGS']!==null){m['Known COGS']+=f['Known COGS'];m['Estimated Consignment Payouts']+=n(f['Estimated Consignment Payout']);m['Item Costs Excluding Estimates']+=n(f['Item Cost Excluding Estimates']);m['Costed Net Sales']+=f['Net Sales'];m['Gross Profit on Costed Sales']+=f['Gross Profit on Costed Sales'];}else{m['Sales Missing Cost']+=f['Sales Missing Cost'];m['Items Missing Cost']++;}if(f['Needs Review'])provisional.add(f.Month);}
 for(const m of map.values()){
  m['COGS Coverage']=m['Net Sales']>0?Math.min(1,Math.max(0,m['Costed Net Sales']/m['Net Sales'])):0;
  m['Profit Before Missing Costs']=m['Net Sales']-m['Known COGS']-m['Operating Expenses']-m['Interest Expense'];
  m['Gross Profit']=m['Net Sales']-m['Known COGS'];m['Profit Before Tax and Depreciation']=m['Profit Before Missing Costs'];
  m.Status=m['Items Missing Cost']?'Incomplete — missing item costs; profit before missing costs is an upper bound':provisional.has(m.Month)?'Management estimate — includes provisional item costs and/or consignment estimates; not tax profit':'Cost coverage complete; source/refund, settlement fees and tax adjustments still require reconciliation';
  for(const k of Object.keys(m))if(typeof m[k]==='number'&&k!=='COGS Coverage')m[k]=round(m[k]);
 }
 return [...map.values()];
}
export async function syncProfit(at,ledger,orders,paypal,inventory){
 const lines=await at.all('tbl5Mpv86jeCfnhcL'),estimates=await at.all('tblyxo9nBe4myX77H'),economics=saleEconomics(ledger,orders,lines,paypal,inventory,estimates);
 const businessDays=await syncBusinessDays(at,ledger,orders,paypal,economics);
 const existing=await at.all('tbllrb3l11MjolXiI'),index=new Map(existing.map(r=>[r.fields['Economics Key'],r.fields]));
 const changed=economics.filter(f=>Object.entries(f).some(([k,v])=>JSON.stringify(v??'')!==JSON.stringify(index.get(f['Economics Key'])?.[k]??'')));
 const active=new Set(economics.map(f=>f['Economics Key']));for(const r of existing)if(!active.has(r.fields['Economics Key']))changed.push({'Economics Key':r.fields['Economics Key'],'Net Sales':0,'Known COGS':null,'Estimated Consignment Payout':0,'Item Cost Excluding Estimates':null,'Gross Profit on Costed Sales':null,'Sales Missing Cost':0,'Needs Review':0,'Cost Basis':'Source sale no longer eligible'});
 await at.upsert('tbllrb3l11MjolXiI','Economics Key',changed);const profitRows=monthlyProfit(ledger,economics);await at.upsert('tblNULg3nBAwrDIgj','Month',profitRows);
 const periods=await at.all('tblNULg3nBAwrDIgj'),finance=await at.all('tblQlmnTA9be5P5jZ');
 const dashboard=monthlyDashboardRows(ledger,economics,profitRows,finance,new Map(periods.map(r=>[r.fields.Month,r.id])));
 const existingDashboard=await at.all('tbliGxkmK9IKSheKU'),dashboardIndex=new Map(existingDashboard.map(r=>[r.fields['Dashboard Key'],r.fields]));
 const dashboardChanged=dashboard.filter(f=>Object.entries(f).some(([k,v])=>JSON.stringify(v??'')!==JSON.stringify(dashboardIndex.get(f['Dashboard Key'])?.[k]??'')));
 const activeDashboard=new Set(dashboard.map(f=>f['Dashboard Key']));for(const r of existingDashboard)if(!activeDashboard.has(r.fields['Dashboard Key']))dashboardChanged.push({'Dashboard Key':r.fields['Dashboard Key'],...Object.fromEntries(['Net Sales','Item Costs Excluding Estimates','Estimated Consignment Payouts','Known Management COGS','Gross Profit on Costed Sales','Gross Profit','Operating Expenses','Interest Expense','Profit Before Tax and Depreciation','Sales Missing Cost','COGS Coverage','Items Missing Cost','Checking In','Checking Out','Checking Net','Beginning Owned Inventory','Ending Owned Inventory','Channel Sales','Ownership Sales','Category Spend','Cash In by Source','Cash Out by Purpose'].map(k=>[k,null]))});
 await at.upsert('tbliGxkmK9IKSheKU','Dashboard Key',dashboardChanged);
 return {businessDays,lines:economics.length,missingCosts:economics.filter(f=>f['Known COGS']===null).length,consignmentEstimateLines:economics.filter(f=>f['Estimated Consignment Payout']>0).length,consignmentEstimates:round(economics.reduce((s,f)=>s+n(f['Estimated Consignment Payout']),0))};
}

// A single source table gives the main dashboard one shared period selector.
export function monthlyDashboardRows(ledger,economics,profitRows,financeRows,periodIds){
 const result=[],groups=new Map();
 const add=(month,kind,label,dimension,measure,amount)=>{if(!amount)return;const key=[month,kind,label].join('|');if(!groups.has(key))groups.set(key,{'Dashboard Key':key,Month:month,Period:[periodIds.get(month)],'Row Type':kind,[dimension]:label,[measure]:0});groups.get(key)[measure]=round(groups.get(key)[measure]+amount);};
 const fin=new Map(financeRows.map(r=>[r.fields.Month,r.fields]));
 for(const p of profitRows){const f={'Dashboard Key':p.Month+'|Summary',Month:p.Month,Period:[periodIds.get(p.Month)],'Row Type':'Summary','Coverage Note':p.Status+' | '+(fin.get(p.Month)?.['Inventory Coverage']||'No inventory snapshot')};
  for(const k of ['Net Sales','Item Costs Excluding Estimates','Estimated Consignment Payouts','Gross Profit on Costed Sales','Gross Profit','Operating Expenses','Interest Expense','Profit Before Tax and Depreciation','Sales Missing Cost','COGS Coverage','Items Missing Cost'])f[k]=p[k];
  f['Known Management COGS']=p['Known COGS'];for(const k of ['Checking In','Checking Out','Checking Net','Beginning Owned Inventory','Ending Owned Inventory'])f[k]=fin.get(p.Month)?.[k]??null;result.push(f);
 }
 for(const f of ledger){
  if(f.Type==='Sale')add(f.Month,'Channel',f['Sales Channel']||'Unassigned','Sales Channel','Channel Sales',n(f.Sales));
  add(f.Month,'Expense',f['Expense Category']||'Unassigned','Expense Category','Category Spend',n(f.Spending));
  const description=String(f.Description||'').toLowerCase();
  const incoming=/shopify.*capital|webbank/.test(description)?'Financing':/reverb/.test(description)?'Reverb payouts':/shopify/.test(description)?'Shopify payouts':/hyperwallet|gear exchange/.test(description)?'Gear Exchange payouts':/paypal/.test(description)?'PayPal transfers':/transfer/.test(description)?'Transfers':'Other bank inflows';
  add(f.Month,'Cash in',incoming,'Cash Source','Cash In by Source',n(f['Checking In']));
  const outgoing=n(f.Spending)?f['Expense Category']:'Repayments, transfers and other';
  add(f.Month,'Cash out',outgoing||'Unassigned','Cash Purpose','Cash Out by Purpose',n(f['Checking Out']));
 }
 for(const f of economics)add(f.Month,'Ownership',f.Ownership,'Ownership','Ownership Sales',n(f['Net Sales']));
 return result.concat([...groups.values()]).filter(f=>f.Period[0]);
}
