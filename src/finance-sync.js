import { createHash } from 'node:crypto';

const BASE = 'app7b0v3wEXudVmkD';
const TABLES = {orders:'tblJF93j14JRV8d5y', lines:'tbl5Mpv86jeCfnhcL', paypal:'tblLfxT9f4TQmXYWw', log:'tblXWcjKT4Tld5ySw',receipts:'tblblwbHmUit1mg3Z',bank:'tbllyk6vCuaP2wYiF',accounts:'tblRzEqOfqQzbrY8h'};
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
export function money(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = typeof value === 'object' ? (value.amount ?? value.value) : value;
  if(raw === null || raw === undefined || raw === '') return null;
  const n=Number(raw); return Number.isFinite(n) ? Math.round(n*100)/100 : null;
}
export function businessDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(value))return value;
  const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  const get=t=>p.find(x=>x.type===t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
const compact = obj => Object.fromEntries(Object.entries(obj).filter(([,v])=>v!==null&&v!==undefined));
const hash = fields => createHash('sha256').update(JSON.stringify(fields)).digest('hex');
const sum = values => Math.round(values.reduce((a,v)=>a+(money(v)||0),0)*100)/100;
export function normalizeShopify(o) {
  if(!o.id) throw Error('Shopify order missing ID');
  const key=`SHOPIFY:${o.id}`, warnings=[];
  const hint=JSON.stringify([o.source_name,o.app_id,o.tags,o.note_attributes]).toLowerCase();
  let channel='Shopify';
  if(/reverb|gear.?exchange|sweetwater|gxe|cedcommerce/.test(hint)) {channel=null;warnings.push('Marketplace mirror: verify original channel and exclude duplicate Shopify copy.');}
  if(!['web','shopify_draft_order','pos'].includes(String(o.source_name)))warnings.push(`Unverified Shopify source: ${o.source_name||'missing'}`);
  const refundParts=(o.refunds||[]).flatMap(r=>r.refund_line_items||[]);
  let refund=sum(refundParts.map(x=>x.subtotal));
  let refundTax=sum(refundParts.map(x=>x.total_tax));
  for(const r of o.refunds||[]){
    for(const a of r.order_adjustments||[]){
      if(a.kind==='shipping_refund'){refund+=Math.abs(money(a.amount)||0);refundTax+=Math.abs(money(a.tax_amount)||0);}
      else warnings.push('Refund adjustment requires review.');
    }
    if(r.transactions?.some(t=>t.kind==='refund'&&t.status!=='success'))warnings.push('Refund payment status requires review.');
  }
  if((o.refunds||[]).length)warnings.push('Refund included; verify shipping, adjustments, and refund date.');
  const fields=compact({'Order Key':key,'Order ID':String(o.id),'Channel':String(o.source_name||''),'Sales Channel':channel,'Status':String(o.financial_status||''),'Order Date':businessDate(o.created_at),'Currency':o.currency||null,'Items Subtotal':money(o.subtotal_price),'Shipping Charged':sum((o.shipping_lines||[]).map(x=>x.discounted_price??x.price)),'Tax Collected':money(o.total_tax),'Refund Amount':Math.round(refund*100)/100,'Import Source':'Shopify API','Source URL':`https://${process.env.SHOPIFY_STORE_DOMAIN||'aflashfloodofgear.myshopify.com'}/admin/orders/${o.id}`,'Fee Status':'Missing — settlement fees not imported','Import Warnings':warnings.join('\n')});
  let report='Needs review';
  if(o.cancelled_at)report='Cancelled — excluded';
  else if(!['paid','partially_refunded','refunded'].includes(o.financial_status))report='Unpaid — excluded';
  const lines=(o.line_items||[]).map(l=>{
    if(!l.id)throw Error('Shopify line missing stable ID');
    const discounts=sum((l.discount_allocations||[]).map(x=>x.amount));
    return { 'Line Key':`${key}:${l.id}`,'Order Key':key,'SKU':String(l.sku||''),'Item':String(l.title||l.name||''),'Quantity':Number(l.quantity)||0,'Sale Amount':Math.round(((money(l.price)||0)*(Number(l.quantity)||0)-discounts)*100)/100,'Cost Status':'Not snapshotted — do not infer profit'};
  });
  return {fields,report,lines,refundTax};
}
export function normalizeReverb(o,shop) {
  const id=o.order_number??o.id; if(!id)throw Error('Reverb order missing ID');
  const key=`REVERB-${shop}:${id}`, warnings=[];
  const status=typeof o.status==='string'?o.status:o.status?.slug||'';
  const subtotal=money(o.amount_product_subtotal??o.amount_product),shipping=money(o.shipping),tax=money(o.amount_tax);
  if([subtotal,shipping,tax].some(v=>v===null))warnings.push('Missing source amount: verify subtotal, shipping and tax.');
  if(/refund|cancel/.test(status)||o.refunds?.length)warnings.push('Refund/cancellation: reconcile actual refund before including.');
  const fields=compact({'Order Key':key,'Order ID':String(id),'Channel':`Reverb ${shop}`,'Sales Channel':shop==='MAIN'?'Reverb (main)':'Reverb (Warehouse deals)','Status':status,'Order Date':businessDate(o.created_at),'Paid At':businessDate(o.paid_at),'Currency':o.amount_product?.currency||o.total?.currency||null,'Items Subtotal':subtotal,'Shipping Charged':shipping,'Tax Collected':tax,'Platform Fees':money(o.selling_fee),'Processing Fees':money(o.direct_checkout_fee),'Shipping Label Fees':money(o.shipping_label_fee),'Import Source':`Reverb ${shop} API`,'Source URL':`https://reverb.com/my/selling/orders/${encodeURIComponent(id)}`,'Fee Status':money(o.selling_fee)!==null&&money(o.direct_checkout_fee)!==null?'Source fees supplied — other charges not reconciled':'Missing source fees','Import Warnings':warnings.join('\n')});
  let report=['paid','shipped','picked_up','received','completed','delivered'].includes(status)?'Needs review':'Unpaid — excluded';
  if(/cancel|refund/.test(status))report='Cancelled — excluded';
  const sku=String(o.sku||o.listing?.sku||'').replace(/^.*?([ACT]\d{8}[A-Z0-9]*)$/i,'$1');
  return {fields,report,lines:[{'Line Key':`${key}:item`,'Order Key':key,'SKU':sku,'Item':String(o.title||o.listing?.title||''),'Quantity':Number(o.quantity)||1,...(subtotal!==null?{'Sale Amount':subtotal}:{}),'Cost Status':'Not snapshotted — do not infer profit'}]};
}
export function normalizePayPal(d) {
  const t=d.transaction_info||{},id=t.transaction_id,code=t.transaction_event_code;
  if(!id||!code)throw Error('PayPal activity missing identity');
  return compact({'Transaction Key':`PAYPAL:${id}:${code}`,'Transaction ID':String(id),'Date':businessDate(t.transaction_initiation_date),'Event Code':code,'Status':t.transaction_status||'','Currency':t.transaction_amount?.currency_code||'','Gross Amount':money(t.transaction_amount),'Fee Amount':money(t.fee_amount),'Invoice ID':String(t.invoice_id||''),'Reference ID':String(t.paypal_reference_id||''),'Description':String(t.transaction_subject||t.transaction_note||'').slice(0,3000)});
}
export function classifyPayPal(f,all=new Map()){
  const override=f['Classification Override'];
  if(['Invoice payment','Show POS sale','Direct PayPal sale','Bricklink sale','Customer refund','Purchase refund','Loan proceeds','Account transfer','Credit financing','Tax remittance','Payment sent — review','Other incoming — review'].includes(override))return [override,f['Owner Classification Note']||'Owner-confirmed classification.'];
  const gross=money(f['Gross Amount'])||0,code=f['Event Code']||'',desc=f['Report Description']||'',name=f['Report Counterparty']||'';
  if(gross>0&&/webbank/i.test(name))return ['Loan proceeds','Financing, not a customer sale.'];
  if(/BML|Transfer To BML/i.test(desc))return ['Credit financing','Credit movement, not sales or a second purchase.'];
  if(/Deposit|Withdrawal/i.test(desc))return ['Account transfer','Funding or withdrawal; do not count as sales or a second expense.'];
  if((desc==='Payment Refund'||code==='T1107')&&gross<0){const original=all.get(f['Reference ID']);return ['Customer refund',original?`Refund links to original payment ${f['Reference ID']}; retain refund transaction date.`:'Refund needs original-payment review.'];}
  if(desc==='Payment Refund'&&gross>0)return ['Purchase refund','Refund received on an outgoing payment, not customer sales.'];
  if(gross>0&&(desc==='POS Payment'||code==='T0018')&&f.Status==='S')return ['Show POS sale','POS identifier verified against uploaded PayPal report.'];
  if(gross>0&&/^\d{4}$/.test(f['Invoice ID']||'')&&(desc==='Express Checkout Payment'||code==='T0006')&&f.Status==='S')return ['Invoice payment','Payment on invoice; group repeated invoice numbers instead of counting each installment as an order.'];
  if(gross<0)return ['Payment sent — review','Review business/personal use and bank/card overlap before treating as expense.'];
  return ['Other incoming — review','Cannot establish a direct business sale from payment type alone.'];
}
export function paypalOrderGroups(activityRows){
  const byTxn=new Map(activityRows.map(r=>[r.fields['Transaction ID'],r.fields])),groups=new Map();
  for(const r of activityRows){const f=r.fields,[kind]=classifyPayPal(f,byTxn);let key;
    if(kind==='Show POS sale')key=`PAYPAL-POS:${f['Transaction ID']}`;
    else if(kind==='Invoice payment')key=`PAYPAL-INVOICE:${f['Invoice ID']}`;
    else if(kind==='Direct PayPal sale')key=`PAYPAL-DIRECT:${f['Transaction ID']}`;
    else if(kind==='Bricklink sale')key=`BRICKLINK:${f['Transaction ID']}`;
    else if(kind==='Customer refund'){
      const parent=byTxn.get(f['Reference ID']);if(!parent)continue;const [parentKind]=classifyPayPal(parent,byTxn);
      if(parentKind==='Invoice payment')key=`PAYPAL-INVOICE:${parent['Invoice ID']}`;
      else if(parentKind==='Show POS sale')key=`PAYPAL-POS:${parent['Transaction ID']}`;
      else if(parentKind==='Direct PayPal sale')key=`PAYPAL-DIRECT:${parent['Transaction ID']}`;
      else if(parentKind==='Bricklink sale')key=`BRICKLINK:${parent['Transaction ID']}`;
    }
    if(!key)continue;
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);
  }
  return [...groups].map(([key,rows])=>{
    const payments=rows.filter(r=>r.fields['Gross Amount']>0),refunds=rows.filter(r=>r.fields['Gross Amount']<0);
    if(!payments.length)return null;
    const first=payments[0].fields,isPos=key.startsWith('PAYPAL-POS:'),isInvoice=key.startsWith('PAYPAL-INVOICE:'),isBricklink=key.startsWith('BRICKLINK:'),currencies=new Set(rows.map(r=>r.fields.Currency));
    const salesChannel=isBricklink?'Bricklink':isPos?'PayPal — Show POS':isInvoice?'PayPal — Invoices':'PayPal — Direct';
    const warning=['Invoice/POS source payment summary: verify original order, tax, items and cross-channel duplication before inclusion.'];
    if(payments.length>1)warning.push(`${payments.length} payments on this invoice; not separate orders. Use activity dates for cash receipt reporting.`);
    if(refunds.length)warning.push('Refunds included in grouped order; activity dates preserve refund timing separately.');
    if(currencies.size!==1)warning.push('Mixed currency: do not aggregate into USD.');
    const verified=rows.every(r=>r.fields['Report Match']==='Matched — ID, gross, fee and currency');
    if(!verified)warning.push('New API-only activity awaits report/tax verification.');
    const subtotal=verified?sum(payments.map(r=>r.fields['Gross Amount']-r.fields['Report Shipping']-Math.abs(r.fields['Report Tax']||0))):null;
    const fields=compact({'Order Key':key,'Order ID':isInvoice?first['Invoice ID']:first['Transaction ID'],'Sales Channel':salesChannel,'Business / Brand':isBricklink?'A Flash Flood of Bricks':'A Flash Flood of Gear','Payment Method':'PayPal','Status':'Payments received — order review pending','Order Date':payments.map(r=>r.fields.Date).sort()[0],'Paid At':payments.map(r=>r.fields.Date).sort().at(-1),'Currency':currencies.size===1?first.Currency:null,'Items Subtotal':subtotal,'Shipping Charged':verified?sum(payments.map(r=>r.fields['Report Shipping'])):null,'Tax Collected':verified?sum(payments.map(r=>Math.abs(r.fields['Report Tax']||0))):null,'Refund Amount':verified?-sum(refunds.map(r=>r.fields['Gross Amount']+Math.abs(r.fields['Report Tax']||0))):null,'Processing Fees':-sum(rows.map(r=>r.fields['Fee Amount'])),'Platform Fees':0,'Fee Status':verified?'Verified':'Source payment fees; tax verification pending','Import Source':'PayPal grouped payments','Receipt Basis':`${payments.length} payment(s), ${refunds.length} refund(s). Order date is first receipt, not verified invoice issue date.`,'Import Warnings':warning.join('\n')});
    return {fields,report:'Needs review',lines:[],activityIds:rows.map(r=>r.id)};
  }).filter(Boolean);
}
async function linkPayPalOrders(at){
  const rows=await at.all(TABLES.paypal),byTxn=new Map(rows.map(r=>[r.fields['Transaction ID'],r.fields]));
  const classified=rows.map(r=>{const [kind,note]=classifyPayPal(r.fields,byTxn);return {'Transaction Key':r.fields['Transaction Key'],'Activity Class':kind,'Classification Note':note};});
  await at.upsert(TABLES.paypal,'Transaction Key',changedRows(classified,uniqueIndex(rows,'Transaction Key'),'Transaction Key'));
  const existing=uniqueIndex(await at.all(TABLES.orders),'Order Key'),groups=paypalOrderGroups(rows);
  const updates=changedRows(groups.map(n=>mergeOrder(existing.get(n.fields['Order Key']),n)),existing,'Order Key');
  await at.upsert(TABLES.orders,'Order Key',updates);
  const fresh=uniqueIndex(await at.all(TABLES.orders),'Order Key'),links=groups.flatMap(n=>n.activityIds.map(id=>({'Transaction Key':rows.find(r=>r.id===id).fields['Transaction Key'],'Related Sales Order':[fresh.get(n.fields['Order Key']).id]})));
  await at.upsert(TABLES.paypal,'Transaction Key',changedRows(links,uniqueIndex(rows,'Transaction Key'),'Transaction Key'));
  return {orders:groups.length,ordersWritten:updates.length};
}
export function normalizeGxe(o){
  if(!/^\d+$/.test(String(o.orderId)))throw Error('GXE order missing ID');
  const key=`GXE:${o.orderId}`,warnings=['Verify GXE USD currency and quantity against order. Hyperwallet settlement fees not imported.'];
  const subtotal=money(o.soldPrice),shipping=money(o.shippingAmount),tax=money(o.taxAmount),total=money(o.totalAmount);
  if([subtotal,shipping,tax,total].some(v=>v===null)||Math.abs((subtotal||0)+(shipping||0)+(tax||0)-(total||0))>0.02)warnings.push('Source order amounts do not reconcile.');
  const status=String(o.status||''),paid=['Awaiting Shipping','Label Created','Tracking Provided','In Transit','Delivered','Picked Up','Payout Complete'].includes(status);
  const fields=compact({'Order Key':key,'Order ID':String(o.orderId),'Sales Channel':'Gear Exchange','Payment Method':'Hyperwallet','Status':status,'Order Date':businessDate(o.soldAt),'Currency':o.currency||'USD','Items Subtotal':subtotal,'Shipping Charged':shipping,'Tax Collected':tax,'Import Source':'Gear Exchange API','Fee Status':'Missing — reconcile Hyperwallet settlement fees','Import Warnings':warnings.join('\n')});
  return {fields,report:paid?'Needs review':/cancel|refund/i.test(status)?'Cancelled — excluded':'Unpaid — excluded',lines:[compact({'Line Key':`${key}:item`,'Order Key':key,'SKU':String(o.sku||''),'Item':String(o.title||o.listingTitle||''),'Quantity':Number(o.quantity)||1,'Sale Amount':subtotal,'Cost Status':'Not snapshotted — do not infer profit'})]};
}
export function normalizeReceipt(r,events=new Map()){
  const f=r.fields,payer=String(f['Payment Method']||'');
  const amount=money(f['Original Amount']??f['JPY Amount']);
  const currency=f.Currency||(money(f['JPY Amount'])!==null?'JPY':null);
  const attachments=(f.Receipt||[]).map(a=>({url:a.url,filename:a.filename}));
  const fields=compact({'Purchase ID':`SRC-${r.id}`,'Sourcing Record ID':r.id,'Purchase Date':f.Date||null,'Vendor':String(f['Vendor / Payee']||''),'Currency':currency,'Original Amount':amount,'Estimated USD':money(f['USD Estimated']),'Payment Account':payer,'Expense Source':/^Chase/.test(payer)?'Chase bank accounts + cards':/^(Amex|Delta Amex)$/.test(payer)?'Amex':/^Cash/.test(payer)?'Cash':'Other','Event ID':(f['Trip / Event']||[]).map(id=>events.get(id)||id).join(', '),'Expense Category':String(f['Expense Category']||''),'Source Record URL':`https://airtable.com/appyiRn4kLqU03S1i/tbln41baCj2Mhkz3u/${r.id}`});
  // Only attach when the source has attachments. Removing a source file must not destroy finance evidence.
  if(attachments.length)fields.Receipt=attachments;
  if(money(f['USD Actual'])!==null)fields['Settled USD']=money(f['USD Actual']);
  const fingerprint=hash({...fields,Receipt:(f.Receipt||[]).map(a=>a.id)});
  return {fields,fingerprint};
}
export function normalizeCashShow(r,events=new Map()){
  const f=r.fields;
  if(String(f.Type||'').toLowerCase()!=='sale'||String(f['Payment Method']||'').toLowerCase()!=='cash')return null;
  const warnings=[],subtotal=money(f['Sale Amount USD']),tax=money(f['Tax Collected USD']),cash=money(f['Cash Received USD']);
  if(!f.Date)warnings.push('Missing sale date');
  if(tax===null)warnings.push('Enter tax explicitly, including 0 when applicable.');
  if(subtotal===null||cash===null||Math.abs((subtotal||0)+(tax||0)-(cash||0))>0.01)warnings.push('Cash received must reconcile to sale amount plus tax.');
  if(f['Trade Group ID'])warnings.push('Trade: do not count trade value as cash sales.');
  const key=`SHOW-CASH:${r.id}`;
  const fields=compact({'Order Key':key,'Order ID':r.id,'Sales Channel':'Cash from shows','Payment Method':'Cash','Status':'Cash sale — source entry','Order Date':f.Date||null,'Currency':'USD','Items Subtotal':subtotal,'Shipping Charged':0,'Tax Collected':tax,'Refund Amount':0,'Platform Fees':0,'Processing Fees':0,'Fee Status':'Verified','Import Source':'Sourcing show cash entry','Event ID':(f['Trip / Event']||[]).map(id=>events.get(id)||id).join(', '),'Source URL':`https://airtable.com/appyiRn4kLqU03S1i/tblJ9QtpEFi1efOgl/${r.id}`,'Import Warnings':warnings.join('\n')});
  return {fields,report:'Needs review',lines:[compact({'Line Key':`${key}:item`,'Order Key':key,'SKU':String(f.SKU||''),'Item':'Show cash sale','Quantity':Number(f.Quantity)||1,'Sale Amount':subtotal,'Cost Status':'Not snapshotted — do not infer profit'})]};
}
const vendorWords=s=>String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w=>w.length>=5&&!['payment','purchase','online','paypal','aplpay','guitar','guitars'].includes(w));
export function receiptSuggestions(bank,receipts,accounts){
  const candidates=new Map(),reverse=new Map();
  for(const b of bank){const f=b.fields;if(f['Is Pending?']||!(f.Amount<0)||f['Receipt / Purchase']?.length)continue;
    const account=accounts.get(f.Account?.[0]);if(!account)continue;
    const institution=String(account.fields['Expense Source']||'');
    for(const r of receipts){const rf=r.fields;if(!rf['Purchase Date']||money(rf['Settled USD'])===null||rf['Expense Source']!==institution)continue;
      const payer=rf['Payment Account']||'';
      // Chase has three identically named cards: don't guess which one paid a receipt.
      if(institution!=='Amex'||!['Amex','Delta Amex'].includes(payer))continue;
      if(Math.abs(Math.abs(f.Amount)-rf['Settled USD'])>0.005)continue;
      const days=Math.abs(Date.parse(f.Date)-Date.parse(rf['Purchase Date']))/86400000;
      if(!Number.isFinite(days)||days>3)continue;
      const text=String(f['Merchant Name']||f.Summary||'').toLowerCase();
      if(!vendorWords(rf.Vendor).some(w=>text.includes(w)))continue;
      if(!candidates.has(b.id))candidates.set(b.id,[]);candidates.get(b.id).push(r.id);
      reverse.set(r.id,(reverse.get(r.id)||0)+1);
    }
  }
  return bank.map(b=>{const ids=candidates.get(b.id)||[];return {id:b.id,fields:{'ID':b.fields.ID,'Suggested Receipt Matches':ids.length===1&&reverse.get(ids[0])===1?ids:[],'Receipt Match Note':ids.length===1&&reverse.get(ids[0])===1?'Suggested only: exact settled USD, Amex account, vendor and date within 3 days. Confirm before reconciling.':ids.length?'Ambiguous: review receipts manually.':''}};});
}
async function syncReceipts(at,env){
  const token=env.SOURCING_AIRTABLE_PAT||env.FINANCE_AIRTABLE_PAT||env.SALES_AIRTABLE_PAT;
  const source=airtable(token,'appyiRn4kLqU03S1i');
  const raw=await source.all('tbln41baCj2Mhkz3u');
  const eventRows=await source.all('tblSTCYw1HFA7H9xm');
  const events=new Map(eventRows.map(r=>[r.id,r.fields['Event ID']||r.id]));
  const current=uniqueIndex(await at.all(TABLES.receipts),'Purchase ID'),updates=[];
  for(const r of raw){const n=normalizeReceipt(r,events),old=current.get(n.fields['Purchase ID']);
    if(old?.fields['Receipt Source Fingerprint']===n.fingerprint)continue;
    if(old?.fields['Bank Transactions']?.length||old?.fields['Transactions (2)']?.length)delete n.fields['Settled USD'];
    updates.push({...n.fields,'Receipt Source Fingerprint':n.fingerprint,...(!old?{'Match Status':'Unmatched — source receipt'}:{})});
  }
  await at.upsert(TABLES.receipts,'Purchase ID',updates);
  const receipts=await at.all(TABLES.receipts),bank=await at.all(TABLES.bank),accounts=new Map((await at.all(TABLES.accounts)).map(r=>[r.id,r]));
  uniqueIndex(bank,'ID');
  const suggestions=receiptSuggestions(bank,receipts,accounts).map(r=>r.fields);
  const changed=changedRows(suggestions,uniqueIndex(bank,'ID'),'ID');await at.upsert(TABLES.bank,'ID',changed);
  const showRows=await source.all('tblJ9QtpEFi1efOgl');
  const showEntries=showRows.map(r=>normalizeCashShow(r,events)).filter(Boolean);
  const orders=uniqueIndex(await at.all(TABLES.orders),'Order Key');
  const showUpdates=changedRows(showEntries.map(n=>mergeOrder(orders.get(n.fields['Order Key']),n)),orders,'Order Key');
  await at.upsert(TABLES.orders,'Order Key',showUpdates);
  const fresh=uniqueIndex(await at.all(TABLES.orders),'Order Key'),lineIndex=uniqueIndex(await at.all(TABLES.lines),'Line Key');
  const showLines=showEntries.flatMap(n=>n.lines.map(l=>({...l,Order:[fresh.get(l['Order Key']).id]})));
  await at.upsert(TABLES.lines,'Line Key',changedRows(showLines,lineIndex,'Line Key'));
  return {read:raw.length+showRows.length,written:updates.length+showUpdates.length,receiptSuggestions:suggestions.filter(r=>r['Suggested Receipt Matches'].length).length,cashSales:showEntries.length};
}
export function mergeOrder(existing,normalized) {
  const fingerprint=hash(normalized.fields),old=existing?.fields||{};
  let report=normalized.report;
  if(old['Source Fingerprint']===fingerprint&&old['Report Status'])report=old['Report Status'];
  if(old['Report Status']==='Duplicate — excluded')report=old['Report Status'];
  // Changes to amounts/status return orders to review; manual notes and categorization aren't overwritten.
  return {...normalized.fields,'Source Fingerprint':fingerprint,'Report Status':report};
}
async function request(url,options={},label='Request') {
  for(let attempt=0;attempt<5;attempt++){
    let response;
    try { response=await fetch(url,{...options,signal:AbortSignal.timeout(45000)}); }
    catch { if(attempt===4)throw Error(`${label}: network failure`);await pause(1000*(attempt+1));continue; }
    if((response.status===429||response.status>=500)&&attempt<4){await pause(Math.min(30000,Number(response.headers.get('retry-after')||0)*1000||1000*2**attempt));continue;}
    if(!response.ok)throw Error(`${label}: HTTP ${response.status}`); // Never log response bodies, tokens or customer data.
    const data=await response.json();return {data,headers:response.headers};
  }
}
function airtable(token,base=BASE){
  const call=async(table,method='GET',body,params='')=>{await pause(230);return (await request(`https://api.airtable.com/v0/${base}/${table}${params}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})},`Airtable ${table}`)).data;};
  return {
    async all(table){let rows=[],offset;do{const d=await call(table,'GET',null,`?pageSize=100${offset?'&offset='+encodeURIComponent(offset):''}`);rows.push(...d.records);offset=d.offset;}while(offset);return rows;},
    async upsert(table,key,records){for(let i=0;i<records.length;i+=10)await call(table,'PATCH',{performUpsert:{fieldsToMergeOn:[key]},records:records.slice(i,i+10).map(fields=>({fields}))});},
    async create(table,fields){await call(table,'POST',{records:[{fields}]});}
  };
}
function uniqueIndex(rows,key){const m=new Map();for(const r of rows){const k=r.fields[key];if(!k)continue;if(m.has(k))throw Error(`Duplicate key in ${key}; stopped before writing`);m.set(k,r);}return m;}
export function changedRows(rows,index,key){return rows.filter(fields=>{const old=index.get(fields[key])?.fields;if(!old)return true;return Object.entries(fields).some(([k,v])=>JSON.stringify(old[k]??(Array.isArray(v)?[]:''))!==JSON.stringify(v??''));});}
export async function shopifyOrders(env,start){
  const host=env.SHOPIFY_STORE_DOMAIN;
  if(!host||!env.SHOPIFY_CLIENT_ID||!env.SHOPIFY_CLIENT_SECRET)throw Error('Missing Shopify credentials');
  if(!/^[a-z0-9-]+\.myshopify\.com$/i.test(host))throw Error('Invalid Shopify host');
  const {data:auth}=await request(`https://${host}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:env.SHOPIFY_CLIENT_ID,client_secret:env.SHOPIFY_CLIENT_SECRET})},'Shopify auth');
  if(!auth.access_token)throw Error('Shopify auth: missing access token');
  let readAllOrders=null;
  try{const {data}=await request(`https://${host}/admin/oauth/access_scopes.json`,{headers:{'X-Shopify-Access-Token':auth.access_token}},'Shopify access scopes');readAllOrders=Array.isArray(data.access_scopes)?data.access_scopes.some(s=>s.handle==='read_all_orders'):null;}catch{}
  let url=`https://${host}/admin/api/${env.SHOPIFY_API_VERSION||'2026-01'}/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(start)}`,all=[],pages=0;
  while(url){if(++pages>100)throw Error('Shopify page limit: incomplete import');const u=new URL(url);if(u.host!==host)throw Error('Unsafe Shopify pagination URL');const r=await request(url,{headers:{'X-Shopify-Access-Token':auth.access_token}},'Shopify orders');if(!Array.isArray(r.data.orders))throw Error('Shopify orders: unexpected response');all.push(...r.data.orders);url=r.headers.get('link')?.match(/<([^>]+)>; rel="next"/)?.[1]||null;await pause(550);}
  all.coverage={readAllOrders,oldestOrder:all.map(o=>businessDate(o.created_at)).filter(Boolean).sort()[0]||null};
  return all;
}
async function reverbOrders(env,shop,start){
  const token=env[`REVERB_${shop}_PERSONAL_TOKEN`];if(!token)throw Error(`Missing Reverb ${shop} token`);
  const all=[];for(let page=1;page<=100;page++){
    const url=new URL('https://api.reverb.com/api/my/orders/selling/all');url.search=new URLSearchParams({updated_start_date:start,per_page:'50',page:String(page)});
    const {data}=await request(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/hal+json','Accept-Version':'3.0'}},`Reverb ${shop}`);
    if(!Array.isArray(data.orders))throw Error(`Reverb ${shop}: unexpected response`);all.push(...data.orders);
    if(page>=Number(data.total_pages||Infinity)||data.orders.length<50)return all.filter(o=>businessDate(o.created_at)>=start.slice(0,10));
    await pause(550);
  }throw Error(`Reverb ${shop}: page limit reached`);
}
async function paypalActivity(env,start){
  if(!env.PAYPAL_CLIENT_ID||!env.PAYPAL_CLIENT_SECRET)throw Error('Missing PayPal credentials');
  const host='https://api-m.paypal.com';
  const {data:auth}=await request(host+'/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'},'PayPal auth');
  if(!auth.access_token)throw Error('PayPal auth: missing access token');
  const all=[],now=Date.now();let begin=Date.parse(start);
  while(begin<now){const end=Math.min(now,begin+30*86400000);
    for(let page=1;page<=100;page++){
      const u=new URL(host+'/v1/reporting/transactions');u.search=new URLSearchParams({start_date:new Date(begin).toISOString(),end_date:new Date(end).toISOString(),fields:'all',balance_affecting_records_only:'Y',page_size:'100',page:String(page)});
      const {data}=await request(u,{headers:{Authorization:`Bearer ${auth.access_token}`}},'PayPal transaction search');
      if(!Array.isArray(data.transaction_details))throw Error('PayPal: unexpected response');all.push(...data.transaction_details);
      if(page>=Number(data.total_pages||1))break;if(page===100)throw Error('PayPal page limit reached');await pause(300);
    }begin=end; // inclusive boundary records are deduplicated below
  }return all;
}
export async function gxeOrders(env,start){
  if(!env.GXE_API_TOKEN)throw Error('Missing GXE_API_TOKEN — copy existing GXE credential into this service');
  const all=[],seen=new Set();
  for(let page=1;page<=100;page++){
    const {data}=await request(`https://www.sweetwater.com/used/public-api/v1/orders?page=${page}&resultsPerPage=100`,{headers:{Authorization:`Bearer ${env.GXE_API_TOKEN}`,Accept:'application/json'}},'Gear Exchange orders');
    const rows=Array.isArray(data)?data:data.orders??data.data;
    if(!Array.isArray(rows))throw Error('Unverified GXE orders response');
    if(!rows.length)return all.filter(o=>businessDate(o.soldAt)>=start.slice(0,10));
    for(const r of rows){const id=String(r.orderId);if(seen.has(id))throw Error('Repeated GXE page; incomplete snapshot');seen.add(id);all.push(r);}
    await pause(550);
  }throw Error('GXE page limit reached');
}
let running=false;
export async function runFinanceSync(env=process.env){
  if(running)return {busy:true};running=true;
  console.log('FINANCE_STAGE','Starting finance access and duplicate-key checks');
  const token=env.FINANCE_AIRTABLE_PAT||env.SALES_AIRTABLE_PAT;
  const start=env.FINANCE_START_DATE||'2026-01-01T00:00:00-05:00';
  const report={sources:{},errors:[]};
  try{
    if(!token)throw Error('Missing finance Airtable token');
    if(!Number.isFinite(Date.parse(start)))throw Error('Invalid finance start date');
    const at=airtable(token);
    // Access and existing-key audit must pass before contacting sales providers or writing rows.
    const existing=uniqueIndex(await at.all(TABLES.orders),'Order Key');
    const lineIndex=uniqueIndex(await at.all(TABLES.lines),'Line Key');
    console.log('FINANCE_STAGE','Starting sourcing receipt and cash mirror');
    try{report.sources.Receipts=await syncReceipts(at,env);}catch(e){report.errors.push(`Receipts: ${e.message}`);}
    for(const source of ['Shopify','Reverb MAIN','Reverb WAREHOUSE','Gear Exchange']){
      try{
        console.log('FINANCE_STAGE',source,'reading provider');
        const raw=source==='Shopify'?await shopifyOrders(env,start):source==='Gear Exchange'?await gxeOrders(env,start):await reverbOrders(env,source.split(' ')[1],start);
        const entries=raw.map(o=>source==='Shopify'?normalizeShopify(o):source==='Gear Exchange'?normalizeGxe(o):normalizeReverb(o,source.split(' ')[1]));
        const batch=new Map();for(const n of entries){const key=n.fields['Order Key'];if(batch.has(key)&&hash(batch.get(key).fields)!==hash(n.fields))throw Error('Conflicting duplicate provider order');batch.set(key,n);}
        const orders=[...batch.values()].map(n=>mergeOrder(existing.get(n.fields['Order Key']),n));
        const changed=changedRows(orders,existing,'Order Key');
        await at.upsert(TABLES.orders,'Order Key',changed);
        const fresh=uniqueIndex(await at.all(TABLES.orders),'Order Key');
        const lines=[...batch.values()].flatMap(n=>n.lines.map(l=>({...l,Order:[fresh.get(l['Order Key']).id]})));
        const changedLines=changedRows(lines,lineIndex,'Line Key');await at.upsert(TABLES.lines,'Line Key',changedLines);
        report.sources[source]={read:raw.length,ordersWritten:changed.length,linesWritten:changedLines.length,...(raw.coverage?{coverage:raw.coverage}:{})};
        console.log('FINANCE_STAGE',source,JSON.stringify(report.sources[source]));
      }catch(e){report.errors.push(`${source}: ${e.message}`);}
    }
    try{
      console.log('FINANCE_STAGE','PayPal activity and payment grouping');
      const current=uniqueIndex(await at.all(TABLES.paypal),'Transaction Key');
      const raw=await paypalActivity(env,start),dedup=new Map();for(const r of raw){const f=normalizePayPal(r);dedup.set(f['Transaction Key'],f);}
      const changed=changedRows([...dedup.values()],current,'Transaction Key');await at.upsert(TABLES.paypal,'Transaction Key',changed);
      const grouped=await linkPayPalOrders(at);
      report.sources.PayPal={read:raw.length,unique:dedup.size,written:changed.length,...grouped,reporting:'Payment summaries — order review required'};
    }catch(e){report.errors.push(`PayPal: ${e.message}`);}
    await at.create(TABLES.log,{'Run ID':`FINANCE-${new Date().toISOString()}`,'Source':'Finance sync','Run Date':new Date().toISOString().slice(0,10),'Status':report.errors.length?'Needs attention':'Imported — review pending','Records Read':Object.values(report.sources).reduce((a,s)=>a+s.read,0),'Records Written':Object.values(report.sources).reduce((a,s)=>a+(s.ordersWritten||s.written||0),0),'Errors':JSON.stringify(report)});
  }catch(e){report.errors.push(e.message);}
  finally{running=false;}
  console.log('FINANCE_SYNC',JSON.stringify(report));return report;
}
export function startFinanceSync(env=process.env){
  if(env.FINANCE_SYNC_ENABLED!=='true')return;
  // One process/replica only. Source IDs plus Airtable upsert protect repeated runs.
  const timer=setTimeout(()=>runFinanceSync(env),10000);timer.unref();
  const interval=setInterval(()=>runFinanceSync(env),Math.max(3600000,Number(env.FINANCE_SYNC_INTERVAL_MS)||3600000));interval.unref();
}
