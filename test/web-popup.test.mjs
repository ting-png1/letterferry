import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../web-extension/popup.js',import.meta.url),'utf8');
function setup({holdInspect=false,holdArm=false}={}){
 const controls=Object.fromEntries(['status','save','bind','arm','stop','inspect','statusCheck','key'].map(x=>[x,{textContent:'',value:'',onclick:null}]));
 const calls=[],timers=new Map();let nextTimer=0,resolveInspect,resolveArm;
 const chrome={runtime:{sendMessage(message){
  calls.push(message.command);
  if(message.command==='arm'&&holdArm)
   return new Promise(resolve=>{resolveArm=resolve;});
  if(message.command==='inspect'&&holdInspect)
   return new Promise(resolve=>{resolveInspect=resolve;});
  return Promise.resolve({message:'STATUS_READY'});
 }}};
 vm.runInNewContext(source,{chrome,document:{getElementById:id=>controls[id]},
  setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,ms});return id;},
  clearTimeout(id){timers.delete(id);}});
 return {controls,calls,timers,answerInspect:value=>resolveInspect({message:value}),
  answerArm:value=>resolveArm({message:value}),
  fireTimeout:()=>{for(const [id,timer]of [...timers]){timers.delete(id);timer.fn();}}};
}
test('inspect click immediately reports progress and times out without sending messages',async()=>{
 const f=setup({holdInspect:true});
 await Promise.resolve();
 const pending=f.controls.inspect.onclick();
 assert.match(f.controls.status.textContent,/正在检查页面结构/);
 assert.deepEqual(f.calls,['status','inspect']);
 assert.equal([...f.timers.values()].some(x=>x.ms===6000),true);
 f.fireTimeout();
 await pending;
 assert.match(f.controls.status.textContent,/检查超时/);
 assert.equal(f.calls.filter(x=>x==='inspect').length,1);
 f.answerInspect('VERY_LATE_SURVEY');
 await Promise.resolve();
 assert.doesNotMatch(f.controls.status.textContent,/VERY_LATE_SURVEY/);
});
test('older status result cannot overwrite a pending inspection',async()=>{
 const f=setup({holdInspect:true});
 const pending=f.controls.inspect.onclick();
 assert.match(f.controls.status.textContent,/正在检查页面结构/);
 await Promise.resolve();
 assert.match(f.controls.status.textContent,/正在检查页面结构/);
 f.fireTimeout();await pending;
 assert.match(f.controls.status.textContent,/检查超时/);
});
test('hung start button responds immediately, prevents duplicate command and treats timeout as unknown',async()=>{
 const f=setup({holdArm:true});
 const first=f.controls.arm.onclick();
 assert.match(f.controls.status.textContent,/正在启动网页接收/);
 assert.equal(f.calls.filter(x=>x==='arm').length,1);
 await f.controls.arm.onclick();
 assert.equal(f.calls.filter(x=>x==='arm').length,1);
 assert.match(f.controls.status.textContent,/请勿重复点击/);
 assert.equal([...f.timers.values()].some(x=>x.ms===10000),true);
 f.fireTimeout();
 await first;
 assert.match(f.controls.status.textContent,/结果未知/);
 f.answerArm('VERY_LATE_ARM_REPLY');
 await Promise.resolve();
 assert.doesNotMatch(f.controls.status.textContent,/VERY_LATE_ARM_REPLY/);
});
test('hung status check times out and leaves a visible diagnostic',async()=>{
 const f=setup({holdInspect:true});
 const pending=f.controls.inspect.onclick();
 f.fireTimeout();await pending;
 assert.match(f.controls.status.textContent,/检查超时/);
});
test('normal popup inspection shows response and clears timeout',async()=>{
 const f=setup();
 const pending=f.controls.inspect.onclick();
 assert.match(f.controls.status.textContent,/正在检查/);
 await pending;
 assert.equal(f.controls.status.textContent,'STATUS_READY');
 assert.equal(f.timers.size,0);
});
