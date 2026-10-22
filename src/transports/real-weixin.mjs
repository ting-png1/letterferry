import { randomBytes } from 'node:crypto';
import { canonicalDirectChatId, directEnvelopeRejection } from '../policy.mjs';

export const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const PROTOCOL_CLIENT_VERSION = '2.4.10';
const BOT_AGENT = 'LetterFerry/0.4.3';
const LONG_POLL_TIMEOUT_MS = 35_000;
const SEND_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ID = /^[A-Za-z0-9@._:-]{1,256}$/;

function clientVersionNumber(version = PROTOCOL_CLIENT_VERSION) {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error('INVALID_PROTOCOL_CLIENT_VERSION');
  }
  return ((parts[0] & 0xff) << 16) | ((parts[1] & 0xff) << 8) | (parts[2] & 0xff);
}

function baseInfo() {
  return { channel_version: PROTOCOL_CLIENT_VERSION, bot_agent: BOT_AGENT };
}

function randomWechatUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
}

function commonHeaders({ token } = {}) {
  const headers = {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(clientVersionNumber()),
  };
  if (token !== undefined) {
    headers['content-type'] = 'application/json';
    headers.AuthorizationType = 'ilink_bot_token';
    headers['X-WECHAT-UIN'] = randomWechatUin();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function validPeer(peer) {
  return peer && ID.test(peer.userId || '') && peer.chatId === peer.userId;
}

export function validateApiBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('INVALID_API_BASE_URL'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('INVALID_API_BASE_URL');
  }
  if (host !== 'ilinkai.weixin.qq.com' && !host.endsWith('.weixin.qq.com')) throw new Error('API_HOST_NOT_ALLOWED');
  url.pathname = '';
  return url.toString().replace(/\/$/, '');
}

export function redirectHostToBaseUrl(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(value) || value.includes('..')) {
    throw new Error('INVALID_REDIRECT_HOST');
  }
  return validateApiBaseUrl(`https://${value}`);
}

export function buildGetUpdatesRequest(cursor = '') {
  if (typeof cursor !== 'string') throw new Error('INVALID_CURSOR');
  return { path: '/ilink/bot/getupdates', method: 'POST', body: { get_updates_buf: cursor, base_info: baseInfo() } };
}

export function buildGetTypingTicketRequest({toUserId,contextToken}) {
  if(!ID.test(toUserId||'') || typeof contextToken!=='string'||!contextToken)
    throw Error('TYPING_CONFIG_REQUEST_INVALID');
  return {path:'/ilink/bot/getconfig',method:'POST',body:{
    ilink_user_id:toUserId,context_token:contextToken,base_info:baseInfo()
  }};
}

export function buildSendTypingRequest({toUserId,typingTicket,status}) {
  if(!ID.test(toUserId||'') || typeof typingTicket!=='string'||!typingTicket ||
    ![1,2].includes(status))throw Error('TYPING_REQUEST_INVALID');
  return {path:'/ilink/bot/sendtyping',method:'POST',body:{
    ilink_user_id:toUserId,typing_ticket:typingTicket,status,base_info:baseInfo()
  }};
}

export function buildSendTextRequest({ toUserId, clientId, contextToken, text }) {
  if (![toUserId, clientId, contextToken, text].every((value) => typeof value === 'string' && value.length > 0)) throw new Error('INCOMPLETE_SEND_REQUEST');
  return { path: '/ilink/bot/sendmessage', method: 'POST', body: { msg: {
    from_user_id: '', to_user_id: toUserId, client_id: clientId, message_type: 2, message_state: 2,
    context_token: contextToken, item_list: [{ type: 1, text_item: { text } }]
  }, base_info: baseInfo() } };
}

async function readJson(response, label) {
  if (!response?.ok) throw new Error(`${label}_HTTP_${response?.status ?? 'UNKNOWN'}`);
  const responseText = await response.text();
  if (Buffer.byteLength(responseText, 'utf8') > MAX_RESPONSE_BYTES) throw new Error(`${label}_RESPONSE_TOO_LARGE`);
  try { return parseWeixinApiJson(responseText); } catch { throw new Error(`${label}_INVALID_JSON`); }
}

const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);

export function parseWeixinApiJson(rawText) {
  let output = '';
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') { output += rawText[index++]; continue; }
    const start = index++;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index++];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') break;
    }
    const token = rawText.slice(start, index);
    output += token;
    let cursor = index;
    while (/\s/.test(rawText[cursor] || '')) cursor++;
    if (rawText[cursor] !== ':') continue;
    let key;
    try { key = JSON.parse(token); } catch { continue; }
    if (!LOSSLESS_ID_FIELDS.has(key)) continue;
    output += rawText.slice(index, cursor + 1);
    cursor++;
    while (/\s/.test(rawText[cursor] || '')) output += rawText[cursor++];
    const numberStart = cursor;
    if (rawText[cursor] === '-') cursor++;
    while (/\d/.test(rawText[cursor] || '')) cursor++;
    if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === '-')) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else index = numberStart;
  }
  return JSON.parse(output);
}

export function normalizeGetUpdatesResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('GETUPDATES_INVALID_RESPONSE');
  if ((body.ret !== undefined && body.ret !== 0) || (body.errcode !== undefined && body.errcode !== 0)) {
    throw new Error(`GETUPDATES_REJECTED_${body.ret ?? body.errcode}`);
  }
  const messages = body.msgs == null ? [] : body.msgs;
  if (!Array.isArray(messages)) throw new Error('GETUPDATES_INVALID_MESSAGES');
  const rawCursor = body.get_updates_buf;
  if (rawCursor !== undefined && rawCursor !== null && typeof rawCursor !== 'string') throw new Error('GETUPDATES_INVALID_CURSOR');
  return { messages, nextCursor: typeof rawCursor === 'string' && rawCursor ? rawCursor : null };
}

