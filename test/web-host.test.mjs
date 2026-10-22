import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebHostStore} from '../src/web-host-store.mjs';
import {createWebHostServer,HOST_HEARTBEAT_TTL_MS} from '../src/web-host-server.mjs';
import {ExistingBridgeClient} from '../src/bridge-client.mjs';

const key='a'.repeat(64), url='https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', peer={tabId:77,url};
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'rwb-web-'));
  const store=new WebHostStore(join(dir,'test.sqlite'));
  const service=createWebHostServer({store,key,port:0});
  const address=await service.start();
  const origin='http://127.0.0.1:'+address.port;
  const bridge=new ExistingBridgeClient({origin:origin+'/bridge-'+key});
  async function request(path,data,authorized=true,additional={}) {
    const res=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',...(authorized?{authorization:'Bearer '+key}:{}),...additional},body:JSON.stringify(data)});
    return {status:res.status,headers:res.headers,body:await res.json()};
  }
  return {store,service,bridge,origin,request,async close(){await service.stop();store.close();rmSync(dir,{recursive:true,force:true});}};
}
function msg() {return {text:'[WeChat authorized text] hello',idempotencyKey:'weixin:'+randomUUID()};}
test('local broker accepts existing adapter bridge contract and only one browser owner',async()=>{
 const f=await fixture();
 try {
  const input=msg(),e=await f.bridge.enqueue(input);
  assert.equal((await f.bridge.getEvent(e.eventId)).status,'QUEUED');
  const prior=await f.bridge.enqueue(input);assert.equal(prior.eventId,e.eventId);
  assert.equal((await f.request('/extension/poll',peer)).status,409);
  assert.equal((await f.request('/extension/heartbeat',{...peer,ready:true})).status,200);
  assert.equal((await f.request('/extension/heartbeat',{tabId:78,url,ready:true})).status,409);
  const take=(await f.request('/extension/poll',peer)).body.event;assert.equal(take.id,e.eventId);assert.equal(take.text,input.text);
  assert.equal((await f.bridge.getEvent(e.eventId)).status,'DISPATCHED');
  assert.equal((await f.request('/extension/poll',peer)).body.event,null);
  assert.equal((await f.request('/extension/submitted',{...peer,id:e.eventId})).status,200);
  assert.equal((await f.bridge.getEvent(e.eventId)).status,'DISPATCHED');
  assert.equal(f.store.get(e.eventId).status,'BROWSER_SUBMITTED');
  assert.equal((await f.request('/extension/complete',{...peer,id:e.eventId,reply:'hi!'})).status,200);
  assert.deepEqual(await f.bridge.getEvent(e.eventId),{status:'SUCCEEDED',replyText:'hi!'});
  assert.equal((await f.request('/extension/complete',{...peer,id:e.eventId,reply:'duplicate'})).status,409);
 }finally{await f.close();}
});
test('unknown browser delivery is never automatically retried or followed by another job',async()=>{
 const f=await fixture();
 try{
  const e=await f.bridge.enqueue(msg()), second=await f.bridge.enqueue(msg());
  await f.request('/extension/heartbeat',{...peer,ready:true});
  assert.equal((await f.request('/extension/poll',peer)).body.event.id,e.eventId);
  await f.request('/extension/unknown',{...peer,id:e.eventId});
  assert.equal((await f.bridge.getEvent(e.eventId)).status,'TIMED_OUT_UNKNOWN');
  assert.equal((await f.request('/extension/poll',peer)).body.event,null);
  assert.equal((await f.bridge.getEvent(second.eventId)).status,'QUEUED');
 }finally{await f.close();}
});
test('an assigned job becomes unknown after database reopen',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rwb-reopen-')),db=join(dir,'test.sqlite');
 try{
  const store=new WebHostStore(db);const input=msg();const first=store.enqueue(input);store.claim();store.close();
  const recovered=new WebHostStore(db);
  assert.equal(recovered.get(first.id).status,'DELIVERY_UNKNOWN');
  assert.equal(recovered.claim(),null);
  assert.equal(recovered.enqueue(input).id,first.id);
  recovered.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('local key, origin, payload and browser heartbeat validation fail closed',async()=>{
 const f=await fixture();
 try{
  assert.equal((await f.request('/extension/heartbeat',{...peer,ready:true},false)).status,404);
  assert.equal((await f.request('/extension/heartbeat',{tabId:1,url:'https://example.com',ready:true})).status,409);
  assert.equal((await f.request('/extension/heartbeat',{tabId:1,url,ready:false})).status,409);
  const e=await f.bridge.enqueue(msg());
  assert.equal((await f.request('/extension/heartbeat',{...peer,ready:true})).status,200);
  assert.equal((await f.request('/extension/poll',{...peer,url:'https://chatgpt.com/c/other'})).status,409);
  assert.equal((await f.request('/extension/complete',{...peer,id:e.eventId,reply:'never submitted'})).status,409);
  const preflight=await fetch(f.origin+'/extension/poll',{method:'OPTIONS',headers:{Origin:'chrome-extension://'+'a'.repeat(32),'Access-Control-Request-Headers':'authorization,content-type'}});
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-origin'),'chrome-extension://'+'a'.repeat(32));
 }finally{await f.close();}
});

test('explicit stop revokes Host readiness but refuses to erase unresolved browser delivery',async()=>{
 const f=await fixture();
 try{
  await f.request('/extension/heartbeat',{...peer,ready:true});
  const ready=await (await fetch(f.origin+'/health')).json();
  assert.equal(ready.host,'HOST_READY');
  assert.equal((await f.request('/extension/disarm',peer)).status,200);
  const stopped=await (await fetch(f.origin+'/health')).json();
  assert.equal(stopped.host,'HOST_UNVERIFIED');
  const e=await f.bridge.enqueue(msg());
  await f.request('/extension/heartbeat',{...peer,ready:true});
  assert.equal((await f.request('/extension/poll',peer)).body.event.id,e.eventId);
  const rejected=await f.request('/extension/disarm',peer);
  assert.equal(rejected.status,409);
  assert.equal(rejected.body.error,'HOST_HAS_UNRESOLVED_EVENT');
  assert.equal((await f.bridge.getEvent(e.eventId)).status,'DISPATCHED');
 }finally{await f.close();}
});

test('30-second Edge alarm cadence remains HOST_READY while missed heartbeats expire safely',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rwb-lease-'));
 const store=new WebHostStore(join(dir,'test.sqlite'));
 let ms=0;
 const service=createWebHostServer({store,key,port:0,now:()=>ms});
 try{
  const address=await service.start(),origin='http://127.0.0.1:'+address.port;
  const heartbeat=()=>fetch(origin+'/extension/heartbeat',{method:'POST',
   headers:{authorization:'Bearer '+key,'content-type':'application/json'},
   body:JSON.stringify({...peer,ready:true})});
  const health=async()=> (await (await fetch(origin+'/health')).json()).host;
  assert.equal(HOST_HEARTBEAT_TTL_MS,75_000);
  assert.equal((await heartbeat()).status,200);
  ms=30_000;assert.equal(await health(),'HOST_READY');
  ms=61_000;assert.equal(await health(),'HOST_READY');
  ms=75_000;assert.equal(await health(),'HOST_UNVERIFIED');
  // A fresh exact owner heartbeat restores readiness; owner takeover stays protected.
  assert.equal((await heartbeat()).status,200);
  ms=105_000;assert.equal(await health(),'HOST_READY');
  ms=151_000;assert.equal(await health(),'HOST_UNVERIFIED');
 }finally{await service.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('authenticated owner proof is exact, read-only and does not expose IDs or URL',async()=>{
 const f=await fixture();
 const owner=async(tabId,location=url,authorized=true)=>{
  const response=await fetch(f.origin+'/extension/owner-status',{
   method:'GET',headers:{...(authorized?{authorization:'Bearer '+key}:{}),
    'x-bridge-tab-id':String(tabId),'x-bridge-url':location}});
  return {status:response.status,body:await response.json()};
 };
 try{
  let proof=await owner(peer.tabId);
  assert.equal(proof.status,200);assert.equal(proof.body.ownerMatches,false);
  assert.equal((await owner(peer.tabId,url,false)).status,404);
  await f.request('/extension/heartbeat',{...peer,ready:true});
  proof=await owner(peer.tabId);
  assert.equal(proof.body.ownerMatches,true);
  assert.equal(proof.body.pendingBrowserDelivery,false);
  assert.equal((await owner(999)).body.ownerMatches,false);
  assert.equal((await owner(peer.tabId,'https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).body.ownerMatches,false);
  assert.equal((await owner('INVALID')).status,409);
  const e=await f.bridge.enqueue(msg());
  assert.equal((await f.request('/extension/poll',peer)).body.event.id,e.eventId);
  proof=await owner(peer.tabId);
  assert.equal(proof.body.pendingBrowserDelivery,true);
  const serialized=JSON.stringify(proof);
  assert.equal(serialized.includes(url),false);
  assert.equal(serialized.includes('tabId'),false);
  assert.equal(serialized.includes(e.eventId),false);
 }finally{await f.close();}
});

test('a slow model reply remains collectible after heartbeat expiry without allowing tab takeover',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rwb-slow-host-'));
 const store=new WebHostStore(join(dir,'test.sqlite'));
 let ms=0;
 const service=createWebHostServer({store,key,port:0,now:()=>ms});
 try{
  const address=await service.start(),root='http://127.0.0.1:'+address.port;
  const api=async(path,data)=>{
   const response=await fetch(root+path,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(data)});
   return {status:response.status,body:await response.json()};
  };
  const bridge=new ExistingBridgeClient({origin:root+'/bridge-'+key});
  const e=await bridge.enqueue(msg());
  assert.equal((await api('/extension/heartbeat',{...peer,ready:true})).status,200);
  assert.equal((await api('/extension/poll',peer)).body.event.id,e.eventId);
  ms=HOST_HEARTBEAT_TTL_MS+5_000; // Heartbeat expired while the ChatGPT browser was generating.
  assert.equal((await (await fetch(root+'/health')).json()).host,'HOST_UNVERIFIED');
  assert.equal((await api('/extension/heartbeat',{tabId:999,url,ready:true})).status,409);
  assert.equal((await api('/extension/submitted',{...peer,id:e.eventId})).status,200);
  ms=180_000;
  assert.equal((await api('/extension/complete',{...peer,id:e.eventId,reply:'slow but complete'})).status,200);
  assert.equal((await bridge.getEvent(e.eventId)).replyText,'slow but complete');
  assert.equal((await api('/extension/heartbeat',{tabId:999,url,ready:true})).status,200);
 }finally{await service.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('always-on pinned ChatGPT tab policy is read only through authenticated local Host endpoint',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rwx-host-auto-'));
 const store=new WebHostStore(join(dir,'test.sqlite'));
 const urlPinned='https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 let enabled=false;
 const host=createWebHostServer({store,key,port:0,autoState:()=>({enabled,chatUrl:urlPinned})});
 try{
  const address=await host.start(),root='http://127.0.0.1:'+address.port;
  const call=async token=>{
    const response=await fetch(root+'/extension/auto-state',{
     method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+key}:{})},body:'{}'
    });
    return {status:response.status,body:await response.json()};
  };
  assert.equal((await call(false)).status,404);
  assert.deepEqual((await call(true)).body,{enabled:false,chatUrl:null});
  enabled=true;
  assert.deepEqual((await call(true)).body,{enabled:true,chatUrl:urlPinned});
 }finally{await host.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('durable task status allows exact pinned owner to reconcile a completed ACK without resending',async()=>{
 const f=await fixture();
 try{
  const e=await f.bridge.enqueue(msg());
  assert.equal((await f.request('/extension/task-status',{...peer,id:e.eventId})).status,409);
  await f.request('/extension/heartbeat',{...peer,ready:true});
  assert.equal((await f.request('/extension/task-status',{...peer,id:e.eventId})).body.status,'QUEUED');
  assert.equal((await f.request('/extension/task-status',{...peer,tabId:999,id:e.eventId})).status,409);
  await f.request('/extension/poll',peer);
  await f.request('/extension/submitted',{...peer,id:e.eventId});
  assert.equal((await f.request('/extension/task-status',{...peer,id:e.eventId})).body.status,'BROWSER_SUBMITTED');
  await f.request('/extension/complete',{...peer,id:e.eventId,reply:'finished once'});
  assert.equal((await f.request('/extension/task-status',{...peer,id:e.eventId})).body.status,'SUCCEEDED');
  assert.equal((await f.bridge.getEvent(e.eventId)).replyText,'finished once');
 }finally{await f.close();}
});
