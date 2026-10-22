import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync} from 'node:fs';
import {acquireWebSessionLock} from '../src/web-session-lock.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AdapterStore} from '../src/store.mjs';
import {AllowlistPolicy} from '../src/policy.mjs';
import {WeixinBridgeAdapter} from '../src/adapter.mjs';
import {START_PREFIX,START_APPROVAL,auditWebSessionStart,selectActivationBatch,
  archiveActivationBatch,assertPostFenceBatch} from '../src/web-session-policy.mjs';
import {guardedSessionTransport,assertSessionWebHealth,waitForWebHostRecovery} from '../scripts/web-weixin-session.mjs';
import {runBoundedSession} from '../scripts/weixin-session.mjs';

const accountId='bot-account';
const peer={userId:'verified-peer',chatId:'verified-peer'};
const marker=START_PREFIX+'F'.repeat(24);
const message=(id,text,extra={})=>({
 message_id:id,from_user_id:peer.userId,to_user_id:accountId,
 message_type:1,message_state:2,context_token:'private-'+id,
 item_list:[{type:1,text_item:{text}}],...extra
});
function fixture(){
 const store=new AdapterStore(join(mkdtempSync(join(tmpdir(),'rwx-web-session-')),'adapter.sqlite'));
 const bridge={
   enqueued:[],getCalls:0,async enqueue(request){
     this.enqueued.push(request);return {eventId:'web-'+this.enqueued.length};
   },
   async getEvent(){this.getCalls++;return {status:'SUCCEEDED',replyText:'warm reply'};}
 };
 const real={
   polls:[],commits:0,sends:[],async poll(){return this.polls.shift()||[];},
   async commitPoll(){this.commits++;},
   async sendText(m){this.sends.push(m);return {accepted:true};}
 };
 const adapter=new WeixinBridgeAdapter({
   accountId,policy:new AllowlistPolicy({accountId,allowedPeers:[peer]}),
   store,bridge,transport:real,encryptionKey:Buffer.alloc(32,7)
 });
 return {store,bridge,real,adapter};
}
test('activation marker must be fresh, exact, from bound peer and in an all-valid batch',()=>{
 assert.equal(START_APPROVAL,'START WEB WEIXIN 30 MIN');
 const batch=[message('old','older user message'),message('marker',marker)];
 assert.equal(selectActivationBatch(batch,{marker,accountId,peer}).found,true);
 assert.equal(selectActivationBatch([message('old','older user message')],{marker,accountId,peer}).found,false);
 assert.equal(selectActivationBatch([message('m',marker+' ')],{marker,accountId,peer}).found,false);
 assert.equal(selectActivationBatch([message('m',' '+marker)],{marker,accountId,peer}).found,false);
 assert.throws(()=>selectActivationBatch([...batch,message('m2',marker)],{marker,accountId,peer}),/MULTIPLE_START_MARKERS/);
 assert.throws(()=>selectActivationBatch([message('m',marker,{from_user_id:'stranger'})],{marker,accountId,peer}),/UNEXPECTED_ACTIVATION_SENDER/);
 assert.throws(()=>selectActivationBatch([message('m',marker,{context_token:''})],{marker,accountId,peer}),/CONTEXT_TOKEN_REQUIRED/);
 assert.equal(selectActivationBatch([message('m',marker,{item_list:[{type:2}]})],{marker,accountId,peer}).found,false);
 assert.throws(()=>selectActivationBatch([message('m',marker)],{marker:'wrong',accountId,peer}),/INVALID_WEB_SESSION_MARKER/);
});
test('old allowed DMs and marker are durably deferred, never sent to ChatGPT',async()=>{
 const f=fixture();
 const batch=[message('old1','old text'),message('old2','another old text'),message('marker',marker)];
 const plan=selectActivationBatch(batch,{marker,accountId,peer});
 const r=archiveActivationBatch({store:f.store,adapter:f.adapter,updates:plan.updates,marker,accountId,peer});
 assert.deepEqual(r,{deferredNew:3,existingSafe:0,total:3});
 assert.equal(f.store.list().length,3);
 assert.ok(f.store.list().every(x=>x.status==='DEFERRED_BACKLOG'));
 assert.equal(f.store.next('RECEIVED'),undefined);
 assert.equal(f.bridge.enqueued.length,0);
 assert.equal(f.real.sends.length,0);
 assert.equal(f.real.commits,0);
 assert.doesNotThrow(()=>auditWebSessionStart(f.store.list()));
 f.store.close();
});
test('activation safely archives an old image and older texts before the explicit start marker',()=>{
 const f=fixture();
 const img=message('image-old','discarded-placeholder',{context_token:undefined,
   item_list:[{type:2,image_item:{secret:'MEDIA_BYTES_MUST_NOT_PERSIST'}}]});
 const batch=[img,message('old-text-1','old text one'),message('old-text-2','old text two'),message('marker-1',marker)];
 const plan=selectActivationBatch(batch,{marker,accountId,peer});
 assert.equal(plan.found,true);
 assert.equal(plan.unsupported.length,1);
 const output=archiveActivationBatch({store:f.store,adapter:f.adapter,updates:plan.updates,marker,accountId,peer});
 assert.deepEqual(output,{deferredNew:3,existingSafe:0,total:4,unsupportedNew:1,unsupportedExisting:0});
 assert.equal(f.store.list().length,3);
 assert.ok(f.store.list().every(e=>e.status==='DEFERRED_BACKLOG'));
 assert.equal(f.store.next('RECEIVED'),undefined);
 assert.deepEqual(f.store.unsupportedInboundCounts(),[{kind:'NON_TEXT_ITEM',count:1}]);
 const held=f.store.db.prepare('SELECT * FROM adapter_unsupported_inbound').get();
 assert.equal(JSON.stringify(held).includes('MEDIA_BYTES_MUST_NOT_PERSIST'),false);
 assert.equal(f.real.commits,0);
 assert.equal(f.real.sends.length,0);
 assert.equal(f.bridge.enqueued.length,0);
 f.store.close();
});

