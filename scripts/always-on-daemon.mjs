import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {ProtectedAuthStore} from '../src/auth-store.mjs';
import {AdapterStore} from '../src/store.mjs';
import {AllowlistPolicy} from '../src/policy.mjs';
import {RealWeixinTransport} from '../src/transports/real-weixin.mjs';
import {ExistingBridgeClient} from '../src/bridge-client.mjs';
import {WeixinBridgeAdapter} from '../src/adapter.mjs';
import {loadEncryptionKey} from '../src/secrets.mjs';
import {runBoundedSession,enforceBridgeLimit} from './weixin-session.mjs';
import {readAlwaysOn,assertAutoBinding,classifyRecovery,durableStartupBatch} from '../src/always-on-policy.mjs';
import {guardedSessionTransport,waitForWebHostRecovery} from './web-weixin-session.mjs';
import {acquireWebSessionLock} from '../src/web-session-lock.mjs';
import {ProgressStore} from '../src/progress-store.mjs';
import {NativeTypingIndicator} from '../src/native-typing.mjs';

const REST_MS=2500,HOST='http://127.0.0.1:8799/health',BRIDGE_TIMEOUT_MS=8000;
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
const safe=e=>/^[A-Z0-9_:-]{1,130}$/.test(e?.message||'')?e.message:'ALWAYS_ON_ERROR';
function enabled(){
 const c=readAlwaysOn();
 if(c.enabled!==true||c.paused!==false)throw Error('ALWAYS_ON_PAUSED');
 const b=JSON.parse(readFileSync(resolve('data/weixin-runtime.json'),'utf8'));
 return assertAutoBinding(b,c);
}
async function hostReady(){
 let res;
 try{res=await fetch(HOST,{signal:AbortSignal.timeout(4000)});}
 catch{throw Error('WEB_HOST_OFFLINE');}
 if(!res.ok)throw Error('WEB_HOST_UNAVAILABLE');
 const h=await res.json();
 // An in-flight submitted browser turn is expected during long work.
 // Unknown delivery is not: that still blocks all new work.
 if(h?.ok!==true||h.host!=='HOST_READY')throw Error('WEB_SESSION_HOST_DISCONNECTED');
 if((h.queue?.DELIVERY_UNKNOWN||0)>0)throw Error('WEB_SESSION_UNKNOWN_BROWSER_DELIVERY');
 return true;
}
function noUnknownHost(h){
 if((h.queue?.DELIVERY_UNKNOWN||0)>0 ||(h.queue?.ASSIGNED_UNKNOWN||0)>0 ||
    (h.queue?.BROWSER_SUBMITTED||0)>0 ||(h.queue?.QUEUED||0)>0)
  throw Error('ALWAYS_ON_WEB_HOST_UNRESOLVED_REQUIRES_REVIEW');
 return true;
}
async function initialFence({store,adapter,transport,accountId,peer}){
 // After boot, old DMs are never silently turned into delayed ChatGPT prompts.
 // Poll once (35 s maximum) and commit only after every paired DM was stored.
 const batch=await transport.poll();
 if(batch.length>0&&!transport.pendingCursor)throw Error('ALWAYS_ON_FENCE_NO_CURSOR');
 const summary=durableStartupBatch({store,adapter,updates:batch,accountId,peer});
 enabled();
 await transport.commitPoll();
 process.stdout.write('ALWAYS_ON_STARTUP_FENCE deferred='+summary.newlyDeferred+
   ' already='+summary.alreadyStored+
   ' unsupported_held='+(summary.unsupportedNew||0)+
   ' unsupported_replayed='+(summary.unsupportedExisting||0)+'\n');
}
async function sessionLoop({store,adapter,raw,peer,accountId,progress,key}){
 let cycle=0;
 while(true){
  enabled();
  classifyRecovery(store.list());
  await waitForWebHostRecovery({check:async()=>{enabled();await hostReady();},
    graceMs:60_000,retryMs:1000,onPause:()=>process.stdout.write('ALWAYS_ON_WAIT_HOST\n')});
  const guarded=guardedSessionTransport(raw,accountId,peer,()=>
    waitForWebHostRecovery({check:async()=>{enabled();await hostReady();},
      graceMs:60_000,retryMs:500}),
    {store,onQuarantine:({count,newlyRecorded})=>
      process.stdout.write('ALWAYS_ON_UNSUPPORTED_QUARANTINED count='+count+
        ' new='+newlyRecorded+' no_reply=TRUE\n')});
  adapter.transport={
    poll:async()=>{const batch=await guarded.poll();enabled();return batch;},
    commitPoll:async()=>{enabled();return guarded.commitPoll();},
    sendText:(...args)=>guarded.sendText(...args)
  };
  const typing=new NativeTypingIndicator({store,transport:raw,key,allowed:async()=>{enabled();}});
  let result;
  try{
   result=await runBoundedSession({adapter,store,
    durationMs:60*60_000,maxAccepted:100,idleDelayMs:300,
    bridgePendingLimitMs:2*60*60_000,
    onPending:async({event,elapsedMs})=>{
      await typing.pulse(event);
      await progress.notify({event,elapsedMs,transport:raw,key,allowed:async()=>{enabled();}});
    },
    beforeSend:async()=>{enabled();await typing.stop();enabled();},
    beforeEnqueue:async()=>{enabled();},
    onProgress:({kind,count})=>process.stdout.write('ALWAYS_ON_'+kind+' '+count+'\n')
   });
  }finally{await typing.stop();}
  cycle++;
  process.stdout.write('ALWAYS_ON_CYCLE '+cycle+' reason='+result.reason+' accepted='+result.acceptedUnique+' replied='+result.repliesSent+'\n');
  if(!['DEADLINE','MESSAGE_LIMIT_DRAINED'].includes(result.reason))
   throw Error('ALWAYS_ON_CYCLE_REQUIRES_REVIEW');
 }
}
export async function runAlwaysOn(){
 let store=null,secret=null,release=null;
 try{
  release=acquireWebSessionLock();
  store=new AdapterStore(resolve('data/adapter.sqlite'));
  let initialFenceDone=false,reported='';
  while(true){
   try{
    const peer=enabled();
    const state=classifyRecovery(store.list());
    // A BRIDGE_QUEUED/REPLY_READY event can safely resume without re-enqueueing.
    // An uncertain send or uncertain enqueue is rejected by classifyRecovery.
    let health;
    try{const result=await fetch(HOST,{signal:AbortSignal.timeout(4000)});health=await result.json();}
    catch{throw Error('WEB_HOST_OFFLINE');}
    noUnknownHost(health);
    await hostReady();
    const authStore=new ProtectedAuthStore();
    const auth=await authStore.load();
    secret=loadEncryptionKey();
    const raw=new RealWeixinTransport({authStore,allowedPeer:peer,inboundEnabled:true,outboundEnabled:true});
    const bridge=enforceBridgeLimit(new ExistingBridgeClient({
      origin:process.env.CHATGPT_BRIDGE_ORIGIN,
      fetchImpl:(url,options={})=>fetch(url,{...options,signal:AbortSignal.timeout(BRIDGE_TIMEOUT_MS)})
    }));
    const progress=new ProgressStore(store);
    const adapter=new WeixinBridgeAdapter({accountId:auth.accountId,
      policy:new AllowlistPolicy({accountId:auth.accountId,allowedPeers:[peer]}),
      store,bridge,transport:raw,encryptionKey:secret});
    if(!initialFenceDone){
      if(!state.hasPending)await initialFence({store,adapter,transport:raw,accountId:auth.accountId,peer});
      initialFenceDone=true;
    }
    process.stdout.write('ALWAYS_ON_ACTIVE paired_dm_only=TRUE\n');
    await sessionLoop({store,adapter,raw,peer,accountId:auth.accountId,progress,key:secret});
   }catch(error){
    const code=safe(error);
    if(code!==reported){process.stdout.write('ALWAYS_ON_WAIT '+code+'\n');reported=code;}
    if(['ALWAYS_ON_AMBIGUOUS_OUTBOUND_REQUIRES_REVIEW','ALWAYS_ON_BRIDGE_ATTEMPT_UNKNOWN',
     'ALWAYS_ON_BRIDGE_ORIGIN_UNKNOWN','ALWAYS_ON_REPLY_ORIGIN_UNKNOWN',
     'ALWAYS_ON_PREEXISTING_PENDING_REQUIRES_REVIEW','ALWAYS_ON_WEB_HOST_UNRESOLVED_REQUIRES_REVIEW',
     'BRIDGE_TERMINAL_TIMED_OUT_UNKNOWN','SESSION_AMBIGUOUS_OUTBOUND_REQUIRES_REVIEW',
     'ALWAYS_ON_BATCH_PREEXISTING_PENDING'].includes(code)){
      // No retrying or silently acknowledging any ambiguous browser or Weixin send.
      initialFenceDone=true;
    }
    await sleep(REST_MS);
   }finally{secret?.fill(0);secret=null;}
  }
 }finally{store?.close();secret?.fill(0);release?.();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await runAlwaysOn();}catch(error){process.stderr.write(safe(error)+'\n');process.exitCode=1;}
}
