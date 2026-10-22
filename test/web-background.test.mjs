import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const source=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'../web-extension/background.js'),'utf8');
const chat='https://chatgpt.com/g/g-p-test/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function setup({down=false,missingReceiver=false,oneEvent=false,deliverError=null,autoEnabled=false,editorBusyWhileActive=false,taskStatus='BROWSER_SUBMITTED',healthHost='HOST_READY',pendingUnknown=false,ownerMatched=true,surveyNeverReturns=false,preflightNeverReturns=false}={}){
 let listener,alarm,receiverLoaded=!missingReceiver,injections=0,polled=false;
 let tab={id:22,url:chat};
 const session={},local={},calls=[];
 const storage=object=>({
   async get(names){return Object.fromEntries(names.map(name=>[name,object[name]]));},
   async set(values){Object.assign(object,values);}
 });
 const chrome={
   storage:{session:storage(session),local:storage(local)},
   tabs:{
     async get(id){if(id!==tab.id)throw Error('NOT_FOUND');return tab;},
     async query(){return [tab];},
     async sendMessage(_id,message){
       if(!receiverLoaded) throw Error('Could not establish connection. Receiving end does not exist.');
       if(['deliver','start-delivery'].includes(message.action) && deliverError) throw Error(deliverError);
       if(message.action==='preflight'){
         if(preflightNeverReturns)return new Promise(()=>{});
         return {receiverVersion:8,ready:!(editorBusyWhileActive&&session.activeEventId),reason:editorBusyWhileActive&&session.activeEventId?'ASSISTANT_GENERATING':'READY'};
       }
       if(message.action==='survey'){
         if(surveyNeverReturns)return new Promise(()=>{});
         return {receiverVersion:8,ready:true,classicAssistant:0,groupedAssistant:2,groupedUser:3,roleAssistant:2,roleUser:3,lastAssistantBodyNodes:1,lastAssistantRecognizedBody:1,lastAssistantLabelOnly:0,assistantsWithBody:2,assistantBodySampled:2,lastAssistantDescendants:9,lastAssistantBlockElements:1,lastAssistantParentBodyNodes:1};
       }
       if(message.action==='start-delivery')return {accepted:true};
       return {ok:true,reply:'fake response'};
     }
   },
   scripting:{async executeScript({target,files}){
     if(target.tabId!==tab.id || files[0]!=='content.js')throw Error('UNAUTHORIZED_INJECTION');
     injections++;receiverLoaded=true;
   }},
   alarms:{create(){},onAlarm:{addListener(fn){alarm=fn;}}},
   runtime:{onStartup:{addListener(){}},onMessage:{addListener(fn){listener=fn;}}}
 };
 async function fakeFetch(url,options){
   if(down)throw Error('LOCAL_HOST_DOWN');
   const parsed=options.body?JSON.parse(options.body):{};
   const endpoint=new URL(url).pathname;
   calls.push({endpoint,data:parsed});
   const result=endpoint==='/health'
     ? {ok:true,host:healthHost,queue:pendingUnknown?{DELIVERY_UNKNOWN:1}:{}}
     : endpoint==='/extension/owner-status'
     ? {host:healthHost,ownerMatches:ownerMatched,pendingBrowserDelivery:pendingUnknown}
     : endpoint==='/extension/task-status'
     ? {status:taskStatus}
     : endpoint==='/extension/auto-state'
     ? {enabled:autoEnabled,chatUrl:autoEnabled?chat:null}
     : endpoint==='/extension/poll'
     ? {event:(oneEvent&&!polled?(polled=true,{id:'offline-test-event',text:'synthetic harmless text'}):null)}
     : {status:endpoint.endsWith('disarm')?'STOPPED':'HOST_READY'};
   return {ok:true,async json(){return result;}};
 }
 vm.runInNewContext(source,{chrome,URL,fetch:fakeFetch,AbortSignal:{timeout(){return undefined;}},setTimeout(callback,ms){if((ms===4500&&surveyNeverReturns)||(ms===4000&&preflightNeverReturns))queueMicrotask(callback);return 1;},clearTimeout(){}});
 function command(command,payload={},sender={}){return new Promise(resolve=>listener({command,...payload},sender,resolve));}
 return {command,session,local,calls,injections:()=>injections,changeTab(url){tab={id:22,url};},triggerAlarm:()=>alarm?.({name:'bridge-check'}),drain:()=>new Promise(done=>setImmediate(done))};
}
test('background refuses unrelated URL and only binds the explicitly selected conversation',async()=>{
 const f=setup();
 f.changeTab('https://chatgpt.com/');
 assert.match((await f.command('bind')).message,/先切换/);
 f.changeTab('https://example.org/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 assert.match((await f.command('bind')).message,/先切换/);
 f.changeTab(chat);
 assert.match((await f.command('bind')).message,/已绑定/);
 assert.equal(f.session.boundUrl,chat);
 assert.equal(f.session.armed,false);
});
test('background arm requires live localhost Host; stop clears readiness',async()=>{
 const f=setup();
 assert.match((await f.command('save-key',{key:'f'.repeat(64)})).message,/已保存/);
 await f.command('bind');
 const started=await f.command('arm');
 assert.match(started.message,/均已连接/);
 await f.drain();
 assert.equal(f.session.armed,true);
 assert.ok(f.calls.some(c=>c.endpoint==='/extension/heartbeat'));
 const rebinding=await f.command('bind');
 assert.match(rebinding.message,/先停止/);
 const stopped=await f.command('stop');
 await f.drain();
 assert.match(stopped.message,/已停止/);
 assert.equal(f.session.armed,false);
 assert.ok(f.calls.some(c=>c.endpoint==='/extension/disarm'));
});
test('hung receiver preflight fails closed without claiming readiness, injection or heartbeat',async()=>{
 const f=setup({preflightNeverReturns:true});
 f.session.boundTabId=22;f.session.boundUrl=chat;f.session.armed=false;
 await f.command('save-key',{key:'f'.repeat(64)});
 const result=await f.command('arm');
 assert.match(result.message,/页面接收脚本超时/);
 assert.equal(f.session.armed,false);
 assert.equal(f.calls.filter(x=>x.endpoint==='/extension/heartbeat').length,0);
 assert.equal(f.calls.filter(x=>x.endpoint==='/extension/poll').length,0);
 assert.equal(f.injections(),0);
});
test('background fails closed if local Host cannot be contacted',async()=>{
 const f=setup({down:true});
 await f.command('save-key',{key:'f'.repeat(64)});
 await f.command('bind');
 const result=await f.command('arm');
 assert.match(result.message,/启动失败/);
 assert.equal(f.session.armed,false);
});

test('missing receiver on pre-existing ChatGPT tab is injected only after explicit Bind',async()=>{
 const f=setup({missingReceiver:true});
 assert.equal(f.injections(),0);
 const message=await f.command('bind');
 assert.match(message.message,/已绑定/);
 assert.equal(f.injections(),1);
 assert.equal(f.session.boundUrl,chat);
 await f.command('bind');
 assert.equal(f.injections(),1);
});
test('non ChatGPT tab never receives programmatic content script injection',async()=>{
 const f=setup({missingReceiver:true});
 f.changeTab('https://example.org/');
 await f.command('bind');
 assert.equal(f.injections(),0);
});

test('browser receiver failure records a fixed diagnostic without raw exception or retry',async()=>{
 const f=setup({oneEvent:true,deliverError:'Could not establish connection. Receiving end does not exist.'});
 await f.command('save-key',{key:'f'.repeat(64)});
 await f.command('bind');
 await f.command('arm');
 for(let i=0;i<5;i++)await f.drain();
 const failures=f.calls.filter(c=>c.endpoint==='/extension/unknown');
 assert.equal(failures.length,1);
 assert.equal(failures[0].data.id,'offline-test-event');
 assert.equal(failures[0].data.stage,'BROWSER_DELIVERY');
 assert.equal(failures[0].data.code,'BROWSER_RECEIVER_MISSING');
 assert.equal(JSON.stringify(failures[0]).includes('synthetic harmless text'),false);
 assert.equal(f.session.armed,false);
 assert.deepEqual(JSON.parse(JSON.stringify(f.session.lastFailure)),{stage:'BROWSER_DELIVERY',code:'BROWSER_RECEIVER_MISSING'});
 assert.match((await f.command('status')).message,/BROWSER_RECEIVER_MISSING/);
 assert.equal(f.calls.filter(c=>c.endpoint==='/extension/complete').length,0);
});
test('unexpected browser exception is redacted to a fixed error code',async()=>{
 const f=setup({oneEvent:true,deliverError:'failure at https://private.example/token=secret'});
 await f.command('save-key',{key:'f'.repeat(64)});
 await f.command('bind');
 await f.command('arm');
 for(let i=0;i<5;i++)await f.drain();
 const errors=f.calls.filter(c=>c.endpoint==='/extension/unknown');
 assert.equal(errors.length,1);
 assert.equal(errors[0].data.code,'BROWSER_MESSAGE_REJECTED');
 assert.equal(JSON.stringify(errors[0]).includes('private.example'),false);
});

test('read-only page structure inspector is scoped to bound tab, sends no message',async()=>{
 const f=setup();
 assert.match((await f.command('inspect')).message,/先绑定/);
 await f.command('bind');
 const report=await f.command('inspect');
 assert.match(report.message,/新版助手标记：2/);
 assert.match(report.message,/新版用户标记：3/);
 assert.match(report.message,/最新助手正文可提取：1/);
 assert.equal(f.calls.filter(c=>c.endpoint==='/extension/poll').length,0);
 assert.equal(f.session.armed,false);
 f.changeTab('https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
 assert.match((await f.command('inspect')).message,/已变化/);
});

test('read-only connection status distinguishes real local readiness from a Weixin delivery proof',async()=>{
 const f=setup({healthHost:'HOST_READY'});
 await f.command('save-key',{key:'f'.repeat(64)});
 await f.command('bind');
 await f.command('arm');
 for(let n=0;n<8;n++)await f.drain();
 const before=f.calls.length;
 const report=await f.command('status');
 assert.match(report.message,/Host：已收到浏览器心跳/);
 assert.match(report.message,/Host 所属标签页：与本扩展精确匹配/);
 assert.match(report.message,/浏览器页面：接收脚本与页面可用/);
 assert.match(report.message,/本地检查：基础条件正常（尚未验证微信实收）/);
 assert.equal(f.calls.slice(before).every(c=>['/health','/extension/owner-status'].includes(c.endpoint)),true);
 assert.equal(f.calls.slice(before).filter(c=>c.endpoint==='/extension/poll').length,0);
});
test('a Host heartbeat from another owner cannot be reported as locally ready',async()=>{
 const f=setup({healthHost:'HOST_READY',ownerMatched:false});
 await f.command('save-key',{key:'f'.repeat(64)});
 await f.command('bind');await f.command('arm');
 const report=await f.command('status');
 assert.match(report.message,/Host 所属标签页：尚未核验或不匹配/);
 assert.match(report.message,/未完全就绪/);
 assert.equal(f.calls.filter(c=>c.endpoint==='/extension/poll').length,0);
});
test('read-only status warns on unavailable heartbeat or uncertain delivery',async()=>{
 for(const opts of [{healthHost:'HOST_UNVERIFIED'},{pendingUnknown:true}]){
  const f=setup(opts);
  await f.command('save-key',{key:'f'.repeat(64)});
  await f.command('bind');
  await f.command('arm');
  for(let n=0;n<6;n++)await f.drain();
  const report=await f.command('status');
  assert.match(report.message,/未完全就绪/);
  if(opts.healthHost==='HOST_UNVERIFIED')assert.match(report.message,/心跳未验证/);
  if(opts.pendingUnknown)assert.match(report.message,/需要等待或人工核查/);
 }
});
test('read-only status does not inject receiver or expose bound URL and secrets',async()=>{
 const f=setup({missingReceiver:true,healthHost:'HOST_UNVERIFIED'});
 f.session.boundTabId=22;f.session.boundUrl=chat;f.session.armed=true;
 f.local.localBridgeKey='f'.repeat(64);
 const result=await f.command('status');
 assert.equal(f.injections(),0);
 assert.equal(f.calls.filter(c=>c.endpoint==='/extension/poll').length,0);
 assert.match(result.message,/页面接收脚本未响应/);
 assert.equal(result.message.includes(chat),false);
 assert.equal(result.message.includes('f'.repeat(64)),false);
 assert.match(result.message,/未完全就绪/);
});

test('hung page survey returns bounded timeout and does not change listener or send anything',async()=>{
 const f=setup({surveyNeverReturns:true});
 await f.command('bind');
 const before=f.calls.length;
 const result=await f.command('inspect');
 assert.match(result.message,/检查超时/);
 assert.match(result.message,/没有更改监听或发送消息/);
 assert.equal(f.session.armed,false);
 assert.equal(f.calls.slice(before).filter(x=>x.endpoint==='/extension/poll').length,0);
 assert.equal(f.calls.slice(before).filter(x=>x.endpoint==='/extension/complete').length,0);
});

test('autostart restores only the owner-pinned ChatGPT tab after authorized Host confirmation',async()=>{
 const f=setup({autoEnabled:true});
 await f.command('save-key',{key:'f'.repeat(64)});
 f.triggerAlarm();
 for(let n=0;n<8;n++)await f.drain();
 assert.equal(f.session.armed,true);
 assert.equal(f.session.autoManaged,true);
 assert.equal(f.session.boundUrl,chat);
 assert.ok(f.calls.some(c=>c.endpoint==='/extension/auto-state'));
 assert.ok(f.calls.some(c=>c.endpoint==='/extension/heartbeat'));
});
test('auto-managed stale tab is disarmed without replay and can restore only exact pinned URL',async()=>{
 const f=setup({autoEnabled:true});
 await f.command('save-key',{key:'f'.repeat(64)});
 f.triggerAlarm();for(let n=0;n<10;n++)await f.drain();
 assert.equal(f.session.armed,true);
 assert.equal(f.session.autoManaged,true);
 const wrong='https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 f.changeTab(wrong);
 for(let attempt=0;attempt<5&&f.session.armed;attempt++){
  f.triggerAlarm();for(let n=0;n<16;n++)await f.drain();
 }
 assert.equal(f.session.armed,false,JSON.stringify({autoManaged:f.session.autoManaged,active:Boolean(f.session.activeEventId),disarmCount:f.calls.filter(x=>x.endpoint==='/extension/disarm').length,autoChecks:f.calls.filter(x=>x.endpoint==='/extension/auto-state').length}));
 assert.equal(f.session.autoManaged,false);
 assert.equal(f.session.boundTabId,null);
 assert.ok(f.calls.some(x=>x.endpoint==='/extension/disarm'));
 assert.equal(f.calls.filter(x=>x.endpoint==='/extension/unknown').length,0);
 f.changeTab(chat);
 for(let attempt=0;attempt<5&&!f.session.armed;attempt++){
  f.triggerAlarm();for(let n=0;n<16;n++)await f.drain();
 }
 assert.equal(f.session.armed,true);
 assert.equal(f.session.boundUrl,chat);
 assert.equal(f.local.manualAutoPause,undefined);
});

test('stale tab never automatically disarms a possibly submitted active message',async()=>{
 const f=setup({autoEnabled:true,oneEvent:true});
 await f.command('save-key',{key:'f'.repeat(64)});
 f.triggerAlarm();for(let n=0;n<16;n++)await f.drain();
 assert.equal(f.session.activeEventId,'offline-test-event');
 const count=f.calls.filter(x=>x.endpoint==='/extension/disarm').length;
 f.changeTab('https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
 f.triggerAlarm();for(let n=0;n<12;n++)await f.drain();
 assert.equal(f.session.activeEventId,'offline-test-event');
 assert.equal(f.session.armed,true);
 assert.equal(f.calls.filter(x=>x.endpoint==='/extension/disarm').length,count);
 assert.equal(f.calls.filter(x=>x.endpoint==='/extension/unknown').length,0);
});

test('manual Stop blocks automatic re-arming of the same tab',async()=>{
 const f=setup({autoEnabled:true});
 await f.command('save-key',{key:'f'.repeat(64)});
 f.triggerAlarm();
 for(let n=0;n<8;n++)await f.drain();
 assert.equal(f.session.armed,true);
 const stopped=await f.command('stop');
 assert.match(stopped.message,/已停止/);
 assert.equal(f.local.manualAutoPause,true);
 f.triggerAlarm();
 for(let n=0;n<8;n++)await f.drain();
 assert.equal(f.session.armed,false);
});
test('without explicit local always-on consent the extension never self-arms',async()=>{
 const f=setup({autoEnabled:false});
 await f.command('save-key',{key:'f'.repeat(64)});
 f.triggerAlarm();
 for(let n=0;n<8;n++)await f.drain();
 assert.notEqual(f.session.armed,true);
 assert.equal(f.calls.filter(c=>c.endpoint==='/extension/heartbeat').length,0);
});

test('detached browser job records submitted and completes through independent acknowledgement',async()=>{
 const f=setup({oneEvent:true});
 await f.command('save-key',{key:'f'.repeat(64)});
 await f.command('bind');
 await f.command('arm');
 for(let n=0;n<12;n++)await f.drain();
 assert.equal(f.session.activeEventId,'offline-test-event');
 const sender={tab:{id:22}};
 assert.equal((await f.command('submitted',{id:'offline-test-event'},sender)).ok,true);
 assert.equal((await f.command('completed',{id:'offline-test-event',reply:'late real final'},sender)).ok,true);
 assert.equal(f.session.activeEventId,null);
 assert.equal(f.calls.filter(x=>x.endpoint==='/extension/submitted').length,1);
 assert.equal(f.calls.filter(x=>x.endpoint==='/extension/complete').length,1);
 assert.equal(f.calls.filter(x=>x.endpoint==='/extension/unknown').length,0);
});
test('detached active job cannot be completed by wrong tab or retried after browser failure',async()=>{
 const f=setup({oneEvent:true});
 await f.command('save-key',{key:'f'.repeat(64)});
 await f.command('bind');await f.command('arm');
 for(let n=0;n<12;n++)await f.drain();
 assert.equal(f.session.activeEventId,'offline-test-event');
 assert.equal((await f.command('completed',{id:'offline-test-event',reply:'wrong'}, {tab:{id:999}})).ok,false);
 assert.equal((await f.command('delivery-unknown',{id:'offline-test-event',code:'ASSISTANT_TURN_NOT_FOUND'},{tab:{id:22}})).ok,true);
 assert.equal(f.session.activeEventId,null);
 assert.equal(f.session.armed,false);
 assert.equal(f.calls.filter(x=>x.endpoint==='/extension/unknown').length,1);
 assert.equal(f.calls.filter(x=>x.endpoint==='/extension/complete').length,0);
});

test('long async browser work preserves Host heartbeat while editor is busy',async()=>{
 const f=setup({oneEvent:true,editorBusyWhileActive:true});
 await f.command('save-key',{key:'f'.repeat(64)});
 await f.command('bind');await f.command('arm');
 for(let n=0;n<12;n++)await f.drain();
 assert.equal(f.session.activeEventId,'offline-test-event');
 const before=f.calls.filter(x=>x.endpoint==='/extension/heartbeat').length;
 f.triggerAlarm();
 for(let n=0;n<14;n++)await f.drain();
 assert.ok(f.calls.filter(x=>x.endpoint==='/extension/heartbeat').length>before);
 assert.equal(f.calls.filter(x=>x.endpoint==='/extension/poll').length,1);
 assert.equal(f.session.armed,true);
});

test('browser recovers a committed final ACK without submitting the task again',async()=>{
 const f=setup({oneEvent:true,taskStatus:'SUCCEEDED',editorBusyWhileActive:true});
 await f.command('save-key',{key:'f'.repeat(64)});
 await f.command('bind');await f.command('arm');
 for(let n=0;n<12;n++)await f.drain();
 assert.equal(f.session.activeEventId,'offline-test-event');
 f.triggerAlarm();
 for(let n=0;n<15;n++)await f.drain();
 assert.equal(f.session.activeEventId,null);
 assert.equal(f.calls.filter(c=>c.endpoint==='/extension/poll').length,1);
 assert.equal(f.calls.filter(c=>c.endpoint==='/extension/complete').length,0);
 assert.equal(f.calls.filter(c=>c.endpoint==='/extension/unknown').length,0);
});
