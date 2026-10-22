import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {partitionPostFenceBatch} from './web-session-policy.mjs';
import {getInboundMessageId} from './policy.mjs';
export const AUTO_FILE=resolve('data/always-on.json');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AUTO_VERSION=1;
export function validPinnedChatUrl(value){
 try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='chatgpt.com'
 &&!url.username&&!url.password&&!url.hash&&!url.search&&
 new RegExp('^(?:/c/|/g/[^/]+/c/)[0-9a-f-]{36}/?$','i').test(url.pathname);}
 catch{return false;}
}
export function readAlwaysOn(filename=AUTO_FILE){
 let obj;
 try{obj=JSON.parse(readFileSync(filename,'utf8'));}catch{return {enabled:false,paused:true,version:AUTO_VERSION};}
 if(obj?.version!==AUTO_VERSION||typeof obj.enabled!=='boolean'||typeof obj.paused!=='boolean'
    ||typeof obj.approvedAt!=='string'||!/^202[0-9]-\d\d-\d\dT/.test(obj.approvedAt)
    ||obj.scope!=='ONE_PAIRED_PRIVATE_CHATGPT_TAB'||!validPinnedChatUrl(obj.chatUrl))throw Error('ALWAYS_ON_CONFIG_INVALID');
 return {version:AUTO_VERSION,enabled:obj.enabled,paused:obj.paused,approvedAt:obj.approvedAt,scope:obj.scope,chatUrl:obj.chatUrl};
}
export function writeAlwaysOn(config,filename=AUTO_FILE){
 if(config?.version!==AUTO_VERSION||typeof config.enabled!=='boolean'||typeof config.paused!=='boolean'
    ||config.scope!=='ONE_PAIRED_PRIVATE_CHATGPT_TAB'||typeof config.approvedAt!=='string'||!validPinnedChatUrl(config.chatUrl))
  throw Error('ALWAYS_ON_CONFIG_INVALID');
 mkdirSync(dirname(filename),{recursive:true});
 const temp=filename+'.'+randomUUID()+'.tmp';
 writeFileSync(temp,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
 renameSync(temp,filename);
}
export function assertAutoBinding(binding,config){
 if(!binding?.allowedPeer?.userId||binding.allowedPeer.userId!==binding.allowedPeer.chatId||
    binding.inboundEnabled!==false||binding.outboundEnabled!==false)
  throw Error('ALWAYS_ON_EXACT_PEER_AND_PERSISTENT_FLAGS_REQUIRED');
 if(config?.enabled!==true||config.paused!==false||config.scope!=='ONE_PAIRED_PRIVATE_CHATGPT_TAB')
  throw Error('ALWAYS_ON_NOT_ENABLED');
 return binding.allowedPeer;
}
export function classifyRecovery(rows){
 if(!Array.isArray(rows))throw Error('ALWAYS_ON_INVALID_EVENTS');
 const terminal=new Set(['SUCCEEDED','REVIEWED_NO_REPLAY','DEFERRED_BACKLOG']);
 const active=rows.filter(x=>!terminal.has(x.status));
 if(active.some(r=>['OUTBOUND_UNKNOWN','OUTBOUND_SENDING'].includes(r.status)))
  throw Error('ALWAYS_ON_AMBIGUOUS_OUTBOUND_REQUIRES_REVIEW');
 if(active.some(r=>r.status==='RECEIVED'&&r.bridge_submit_attempts!==0))
  throw Error('ALWAYS_ON_BRIDGE_ATTEMPT_UNKNOWN');
 if(active.some(r=>r.status==='BRIDGE_QUEUED'&&(!r.bridge_event_id||r.bridge_submit_attempts!==1)))
  throw Error('ALWAYS_ON_BRIDGE_ORIGIN_UNKNOWN');
 if(active.some(r=>r.status==='REPLY_READY'&&(!r.bridge_event_id||r.bridge_submit_attempts!==1)))
  throw Error('ALWAYS_ON_REPLY_ORIGIN_UNKNOWN');
 if(active.some(r=>!['RECEIVED','BRIDGE_QUEUED','REPLY_READY'].includes(r.status)))
  throw Error('ALWAYS_ON_UNEXPECTED_ADAPTER_STATE');
 return {active:active.length,hasPending:active.length>0};
}
export function durableStartupBatch({store,adapter,updates,accountId,peer}){
 if(!Array.isArray(updates))throw Error('ALWAYS_ON_INVALID_BATCH');
 if(typeof adapter?.policy?.authorize!=='function'||!store?.db)
   throw Error('ALWAYS_ON_POLICY_MISSING');
 let plan;
 try{plan=partitionPostFenceBatch(updates,accountId,peer);}
 catch{throw Error('ALWAYS_ON_BATCH_UNSAFE');}
 if(plan.unsupported.length&&typeof store.quarantineUnsupportedInbound!=='function')
   throw Error('ALWAYS_ON_UNSUPPORTED_QUARANTINE_REQUIRED');
 const media=new Map(plan.unsupported.map(record=>[accountId+':'+record.messageId,record]));
 let newlyDeferred=0,alreadyStored=0,unsupportedNew=0,unsupportedExisting=0;
 // This entire boot fence is one durable unit. The caller commits the Weixin
 // cursor only after this transaction succeeds; no old item can trigger a reply.
 store.db.exec('BEGIN IMMEDIATE');
 try{
  for(const raw of updates){
    const isPureText=raw.item_list.length===1&&raw.item_list[0].type===1;
    if(!isPureText){
      const key=accountId+':'+getInboundMessageId(raw);
      const record=media.get(key);
      if(!record)throw Error('ALWAYS_ON_UNCLASSIFIED_MEDIA');
      const held=store.quarantineUnsupportedInbound(record);
      if(held.newlyRecorded)unsupportedNew++;
      else unsupportedExisting++;
      continue;
    }
    const accepted=adapter.ingestRaw(raw);
    if(!accepted.accepted||!accepted.event)throw Error('ALWAYS_ON_BATCH_UNSAFE');
    if(accepted.event.account_id!==accountId||accepted.event.user_id!==peer.userId||
       accepted.event.chat_id!==peer.chatId)throw Error('ALWAYS_ON_BINDING_CONFLICT');
    if(accepted.event.status==='RECEIVED'){
      store.deferBacklog(accepted.event.id);
      newlyDeferred++;
    }else if(['SUCCEEDED','REVIEWED_NO_REPLAY','DEFERRED_BACKLOG'].includes(accepted.event.status))alreadyStored++;
    else throw Error('ALWAYS_ON_BATCH_PREEXISTING_PENDING');
  }
  store.db.exec('COMMIT');
 }catch(error){store.db.exec('ROLLBACK');throw error;}
 const result={newlyDeferred,alreadyStored,total:updates.length};
 if(plan.unsupported.length)Object.assign(result,{unsupportedNew,unsupportedExisting});
 return result;
}