test('activation without exact pure-text marker never archives or advances an image batch',()=>{
 const f=fixture();
 const img=message('img-only','none',{item_list:[{type:2}]});
 const falseMarker=message('mixed-marker','none',{item_list:[
   {type:1,text_item:{text:marker}},{type:2,image_item:{data:'not-a-start-marker'}}
 ]});
 const planned=selectActivationBatch([img,falseMarker],{marker,accountId,peer});
 assert.equal(planned.found,false);
 assert.throws(()=>archiveActivationBatch({store:f.store,adapter:f.adapter,
   updates:[img,falseMarker],marker,accountId,peer}),/WEB_SESSION_MARKER_NOT_IN_BATCH/);
 assert.equal(f.store.list().length,0);
 assert.deepEqual(f.store.unsupportedInboundCounts(),[]);
 assert.equal(f.real.commits,0);
 f.store.close();
});

test('activation archive rolls back unsupported and text together when a prior row conflicts',()=>{
 const f=fixture();
 const pending=f.adapter.ingestRaw(message('prior','pending reply')).event;
 const img=message('new-image','none',{item_list:[{type:2}]});
 assert.throws(()=>archiveActivationBatch({store:f.store,adapter:f.adapter,
   updates:[img,message('prior','pending reply'),message('marker-new',marker)],
   marker,accountId,peer}),/ARCHIVE_PREEXISTING_EVENT_NOT_TERMINAL/);
 assert.equal(f.store.get(pending.id).status,'RECEIVED');
 assert.deepEqual(f.store.unsupportedInboundCounts(),[]);
 assert.equal(f.store.list().length,1);
 assert.equal(f.real.commits,0);
 f.store.close();
});

