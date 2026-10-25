import { timingSafeEqual, createHash } from 'node:crypto';

export const TARGETS = {
  inventory: {base:'app2DxCRaxnHQL3zR',table:'tbljh3I54QsvFDoZe',field:'fldMdK1LrNCXn2VmB',token:'INVENTORY_AIRTABLE_PAT',search:['SKU','Name','Serial Number'],label:'Inventory photos'},
  finance: {base:'app7b0v3wEXudVmkD',table:'tblblwbHmUit1mg3Z',field:'fldHXeyhq6RQTuwAH',token:'FINANCE_AIRTABLE_PAT',search:['Purchase ID','Vendor','Notes'],label:'Accounting receipts & photos'},
  sourcing: {base:'appyiRn4kLqU03S1i',table:'tblgOTbH4zMXk50Qz',field:'fldn2qvZHSdD0Shnh',token:'FINANCE_AIRTABLE_PAT',search:['SKU','Item','Serial Number'],label:'Sourcing item photos'},
  receipts: {base:'appyiRn4kLqU03S1i',table:'tbln41baCj2Mhkz3u',field:'fldUbNHHF7dBh4IBX',token:'FINANCE_AIRTABLE_PAT',search:['Purchase ID','Transaction','Vendor / Payee'],label:'Sourcing receipts'}
};
const MAX=5_000_000, MAX_BODY=7_000_000;
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src blob:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"};
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{...headers,'Content-Type':'application/json'}});
const safe=(a,b)=>{let x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
const quote=s=>s.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
export function detect(b){if(b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';if(b.subarray(0,6).toString().match(/^GIF8[79]a$/))return 'image/gif';if(b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP')return 'image/webp';if(b.subarray(0,5).toString()==='%PDF-')return 'application/pdf';return null;}
export async function boundedBody(req){const reader=req.body?.getReader();let parts=[],n=0;if(!reader)throw Object.assign(new Error('File required'),{status:400});try{while(true){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>MAX_BODY){await reader.cancel();throw Object.assign(new Error('Request too large'),{status:413});}parts.push(Buffer.from(value));}}finally{reader.releaseLock();}return Buffer.concat(parts);}
export function createApp(env, upstream=fetch){
 const locks=new Map(),rates=new Map();
 async function airtable(t,path='',options={}){const token=env[t.token];if(!token)throw Object.assign(new Error('Airtable credential not configured'),{status:503});const r=await upstream('https://api.airtable.com/v0/'+t.base+'/'+t.table+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:AbortSignal.timeout(25000)});if(!r.ok)throw Object.assign(new Error('Airtable returned '+r.status),{status:r.status===429?429:502});return r.json();}
 async function locked(key,fn){let previous=locks.get(key)||Promise.resolve();let release;const next=new Promise(r=>release=r);locks.set(key,next);await previous;try{return await fn();}finally{release();if(locks.get(key)===next)locks.delete(key);}}
 return async function handler(req){try{
  const url=new URL(req.url);
  if(req.method==='GET'&&url.pathname==='/health')return json({ok:true,configured:!!(env.UPLOADER_KEY&&env.FINANCE_AIRTABLE_PAT&&env.INVENTORY_AIRTABLE_PAT)});
  if(req.method==='GET'&&url.pathname==='/')return new Response(PAGE,{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
  if(!env.UPLOADER_KEY||env.UPLOADER_KEY.length<24)return json({error:'Uploader access key is not configured'},503);
  if(!safe(req.headers.get('Authorization')||'','Bearer '+env.UPLOADER_KEY))return json({error:'Access key required'},401);
  const origin=req.headers.get('origin');if(origin&&origin!==url.origin)return json({error:'Cross-origin requests are not allowed'},403);
  const ip=req.headers.get('x-real-ip')||req.headers.get('x-forwarded-for')?.split(',')[0]||'authenticated';const now=Date.now();for(const [k,v]of rates)if(now-v.start>60000)rates.delete(k);let bucket=rates.get(ip)||{start:now,n:0};rates.set(ip,bucket);if(++bucket.n>60)return json({error:'Please wait a minute'},429);
  if(req.method==='GET'&&url.pathname==='/api/targets')return json(Object.entries(TARGETS).map(([id,t])=>({id,label:t.label})));
  const target=url.searchParams.get('target'),t=Object.hasOwn(TARGETS,target)?TARGETS[target]:null;if(!t)return json({error:'Choose a valid destination'},400);
  if(req.method==='GET'&&url.pathname==='/api/search'){
   const q=(url.searchParams.get('q')||'').trim();if(q.length<2||q.length>100)return json({error:'Enter 2–100 characters'},400);
   const params=new URLSearchParams({maxRecords:'20',returnFieldsByFieldId:'false',filterByFormula:'OR('+t.search.map(f=>"FIND(LOWER('"+quote(q)+"'),LOWER({"+f+"}&''))").join(',')+')'});for(const f of t.search)params.append('fields[]',f);
   const data=await airtable(t,'?'+params);return json(data.records.map(r=>({id:r.id,title:t.search.map(f=>r.fields[f]).filter(Boolean).join(' · ').slice(0,350)})));
  }
  if(req.method==='POST'&&url.pathname==='/api/upload'){
   const record=url.searchParams.get('record');if(!/^rec[A-Za-z0-9]{14}$/.test(record||''))return json({error:'Invalid record'},400);
   if(!(req.headers.get('content-type')||'').startsWith('multipart/form-data;'))return json({error:'Multipart file upload required'},400);
   if(Number(req.headers.get('content-length'))>MAX_BODY)return json({error:'Request too large'},413);
   const body=await boundedBody(req);const form=await new Response(body,{headers:{'Content-Type':req.headers.get('content-type')}}).formData();const files=form.getAll('file');if(files.length!==1||typeof files[0]==='string')return json({error:'Send exactly one file per request'},400);
   const file=files[0];if(!file.size||file.size>MAX)return json({error:'Each file must be between 1 byte and 5 MB'},413);
   const bytes=Buffer.from(await file.arrayBuffer()),contentType=detect(bytes);if(!contentType)return json({error:'Use JPEG, PNG, GIF, WebP, or PDF. Convert HEIC photos before uploading.'},415);
   const hash=createHash('sha256').update(bytes).digest('hex').slice(0,24);const cleaned=file.name.replace(/[^a-zA-Z0-9_. -]/g,'_').slice(-110)||'attachment';const ext={ 'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp','application/pdf':'pdf'}[contentType];const filename=cleaned.replace(/\.[^.]*$/,'')+'--'+hash+'.'+ext;
   return await locked(t.base+record+t.field,async()=>{
    const current=await airtable(t,'/'+record+'?returnFieldsByFieldId=true');const old=current.fields[t.field]||[];
    if(old.some(a=>a.filename?.includes('--'+hash+'.')))return json({ok:true,status:'already_attached',record,filename});
    let r;try{r=await upstream('https://content.airtable.com/v0/'+t.base+'/'+record+'/'+t.field+'/uploadAttachment',{method:'POST',headers:{Authorization:'Bearer '+env[t.token],'Content-Type':'application/json'},body:JSON.stringify({contentType,filename,file:bytes.toString('base64')}),signal:AbortSignal.timeout(45000)});}catch{return json({error:'Upload response was interrupted. Check the record before retrying; the upload may have succeeded.',record,filename},502);}
    if(!r.ok)return json({error:'Airtable upload returned '+r.status+'. Check the record before retrying.',record,filename},r.status===429?429:502);
    const verify=await airtable(t,'/'+record+'?returnFieldsByFieldId=true');const attached=verify.fields[t.field]||[];const saved=attached.find(a=>a.filename===filename&&a.size===file.size);
    if(!saved||old.some(a=>!attached.some(b=>b.id===a.id)))return json({error:'Upload could not be fully verified. Check the record before retrying.',record,filename},502);
    return json({ok:true,status:'attached',record,filename,attachmentId:saved.id,size:saved.size});
   });
  }
  return json({error:'Not found'},404);
 }catch(e){return json({error:e.status?e.message:'Request failed. Check the record before retrying an upload.'},e.status||502);}};
}
const PAGE=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FF Gear · Attachments</title><style>body{font:16px system-ui;background:#f4f3ef;color:#172923;margin:0}main{max-width:680px;margin:5vh auto;padding:28px}h1{font-size:32px}label{display:block;margin:22px 0 8px;font-weight:600}input,select,button{box-sizing:border-box;font:inherit;border:1px solid #bcc6bd;border-radius:8px;padding:12px;width:100%;background:white}button{background:#164c3b;color:white;cursor:pointer;margin-top:12px}button:disabled{opacity:.5;cursor:wait}small{color:#58635d}#results button{background:white;color:#172923;text-align:left}#results button[aria-pressed=true]{border:3px solid #164c3b}#status{white-space:pre-wrap;padding:16px 0}section{padding:24px;background:white;border-radius:16px}footer{font-size:13px;margin:18px 0} .row{display:flex;gap:10px}.row input{flex:1}.row button{width:auto;margin:0}</style><main><small>A FLASH FLOOD OF GEAR</small><h1>Photos & receipts</h1><section><label for="key">Uploader access key</label><input id="key" type="password" autocomplete="off" placeholder="Your private uploader key"><small>The key stays in this tab and clears when you close it.</small><label for="target">Attach to</label><select id="target"><option value="inventory">Inventory photos</option><option value="finance">Accounting receipts & photos</option><option value="sourcing">Sourcing item photos</option><option value="receipts">Sourcing receipts</option></select><label for="q">Find the item or purchase</label><div class="row"><input id="q" placeholder="SKU, serial, item, vendor, or purchase ID"><button id="search">Search</button></div><div id="results"></div><p id="chosen">Select a record above before uploading.</p><label for="files">Choose photos or receipts</label><input id="files" type="file" multiple accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"><small>Up to 20 files per batch, 5 MB each. Original files are sent directly to Airtable.</small><button id="upload" disabled>Attach files</button><div id="status" role="status" aria-live="polite"></div></section><footer>Existing attachments stay in place. Identical uploads made through this uploader are skipped. No files are stored on this server.</footer></main><script>
const $=id=>document.getElementById(id);let selected=null,busy=false;
async function api(path,options={}){const response=await fetch(path,{...options,headers:{Authorization:'Bearer '+$('key').value,...options.headers}});const data=await response.json();if(!response.ok)throw Error(data.error||'Request failed');return data;}
function clear(){selected=null;$('results').replaceChildren();$('chosen').textContent='Select a record above before uploading.';$('upload').disabled=true;}
$('target').onchange=clear;$('q').oninput=clear;
$('search').onclick=async()=>{if(busy)return;clear();$('status').textContent='Searching…';try{const rows=await api('/api/search?'+new URLSearchParams({target:$('target').value,q:$('q').value}));$('status').textContent=rows.length?'':'No matching records.';for(const row of rows){const b=document.createElement('button');b.textContent=row.title||row.id;b.setAttribute('aria-pressed','false');b.onclick=()=>{selected={id:row.id,target:$('target').value};for(const c of $('results').children)c.setAttribute('aria-pressed','false');b.setAttribute('aria-pressed','true');$('chosen').textContent='Attach to: '+row.title;$('upload').disabled=false;};$('results').append(b);}}catch(e){$('status').textContent=e.message;}};
$('upload').onclick=async()=>{if(busy||!selected)return;const files=[...$('files').files];if(!files.length||files.length>20){$('status').textContent='Choose between 1 and 20 files.';return;}if(files.some(f=>f.size>5000000)){ $('status').textContent='A file exceeds 5 MB. Resize it or use a smaller copy.';return;}const dest={...selected};busy=true;for(const id of ['upload','search','target','q','files','key'])$(id).disabled=true;$('results').inert=true;$('status').textContent='';try{for(const file of files){const form=new FormData();form.append('file',file);const data=await api('/api/upload?'+new URLSearchParams({target:dest.target,record:dest.id}),{method:'POST',body:form});$('status').textContent+=file.name+': '+(data.status==='attached'?'attached and verified':'already attached — skipped')+'\\n';}$('files').value='';}catch(e){$('status').textContent+='Stopped: '+e.message;}finally{busy=false;for(const id of ['upload','search','target','q','files','key'])$(id).disabled=false;$('results').inert=false;}};
</script></html>`;
if(typeof Bun!=='undefined'&&import.meta.main){
 const app=createApp(Bun.env);Bun.serve({port:Number(Bun.env.PORT||8080),maxRequestBodySize:MAX_BODY,fetch:app});
 console.log('Attachment uploader listening; file bytes and credentials are never logged.');
 if(Bun.env.UPLOADER_KEY){
  for(const [target,q]of [['inventory','A10252601'],['finance','Swedish Vintage'],['sourcing','A10252601'],['receipts','TAMPA-20261024']]){
   const r=await app(new Request('http://localhost/api/search?'+new URLSearchParams({target,q}),{headers:{Authorization:'Bearer '+Bun.env.UPLOADER_KEY}}));
   const detail=await r.json();console.log('Read-only credential preflight: '+target+' HTTP '+r.status+(r.ok?'':' '+detail.error));
  }
 }
}
