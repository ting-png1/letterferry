import {normalizeInbound,directEnvelopeRejection,getInboundMessageId} from './policy.mjs';

export const START_PREFIX='RWX_SESSION_START_';
export const START_APPROVAL='START WEB WEIXIN 30 MIN';
const SAFE_PRIOR=new Set(['SUCCEEDED','REVIEWED_NO_REPLAY','DEFERRED_BACKLOG']);

export function exactStartMarker(value){
  return typeof value==='string' && /^RWX_SESSION_START_[A-F0-9]{24}$/.test(value);
}

export function auditWebSessionStart(rows){
  if(!Array.isArray(rows)||rows.some(row=>!SAFE_PRIOR.has(row.status)))
    throw Error('WEB_SESSION_PREEXISTING_EVENT_REQUIRES_REVIEW');
  return true;
}

export function selectActivationBatch(updates,{marker,accountId,peer}){
  if(!exactStartMarker(marker))throw Error('INVALID_WEB_SESSION_MARKER');
  if(!peer?.userId || peer.userId!==peer.chatId)throw Error('SESSION_EXACT_PAIRED_DM_REQUIRED');
  if(!Array.isArray(updates))throw Error('INVALID_ACTIVATION_BATCH');
  // A prior image must not block the explicit start marker. Validate the
  // whole batch before any cursor or SQLite mutation; only pure text may arm.
  for(const raw of updates){
    if(raw?.from_user_id!==peer.userId)throw Error('UNEXPECTED_ACTIVATION_SENDER');
  }
  const planned=partitionPostFenceBatch(updates,accountId,peer);
  let matches=0;
  for(const raw of planned.text){
    if(raw.item_list[0].text_item.text===marker)matches++;
  }
  if(matches>1)throw Error('MULTIPLE_START_MARKERS_NO_CURSOR_CHANGE');
  if(matches===0)return {found:false,count:updates.length,updates:[]};
  return {found:true,count:updates.length,updates,unsupported:planned.unsupported};
}

export function archiveActivationBatch({store,adapter,updates,marker,accountId,peer}){
  const selected=selectActivationBatch(updates,{marker,accountId,peer});
  if(!selected.found)throw Error('WEB_SESSION_MARKER_NOT_IN_BATCH');
  if(!store?.db || !adapter?.ingestRaw ||
     (selected.unsupported.length && typeof store.quarantineUnsupportedInbound!=='function'))
    throw Error('ARCHIVE_DEPENDENCIES_REQUIRED');
  let newDeferred=0,existingSafe=0,unsupportedNew=0,unsupportedExisting=0;
  const unsupportedByKey=new Map(selected.unsupported.map(
    record=>[accountId+':'+record.messageId,record]));
  // The start-marker batch is one atomic archival unit. Do not acknowledge a
  // Weixin cursor until every old text and unsupported item is durably covered.
  store.db.exec('BEGIN IMMEDIATE');
  try{
    for(const raw of selected.updates){
      const key=accountId+':'+getInboundMessageId(raw);
      const unsupported=(raw.item_list.length!==1||raw.item_list[0].type!==1)
        ?unsupportedByKey.get(key):null;
      if(unsupported){
        const held=store.quarantineUnsupportedInbound(unsupported);
        if(held.newlyRecorded)unsupportedNew++;
        else unsupportedExisting++;
        continue;
      }
      const parsed=normalizeInbound(raw,accountId);
      const prior=store.getByInboundKey(accountId+':'+parsed.messageId);
      if(raw.item_list?.[0]?.text_item?.text===marker && prior)throw Error('SESSION_MARKER_ALREADY_STORED');
      if(prior && !SAFE_PRIOR.has(prior.status))throw Error('ARCHIVE_PREEXISTING_EVENT_NOT_TERMINAL');
      const accepted=adapter.ingestRaw(raw);
      if(!accepted?.accepted || !accepted.event)throw Error('ARCHIVE_INBOUND_REJECTED');
      if(prior){existingSafe++;continue;}
      store.deferBacklog(accepted.event.id);
      newDeferred++;
    }
    store.db.exec('COMMIT');
  }catch(error){
    store.db.exec('ROLLBACK');
    throw error;
  }
  const result={deferredNew:newDeferred,existingSafe,total:selected.count};
  if(selected.unsupported.length)
    Object.assign(result,{unsupportedNew,unsupportedExisting});
  return result;
}

// Validate an entire batch before changing durable state or acknowledging a cursor.
// Only clearly classified unsupported items from the exact paired peer can be
// quarantined; malformed text and unknown envelopes still fail closed.
export function partitionPostFenceBatch(updates,accountId,peer){
  if(!Array.isArray(updates))throw Error('INVALID_SESSION_BATCH');
  if(!peer?.userId||peer.userId!==peer.chatId)throw Error('SESSION_EXACT_PAIRED_DM_REQUIRED');
  const text=[],unsupported=[];
  for(const raw of updates){
    if(raw?.from_user_id!==peer.userId)throw Error('UNEXPECTED_SESSION_SENDER');
    const rejection=directEnvelopeRejection(raw,accountId);
    if(rejection)throw Error('INBOUND_'+rejection.toUpperCase());
    const items=raw?.item_list;
    if(!Array.isArray(items)||items.length<1||items.length>8)
      throw Error('SESSION_ITEMS_MALFORMED');
    if(items.length===1&&items[0]?.type===1){
      const parsed=normalizeInbound(raw,accountId);
      if(parsed.chatId!==peer.chatId)throw Error('SESSION_PEER_MISMATCH');
      text.push(raw);
      continue;
    }
    // Only observed image type 2 is classified for no-reply quarantine.
    // Unknown media types must keep the cursor uncommitted for review.
    if(!items.every(item=>item?.type===1||item?.type===2)||
       !items.some(item=>item.type===2))
      throw Error('SESSION_ITEMS_UNCLASSIFIED');
    const messageId=getInboundMessageId(raw);
    if(typeof messageId!=='string'||!/^[A-Za-z0-9@._:-]{1,256}$/.test(messageId))
      throw Error('SESSION_UNSUPPORTED_MESSAGE_ID_INVALID');
    unsupported.push({
      accountId,fromUserId:peer.userId,chatId:peer.chatId,messageId,
      kind:items.length===1?'NON_TEXT_ITEM':'MIXED_ITEM_TYPES'
    });
  }
  return {text,unsupported};
}

export function assertPostFenceBatch(updates,accountId,peer){
  const result=partitionPostFenceBatch(updates,accountId,peer);
  if(result.unsupported.length)throw Error('SESSION_UNSUPPORTED_ITEMS_REQUIRE_QUARANTINE');
  return true;
}