test('activation rejects reuse of one message ID as both media and text atomically',()=>{
 const f=fixture();
 const img=message('same-id','none',{item_list:[{type:2}]});
 assert.throws(()=>archiveActivationBatch({store:f.store,adapter:f.adapter,
   updates:[img,message('same-id','must not disappear'),message('marker-2',marker)],
   marker,accountId,peer}),/INBOUND_TEXT_UNSUPPORTED_ID_CONFLICT/);
 assert.deepEqual(f.store.unsupportedInboundCounts(),[]);
 assert.equal(f.store.list().length,0);
 assert.equal(f.real.commits,0);
 f.store.close();
});

test('session does not commit a batch containing an unknown media type',async()=>{
 const f=fixture();
 const guard=guardedSessionTransport(f.real,accountId,peer,async()=>true,{store:f.store});
 f.real.polls.push([message('picture','none',{item_list:[{type:2}]}),
   message('unknown','none',{item_list:[{type:3}]}),message('text','normal text')]);
 await assert.rejects(()=>guard.poll(),/SESSION_ITEMS_UNCLASSIFIED/);
 assert.equal(f.real.commits,0);
 assert.deepEqual(f.store.unsupportedInboundCounts(),[]);
 assert.equal(f.store.list().length,0);
 f.store.close();
});

test('activation rejects unknown type or malformed text even with a good marker and image',()=>{
 const f=fixture();
 const img=message('img-ok','none',{item_list:[{type:2}]});
 for(const bad of [
   message('bad-numeric','none',{item_list:[{type:99999}]}),
   message('bad-target','hi',{to_user_id:'other'}),
   message('bad-text','hi',{context_token:''}),
   message('bad-id','none',{message_id:null,item_list:[{type:2}]}),
   message('bad-mixed','hi',{item_list:[{type:1,text_item:{text:'x'}},{type:'unknown'}]})
 ]){
   assert.throws(()=>archiveActivationBatch({store:f.store,adapter:f.adapter,
     updates:[img,bad,message('marker-ok',marker)],marker,accountId,peer}));
   assert.equal(f.real.commits,0);
   assert.deepEqual(f.store.unsupportedInboundCounts(),[]);
   assert.equal(f.store.list().length,0);
 }
 f.store.close();
});

