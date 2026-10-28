import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReporting,monthlyReporting,inventorySnapshot} from '../src/finance-reporting.js';
const row=fields=>({fields});
test('documented cash uses receipt schema and never substitutes estimated currency conversion',()=>{
 const receipts=[row({'Purchase ID':'USD','Purchase Date':'2026-10-24','Payment Account':'Cash USD','Settled USD':1400,'Expense Category':'Inventory Purchases'}),row({'Purchase ID':'JPY','Purchase Date':'2026-09-10','Payment Account':'Cash ¥','Original Amount':70000,'Estimated USD':450,Currency:'JPY','Expense Category':'Inventory'})];
 const rows=buildReporting([],[],[],receipts);assert.equal(rows.length,2);assert.equal(rows[0].Spending,1400);assert.equal(rows[1].Spending,0);assert.equal(rows[1]['Needs Review'],1);
});
test('credit-funded purchases and refunds count once; funding and repayments do not',()=>{
 const pp=[row({'Report Description':'BML Credit - Transfer from BML','Gross Amount':525,'Reference ID':'purchase'}),row({'Transaction ID':'purchase','Transaction Key':'purchase',Date:'2026-07-06',Currency:'USD','Report Match':'Matched — checked','Report Counterparty':'Reverb.com','Gross Amount':-525}),row({'Transaction ID':'refund','Transaction Key':'refund',Date:'2026-07-25',Currency:'USD','Report Match':'Matched — checked','Activity Class':'Purchase refund','Reference ID':'purchase','Gross Amount':525})];
 const ledger=buildReporting([],[],pp);assert.equal(ledger.length,2);assert.equal(ledger.reduce((s,f)=>s+f.Spending,0),0);
});
test('exclude marketplace mirror and unpaid orders; include clean paid order',()=>{
 const source={'Order Key':'SHOPIFY:1','Order Date':'2026-01-01','Items Subtotal':100,'Shipping Charged':10,'Tax Collected':7,Currency:'USD','Sales Channel':'Shopify',Status:'paid'};
 const rows=buildReporting([],[row(source),row({...source,'Order Key':'SHOPIFY:2','Report Status':'Duplicate — excluded'}),row({...source,'Order Key':'SHOPIFY:3',Status:'pending','Report Status':'Unpaid — excluded'})],[]);assert.equal(rows.reduce((s,f)=>s+f.Sales,0),110);
});
test('PayPal sales exclude tax and use refund dates',()=>{const rows=buildReporting([],[],[row({'Transaction Key':'p','Activity Class':'Invoice payment',Currency:'USD',Date:'2026-01-01','Report Match':'Matched','Gross Amount':107,'Report Tax':7}),row({'Transaction Key':'r','Activity Class':'Customer refund',Currency:'USD',Date:'2026-02-01','Report Match':'Matched','Gross Amount':-107,'Report Tax':-7})]);assert.deepEqual(rows.map(r=>r.Sales),[100,-100]);});
test('no historical inventory is invented; prior day snapshot supplies opening',()=>{const ledger=[{Month:'2026-02',Sales:100,Spending:20}];const [m]=monthlyReporting(ledger);assert.equal(m['Beginning Owned Inventory'],null);assert.equal(m['Ending Owned Inventory'],null);const [n]=monthlyReporting(ledger,[row({'Snapshot Date':'2026-01-31','Owned Inventory Cost':500}),row({'Snapshot Date':'2026-02-10','Owned Inventory Cost':400})]);assert.equal(n['Beginning Owned Inventory'],500);assert.equal(n['Ending Owned Inventory'],400);});
test('inventory distinguishes owned from consigned and preserves missing cost coverage',()=>{const s=inventorySnapshot([row({Owner:'FF','Qty On Hand':2,Cost:100,Price:300}),row({Owner:'Grace','Qty On Hand':1,Cost:900,Price:1200}),row({Owner:'FF','Qty On Hand':1,Price:200})],'2026-01-01');assert.equal(s['Owned Inventory Cost'],200);assert.equal(s['Units On Hand'],4);assert.equal(s['Missing Cost Units'],1);});


test('inventory drill-down preserves the observed item quantities, list prices and total',async()=>{const{decodeInventoryDetail}=await import('../src/finance-dashboard-api.js');const snapshot=inventorySnapshot([{id:'rec1',fields:{SKU:'A1',Name:'Unlisted guitar',Owner:'FF','Qty On Hand':2,Price:300}},{id:'rec2',fields:{SKU:'C1',Name:'Consigned guitar',Owner:'Grace','Qty On Hand':1,Price:1200}},{id:'rec3',fields:{SKU:'SOLD','Qty On Hand':0,Price:999}}],'2026-10-28');const items=decodeInventoryDetail(snapshot['Inventory Detail']);assert.equal(items.length,2);assert.equal(items.reduce((s,i)=>s+i.amount,0),snapshot['Inventory List Value']);assert.equal(items[0].quantity,2);assert.match(items[0].url,/rec1$/);assert.equal(decodeInventoryDetail(undefined),null);assert.equal(decodeInventoryDetail('deflate:invalid'),null);});
