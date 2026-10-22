import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AdapterStore} from '../src/store.mjs';

test('legacy production-shaped adapter SQLite migrates without replay, drops or body leakage',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rwx-migrate-'));
 t.after(()=>rmSync(dir,{force:true,recursive:true}));
 const filename=join(dir,'adapter.sqlite');
 const db=new DatabaseSync(filename);
 db.exec(`CREATE TABLE adapter_events(
 id TEXT PRIMARY KEY,inbound_key TEXT UNIQUE NOT NULL,
 account_id TEXT NOT NULL,user_id TEXT NOT NULL,chat_id TEXT NOT NULL,
 message_id TEXT NOT NULL,text TEXT NOT NULL,context_cipher TEXT NOT NULL,
 status TEXT NOT NULL,created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL,
 bridge_event_id TEXT UNIQUE,bridge_submit_attempts INTEGER NOT NULL DEFAULT 0,
 reply_text TEXT,outbound_client_id TEXT UNIQUE NOT NULL,last_error TEXT);`);
 const insert=db.prepare(`INSERT INTO adapter_events
 (id,inbound_key,account_id,user_id,chat_id,message_id,text,context_cipher,status,
 created_ms,updated_ms,outbound_client_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
 insert.run('legacy-ok','bot:ok','bot','peer','peer','ok','PRIVATE_LEGACY_TEXT','sealed','SUCCEEDED',100,200,'cid-ok');
 insert.run('legacy-inflight','bot:inflight','bot','peer','peer','inflight','PRIVATE_AMBIGUOUS_TEXT','sealed','OUTBOUND_SENDING',300,400,'cid-uncertain');
 db.close();
 const store=new AdapterStore(filename,()=>500);
 try{
  assert.equal(store.list().length,2);
  assert.equal(store.get('legacy-ok').status,'SUCCEEDED');
  assert.equal(store.get('legacy-inflight').status,'OUTBOUND_UNKNOWN');
  assert.equal(store.get('legacy-inflight').last_error,'RECOVERED_AMBIGUOUS_OUTBOUND');
  assert.equal(store.unsupportedInboundCounts().length,0);
  const marks=store.db.prepare('SELECT event_id,phase,marked_ms FROM adapter_phase_marks').all();
  assert.equal(marks.length,1);
  assert.equal(marks[0].phase,'OUTBOUND_UNKNOWN');
  assert.equal(marks[0].marked_ms,500);
  assert.equal(JSON.stringify(marks).includes('PRIVATE'),false);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM adapter_events').get().n,2);
 }finally{store.close();}
 const reopened=new AdapterStore(filename,()=>600);
 try{
  assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM adapter_events').get().n,2);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM adapter_phase_marks').get().n,1);
  assert.equal(reopened.get('legacy-inflight').status,'OUTBOUND_UNKNOWN');
 }finally{reopened.close();}
});
