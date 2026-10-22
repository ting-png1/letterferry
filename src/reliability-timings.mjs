// Read-only, aggregate timing evidence. Never emit message, peer, token or event IDs.
import {DatabaseSync} from 'node:sqlite';
import {join,resolve} from 'node:path';

function readColumns(filename,sql){
 let db=null;
 try{
  db=new DatabaseSync(filename,{readOnly:true});
  return db.prepare(sql).all();
 }catch{throw Error('RELIABILITY_SQLITE_READ_FAILED');}
 finally{db?.close();}
}
const ALLOWED_ADAPTER=new Set(['RECEIVED','BRIDGE_QUEUED','REPLY_READY','OUTBOUND_SENDING',
 'OUTBOUND_UNKNOWN','SUCCEEDED','DEFERRED_BACKLOG','REVIEWED_NO_REPLAY']);
const ALLOWED_HOST=new Set(['QUEUED','ASSIGNED_UNKNOWN','BROWSER_SUBMITTED','DELIVERY_UNKNOWN',
 'SUCCEEDED','REVIEWED_NO_REPLAY']);
function readPhaseMarks(filename){
 let db=null;
 try{
  db=new DatabaseSync(filename,{readOnly:true});
  const exists=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='adapter_phase_marks'").get();
  if(!exists)return null;
  return db.prepare("SELECT event_id,phase,marked_ms FROM adapter_phase_marks").all();
 }catch{throw Error('RELIABILITY_PHASES_READ_FAILED');}
 finally{db?.close();}
}
function histogram(rows,allowed){
 const result={};
 for(const row of rows){
  const key=allowed.has(row.status)?row.status:'UNRECOGNIZED';
  result[key]=(result[key]||0)+1;
 }
 return result;
}
function percentile(sorted,fraction){
 return sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)];
}
function describe(numbers){
 if(!numbers.length)return {samples:0,p50Ms:null,p95Ms:null,maxMs:null,over180s:0};
 numbers.sort((a,b)=>a-b);
 return {samples:numbers.length,p50Ms:percentile(numbers,0.5),
   p95Ms:percentile(numbers,0.95),maxMs:numbers[numbers.length-1],
   over180s:numbers.filter(n=>n>180000).length};
}
function duration(a,b){
 if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||b<a||
    b-a>30*24*60*60*1000)return null;
 return b-a;
}
export function summarizeReliabilityTimings(adapterRows,hostRows,phaseRows=null){
 if(!Array.isArray(adapterRows)||!Array.isArray(hostRows))throw Error('TIMING_ROWS_REQUIRED');
 const hosts=new Map(hostRows.map(row=>[row.id,row]));
 const phaseMap=new Map();
 if(phaseRows!==null){
  if(!Array.isArray(phaseRows))throw Error('TIMING_PHASE_ROWS_INVALID');
  const phases=new Set(['INGESTED','BRIDGE_QUEUED','REPLY_READY','OUTBOUND_SENDING','SUCCEEDED','OUTBOUND_UNKNOWN']);
  for(const mark of phaseRows){
   if(typeof mark.event_id!=='string'||!phases.has(mark.phase)||!Number.isSafeInteger(mark.marked_ms))
    continue;
   const m=phaseMap.get(mark.event_id)||new Map();
   if(!m.has(mark.phase))m.set(mark.phase,mark.marked_ms);
   phaseMap.set(mark.event_id,m);
  }
 }
 const exact={hostCompletedToReplyReady:[],replyReadyToSendStarted:[],sendStartedToSucceeded:[]};
 const stages={inboundToHost:[],browserProcessing:[],hostToWeixinAck:[],endToEnd:[]};
 let paired=0,excluded=0;
 for(const row of adapterRows){
  if(row.status!=='SUCCEEDED'||!row.bridge_event_id){excluded++;continue;}
  const host=hosts.get(row.bridge_event_id);
  if(host?.status!=='SUCCEEDED'){excluded++;continue;}
  const metrics={
   inboundToHost:duration(row.created_ms,host.created_ms),
   browserProcessing:duration(host.created_ms,host.updated_ms),
   hostToWeixinAck:duration(host.updated_ms,row.updated_ms),
   endToEnd:duration(row.created_ms,row.updated_ms)
  };
  if(Object.values(metrics).some(v=>v===null)){excluded++;continue;}
  paired++;
  for(const [k,v] of Object.entries(metrics))stages[k].push(v);
  if(phaseRows!==null){
   const marks=phaseMap.get(row.id);
   if(marks){
    const pairs={
     hostCompletedToReplyReady:duration(host.updated_ms,marks.get('REPLY_READY')),
     replyReadyToSendStarted:duration(marks.get('REPLY_READY'),marks.get('OUTBOUND_SENDING')),
     sendStartedToSucceeded:duration(marks.get('OUTBOUND_SENDING'),marks.get('SUCCEEDED'))
    };
    for(const [key,value] of Object.entries(pairs))if(value!==null)exact[key].push(value);
   }
  }
 }
 return {
  source:'READ_ONLY_SQLITE_AGGREGATES',
  adapterStatusCounts:histogram(adapterRows,ALLOWED_ADAPTER),
  hostStatusCounts:histogram(hostRows,ALLOWED_HOST),
  pairedSucceeded:paired,excludedOrUnpaired:excluded,
  timingsMs:Object.fromEntries(Object.entries(stages).map(([k,v])=>[k,describe(v)])),
  durablePhaseTimingsMs:phaseRows===null?null:Object.fromEntries(Object.entries(exact).map(([k,v])=>[k,describe(v)])),
  note:'Historical, non-atomic snapshots from two SQLite databases. Browser time includes queue/wait; Weixin ACK time includes post-browser processing. created_ms/updated_ms are approximate stage intervals, not wire-level traces.'
 };
}
export function inspectReliabilityTimings(productionRoot){
 if(typeof productionRoot!=='string'||!productionRoot.trim())
  throw Error('RELIABILITY_ROOT_REQUIRED');
 const root=resolve(productionRoot);
 const adapter=readColumns(join(root,'data','adapter.sqlite'),
  'SELECT id,bridge_event_id,status,created_ms,updated_ms FROM adapter_events');
 const host=readColumns(join(root,'data','web-host.sqlite'),
  'SELECT id,status,created_ms,updated_ms FROM web_host_events');
 const phases=readPhaseMarks(join(root,'data','adapter.sqlite'));
 return summarizeReliabilityTimings(adapter,host,phases);
}
