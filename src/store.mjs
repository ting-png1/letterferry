import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const PUBLIC_COLUMNS = `id,inbound_key,account_id,user_id,chat_id,message_id,text,status,created_ms,updated_ms,
bridge_event_id,bridge_submit_attempts,outbound_client_id,last_error`;

export class AdapterStore {
  constructor(filename = resolve('data/adapter.sqlite'), clock = () => Date.now()) {
    mkdirSync(dirname(filename), { recursive: true });
    this.filename = filename;
    this.clock = clock;
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS adapter_events (
        id TEXT PRIMARY KEY,
        inbound_key TEXT UNIQUE NOT NULL,
        account_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        context_cipher TEXT NOT NULL,
        status TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL,
        bridge_event_id TEXT UNIQUE,
        bridge_submit_attempts INTEGER NOT NULL DEFAULT 0,
        reply_text TEXT,
        outbound_client_id TEXT UNIQUE NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS adapter_status ON adapter_events(status,created_ms);`);
    // A separate minimal reliability schema; no streaming or message-body changes.
    this.db.exec(`CREATE TABLE IF NOT EXISTS adapter_unsupported_inbound (
      inbound_key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,user_id TEXT NOT NULL,chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,kind TEXT NOT NULL
        CHECK(kind IN ('NON_TEXT_ITEM','MIXED_ITEM_TYPES')),
      status TEXT NOT NULL DEFAULT 'QUARANTINED_NO_REPLY'
        CHECK(status='QUARANTINED_NO_REPLY'),
      created_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS adapter_phase_marks (
      event_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN (
        'INGESTED','BRIDGE_QUEUED','REPLY_READY','OUTBOUND_SENDING',
        'SUCCEEDED','OUTBOUND_UNKNOWN')),
      marked_ms INTEGER NOT NULL,
      PRIMARY KEY(event_id,phase)
    );
    CREATE TRIGGER IF NOT EXISTS adapter_phase_ingest
    AFTER INSERT ON adapter_events
    BEGIN
      INSERT OR IGNORE INTO adapter_phase_marks(event_id,phase,marked_ms)
      VALUES(NEW.id,'INGESTED',NEW.created_ms);
    END;
    CREATE TRIGGER IF NOT EXISTS adapter_phase_transition
    AFTER UPDATE OF status ON adapter_events
    WHEN NEW.status IN ('BRIDGE_QUEUED','REPLY_READY','OUTBOUND_SENDING',
      'SUCCEEDED','OUTBOUND_UNKNOWN') AND NEW.status<>OLD.status
    BEGIN
      INSERT OR IGNORE INTO adapter_phase_marks(event_id,phase,marked_ms)
      VALUES(NEW.id,NEW.status,NEW.updated_ms);
    END;`);
    this.db.prepare("UPDATE adapter_events SET status='OUTBOUND_UNKNOWN',last_error='RECOVERED_AMBIGUOUS_OUTBOUND',updated_ms=? WHERE status='OUTBOUND_SENDING'").run(this.clock());
  }

  ingest(update, contextCipher) {
    const inboundKey = `${update.accountId}:${update.messageId}`;
    if(this.db.prepare('SELECT inbound_key FROM adapter_unsupported_inbound WHERE inbound_key=?').get(inboundKey))
      throw Error('INBOUND_TEXT_UNSUPPORTED_ID_CONFLICT');
    const id = randomUUID();
    const now = this.clock();
    const outboundClientId = `rwb-${id}`;
    this.db.prepare(`INSERT OR IGNORE INTO adapter_events
      (id,inbound_key,account_id,user_id,chat_id,message_id,text,context_cipher,status,created_ms,updated_ms,outbound_client_id)
      VALUES (?,?,?,?,?,?,?,?,'RECEIVED',?,?,?)`)
      .run(id,inboundKey,update.accountId,update.fromUserId,update.chatId,update.messageId,update.text,contextCipher,now,now,outboundClientId);
    const row = this.getByInboundKey(inboundKey, true);
    if (row.user_id !== update.fromUserId || row.chat_id !== update.chatId || row.text !== update.text) throw new Error('IDEMPOTENCY_CONFLICT');
    return this.get(row.id);
  }

  // Quarantine records only minimal metadata, never image contents or token.
  quarantineUnsupportedInbound(record){
    const {accountId,fromUserId,chatId,messageId,kind}=record||{};
    if(![accountId,fromUserId,chatId,messageId].every(
       s=>typeof s==='string'&&/^[A-Za-z0-9@._:-]{1,256}$/.test(s))||
       fromUserId!==chatId||!['NON_TEXT_ITEM','MIXED_ITEM_TYPES'].includes(kind))
      throw Error('UNSUPPORTED_INBOUND_RECORD_INVALID');
    const key=accountId+':'+messageId;
    if(this.getByInboundKey(key))throw Error('UNSUPPORTED_INBOUND_TEXT_ID_CONFLICT');
    const result=this.db.prepare(`INSERT OR IGNORE INTO adapter_unsupported_inbound
      (inbound_key,account_id,user_id,chat_id,message_id,kind,status,created_ms)
      VALUES (?,?,?,?,?,?,'QUARANTINED_NO_REPLY',?)`)
      .run(key,accountId,fromUserId,chatId,messageId,kind,this.clock());
    const prior=this.db.prepare(`SELECT account_id,user_id,chat_id,message_id,kind,status
      FROM adapter_unsupported_inbound WHERE inbound_key=?`).get(key);
    if(prior.account_id!==accountId||prior.user_id!==fromUserId||
       prior.chat_id!==chatId||prior.message_id!==messageId||prior.kind!==kind||
       prior.status!=='QUARANTINED_NO_REPLY')
      throw Error('UNSUPPORTED_INBOUND_IDEMPOTENCY_CONFLICT');
    return {newlyRecorded:result.changes===1,status:'QUARANTINED_NO_REPLY'};
  }
  unsupportedInboundCounts(){
    return this.db.prepare(`SELECT kind,COUNT(*) AS count
      FROM adapter_unsupported_inbound GROUP BY kind ORDER BY kind`).all()
      .map(row=>({kind:row.kind,count:row.count}));
  }
  get(id, includePrivate = false) {
    return this.db.prepare(`SELECT ${includePrivate ? '*' : PUBLIC_COLUMNS} FROM adapter_events WHERE id=?`).get(id);
  }
  getPrivate(id) { return this.get(id, true); }
  getByInboundKey(key, includePrivate = false) {
    return this.db.prepare(`SELECT ${includePrivate ? '*' : PUBLIC_COLUMNS} FROM adapter_events WHERE inbound_key=?`).get(key);
  }
  next(status) {
    return this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM adapter_events WHERE status=? ORDER BY created_ms,rowid LIMIT 1`).get(status);
  }
  list() { return this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM adapter_events ORDER BY created_ms,rowid`).all(); }

  noteBridgeAttempt(id) {
    const result = this.db.prepare("UPDATE adapter_events SET bridge_submit_attempts=bridge_submit_attempts+1,updated_ms=?,last_error=NULL WHERE id=? AND status='RECEIVED'").run(this.clock(),id);
    if (result.changes !== 1) throw new Error('STALE_EVENT');
  }
  deferBacklog(id) {
    const changed=this.db.prepare("UPDATE adapter_events SET status='DEFERRED_BACKLOG',updated_ms=?,last_error=NULL WHERE id=? AND status='RECEIVED'").run(this.clock(),id);
    if(changed.changes!==1) throw new Error('BACKLOG_STATE_CONFLICT');
    return this.get(id);
  }
  bridgeQueued(id, bridgeEventId) {
    const result = this.db.prepare("UPDATE adapter_events SET status='BRIDGE_QUEUED',bridge_event_id=?,updated_ms=?,last_error=NULL WHERE id=? AND status='RECEIVED'").run(bridgeEventId,this.clock(),id);
    if (result.changes !== 1) throw new Error('STALE_EVENT');
    return this.get(id);
  }
  bridgeError(id, code) {
    this.db.prepare("UPDATE adapter_events SET updated_ms=?,last_error=? WHERE id=? AND status='RECEIVED'").run(this.clock(),code,id);
  }
  replyReady(id, replyText) {
    if (typeof replyText !== 'string' || !replyText.trim() || replyText.length > 8000) throw new Error('INVALID_REPLY');
    const result = this.db.prepare("UPDATE adapter_events SET status='REPLY_READY',reply_text=?,updated_ms=?,last_error=NULL WHERE id=? AND status='BRIDGE_QUEUED'").run(replyText.trim(),this.clock(),id);
    if (result.changes !== 1) throw new Error('STALE_EVENT');
    return this.get(id);
  }
  beginOutbound(id) {
    const result = this.db.prepare("UPDATE adapter_events SET status='OUTBOUND_SENDING',updated_ms=?,last_error=NULL WHERE id=? AND status='REPLY_READY'").run(this.clock(),id);
    if (result.changes !== 1) throw new Error('STALE_EVENT');
    return this.getPrivate(id);
  }
  outboundSucceeded(id) {
    const result = this.db.prepare("UPDATE adapter_events SET status='SUCCEEDED',updated_ms=? WHERE id=? AND status='OUTBOUND_SENDING'").run(this.clock(),id);
    if (result.changes !== 1) throw new Error('STALE_EVENT');
    return this.get(id);
  }
  outboundUnknown(id, code = 'OUTBOUND_RESULT_UNKNOWN') {
    const result = this.db.prepare("UPDATE adapter_events SET status='OUTBOUND_UNKNOWN',updated_ms=?,last_error=? WHERE id=? AND status='OUTBOUND_SENDING'").run(this.clock(),code,id);
    if (result.changes !== 1) throw new Error('STALE_EVENT');
    return this.get(id);
  }
  reviewBridgeWithoutReplay(id,bridgeEventId){
    if(typeof id!=='string'||typeof bridgeEventId!=='string')throw Error('REVIEW_IDS_REQUIRED');
    const row=this.get(id);
    if(row?.bridge_event_id!==bridgeEventId||row?.bridge_submit_attempts!==1||
      row?.status!=='BRIDGE_QUEUED')throw Error('REVIEW_EXACT_PENDING_BRIDGE_REQUIRED');
    const result=this.db.prepare(`UPDATE adapter_events
      SET status='REVIEWED_NO_REPLAY',last_error='HUMAN_REVIEW_BROWSER_INPUT_NOT_CONFIRMED',updated_ms=?
      WHERE id=? AND bridge_event_id=? AND status='BRIDGE_QUEUED' AND bridge_submit_attempts=1`)
      .run(this.clock(),id,bridgeEventId);
    if(result.changes!==1)throw Error('REVIEW_COMMIT_CONFLICT');
    return this.get(id);
  }
  close() { this.db.close(); }
}
