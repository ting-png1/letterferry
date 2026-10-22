import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ProtectedAuthStore } from '../src/auth-store.mjs';
import { AdapterStore } from '../src/store.mjs';
import { AllowlistPolicy } from '../src/policy.mjs';
import { ExistingBridgeClient } from '../src/bridge-client.mjs';
import { RealWeixinTransport } from '../src/transports/real-weixin.mjs';
import { WeixinBridgeAdapter } from '../src/adapter.mjs';
import { loadEncryptionKey } from '../src/secrets.mjs';

export const SESSION_DURATION_MS = 60 * 60_000;
export const SESSION_MAX_ACCEPTED = 20;

export function selectSessionDuration(env = process.env) {
  const minutes = env.RIVEN_WEIXIN_SESSION_MINUTES ?? '60';
  if (minutes !== '30' && minutes !== '60') throw new Error('SESSION_DURATION_NOT_ALLOWED');
  return Number(minutes) * 60_000;
}
export const BRIDGE_TEXT_LIMIT = 2000;
const POLL_RESERVE_MS = 36_000;
export const BRIDGE_PENDING_LIMIT_MS = 10 * 60_000;
const OPERATION_RESERVE_MS = 16_000;
const BRIDGE_REQUEST_TIMEOUT_MS = 8_000;
const SAFE_EXISTING = new Set(['SUCCEEDED', 'REVIEWED_NO_REPLAY', 'DEFERRED_BACKLOG', 'RECEIVED', 'BRIDGE_QUEUED', 'REPLY_READY']);

function safeCode(error, fallback = 'WEIXIN_SESSION_FAILED') {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z0-9_:-]{1,160}$/.test(message) ? message : fallback;
}

export function loadSessionBinding(filename = resolve('data/weixin-runtime.json')) {
  let config;
  try { config = JSON.parse(readFileSync(filename, 'utf8')); }
  catch { throw new Error('SESSION_RUNTIME_CONFIG_REQUIRED'); }
  if (!config?.allowedPeer?.userId || config.allowedPeer.chatId !== config.allowedPeer.userId) {
    throw new Error('SESSION_EXACT_SINGLE_BINDING_REQUIRED');
  }
  if (config.inboundEnabled !== false || config.outboundEnabled !== false) {
    throw new Error('SESSION_PERSISTENT_CAPABILITIES_MUST_BE_DISABLED');
  }
  return { allowedPeer: { userId: config.allowedPeer.userId, chatId: config.allowedPeer.chatId } };
}

function auditStartup(events) {
  for (const event of events) {
    if (event.status === 'OUTBOUND_SENDING' || event.status === 'OUTBOUND_UNKNOWN') {
      throw new Error('SESSION_AMBIGUOUS_OUTBOUND_REQUIRES_REVIEW');
    }
    if (!SAFE_EXISTING.has(event.status)) throw new Error('SESSION_UNKNOWN_STATUS_REQUIRES_REVIEW');
  }
}

export function enforceBridgeLimit(bridge) {
  return {
    async enqueue(input) {
      if (typeof input?.text !== 'string' || input.text.length > BRIDGE_TEXT_LIMIT) {
        throw new Error('BRIDGE_TEXT_LIMIT_EXCEEDED');
      }
      return bridge.enqueue(input);
    },
    getEvent: (eventId) => bridge.getEvent(eventId),
  };
}

function result(reason, state) {
  return {
    completed: true,
    reason,
    acceptedUnique: state.acceptedUnique,
    duplicateAccepted: state.duplicateAccepted,
    pollTimeouts: state.pollTimeouts,
    bridgeQueued: state.bridgeQueued,
    repliesSent: state.repliesSent,
    persistentCapabilityFlagsChanged: false,
  };
}

/**
 * Runs one bounded foreground session. Dependencies and limits are injectable only
 * so the state machine can be verified offline; the CLI supports only fixed
 * 30- or 60-minute / 20-message production limits.
 */