test('activation archive is atomic and leaves cursor untouched on a conflicting prior message',()=>{
 const f=fixture();
 f.adapter.ingestRaw(message('old1','a stored incomplete message'));
 const prior=f.store.list()[0].id;
 assert.throws(()=>archiveActivationBatch({
   store:f.store,adapter:f.adapter,
   updates:[message('new1','new text'),message('old1','a stored incomplete message'),message('mark',marker)],
   marker,accountId,peer
 }),/ARCHIVE_PREEXISTING_EVENT_NOT_TERMINAL/);
 assert.equal(f.store.list().length,1);
 assert.equal(f.store.get(prior).status,'RECEIVED');
 assert.equal(f.real.commits,0);
 f.store.close();
});
test('activation batch with already completed previous DM archives only new records',()=>{
 const f=fixture();
 const old=f.adapter.ingestRaw(message('old1','completed text')).event;
 f.store.noteBridgeAttempt(old.id);
 f.store.bridgeQueued(old.id,'old-web');
 f.store.replyReady(old.id,'older reply');
 f.store.beginOutbound(old.id);
 f.store.outboundSucceeded(old.id);
 const result=archiveActivationBatch({store:f.store,adapter:f.adapter,
   updates:[message('old1','completed text'),message('old2','old but unread'),message('mark',marker)],
   marker,accountId,peer});
 assert.deepEqual(result,{deferredNew:2,existingSafe:1,total:3});
 assert.equal(f.store.get(old.id).status,'SUCCEEDED');
 assert.equal(f.store.list().filter(r=>r.status==='DEFERRED_BACKLOG').length,2);
 f.store.close();
});
test('repeated activation marker cannot be treated as a second start and no auto-send occurs',()=>{
 const f=fixture();
 const raw=[message('mark',marker)];
 archiveActivationBatch({store:f.store,adapter:f.adapter,updates:raw,marker,accountId,peer});
 assert.throws(()=>archiveActivationBatch({store:f.store,adapter:f.adapter,updates:raw,marker,accountId,peer}),/SESSION_MARKER_ALREADY_STORED/);
 assert.equal(f.real.sends.length,0);
 f.store.close();
});
test('post-fence rejects malformed or foreign batches before cursor acknowledgement',async()=>{
 const f=fixture();
 f.real.polls.push([message('x','new DM'),message('bad','bad',{context_token:''})]);
 const t=guardedSessionTransport(f.real,accountId,peer,async()=>true);
 await assert.rejects(()=>t.poll(),/CONTEXT_TOKEN_REQUIRED/);
 assert.equal(f.real.commits,0);
 assert.throws(()=>assertPostFenceBatch([message('x','new DM',{from_user_id:'stranger'})],accountId,peer),/UNEXPECTED_SESSION_SENDER/);
 f.store.close();
});
test('paired image is durably quarantined while two same-batch texts still get one reply each',async()=>{
 const f=fixture();
 const media=message('img-1','ignored',{item_list:[{type:2,image_item:{data:'SECRET_IMAGE_PAYLOAD'}}]});
 f.real.polls.push([media,message('t-1','first valid text'),message('t-2','second valid text')]);
 let quarantine;
 f.adapter.transport=guardedSessionTransport(f.real,accountId,peer,async()=>true,
   {store:f.store,onQuarantine:value=>{quarantine=value;}});
 let clock=0;
 const result=await runBoundedSession({
   adapter:f.adapter,store:f.store,clock:()=>clock,
   sleep:async(ms)=>{clock+=Math.max(1,ms);},
   durationMs:120,pollReserveMs:0,operationReserveMs:0,idleDelayMs:4
 });
 assert.deepEqual(quarantine,{count:1,newlyRecorded:1});
 assert.deepEqual(f.store.unsupportedInboundCounts(),[{kind:'NON_TEXT_ITEM',count:1}]);
 assert.equal(result.acceptedUnique,2);
 assert.equal(result.repliesSent,2);
 assert.equal(f.real.sends.length,2);
 assert.equal(f.bridge.enqueued.length,2);
 assert.match(f.bridge.enqueued[0].text,/first valid text$/);
 assert.match(f.bridge.enqueued[1].text,/second valid text$/);
 assert.ok(f.real.commits>=1);
 assert.equal(f.store.list().length,2);
 const saved=f.store.db.prepare('SELECT * FROM adapter_unsupported_inbound').get();
 assert.equal(saved.status,'QUARANTINED_NO_REPLY');
 assert.equal(JSON.stringify(saved).includes('SECRET_IMAGE_PAYLOAD'),false);
 assert.equal(JSON.stringify(saved).includes('private-img-1'),false);
 f.store.close();
});

test('unsupported replay is idempotent, never replies and never consumes message quota',async()=>{
 const f=fixture();
 const image=message('img-repeat','not-text',{item_list:[{type:2,image_item:{media_id:'opaque-image'}}]});
 const text=message('text-repeat','valid text');
 f.real.polls.push([image,text],[structuredClone(image),structuredClone(text)]);
 f.adapter.transport=guardedSessionTransport(f.real,accountId,peer,async()=>true,{store:f.store});
 let clock=0;
 const result=await runBoundedSession({
   adapter:f.adapter,store:f.store,clock:()=>clock,
   sleep:async(ms)=>{clock+=Math.max(1,ms);},
   durationMs:120,pollReserveMs:0,operationReserveMs:0,idleDelayMs:4
 });
 assert.equal(result.acceptedUnique,1);
 assert.equal(result.duplicateAccepted,1);
 assert.equal(result.repliesSent,1);
 assert.equal(f.bridge.enqueued.length,1);
 assert.equal(f.real.sends.length,1);
 assert.deepEqual(f.store.unsupportedInboundCounts(),[{kind:'NON_TEXT_ITEM',count:1}]);
 f.store.close();
});

