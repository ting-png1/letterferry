import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stdin,stdout} from 'node:process';
import {createInterface} from 'node:readline/promises';
import {ProtectedAuthStore} from '../src/auth-store.mjs';
import {AdapterStore} from '../src/store.mjs';
import {AllowlistPolicy} from '../src/policy.mjs';
import {ExistingBridgeClient} from '../src/bridge-client.mjs';
import {RealWeixinTransport} from '../src/transports/real-weixin.mjs';
import {WeixinBridgeAdapter} from '../src/adapter.mjs';
import {loadEncryptionKey} from '../src/secrets.mjs';
import {loadSessionBinding,runBoundedSession,enforceBridgeLimit} from './weixin-session.mjs';
import {hasVerifiedBrowserSmoke} from './verify-web-smoke-history.mjs';
import {verifyWebHostHealth} from '../src/web-weixin-once-policy.mjs';
import {START_PREFIX,START_APPROVAL,auditWebSessionStart,selectActivationBatch,archiveActivationBatch,partitionPostFenceBatch} from '../src/web-session-policy.mjs';
import {acquireWebSessionLock} from '../src/web-session-lock.mjs';

const WEB_HEALTH='http://127.0.0.1:8799/health';
const SESSION_LENGTH_MS=30*60_000;
const POLL_TIMEOUT_MS=36_000;
const SESSION_LIMIT=20;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function safeCode(error){
 const value=error?.message||'WEB_WEIXIN_SESSION_FAILED';
 return /^[A-Z0-9_:-]{1,140}$/.test(value)?value:'WEB_WEIXIN_SESSION_FAILED';
}
export function assertSessionWebHealth(health,{startup=false}={}){
 if(startup)return verifyWebHostHealth(health);
 if((health?.queue?.DELIVERY_UNKNOWN||0)>0)
   throw Error('WEB_SESSION_UNKNOWN_BROWSER_DELIVERY');
 if((health?.queue?.QUEUED||0)>0 || (health?.queue?.ASSIGNED_UNKNOWN||0)>0 || (health?.queue?.BROWSER_SUBMITTED||0)>0)
   throw Error('WEB_SESSION_UNEXPECTED_BROWSER_WORK');
 if(health?.ok!==true||health.host!=='HOST_READY')
   throw Error('WEB_SESSION_HOST_DISCONNECTED');
 return true;
}
async function ready({startup=false}={}){
 let response;
 try{response=await fetch(WEB_HEALTH,{signal:AbortSignal.timeout(4_000)});}
 catch{throw Error('WEB_HOST_OFFLINE');}
 if(!response.ok)throw Error('WEB_HOST_UNAVAILABLE');
 return assertSessionWebHealth(await response.json(),{startup});
}

// A long ChatGPT browser turn blocks the extension's regular heartbeat; the
// broker may briefly report HOST_UNVERIFIED just after that reply completes.
// Pause new Weixin polling during this bounded grace; do not enqueue or send.
export async function waitForWebHostRecovery({
 check,signal,clock=()=>Date.now(),delay=sleep,
 graceMs=60_000,retryMs=500,
 onPause=()=>{},onRestore=()=>{}
}={}){
 if(typeof check!=='function'||!Number.isFinite(graceMs)||graceMs<0||
    !Number.isFinite(retryMs)||retryMs<=0)throw Error('WEB_SESSION_HOST_GATE_INVALID');
 const start=clock();
 let paused=false;
 while(true){
   if(signal?.aborted)throw Error('WEB_SESSION_CANCELLED_DURING_HOST_WAIT');
   try{
     await check();
     if(signal?.aborted)throw Error('WEB_SESSION_CANCELLED_DURING_HOST_WAIT');
     if(paused)onRestore();
     return {restored:paused};
   }catch(error){
     const code=error instanceof Error?error.message:'';
     if(!['WEB_SESSION_HOST_DISCONNECTED','WEB_HOST_OFFLINE','WEB_HOST_UNAVAILABLE'].includes(code))
       throw error;
     if(!paused){paused=true;onPause();}
     const elapsed=Math.max(0,clock()-start);
     if(elapsed>=graceMs)throw Error('WEB_SESSION_HOST_GRACE_EXPIRED');
     await delay(Math.min(retryMs,graceMs-elapsed));
   }
 }
}
export function guardedSessionTransport(real,accountId,peer,healthCheck,{store,onQuarantine=()=>{}}={}){
 return {
   async poll(){
     await healthCheck();
     const batch=await real.poll();
     const planned=partitionPostFenceBatch(batch,accountId,peer);
     if(planned.unsupported.length){
       if(typeof store?.quarantineUnsupportedInbound!=='function')
         throw Error('UNSUPPORTED_INBOUND_QUARANTINE_REQUIRED');
       let newlyRecorded=0;
       for(const record of planned.unsupported){
         if(store.quarantineUnsupportedInbound(record).newlyRecorded)newlyRecorded++;
       }
       onQuarantine({count:planned.unsupported.length,newlyRecorded});
     }
     return planned.text;
   },
   commitPoll:()=>real.commitPoll(),
   sendText:(...args)=>real.sendText(...args)
 };
}

