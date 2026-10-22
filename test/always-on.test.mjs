import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AdapterStore} from '../src/store.mjs';
import {AllowlistPolicy} from '../src/policy.mjs';
import {WeixinBridgeAdapter} from '../src/adapter.mjs';
import {readAlwaysOn,writeAlwaysOn,assertAutoBinding,classifyRecovery,
 durableStartupBatch,validPinnedChatUrl,AUTO_VERSION} from '../src/always-on-policy.mjs';
import {controlMode} from '../scripts/always-on-control.mjs';
const chatUrl='https://chatgpt.com/g/g-p-6a9e46e6f7988191829ae0887ef75f9d-riven/c/6ad2235a-48cc-83eb-bbe3-60fdc12412ae';
const peer={userId:'one-user',chatId:'one-user'},accountId='bot';
const raw=(msg,text,extra={})=>({
 message_id:msg,from_user_id:peer.userId,to_user_id:accountId,message_type:1,message_state:2,
 context_token:'token-'+msg,item_list:[{type:1,text_item:{text}}],...extra
});
function fixture(){
 const path=join(mkdtempSync(join(tmpdir(),'rwx-always-')),'adapter.sqlite');
 const store=new AdapterStore(path);
 const adapter=new WeixinBridgeAdapter({
  accountId,policy:new AllowlistPolicy({accountId,allowedPeers:[peer]}),
  store,encryptionKey:Buffer.alloc(32,7),transport:{},bridge:{}
 });
 return {store,adapter};
}
test('pinned URL and durable owner authorization are exact and reversible',()=>{
 assert.equal(validPinnedChatUrl(chatUrl),true);
 for(const bad of ['https://example.com/c/6ad2235a-48cc-83eb-bbe3-60fdc12412ae',
  chatUrl+'#other',chatUrl+'?hello=true','http://chatgpt.com/c/6ad2235a-48cc-83eb-bbe3-60fdc12412ae']){
  assert.equal(validPinnedChatUrl(bad),false);
 }
 const dir=mkdtempSync(join(tmpdir(),'rwx-config-')),path=join(dir,'always-on.json');
 assert.equal(readAlwaysOn(path).enabled,false);
 const enabled=controlMode('enable',null,chatUrl);
 assert.equal(enabled.version,AUTO_VERSION);
 writeAlwaysOn(enabled,path);
 assert.equal(readAlwaysOn(path).chatUrl,chatUrl);
 assert.equal(readAlwaysOn(path).enabled,true);
 assert.equal(controlMode('pause',enabled).paused,true);
 assert.equal(controlMode('resume',controlMode('pause',enabled)).paused,false);
 assert.equal(controlMode('disable',enabled).enabled,false);
 assert.throws(()=>controlMode('enable',null,'https://another.example.com'),/PINNED_CHAT/);
 assert.deepEqual(assertAutoBinding({allowedPeer:peer,inboundEnabled:false,outboundEnabled:false},enabled),peer);
 assert.throws(()=>assertAutoBinding({allowedPeer:peer,inboundEnabled:true,outboundEnabled:false},enabled),/PERSISTENT_FLAGS/);
 assert.throws(()=>assertAutoBinding({allowedPeer:peer,inboundEnabled:false,outboundEnabled:false},controlMode('pause',enabled)),/NOT_ENABLED/);
});
test('startup backlog is atomically saved as deferred and never sent or bridged',()=>{
 const f=fixture(),batch=[raw('a','old DM'),raw('b','startup DM')];
 const result=durableStartupBatch({store:f.store,adapter:f.adapter,updates:batch,accountId,peer});
 assert.deepEqual(result,{newlyDeferred:2,alreadyStored:0,total:2});
 assert.deepEqual(f.store.list().map(x=>x.status),['DEFERRED_BACKLOG','DEFERRED_BACKLOG']);
 assert.equal(f.store.next('RECEIVED'),undefined);
 const duplicated=durableStartupBatch({store:f.store,adapter:f.adapter,updates:batch,accountId,peer});
 assert.deepEqual(duplicated,{newlyDeferred:0,alreadyStored:2,total:2});
 f.store.close();
});
test('always-on startup quarantines old image and preserves nearby texts without sending',()=>{
 const f=fixture();
 const image=raw('old-media','ignored',{context_token:undefined,
   item_list:[{type:2,image_item:{data:'UNSAVED_MEDIA_SECRET'}}]});
 const batch=[image,raw('old-1','old text 1'),raw('old-2','old text 2')];
 const result=durableStartupBatch({store:f.store,adapter:f.adapter,updates:batch,accountId,peer});
 assert.deepEqual(result,{newlyDeferred:2,alreadyStored:0,total:3,unsupportedNew:1,unsupportedExisting:0});
 assert.deepEqual(f.store.list().map(r=>r.status),['DEFERRED_BACKLOG','DEFERRED_BACKLOG']);
 assert.equal(f.store.next('RECEIVED'),undefined);
 assert.deepEqual(f.store.unsupportedInboundCounts(),[{kind:'NON_TEXT_ITEM',count:1}]);
 const media=f.store.db.prepare('SELECT * FROM adapter_unsupported_inbound').get();
 assert.equal(JSON.stringify(media).includes('UNSAVED_MEDIA_SECRET'),false);
 assert.equal(JSON.stringify(media).includes('token-'),false);
 const replay=durableStartupBatch({store:f.store,adapter:f.adapter,updates:batch,accountId,peer});
 assert.deepEqual(replay,{newlyDeferred:0,alreadyStored:2,total:3,unsupportedNew:0,unsupportedExisting:1});
 f.store.close();
});

