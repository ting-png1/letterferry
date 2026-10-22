import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AdapterStore} from '../src/store.mjs';
import {inspectReliabilityTimings,summarizeReliabilityTimings} from '../src/reliability-timings.mjs';

const adapter=[
 {status:'SUCCEEDED',bridge_event_id:'h1',created_ms:1000,updated_ms:136000,text:'PRIVATE'},
 {status:'SUCCEEDED',bridge_event_id:'h2',created_ms:200000,updated_ms:385000},
 {status:'OUTBOUND_UNKNOWN',bridge_event_id:'h3',created_ms:0,updated_ms:0},
 {status:'SUCCEEDED',bridge_event_id:'missing',created_ms:0,updated_ms:1}
];
const host=[
 {id:'h1',status:'SUCCEEDED',created_ms:6000,updated_ms:126000,text:'PRIVATE_REPLY'},
 {id:'h2',status:'SUCCEEDED',created_ms:201000,updated_ms:382000},
 {id:'h3',status:'DELIVERY_UNKNOWN',created_ms:1,updated_ms:1000}
];
test('latency profile attributes completed rows to stages without emitting private data',()=>{
 const result=summarizeReliabilityTimings(adapter,host);
 assert.equal(result.pairedSucceeded,2);
 assert.equal(result.excludedOrUnpaired,2);
 assert.deepEqual(result.adapterStatusCounts,{SUCCEEDED:3,OUTBOUND_UNKNOWN:1});
 assert.deepEqual(result.hostStatusCounts,{SUCCEEDED:2,DELIVERY_UNKNOWN:1});
 assert.equal(result.timingsMs.inboundToHost.p50Ms,1000);
 assert.equal(result.timingsMs.inboundToHost.maxMs,5000);
 assert.equal(result.timingsMs.browserProcessing.maxMs,181000);
 assert.equal(result.timingsMs.browserProcessing.over180s,1);
 assert.equal(result.timingsMs.hostToWeixinAck.maxMs,10000);
 assert.equal(result.timingsMs.endToEnd.maxMs,185000);
 const json=JSON.stringify(result);
 for(const secret of ['PRIVATE','PRIVATE_REPLY','missing','h1','h2'])assert.equal(json.includes('"'+secret+'"'),false);
});
test('unrecognized status values are redacted instead of printed',()=>{
 const privateStatus='PRIVATE_PERSONAL_STATUS_TOKEN';
 const result=summarizeReliabilityTimings(
  [{status:privateStatus,bridge_event_id:'SECRET_ID',created_ms:0,updated_ms:0}],[]);
 assert.deepEqual(result.adapterStatusCounts,{UNRECOGNIZED:1});
 const serialized=JSON.stringify(result);
 assert.equal(serialized.includes(privateStatus),false);
 assert.equal(serialized.includes('SECRET_ID'),false);
});

