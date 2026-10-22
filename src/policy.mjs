const ID = /^[A-Za-z0-9@._:-]{1,256}$/;

function validId(value) {
  return typeof value === 'string' && ID.test(value);
}

export function canonicalDirectChatId(fromUserId) {
  if (!validId(fromUserId)) throw new Error('INVALID_SENDER_ID');
  return fromUserId;
}

export function directEnvelopeRejection(raw, accountId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid_message';
  if (raw.group_id) return 'group_message';
  if (raw.to_user_id !== undefined && raw.to_user_id !== accountId) return 'wrong_target';
  if (raw.message_type === 2) return 'bot_outbound';
  if (raw.message_type !== undefined && raw.message_type !== 1) return 'unsupported_message_type';
  if (raw.message_state === 1) return 'generating';
  if (raw.message_state !== undefined && raw.message_state !== 0 && raw.message_state !== 2) return 'unsupported_message_state';
  if (!validId(raw.from_user_id)) return 'invalid_sender';
  return null;
}

export function getInboundMessageId(raw) {
  const candidates = [raw?.message_id, ...(Array.isArray(raw?.item_list) ? raw.item_list.map((item) => item?.msg_id) : [])];
  for (const value of candidates) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw new Error('INVALID_MESSAGE_ID_TYPE');
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

export class AllowlistPolicy {
  constructor({ accountId, allowedPeers }) {
    if (!validId(accountId)) throw new Error('INVALID_ACCOUNT_ID');
    if (!Array.isArray(allowedPeers) || allowedPeers.length === 0) throw new Error('ALLOWLIST_REQUIRED');
    if (allowedPeers.length !== 1) throw new Error('PROTOTYPE_REQUIRES_EXACTLY_ONE_PEER');
    this.accountId = accountId;
    this.allowed = new Set(allowedPeers.map((peer) => {
      if (!validId(peer?.userId) || peer?.chatId !== peer.userId) throw new Error('INVALID_ALLOWLIST_ENTRY');
      return `${peer.userId}\u0000${peer.chatId}`;
    }));
  }

  authorize(update) {
    if (update.accountId !== this.accountId) return false;
    return this.allowed.has(`${update.fromUserId}\u0000${update.chatId}`);
  }
}

export function normalizeInbound(raw, accountId) {
  const envelopeRejection = directEnvelopeRejection(raw, accountId);
  if (envelopeRejection) throw new Error(`INBOUND_${envelopeRejection.toUpperCase()}`);
  const fromUserId = raw.from_user_id;
  const chatId = canonicalDirectChatId(fromUserId);
  const messageId = getInboundMessageId(raw);
  if (!validId(accountId) || !validId(fromUserId) || !validId(chatId) || !validId(messageId)) throw new Error('INVALID_IDENTIFIERS');
  const textItems = Array.isArray(raw.item_list)
    ? raw.item_list.filter((item) => item?.type === 1 && typeof item?.text_item?.text === 'string')
    : [];
  if (textItems.length !== 1 || raw.item_list.length !== 1) throw new Error('EXACTLY_ONE_TEXT_ITEM_REQUIRED');
  const text = textItems[0].text_item.text.trim();
  if (!text || text.length > 2000) throw new Error('INVALID_TEXT');
  if (typeof raw.context_token !== 'string' || !raw.context_token) throw new Error('CONTEXT_TOKEN_REQUIRED');
  return { accountId, fromUserId, chatId, messageId, text, contextToken: raw.context_token };
}