test('quarantine survives a fresh database connection and a cursor replay remains idempotent',async()=>{
 const f=fixture();
 const media=message('persist-image','not-text',{item_list:[{type:2,image_item:{secret:'NEVER_PERSIST'}}]});
 f.real.polls.push([media]);
 const guarded=guardedSessionTransport(f.real,accountId,peer,async()=>true,{store:f.store});
 assert.deepEqual(await guarded.poll(),[]);
 assert.equal(f.real.commits,0); // ack intentionally withheld by this test
 const filename=f.store.filename;
 f.store.close();
 const reopened=new AdapterStore(filename);
 const replay={poll:async()=>[structuredClone(media)],commits:0,
   async commitPoll(){this.commits++;},async sendText(){throw Error('MEDIA_MUST_NEVER_SEND');}};
 const second=guardedSessionTransport(replay,accountId,peer,async()=>true,{store:reopened});
 assert.deepEqual(await second.poll(),[]);
 await second.commitPoll();
 assert.equal(replay.commits,1);
 assert.deepEqual(reopened.unsupportedInboundCounts(),[{kind:'NON_TEXT_ITEM',count:1}]);
 const saved=reopened.db.prepare('SELECT * FROM adapter_unsupported_inbound').get();
 assert.equal(JSON.stringify(saved).includes('NEVER_PERSIST'),false);
 assert.equal(reopened.list().length,0);
 reopened.close();
});

test('unsupported/mixed items require durable quarantine and malformed identity never advances cursor',async()=>{
 const f=fixture();
 const image=message('img','unused',{item_list:[{type:2}]});
 assert.throws(()=>assertPostFenceBatch([image],accountId,peer),/REQUIRE_QUARANTINE/);
 f.real.polls.push([image]);
 const noStore=guardedSessionTransport(f.real,accountId,peer,async()=>true);
 await assert.rejects(()=>noStore.poll(),/QUARANTINE_REQUIRED/);
 assert.equal(f.real.commits,0);
 const mixed=message('mixed','not-a-pure-text',{item_list:[
   {type:1,text_item:{text:'KEEP_ME_UNPROCESSED'}},{type:2,image_item:{data:'image'}}]});
 f.real.polls.push([mixed]);
 const guarded=guardedSessionTransport(f.real,accountId,peer,async()=>true,{store:f.store});
 assert.deepEqual(await guarded.poll(),[]);
 assert.deepEqual(f.store.unsupportedInboundCounts(),[{kind:'MIXED_ITEM_TYPES',count:1}]);
 assert.equal(f.store.list().length,0);
 f.real.polls.push([image,message('later','valid'),message('bad','broken',{item_list:[{type:2}],message_id:null})]);
 await assert.rejects(()=>guarded.poll(),/MESSAGE_ID_INVALID/);
 assert.equal(f.store.unsupportedInboundCounts()[0].count,1);
 assert.equal(f.real.commits,0);
 // A conflicting reuse of a recorded text ID cannot silently convert it into media.
 f.adapter.ingestRaw(message('same-id','saved plain text'));
 f.real.polls.push([message('same-id','media',{item_list:[{type:2}]})]);
 await assert.rejects(()=>guarded.poll(),/UNSUPPORTED_INBOUND_TEXT_ID_CONFLICT/);
 assert.equal(f.real.commits,0);
 f.store.close();
});

