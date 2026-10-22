import test from 'node:test';
import assert from 'node:assert/strict';
import {reconnectDecision} from '../src/reconnect-policy.mjs';
const base={enabled:true,paused:false,daemonRunning:true,hostRunning:true,
 hostResponds:true,hostState:'HOST_READY',unresolved:false};
test('healthy live chat is untouched by reconnect action',()=>{
 assert.equal(reconnectDecision(base),'ALREADY_CONNECTED');
 assert.equal(reconnectDecision({...base,hostState:'HOST_UNVERIFIED',unresolved:false}),'BROWSER_BUSY_OR_WAITING');
});
test('owner pause and disable always take precedence',()=>{
 assert.equal(reconnectDecision({...base,paused:true}),'PAUSED_BY_OWNER');
 assert.equal(reconnectDecision({...base,enabled:false}),'DISABLED_BY_OWNER');
 assert.equal(reconnectDecision({...base,enabled:false,daemonRunning:false,hostRunning:false}),'DISABLED_BY_OWNER');
});
test('unresolved tasks cannot masquerade as already connected or merely a busy browser',()=>{
 assert.equal(reconnectDecision({...base,unresolved:true}),'UNRESOLVED_DELIVERY_REVIEW_REQUIRED');
 assert.equal(reconnectDecision({...base,hostState:'HOST_UNVERIFIED',unresolved:true}),
   'UNRESOLVED_DELIVERY_REVIEW_REQUIRED');
 assert.equal(reconnectDecision({...base,daemonRunning:true,hostResponds:true,unresolved:true}),
   'UNRESOLVED_DELIVERY_REVIEW_REQUIRED');
 assert.equal(reconnectDecision({...base,enabled:false,unresolved:true}),'DISABLED_BY_OWNER');
 assert.equal(reconnectDecision({...base,paused:true,unresolved:true}),'PAUSED_BY_OWNER');
});

test('incomplete delivery always prevents new services from being spawned',()=>{
 assert.equal(reconnectDecision({...base,daemonRunning:false,unresolved:true}),'UNRESOLVED_DELIVERY_REVIEW_REQUIRED');
 assert.equal(reconnectDecision({...base,hostRunning:false,hostResponds:false,hostState:'HOST_OFFLINE',unresolved:true}),'UNRESOLVED_DELIVERY_REVIEW_REQUIRED');
});
test('only truly missing processes may be started',()=>{
 assert.equal(reconnectDecision({...base,daemonRunning:false}),'START_MISSING_DAEMON');
 assert.equal(reconnectDecision({...base,hostRunning:false,hostResponds:false,hostState:'HOST_OFFLINE'}),'START_MISSING_HOST');
 assert.equal(reconnectDecision({...base,hostRunning:false,daemonRunning:false,hostResponds:false,hostState:'HOST_OFFLINE'}),'START_MISSING_DAEMON');
 assert.equal(reconnectDecision({...base,hostResponds:false,hostState:'HOST_OFFLINE'}),'HOST_PROCESS_UNRESPONSIVE');
 assert.equal(reconnectDecision({...base,hostRunning:false}),'UNRECOGNIZED_LOCAL_HOST_PROCESS');
});
