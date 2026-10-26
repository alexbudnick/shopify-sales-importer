import {createHash}from 'node:crypto';
export const SALE_REVIEW_TABLE='tbl329QLbLJBGNfGF';

export const PUBLICATION_HISTORY_TABLE='tblJW5tfTsHV6b6iT';
export function skuFamily(sku){const s=String(sku||'').trim().toUpperCase();const m=s.match(/^([ACT]\d{8})(?:W|N\d*|R\d*)?$/);return m?m[1]:s;}
export function skuCheckInDate(sku){const m=skuFamily(sku).match(/^[ACT](\d{2})(\d{2})(\d{2})\d{2}$/);if(!m)return null;const date=`20${m[3]}-${m[1]}-${m[2]}`,d=new Date(date+'T00:00:00Z');return !Number.isNaN(d.valueOf())&&d.toISOString().slice(0,10)===date?date:null;}
export function publicationIndex(history){const index=new Map();for(const row of history){const f=row.fields||row,sku=skuFamily(f.SKU),date=f['Published Date'];if(!sku||!/^\d{4}-\d{2}-\d{2}$/.test(date||''))continue;if(!index.has(sku))index.set(sku,[]);index.get(sku).push(f);}return index;}
export function saleTiming(sku,saleDate,line={},index=new Map()){
 const checkIn=skuCheckInDate(sku),records=(index.get(skuFamily(sku))||[]).filter(f=>f['Published Date']<=saleDate),listingId=String(line['Reverb Listing ID']||'');
 // Source Listing Date on a Reverb order is actual publication; Shopify product dates are never used here.
 const direct=/^REVERB-/.test(line['Order Key']||'')&&line['Source Listing Date']&&line['Source Listing Date']<=saleDate?line['Source Listing Date']:null;
 const dates=[...records.map(f=>f['Published Date']),...(direct?[direct]:[])].sort(),first=dates[0]||null;
 const orderMatch=String(line['Order Key']||'').match(/^REVERB-(MAIN|WAREHOUSE):(.+)$/),exact=records.filter(f=>(listingId&&String(f['Listing ID']||'')===listingId)||(orderMatch&&String(f['Listing Key']||'').startsWith(`CSV:${orderMatch[1]}:${orderMatch[2]}:`))),current=direct||exact.map(f=>f['Published Date']).sort()[0]||null;
 const issue=[];if(!checkIn)issue.push('Check-in date unavailable from SKU');if(checkIn&&checkIn>saleDate)issue.push('SKU check-in date is after sale');if(first&&checkIn&&first<checkIn)issue.push('Publication predates SKU check-in');
 return {'SKU Check-in Date':checkIn,'First Reverb Published Date':first,'This Reverb Listing Published Date':current,'Reverb Listing ID':listingId,'Publication Source':first?[...new Set([...records.filter(f=>f['Published Date']===first).map(f=>`${f.Source||'Reverb publication history'}${f['Source File']?' · '+f['Source File']:''}`),...(direct===first?['Reverb order API · published_at']:[])])].join('\n'):'Awaiting Reverb publication export','Timing Check':issue.join('; ')||'Dates consistent'};
}