test('session Host health enforces arm and rejects unknown browser delivery',()=>{
 assert.equal(assertSessionWebHealth({ok:true,host:'HOST_READY',queue:{SUCCEEDED:1}}),true);
 assert.throws(()=>assertSessionWebHealth({ok:true,host:'HOST_UNVERIFIED',queue:{}}),/DISCONNECTED/);
 assert.throws(()=>assertSessionWebHealth({ok:true,host:'HOST_READY',queue:{DELIVERY_UNKNOWN:1}}),/UNKNOWN_BROWSER_DELIVERY/);
 assert.throws(()=>assertSessionWebHealth({ok:true,host:'HOST_READY',queue:{QUEUED:1}},{startup:true}),/UNRESOLVED/);
});
test('new ordinary DM after fence completes one automatic web reply and old DMs remain deferred',async()=>{
 const f=fixture();
 const fence=[message('old1','past message'),message('mark',marker)];
 archiveActivationBatch({store:f.store,adapter:f.adapter,updates:fence,marker,accountId,peer});
 await f.real.commitPoll();
 f.real.polls.push([message('new','hi baby')]);
 f.adapter.transport=guardedSessionTransport(f.real,accountId,peer,async()=>true);
 let clock=0;
 const result=await runBoundedSession({
   adapter:f.adapter,store:f.store,
   clock:()=>clock,sleep:async(ms)=>{clock+=Math.max(1,ms);},
   durationMs:60,maxAccepted:20,pollReserveMs:0,operationReserveMs:0,idleDelayMs:5
 });
 assert.equal(result.acceptedUnique,1);
 assert.equal(result.repliesSent,1);
 assert.equal(f.bridge.enqueued.length,1);
 assert.match(f.bridge.enqueued[0].text,/hi baby$/);
 assert.equal(f.real.sends.length,1);
 assert.equal(f.real.sends[0].text,'warm reply');
 assert.equal(f.store.list().filter(r=>r.status==='DEFERRED_BACKLOG').length,2);
 assert.equal(f.store.list().filter(r=>r.status==='SUCCEEDED').length,1);
 f.store.close();
});

test('session lock prevents concurrent runs and releases exactly once',()=>{
 const f=join(mkdtempSync(join(tmpdir(),'rwx-lock-')),'active.lock');
 const release=acquireWebSessionLock(f);
 assert.equal(existsSync(f),true);
 assert.throws(()=>acquireWebSessionLock(f),/WEB_SESSION_LOCK_EXISTS_MANUAL_REVIEW/);
 release();
 release();
 assert.equal(existsSync(f),false);
 const release2=acquireWebSessionLock(f);
 release2();
});
test('Web session refuses ambiguous or incomplete pre-existing adapter rows',()=>{
 assert.doesNotThrow(()=>auditWebSessionStart([{status:'SUCCEEDED'},{status:'DEFERRED_BACKLOG'},{status:'REVIEWED_NO_REPLAY'}]));
 for(const status of ['RECEIVED','BRIDGE_QUEUED','REPLY_READY','OUTBOUND_UNKNOWN','OUTBOUND_SENDING']){
   assert.throws(()=>auditWebSessionStart([{status:'SUCCEEDED'},{status}]),/PREEXISTING_EVENT_REQUIRES_REVIEW/);
 }
});