test('always-on image isolation survives sqlite reopen without replaying or retaining payload',()=>{
 const f=fixture(),filename=f.store.filename;
 const image=raw('image-on-reboot','ignore',{item_list:[{type:2,image_item:{secret:'NO_PERSIST'}}]});
 durableStartupBatch({store:f.store,adapter:f.adapter,updates:[image],accountId,peer});
 f.store.close();
 const reopened=new AdapterStore(filename);
 const adapter=new WeixinBridgeAdapter({accountId,policy:new AllowlistPolicy({accountId,allowedPeers:[peer]}),
   store:reopened,encryptionKey:Buffer.alloc(32,7),transport:{},bridge:{}});
 const result=durableStartupBatch({store:reopened,adapter,updates:[image],accountId,peer});
 assert.deepEqual(result,{newlyDeferred:0,alreadyStored:0,total:1,unsupportedNew:0,unsupportedExisting:1});
 assert.deepEqual(reopened.unsupportedInboundCounts(),[{kind:'NON_TEXT_ITEM',count:1}]);
 assert.equal(JSON.stringify(reopened.db.prepare('SELECT * FROM adapter_unsupported_inbound').get()).includes('NO_PERSIST'),false);
 reopened.close();
});

test('always-on startup malformed member fails whole media+text batch without cursor effects',()=>{
 const f=fixture();
 const media=raw('media','none',{item_list:[{type:2}]});
 for(const bad of [
  raw('wrong-target','text',{to_user_id:'different-account'}),
  raw('missing-context','text',{context_token:''}),
  raw('missing-media-id','none',{message_id:null,item_list:[{type:2}]}),
  raw('unknown-item','none',{item_list:[{type:50000}]}),
  raw('stranger','text',{from_user_id:'another-peer'})
 ]){
   assert.throws(()=>durableStartupBatch({store:f.store,adapter:f.adapter,
     updates:[media,raw('valid','valid text'),bad],accountId,peer}));
   assert.equal(f.store.list().length,0);
   assert.deepEqual(f.store.unsupportedInboundCounts(),[]);
 }
 f.store.close();
});

test('always-on refuses unrecognized media types rather than silently skipping',()=>{
 const f=fixture();
 for(const type of [3,7,999]){
  assert.throws(()=>durableStartupBatch({
   store:f.store,adapter:f.adapter,accountId,peer,
   updates:[raw('good-image','none',{item_list:[{type:2}]}),
    raw('unknown-media','none',{item_list:[{type}]}),raw('next-text','important')]
  }),/ALWAYS_ON_BATCH_UNSAFE/);
  assert.equal(f.store.list().length,0);
  assert.deepEqual(f.store.unsupportedInboundCounts(),[]);
 }
 f.store.close();
});

test('always-on startup atomically refuses message-id conflict between old image and text',()=>{
 const f=fixture(),media=raw('shared','none',{item_list:[{type:2}]});
 for(const batch of [
  [media,raw('shared','valid text')],
  [raw('shared','valid text'),media]
 ]){
   assert.throws(()=>durableStartupBatch({store:f.store,adapter:f.adapter,updates:batch,accountId,peer}),
     /INBOUND_.*_ID_CONFLICT/);
   assert.equal(f.store.list().length,0);
   assert.deepEqual(f.store.unsupportedInboundCounts(),[]);
 }
 f.store.close();
});

test('malformed startup batch is rolled back without cursor success or partial archive',()=>{
 const f=fixture();
 assert.throws(()=>durableStartupBatch({
  store:f.store,adapter:f.adapter,
  updates:[raw('a','good'),raw('b','invalid',{context_token:''})],
  accountId,peer
 }),/ALWAYS_ON_BATCH_UNSAFE/);
 assert.equal(f.store.list().length,0);
 f.store.close();
});
test('no restart/replay of uncertain outbound, unknown bridge submit, or incomplete origin',()=>{
 const safe=[
  {status:'DEFERRED_BACKLOG'},
  {status:'SUCCEEDED'},
  {status:'REVIEWED_NO_REPLAY'},
  {status:'REPLY_READY',bridge_submit_attempts:1,bridge_event_id:'web1'},
  {status:'BRIDGE_QUEUED',bridge_submit_attempts:1,bridge_event_id:'web2'},
  {status:'RECEIVED',bridge_submit_attempts:0}
 ];
 assert.equal(classifyRecovery(safe).active,3);
 for(const unsafe of [
  {status:'OUTBOUND_UNKNOWN'},
  {status:'OUTBOUND_SENDING'},
  {status:'RECEIVED',bridge_submit_attempts:1},
  {status:'BRIDGE_QUEUED',bridge_submit_attempts:0},
  {status:'REPLY_READY',bridge_submit_attempts:1,bridge_event_id:null}
 ])assert.throws(()=>classifyRecovery([...safe,unsafe]),/REQUIRES_REVIEW|UNKNOWN/);
});