async function main(){
 if(!stdin.isTTY||!stdout.isTTY)throw Error('FOREGROUND_TTY_REQUIRED');
 const {allowedPeer}=loadSessionBinding();
 if(!hasVerifiedBrowserSmoke())throw Error('WEB_SMOKE_VERIFICATION_REQUIRED');
 await ready({startup:true});
 let store=null,releaseLock=null,key=null;
 const rl=createInterface({input:stdin,output:stdout});
 const controller=new AbortController();
 const onInterrupt=()=>controller.abort();
 process.once('SIGINT',onInterrupt);
 try{
   releaseLock=acquireWebSessionLock();
   store=new AdapterStore(resolve('data/adapter.sqlite'));
   auditWebSessionStart(store.list());
   const marker=START_PREFIX+randomBytes(12).toString('hex').toUpperCase();
   stdout.write('FOREGROUND 30-MIN WEB WEIXIN SESSION / MAX 20 NEW DMs. THIS MODE SENDS AUTO REPLIES AFTER YOU START IT.\n');
   stdout.write('Do NOT send private/sensitive DMs into the bot. No automatic replay of old or ambiguous tasks.\n');
   stdout.write('Send this exact START marker in the ALREADY PAIRED Weixin Bot private chat: '+marker+'\n');
   stdout.write('Wait for SESSION_ACTIVE before sending ordinary text (no prefixes required then).\n');
   const approval=await rl.question('After sending the marker, type '+START_APPROVAL+' to allow up to 20 automatic replies during 30 minutes (anything else cancels): ');
   if(approval!==START_APPROVAL){stdout.write('CANCELLED_NO_WEIXIN_NETWORK\n');return;}
   auditWebSessionStart(store.list());
   await ready({startup:true});
   const authStore=new ProtectedAuthStore();
   const auth=await authStore.load();
   key=loadEncryptionKey();
   const real=new RealWeixinTransport({authStore,allowedPeer,inboundEnabled:true,outboundEnabled:true});
   const activation=await real.poll();
   if(!real.pendingCursor)throw Error('START_FENCE_CURSOR_MISSING_NO_ARCHIVE');
   const selection=selectActivationBatch(activation,{marker,accountId:auth.accountId,peer:allowedPeer});
   if(!selection.found)throw Error('START_MARKER_NOT_SEEN_CURSOR_UNCHANGED');
   let sessionDeadline=Infinity;
   const transport=guardedSessionTransport(real,auth.accountId,allowedPeer,()=>waitForWebHostRecovery({
      check:()=>{
        if(Date.now()>=sessionDeadline)throw Error('WEB_SESSION_DEADLINE_DURING_HOST_WAIT');
        return ready();
      },signal:controller.signal,
      onPause:()=>stdout.write('WEB_SESSION_HOST_WAITING no_new_weixin_poll=TRUE no_auto_replay=TRUE\n'),
      onRestore:()=>stdout.write('WEB_SESSION_HOST_RESTORED\n')
   }),{store,onQuarantine:({count,newlyRecorded})=>
     stdout.write('WEB_SESSION_UNSUPPORTED_QUARANTINED count='+count+
       ' new='+newlyRecorded+' no_reply=TRUE\n')});
   const bridge=enforceBridgeLimit(new ExistingBridgeClient({
     origin:process.env.CHATGPT_BRIDGE_ORIGIN,
     fetchImpl:(url,options={})=>fetch(url,{...options,signal:AbortSignal.timeout(8000)})
   }));
   const adapter=new WeixinBridgeAdapter({accountId:auth.accountId,
     policy:new AllowlistPolicy({accountId:auth.accountId,allowedPeers:[allowedPeer]}),
     store,bridge,transport,encryptionKey:key});
   const archived=archiveActivationBatch({store,adapter,updates:activation,
     marker,accountId:auth.accountId,peer:allowedPeer});
   // Only move the Weixin cursor AFTER every allowed message in the fence batch
   // has been durably stored as terminal/deferred, never merely discarded.
   await real.commitPoll();
   stdout.write('START_FENCE_ARCHIVED deferred_new='+archived.deferredNew+
     ' already_safe='+archived.existingSafe+
     ' unsupported_held='+(archived.unsupportedNew||0)+
     ' unsupported_replayed='+(archived.unsupportedExisting||0)+
     ' no_old_messages_sent=TRUE\n');
   await ready();
   if(controller.signal.aborted){stdout.write('CANCELLED_AFTER_SAFE_FENCE_NO_WEIXIN_SEND\n');return;}
   stdout.write('SESSION_ACTIVE: from NOW, send normal private messages; no prefix required. AUTO REPLIES ENABLED ONLY FOR THIS SESSION.\n');
   sessionDeadline=Date.now()+SESSION_LENGTH_MS;
   const outcome=await runBoundedSession({
     adapter,store,signal:controller.signal,
     durationMs:SESSION_LENGTH_MS,
     maxAccepted:SESSION_LIMIT,
     pollReserveMs:POLL_TIMEOUT_MS,
     idleDelayMs:300,
     onProgress:({kind,count})=>stdout.write('WEB_SESSION_PROGRESS '+kind+' '+count+'\n')
   });
   stdout.write('WEB_SESSION_END '+JSON.stringify(outcome)+'\n');
 }finally{
   process.removeListener('SIGINT',onInterrupt);
   rl.close();
   store?.close();
   releaseLock?.();
   key?.fill(0);
 }
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main();}
 catch(e){console.error(safeCode(e));process.exitCode=1;}
}