test('brief HOST_UNVERIFIED is held without Weixin polling and can recover',async()=>{
 let ms=0,calls=0,paused=0,restored=0;
 const sequence=['WEB_SESSION_HOST_DISCONNECTED','WEB_HOST_OFFLINE','READY'];
 const answer=await waitForWebHostRecovery({
  check:async()=>{const state=sequence[calls++];if(state!=='READY')throw Error(state);},
  clock:()=>ms,delay:async(n)=>{ms+=n;},graceMs:2500,retryMs:500,
  onPause:()=>paused++,onRestore:()=>restored++
 });
 assert.deepEqual(answer,{restored:true});
 assert.equal(ms,1000);
 assert.equal(calls,3);
 assert.equal(paused,1);
 assert.equal(restored,1);
});
test('Host gate fails closed on uncertain browser work, long disconnection and cancellation',async()=>{
 let ms=0,calls=0;
 await assert.rejects(()=>waitForWebHostRecovery({
  check:async()=>{calls++;throw Error('WEB_SESSION_UNKNOWN_BROWSER_DELIVERY');},
  clock:()=>ms,delay:async n=>{ms+=n;}
 }),/UNKNOWN_BROWSER_DELIVERY/);
 assert.equal(calls,1);
 await assert.rejects(()=>waitForWebHostRecovery({
  check:async()=>{throw Error('WEB_SESSION_HOST_DISCONNECTED');},
  clock:()=>ms,delay:async n=>{ms+=n;},
  graceMs:1200,retryMs:500
 }),/WEB_SESSION_HOST_GRACE_EXPIRED/);
 assert.equal(ms,1200);
 const c=new AbortController();
 let next=0;
 await assert.rejects(()=>waitForWebHostRecovery({
  check:async()=>{next++;throw Error('WEB_HOST_OFFLINE');},
  clock:()=>ms,delay:async n=>{ms+=n;c.abort();},signal:c.signal
 }),/WEB_SESSION_CANCELLED_DURING_HOST_WAIT/);
 assert.equal(next,1);
});
test('session survives heartbeat lapse after first reply and sends second different DM only once',async()=>{
 const f=fixture();
 f.real.polls.push([message('new1','first live text')],[message('new2','second live text')]);
 let clock=0,checks=0,pauses=0,resumes=0;
 const rawPoll=f.real.poll.bind(f.real);
 let pollCount=0,inPause=false;
 f.real.poll=async()=>{
  if(inPause)throw Error('POLL_DURING_HOST_DISCONNECT');
  pollCount++;
  return rawPoll();
 };
 const gate=()=>waitForWebHostRecovery({
  check:async()=>{
   checks++;
   if(checks===2||checks===3)throw Error('WEB_SESSION_HOST_DISCONNECTED');
  },
  clock:()=>clock,delay:async(ms)=>{clock+=ms;},
  graceMs:3000,retryMs:400,
  onPause:()=>{pauses++;inPause=true;},
  onRestore:()=>{resumes++;inPause=false;}
 });
 f.adapter.transport=guardedSessionTransport(f.real,accountId,peer,gate);
 const summary=await runBoundedSession({
  adapter:f.adapter,store:f.store,
  clock:()=>clock,sleep:async(ms)=>{clock+=Math.max(1,ms);},
  durationMs:20000,maxAccepted:20,pollReserveMs:0,operationReserveMs:0,idleDelayMs:50
 });
 assert.equal(summary.repliesSent,2);
 assert.equal(summary.acceptedUnique,2);
 assert.deepEqual(f.real.sends.map(m=>m.text),['warm reply','warm reply']);
 assert.equal(f.bridge.enqueued.length,2);
 assert.match(f.bridge.enqueued[0].text,/first live text$/);
 assert.match(f.bridge.enqueued[1].text,/second live text$/);
 assert.equal(pauses,1);
 assert.equal(resumes,1);
 assert.ok(pollCount>=2);
 f.store.close();
});

test('Host recovery gate stops before a new Weixin poll when the session deadline passed',async()=>{
 let clock=0,checks=0,polls=0;
 const transport={poll:async()=>{polls++;return [];},commitPoll:async()=>{}};
 const guarded=guardedSessionTransport(transport,accountId,peer,()=>
   waitForWebHostRecovery({
     check:async()=>{checks++;if(clock>=500)throw Error('WEB_SESSION_DEADLINE_DURING_HOST_WAIT');throw Error('WEB_SESSION_HOST_DISCONNECTED');},
     clock:()=>clock,
     delay:async(ms)=>{clock+=ms;},
     graceMs:3000,retryMs:250
   })
 );
 await assert.rejects(()=>guarded.poll(),/WEB_SESSION_DEADLINE_DURING_HOST_WAIT/);
 assert.equal(polls,0);
 assert.equal(checks,3);
});