const n=x=>Number(x)||0,round=x=>Math.round(x*100)/100;
export function reviewCostOverrides(lines,reviews){const overrides=new Map(reviews.filter(r=>typeof r.fields['Item Cost Override']==='number').map(r=>[r.fields['Line Key'],r.fields['Item Cost Override']])),existing=new Set(lines.map(r=>r.fields['Line Key']));const result=lines.map(r=>overrides.has(r.fields['Line Key'])?{...r,fields:{...r.fields,'Confirmed Item COGS':overrides.get(r.fields['Line Key'])}}:r);for(const {fields:f}of reviews)if(overrides.has(f['Line Key'])&&!existing.has(f['Line Key'])&&f['Order Key'])result.push({fields:{'Line Key':f['Line Key'],'Order Key':f['Order Key'],SKU:f.SKU||'',Item:f.Item||'Sale requires item allocation',Quantity:f.Quantity||1,'Sale Amount':f['Sale Price']||0,'Confirmed Item COGS':overrides.get(f['Line Key'])}});return result;}
function imageUrls(value){let s=value;if(typeof s==='string'){try{s=JSON.parse(s)}catch{s=String(s).split(/[\s,]+/)}}if(!Array.isArray(s))return [];return s.map(v=>typeof v==='string'?v:v.url||v.src||v._links?.large_crop?.href||v._links?.large?.href||v._links?.full?.href).filter(v=>/^https:\/\//.test(v||''));}
export function buildSaleReviews(economics,orders,lines,paypal,inventory,labels=[],settlements=[],catalog=new Map(),history=[]){
 const timingIndex=publicationIndex(history);
 const byOrder=new Map(orders.map(r=>[r.fields['Order Key'],r.fields])),byId=new Map(orders.map(r=>[r.id,r.fields['Order Key']])),lineMap=new Map(lines.map(r=>[r.fields['Line Key'],r.fields]));
 const inventoryMap=new Map();for(const r of inventory){const sku=String(r.fields.SKU||'').trim();if(!sku)continue;if(!inventoryMap.has(sku))inventoryMap.set(sku,[]);inventoryMap.get(sku).push(r);}
 const orderTotals=new Map(),groups=new Map();for(const e of economics){if(!n(e['Net Sales']))continue;const key=e['Line Key'];let g=groups.get(key);if(!g){g={...e,revenue:0,cost:0,date:e.Date};groups.set(key,g)}g.revenue+=n(e['Net Sales']);g.cost+=n(e['Known COGS']);if(e.Date<g.date)g.date=e.Date;orderTotals.set(e['Order Key'],n(orderTotals.get(e['Order Key']))+n(e['Net Sales']));}
 const ppFees=new Map();for(const {fields:f}of paypal){const order=byId.get(f['Related Sales Order']?.[0]);if(order)ppFees.set(order,n(ppFees.get(order))-n(f['Fee Amount']));}
 const sourceFees=new Map();for(const row of settlements){const f=row.fields||row;sourceFees.set(f['Order Key'],n(sourceFees.get(f['Order Key']))+n(f['Fee Amount']));}
 const shipping=new Map();for(const row of labels){const f=row.fields||row;if(f.Status==='Matched')shipping.set(f['Matched Order Key'],n(shipping.get(f['Matched Order Key']))+n(f['Total Cost']));}
 const result=[],budgets=new Map();
 for(const [lineKey,g]of groups){const line=lineMap.get(lineKey)||{},order=byOrder.get(g['Order Key'])||{},matches=inventoryMap.get(g.SKU)||[],inv=matches.length===1?matches[0]:null,i=inv?.fields||{};
  const product=catalog.get(String(line['Product ID']||i['Shopify Product ID']||''));const variant=product?.variants?.find(v=>v.sku===g.SKU);
  const share=n(orderTotals.get(g['Order Key']))?g.revenue/orderTotals.get(g['Order Key']):0;
  const fees=n(order['Platform Fees'])+(typeof order['Processing Fees']==='number'?order['Processing Fees']:n(ppFees.get(g['Order Key'])))+n(sourceFees.get(g['Order Key']));
  const ship=n(order['Shipping Label Fees'])+n(shipping.get(g['Order Key']));budgets.set(g['Order Key'],{fees,ship});
  let photos=imageUrls(line['Listing Photo URLs']),photoKind='Source listing';if(!photos.length&&product?.images?.length){photos=imageUrls(product.images);photoKind='Shopify product'}if(!photos.length){photos=imageUrls(i['Tech Photos']);photoKind='Inventory intake photos'}
  const photoKey=photos.length?createHash('sha256').update(JSON.stringify(photoKind==='Inventory intake photos'?(i['Tech Photos']||[]).map(a=>a.id):photos)).digest('hex'):'';
  let listed=line['Source Listing Date']||product?.published_at?.slice(0,10)||null;if(listed&&listed>g.date)listed=null;
  const f={...saleTiming(g.SKU,g.date,line,timingIndex),Item:g.Item||line.Item||g.SKU||'Unallocated sale','Line Key':lineKey,SKU:g.SKU||'','Order Key':g['Order Key'],'Sale Date':g.date,'Sales Channel':g['Sales Channel']||'','Channel Filter':g['Sales Channel']||'Shopify',Ownership:g.Ownership||'Unknown','Ownership Filter':g.Ownership||'Unknown',Quantity:n(line.Quantity)||1,'Sale Price':round(n(line['Sale Amount'])||g.revenue),'Revenue Before Selling Costs':round(g.revenue),'Source Fees':round(fees*share),'Source Shipping Cost':round(ship*share),'Source Item Cost Estimate':round(g.cost),'List Price Reference':typeof line['Source Listed Price']==='number'?line['Source Listed Price']:variant?Number(variant.price):typeof i.Price==='number'?i.Price:null,'Listing URL':i['Reverb URL']||order['Source URL']||'','Inventory URL':inv?'https://airtable.com/app2DxCRaxnHQL3zR/tbljh3I54QsvFDoZe/'+inv.id:'','Source Listed Date':listed,'Source Note':'Management estimates. Fees: '+(sourceFees.has(g['Order Key'])?'Shopify settlement fees matched':order['Fee Status']||'source charges only')+'. Shipping uses matched labels only; unassigned labels remain in period totals. '+'Reverb publication history supplies the listing timeline; SKU supplies check-in. '+(typeof line['Source Listed Price']==='number'?'Listed price recorded from listing.':'List price is a current product/inventory reference, not a historical snapshot.')};
  if(photos.length){f.Photos=photos.slice(0,4).map((url,k)=>({url,filename:(g.SKU||'sale')+'-'+(k+1)+'.jpg'}));f['Photo Source Key']=photoKey;f['Source Note']+=' Photos: '+photoKind+'.';}
  result.push(f);
 }
 const grouped=new Map();for(const f of result){if(!grouped.has(f['Order Key']))grouped.set(f['Order Key'],[]);grouped.get(f['Order Key']).push(f)}for(const [key,items]of grouped){const budget=budgets.get(key),sum=items.reduce((s,f)=>s+Math.max(0,n(f['Revenue Before Selling Costs'])),0);let fees=0,ship=0;for(let j=0;j<items.length;j++){const f=items[j],weight=sum?Math.max(0,n(f['Revenue Before Selling Costs']))/sum:1/items.length;f['Source Fees']=j===items.length-1?round(budget.fees-fees):round(budget.fees*weight);f['Source Shipping Cost']=j===items.length-1?round(budget.ship-ship):round(budget.ship*weight);fees+=f['Source Fees'];ship+=f['Source Shipping Cost'];}}
 return result;
}
export async function saleProductCatalog(env,inventory,lines){
 const neededSkus=new Set(lines.map(r=>r.fields.SKU)),ids=[...new Set([...inventory.filter(r=>neededSkus.has(r.fields.SKU)).map(r=>r.fields['Shopify Product ID']),...lines.map(r=>r.fields['Product ID'])].filter(x=>/^\d+$/.test(String(x))))];const catalog=new Map();if(!ids.length)return catalog;
 const host=env.SHOPIFY_STORE_DOMAIN;if(!/^[a-z0-9-]+\.myshopify\.com$/i.test(host))return catalog;
 const a=await fetch('https://'+host+'/admin/oauth/access_token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:env.SHOPIFY_CLIENT_ID,client_secret:env.SHOPIFY_CLIENT_SECRET})});if(!a.ok)throw Error('Product photo authorization failed');const auth=await a.json();
 for(let j=0;j<ids.length;j+=200){const q=new URLSearchParams({ids:ids.slice(j,j+200).join(','),fields:'id,published_at,images,variants',limit:'250'});const r=await fetch('https://'+host+'/admin/api/'+(env.SHOPIFY_API_VERSION||'2026-01')+'/products.json?'+q,{headers:{'X-Shopify-Access-Token':auth.access_token},signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('Product photos HTTP '+r.status);const d=await r.json();for(const p of d.products||[])catalog.set(String(p.id),p);}
 return catalog;
}
export async function syncSaleReviews(at,economics,orders,lines,paypal,inventory,reviews){
 const labels=await at.all('tbltb5iyUiHH0pSPI'),settlements=await at.all('tblhTTbD4ezGKfLhc');let catalog=new Map(),photoAccess='Available';try{catalog=await saleProductCatalog(process.env,inventory,lines)}catch(e){photoAccess=e.message;}
 const history=await at.all(PUBLICATION_HISTORY_TABLE);
 const rows=buildSaleReviews(economics,orders,lines,paypal,inventory,labels,settlements,catalog,history),index=new Map(reviews.map(r=>[r.fields['Line Key'],r.fields]));
 const changed=[];for(const f of rows){const old=index.get(f['Line Key']);if(f['Photo Source Key']===old?.['Photo Source Key']){delete f.Photos;delete f['Photo Source Key'];}if(Object.entries(f).some(([k,v])=>JSON.stringify(v??'')!==JSON.stringify(old?.[k]??'')))changed.push(f);}
 const active=new Set(rows.map(r=>r['Line Key']));for(const {fields:f}of reviews)if(!active.has(f['Line Key']))changed.push({'Line Key':f['Line Key'],'Revenue Before Selling Costs':0,'Sale Price':0,'Source Fees':0,'Source Shipping Cost':0,'Source Item Cost Estimate':0,'Source Note':'Source sale no longer eligible. Manual notes and overrides retained.'});
 for(let j=0;j<changed.length;j+=10){const batch=changed.slice(j,j+10);try{await at.upsert(SALE_REVIEW_TABLE,'Line Key',batch)}catch(e){if(!batch.some(f=>f.Photos))throw e;const retry=batch.map(f=>{const out={...f};delete out.Photos;delete out['Photo Source Key'];out['Source Note']=(out['Source Note']||'')+' Photo attachment could not be imported.';return out});await at.upsert(SALE_REVIEW_TABLE,'Line Key',retry);}}
 return {rows:rows.length,written:changed.length,productPhotos:catalog.size,publicationDates:rows.filter(f=>f['First Reverb Published Date']).length,checkInDates:rows.filter(f=>f['SKU Check-in Date']).length,photoAccess};
}