export async function runBoundedSession({
  adapter, store, signal,
  clock = () => Date.now(),
  sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  durationMs = SESSION_DURATION_MS,
  maxAccepted = SESSION_MAX_ACCEPTED,
  pollReserveMs = POLL_RESERVE_MS,
  bridgePendingLimitMs = BRIDGE_PENDING_LIMIT_MS,
  operationReserveMs = OPERATION_RESERVE_MS,
  idleDelayMs = 1000,
  onProgress = () => {},
  onPending = async () => {},
  beforeSend = async () => {},
  beforeEnqueue = async () => {},
} = {}) {
  if (!adapter || !store) throw new Error('SESSION_DEPENDENCIES_REQUIRED');
  auditStartup(store.list());
  const started = clock();
  const deadline = started + durationMs;
  const knownIds = new Set(store.list().map((event) => event.id));
  const pendingSince = new Map();
  const state = { acceptedUnique: 0, duplicateAccepted: 0, pollTimeouts: 0, bridgeQueued: 0, repliesSent: 0 };

  while (true) {
    const now = clock();
    if (signal?.aborted) return result('CANCELLED', state);
    if (now >= deadline) return result('DEADLINE', state);

    const ambiguous = store.list().find((event) => ['OUTBOUND_SENDING', 'OUTBOUND_UNKNOWN'].includes(event.status));
    if (ambiguous) throw new Error('SESSION_AMBIGUOUS_OUTBOUND_REQUIRES_REVIEW');

    const queued = store.next('BRIDGE_QUEUED');
    if (queued) {
      if (deadline - clock() < operationReserveMs) return result('DEADLINE', state);
      const firstSeen = pendingSince.get(queued.id) ?? now;
      pendingSince.set(queued.id, firstSeen);
      const collected = await adapter.collectOneReply();
      if (collected?.status === 'BRIDGE_QUEUED') {
        await onPending({event:queued,elapsedMs:Math.max(0,clock()-firstSeen)});
        if (clock() - firstSeen >= bridgePendingLimitMs) return result('BRIDGE_PENDING_TIMEOUT', state);
        // Never long-poll Weixin while awaiting a ChatGPT browser answer. A poll
        // can block for 35 seconds, delaying a reply already finished in the browser.
        await sleep(Math.min(idleDelayMs, Math.max(0, deadline - clock())));
        continue;
      } else if (collected?.status === 'REPLY_READY') pendingSince.delete(queued.id);
    }

    const ready = store.next('REPLY_READY');
    if (ready) {
      const privateReady = store.getPrivate(ready.id);
      if (typeof privateReady?.reply_text !== 'string' || !privateReady.reply_text.trim()) {
        throw new Error('SESSION_INVALID_READY_REPLY');
      }
      if (privateReady.reply_text.trim().length > BRIDGE_TEXT_LIMIT) {
        return result('REPLY_TEXT_LIMIT_EXCEEDED', state);
      }
      if (deadline - clock() < operationReserveMs) return result('DEADLINE', state);
      await beforeSend();
      const sent = await adapter.sendOneReply();
      if (sent?.status !== 'SUCCEEDED') throw new Error('SESSION_SEND_DID_NOT_COMPLETE');
      state.repliesSent++;
      onProgress({kind:'REPLY_SENT',count:state.repliesSent});
    }

    const received = store.next('RECEIVED');
    if (received) {
      if (deadline - clock() < operationReserveMs) return result('DEADLINE', state);
      await beforeEnqueue();
      const queuedEvent = await adapter.submitOneToBridge();
      if (queuedEvent?.status !== 'BRIDGE_QUEUED') throw new Error('SESSION_BRIDGE_QUEUE_DID_NOT_COMPLETE');
      state.bridgeQueued++;
      onProgress({kind:'BRIDGE_QUEUED',count:state.bridgeQueued});
      // Collect this pending browser reply before asking Weixin for more updates.
      continue;
    }

    if (state.acceptedUnique >= maxAccepted) {
      const inflight = store.list().some((event) => !['SUCCEEDED','REVIEWED_NO_REPLAY','DEFERRED_BACKLOG'].includes(event.status));
      if (!inflight) return result('MESSAGE_LIMIT_DRAINED', state);
      await sleep(Math.min(idleDelayMs, Math.max(0, deadline - clock())));
      continue;
    }

    if (deadline - clock() < pollReserveMs) return result('DEADLINE', state);
    let rawUpdates;
    try { rawUpdates = await adapter.transport.poll(); }
    catch (error) {
      if (safeCode(error) === 'GETUPDATES_TIMEOUT') {
        state.pollTimeouts++;
        continue;
      }
      throw error;
    }
    let fullyIngested = true;
    const incoming = [];
    for (const raw of rawUpdates) {
      if (state.acceptedUnique >= maxAccepted) {
        fullyIngested = false;
        break;
      }
      const item = adapter.ingestRaw(raw);
      incoming.push(item);
      if (!item?.accepted) continue;
      if (knownIds.has(item.event.id)) state.duplicateAccepted++;
      else { knownIds.add(item.event.id); state.acceptedUnique++; }
    }
    if (fullyIngested && typeof adapter.transport.commitPoll === 'function') await adapter.transport.commitPoll();
    if (incoming.length > 0) continue; // process accepted messages before the next long poll
    await sleep(Math.min(idleDelayMs, Math.max(0, deadline - clock())));
  }
}

async function main() {
  const durationMs = selectSessionDuration();
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('FOREGROUND_TTY_REQUIRED');
  const binding = loadSessionBinding();
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write('Arm the LetterFerry Chat Bridge Fixed Listener v7 Continuous separately in chat. The Host is not a background API.\n');
    const approval = await rl.question(`Foreground only: up to ${durationMs / 60_000} minutes / 20 new messages. Type START_WEIXIN_SESSION to continue: `);
    if (approval !== 'START_WEIXIN_SESSION') throw new Error('SESSION_NOT_APPROVED');
  } finally { rl.close(); }

  const authStore = new ProtectedAuthStore();
  const auth = await authStore.load();
  const encryptionKey = loadEncryptionKey();
  let store;
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once('SIGINT', onInterrupt);
  try {
    store = new AdapterStore(resolve('data/adapter.sqlite'));
    const policy = new AllowlistPolicy({ accountId: auth.accountId, allowedPeers: [binding.allowedPeer] });
    const transport = new RealWeixinTransport({ authStore, allowedPeer: binding.allowedPeer,
      inboundEnabled: true, outboundEnabled: true });
    const boundedBridgeFetch = (url, options = {}) => fetch(url, {
      ...options,
      signal: AbortSignal.timeout(BRIDGE_REQUEST_TIMEOUT_MS),
    });
    const bridge = enforceBridgeLimit(new ExistingBridgeClient({
      origin: process.env.CHATGPT_BRIDGE_ORIGIN,
      fetchImpl: boundedBridgeFetch,
    }));
    const adapter = new WeixinBridgeAdapter({ accountId: auth.accountId, policy, store, transport,
      bridge, encryptionKey });
    const summary = await runBoundedSession({ adapter, store, signal: controller.signal, durationMs });
    stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    store?.close();
    encryptionKey.fill(0);
  }
}

const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntryPoint) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`${safeCode(error)}\n`);
    process.exitCode = 1;
  }
}
