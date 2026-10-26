const n=x=>Number(x)||0,round=x=>Math.round(x*100)/100;
export const SHIPPING_TABLE='tbltb5iyUiHH0pSPI';
const clean=x=>String(x||'').trim().replace(/^#/,'');
export function reconcileShipments(shipments,orders,lines,paypal=[]){
 const eligible=orders.filter(r=>!/^Duplicate|^Unpaid|^Cancelled/.test(r.fields['Report Status']||''));const keys=new Map(eligible.map(r=>[r.fields['Order Key'],r.fields]));
 const skuOrders=new Map();for(const {fields:f}of lines){if(!keys.has(f['Order Key'])||!f.SKU)continue;if(!skuOrders.has(f.SKU))skuOrders.set(f.SKU,new Set());skuOrders.get(f.SKU).add(f['Order Key']);}
 const byId=new Map(eligible.map(r=>[r.id,r.fields['Order Key']]));const paypalKeys=new Map(paypal.map(r=>[r.fields['Transaction ID'],byId.get(r.fields['Related Sales Order']?.[0])]));
 const trackCounts=new Map();for(const s of shipments)if(!s.voided&&s.trackingNumber)trackCounts.set(s.trackingNumber,(trackCounts.get(s.trackingNumber)||0)+1);
 return shipments.map(s=>{const skus=[...new Set((s.shipmentItems||[]).map(i=>String(i.sku||'').trim()).filter(Boolean))];
  const identifiers=[s.orderKey,s.orderNumber,/^\d{10,}-\d+$/.test(String(s.orderKey||''))?String(s.orderKey).split('-')[0]:null,/^GX\d+$/.test(String(s.orderNumber||''))?String(s.orderNumber).slice(2):null,paypalKeys.get(s.orderNumber)];
  let candidates=eligible.filter(({fields:f})=>identifiers.some(v=>clean(v)&&[f['Order Key'],f['Order ID'],String(f['Order Key']||'').split(':').at(-1)].some(x=>clean(x)===clean(v)))).map(r=>r.fields['Order Key']);
  if(candidates.length>1&&skus.length)candidates=candidates.filter(k=>skus.every(sku=>skuOrders.get(sku)?.has(k)));
  let evidence='Exact order identifier';if(!candidates.length&&skus.length){candidates=[...keys.keys()].filter(k=>skus.every(sku=>skuOrders.get(sku)?.has(k))&&Math.abs(Date.parse(keys.get(k)['Order Date'])-Date.parse(String(s.shipDate||s.createDate).slice(0,10)))<32*86400000);evidence='Unique SKU set and order date within 31 days';}
  const match=candidates.length===1?keys.get(candidates[0]):null;
  let status=s.voided?'Voided — excluded':typeof s.shipmentCost!=='number'?'Missing source amount':candidates.length!==1?'Unmatched / ambiguous order':n(match?.['Shipping Label Fees'])>0?'Reverb / ShipStation overlap — review':s.trackingNumber&&trackCounts.get(s.trackingNumber)>1?'Repeated tracking — review':'Matched';
  return {'Label Key':'SHIPSTATION:'+s.shipmentId,Source:'ShipStation','Order Number':String(s.orderNumber||''),'Source Order Key':String(s.orderKey||''),'Matched Order Key':match?.['Order Key']||'',SKUs:skus.join('\n'),Date:String(s.shipDate||s.createDate).slice(0,10),'Tracking Number':s.trackingNumber||'','Label Cost':n(s.shipmentCost),'Insurance Cost':n(s.insuranceCost),'Total Cost':s.voided?0:round(n(s.shipmentCost)+n(s.insuranceCost)),Status:status,Notes:evidence+(match?' · sale date '+match['Order Date']:'')};
 });
}
export async function syncShipping(at,env,start){
 if(!env.SHIPSTATION_API_KEY||!env.SHIPSTATION_API_SECRET)throw Error('ShipStation API key and secret are not configured');
 const shipments=[],seen=new Set();let pages=1;
 for(let page=1;page<=pages;page++){if(page>20)throw Error('ShipStation shipment history exceeds the supported page limit');const q=new URLSearchParams({createDateStart:start.slice(0,10),page:String(page),pageSize:'500',includeShipmentItems:'true'});const r=await fetch((env.SHIPSTATION_API_BASE||'https://ssapi.shipstation.com').replace(/\/$/,'')+'/shipments?'+q,{headers:{Authorization:'Basic '+Buffer.from(env.SHIPSTATION_API_KEY+':'+env.SHIPSTATION_API_SECRET).toString('base64')},signal:AbortSignal.timeout(45000)});if(!r.ok)throw Error('ShipStation shipments HTTP '+r.status);const data=await r.json();pages=Number(data.pages)||1;for(const s of data.shipments||[]){if(!s.shipmentId)throw Error('Shipment ID missing');if(seen.has(s.shipmentId))throw Error('Repeated ShipStation shipment ID');seen.add(s.shipmentId);shipments.push(s);}}
 const orders=await at.all('tblJF93j14JRV8d5y'),lines=await at.all('tbl5Mpv86jeCfnhcL'),paypal=await at.all('tblLfxT9f4TQmXYWw'),rows=reconcileShipments(shipments,orders,lines,paypal),old=await at.all(SHIPPING_TABLE),index=new Map(old.map(r=>[r.fields['Label Key'],r.fields]));
 const changed=rows.filter(f=>Object.entries(f).some(([k,v])=>JSON.stringify(v)!==JSON.stringify(index.get(f['Label Key'])?.[k]??(typeof v==='number'?0:''))));await at.upsert(SHIPPING_TABLE,'Label Key',changed);
 return {read:rows.length,written:changed.length,matched:rows.filter(f=>f.Status==='Matched').length,held:rows.filter(f=>f.Status!=='Matched'&&!f.Status.startsWith('Voided')).length,voided:rows.filter(f=>f.Status.startsWith('Voided')).length};
}