test('invalid or unpaired stage timestamps cannot fabricate a duration',()=>{
 const input=[{status:'SUCCEEDED',bridge_event_id:'h1',created_ms:0,updated_ms:100}];
 const hosts=[{id:'h1',status:'SUCCEEDED',created_ms:99,updated_ms:200}];
 const result=summarizeReliabilityTimings(input,hosts);
 assert.equal(result.pairedSucceeded,0);
 assert.equal(result.excludedOrUnpaired,1);
 assert.equal(result.timingsMs.endToEnd.samples,0);
 assert.equal(result.timingsMs.endToEnd.p50Ms,null);
});
test('read-only SQLite inspection does not store or expose message text or identities',t=>{
 const root=mkdtempSync(join(tmpdir(),'rwx-latency-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const data=join(root,'data');mkdirSync(data);
 for(const [name,table,columns] of [
  ['adapter.sqlite','adapter_events','id TEXT,bridge_event_id TEXT,status TEXT,created_ms INTEGER,updated_ms INTEGER,text TEXT'],
  ['web-host.sqlite','web_host_events','id TEXT,status TEXT,created_ms INTEGER,updated_ms INTEGER,text TEXT']]){
  const db=new DatabaseSync(join(data,name));
  db.exec('CREATE TABLE '+table+' ('+columns+')');
  if(name==='adapter.sqlite')db.prepare('INSERT INTO adapter_events VALUES (?,?,?,?,?,?)')
    .run('a-1','h-1','SUCCEEDED',1000,4000,'PRIVATE_TEXT_DO_NOT_PRINT');
  else db.prepare('INSERT INTO web_host_events VALUES (?,?,?,?,?)')
    .run('h-1','SUCCEEDED',1500,3000,'OTHER_PRIVATE_TEXT');
  db.close();
 }
 const result=inspectReliabilityTimings(root);
 assert.equal(result.pairedSucceeded,1);
 assert.equal(result.timingsMs.endToEnd.p50Ms,3000);
 assert.equal(JSON.stringify(result).includes('PRIVATE_TEXT'),false);
});
test('durable phase journal pinpoints the waiting stage, preserves no content and survives reopen',t=>{
 const root=mkdtempSync(join(tmpdir(),'rwx-latency-phases-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const data=join(root,'data');mkdirSync(data);
 let ms=1000;
 const store=new AdapterStore(join(data,'adapter.sqlite'),()=>ms);
 const row=store.ingest({
  accountId:'bot',fromUserId:'paired',chatId:'paired',messageId:'msg-1',
  text:'PRIVATE_MESSAGE_MUST_STAY_OUT',contextToken:'secret-token'
 },'encrypted-test-context');
 ms=1300;store.noteBridgeAttempt(row.id);
 ms=1350;store.bridgeQueued(row.id,'h-stage-1');
 ms=2200;store.replyReady(row.id,'PRIVATE_REPLY_MUST_STAY_OUT');
 ms=2600;store.beginOutbound(row.id);
 ms=3050;store.outboundSucceeded(row.id);
 const before=store.db.prepare('SELECT phase,marked_ms FROM adapter_phase_marks ORDER BY marked_ms').all();
 assert.deepEqual(before.map(r=>r.phase),['INGESTED','BRIDGE_QUEUED','REPLY_READY','OUTBOUND_SENDING','SUCCEEDED']);
 assert.deepEqual(before.map(r=>r.marked_ms),[1000,1350,2200,2600,3050]);
 const serialized=JSON.stringify(before);
 assert.equal(serialized.includes('PRIVATE_'),false);
 store.close();
 const reopen=new AdapterStore(join(data,'adapter.sqlite'),()=>5000);
 assert.equal(reopen.db.prepare('SELECT COUNT(*) n FROM adapter_phase_marks').get().n,5);
 reopen.close();
 const host=new DatabaseSync(join(data,'web-host.sqlite'));
 host.exec('CREATE TABLE web_host_events (id TEXT,status TEXT,created_ms INTEGER,updated_ms INTEGER)');
 host.prepare('INSERT INTO web_host_events VALUES (?,?,?,?)').run('h-stage-1','SUCCEEDED',1500,1800);
 host.close();
 const report=inspectReliabilityTimings(root);
 assert.equal(report.pairedSucceeded,1);
 assert.equal(report.durablePhaseTimingsMs.hostCompletedToReplyReady.p50Ms,400);
 assert.equal(report.durablePhaseTimingsMs.replyReadyToSendStarted.p50Ms,400);
 assert.equal(report.durablePhaseTimingsMs.sendStartedToSucceeded.p50Ms,450);
 assert.equal(JSON.stringify(report).includes('PRIVATE_'),false);
 assert.equal(JSON.stringify(report).includes('h-stage-1'),false);
});

test('legacy database without phase journal reports unavailable rather than fabricated phase timings',t=>{
 const root=mkdtempSync(join(tmpdir(),'rwx-latency-legacy-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const data=join(root,'data');mkdirSync(data);
 for(const [file,sql] of [
  ['adapter.sqlite','CREATE TABLE adapter_events(id TEXT,bridge_event_id TEXT,status TEXT,created_ms INTEGER,updated_ms INTEGER)'],
  ['web-host.sqlite','CREATE TABLE web_host_events(id TEXT,status TEXT,created_ms INTEGER,updated_ms INTEGER)']
 ]){
  const db=new DatabaseSync(join(data,file));db.exec(sql);db.close();
 }
 assert.equal(inspectReliabilityTimings(root).durablePhaseTimingsMs,null);
});

test('unavailable files fail closed and do not create storage',t=>{
 const root=mkdtempSync(join(tmpdir(),'rwx-latency-missing-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.throws(()=>inspectReliabilityTimings(root),/RELIABILITY_SQLITE_READ_FAILED/);
 assert.equal(existsSync(join(root,'data','adapter.sqlite')),false);
});