async function fetchJson(fetchImpl, url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
    return await readJson(response, label);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${label}_TIMEOUT`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class RealWeixinTransport {
  constructor({ authStore, allowedPeer, inboundEnabled = false, outboundEnabled = false, fetchImpl = fetch }) {
    if (!authStore || typeof authStore.load !== 'function' || typeof authStore.updateCursor !== 'function') throw new Error('AUTH_STORE_REQUIRED');
    if (!validPeer(allowedPeer)) throw new Error('EXACT_ALLOWED_PEER_REQUIRED');
    this.authStore = authStore;
    this.allowedPeer = { ...allowedPeer };
    this.inboundEnabled = inboundEnabled === true;
    this.outboundEnabled = outboundEnabled === true;
    this.fetch = fetchImpl;
    this.pendingCursor = null;
  }

  static feasibility() {
    return { baseUrl: FIXED_BASE_URL, protocolMapped: true, qrLoginImplemented: true, networkEnabled: 'explicit-gates', liveEligible: false };
  }

  async poll() {
    if (!this.inboundEnabled) return [];
    if (this.pendingCursor !== null) throw new Error('POLL_CURSOR_NOT_COMMITTED');
    const auth = await this.authStore.load();
    const baseUrl = validateApiBaseUrl(auth.baseUrl);
    const request = buildGetUpdatesRequest(auth.cursor || '');
    const body = await fetchJson(this.fetch, new URL(request.path, `${baseUrl}/`), {
      method: request.method,
      headers: commonHeaders({ token: auth.botToken }),
      body: JSON.stringify(request.body),
    }, LONG_POLL_TIMEOUT_MS, 'GETUPDATES');
    const normalized = normalizeGetUpdatesResponse(body);
    this.pendingCursor = normalized.nextCursor;
    return normalized.messages.filter((message) => directEnvelopeRejection(message, auth.accountId) === null
      && message.from_user_id === this.allowedPeer.userId
      && canonicalDirectChatId(message.from_user_id) === this.allowedPeer.chatId);
  }

  async commitPoll() {
    if (this.pendingCursor === null) return;
    const cursor = this.pendingCursor;
    await this.authStore.updateCursor(cursor);
    this.pendingCursor = null;
  }

  async getTypingTicket({toUserId,contextToken}) {
    if (!this.outboundEnabled) throw Error('OUTBOUND_CAPABILITY_DISABLED');
    if (toUserId!==this.allowedPeer.userId)throw Error('TYPING_PEER_NOT_ALLOWED');
    const auth=await this.authStore.load();
    const req=buildGetTypingTicketRequest({toUserId,contextToken});
    const body=await fetchJson(this.fetch,new URL(req.path,validateApiBaseUrl(auth.baseUrl)+'/'),{
      method:req.method,headers:commonHeaders({token:auth.botToken}),body:JSON.stringify(req.body)
    },4000,'GETCONFIG');
    if((body.ret!==undefined&&body.ret!==0)||(body.errcode!==undefined&&body.errcode!==0))
      throw Error('GETCONFIG_REJECTED');
    if(typeof body.typing_ticket!=='string'||!body.typing_ticket||body.typing_ticket.length>4096)
      throw Error('TYPING_TICKET_MISSING');
    return body.typing_ticket;
  }

  async sendTyping({toUserId,typingTicket,status}) {
    if (!this.outboundEnabled) throw Error('OUTBOUND_CAPABILITY_DISABLED');
    if (toUserId!==this.allowedPeer.userId)throw Error('TYPING_PEER_NOT_ALLOWED');
    const auth=await this.authStore.load();
    const req=buildSendTypingRequest({toUserId,typingTicket,status});
    const body=await fetchJson(this.fetch,new URL(req.path,validateApiBaseUrl(auth.baseUrl)+'/'),{
      method:req.method,headers:commonHeaders({token:auth.botToken}),body:JSON.stringify(req.body)
    },4000,'SENDTYPING');
    if((body.ret!==undefined&&body.ret!==0)||(body.errcode!==undefined&&body.errcode!==0))
      throw Error('SENDTYPING_REJECTED');
    return true;
  }

  async sendText(message) {
    if (!this.outboundEnabled) throw new Error('OUTBOUND_CAPABILITY_DISABLED');
    if (message?.toUserId !== this.allowedPeer.userId || message?.chatId !== this.allowedPeer.chatId) throw new Error('OUTBOUND_PEER_NOT_ALLOWED');
    const auth = await this.authStore.load();
    const baseUrl = validateApiBaseUrl(auth.baseUrl);
    const request = buildSendTextRequest(message);
    const body = await fetchJson(this.fetch, new URL(request.path, `${baseUrl}/`), {
      method: request.method,
      headers: commonHeaders({ token: auth.botToken }),
      body: JSON.stringify(request.body),
    }, SEND_TIMEOUT_MS, 'SENDMESSAGE');
    if (body.ret !== undefined && body.ret !== 0) throw new Error(`SENDMESSAGE_REJECTED_${body.ret}`);
    return { accepted: true, messageId: body.message_id === undefined ? null : String(body.message_id) };
  }
}

export const protocolInternalsForTest = { commonHeaders, clientVersionNumber, fetchJson };
