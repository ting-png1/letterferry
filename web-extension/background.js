const ROOT='http://127.0.0.1:8799';
let inFlight=false, loopTimer=null, currentEvent=null;
const browserFailureCodes=new Set([
  'STOPPED_AFTER_ASSIGNMENT','PAGE_NOT_READY','PAGE_BUSY','COMPOSER_NOT_EMPTY',
  'INPUT_NOT_ACCEPTED','INPUT_NOT_CONFIRMED','SEND_NOT_READY','SEND_BUTTON_NOT_FOUND','SEND_BUTTON_DISABLED','INVALID_TEXT',
  'BOUND_TAB_NAVIGATED','REPLY_TOO_LONG','ASSISTANT_TURN_NOT_FOUND',
  'REPLY_COMPLETION_UNVERIFIED','ASSISTANT_BODY_NOT_FOUND','SUBMITTED_USER_TURN_NOT_FOUND','BROWSER_RESULT_UNKNOWN'
]);
function failureCode(error){
  const message=typeof error?.message==='string'?error.message:'';
  if(/Receiving end does not exist/i.test(message))return 'BROWSER_RECEIVER_MISSING';
  return browserFailureCodes.has(message)?message:'BROWSER_MESSAGE_REJECTED';
}
const runtime=async()=>await chrome.storage.session.get(['armed','boundTabId','boundUrl','lastFailure','activeEventId','autoManaged']);
const config=async()=>await chrome.storage.local.get(['localBridgeKey']);
function validUrl(url) {try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='chatgpt.com'&&!u.username&&!u.password&&!u.hash&&/^(?:\/c\/|\/g\/[^/]+\/c\/)[0-9a-f-]{36}\/?$/i.test(u.pathname);}catch{return false;}}
async function request(path,data,timeoutMs=15000) {
  const {localBridgeKey}=await config();
  if(!/^[a-f0-9]{64}$/.test(localBridgeKey||'')) throw Error('LOCAL_KEY_MISSING');
  const response=await fetch(ROOT+path,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+localBridgeKey},body:JSON.stringify(data),signal:AbortSignal.timeout(timeoutMs)});
  const result=await response.json();
  if(!response.ok) throw Error(result.error||'LOCAL_BRIDGE_UNAVAILABLE');
  return result;
}
async function receiverPreflight(tabId,boundUrl){
  let timer;
  try{
    return await Promise.race([
      chrome.tabs.sendMessage(tabId,{action:'preflight',boundUrl}),
      new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('RECEIVER_PREFLIGHT_TIMEOUT')),4000);
      })
    ]);
  }finally{if(timer!==undefined)clearTimeout(timer);}
}
async function preflight(tabId,boundUrl) {
  if(!validUrl(boundUrl)) throw Error('INVALID_CHATGPT_TAB');
  const tab=await chrome.tabs.get(tabId);
  if(tab.url!==boundUrl) throw Error('BOUND_TAB_CHANGED');
  let answer;
  try {
    answer=await receiverPreflight(tabId,boundUrl);
  } catch(error) {
    // Existing ChatGPT tabs often predate extension installation; content.js was not injected.
    if(!/Receiving end does not exist/i.test(error?.message||'')) throw error;
    const stillSameTab=await chrome.tabs.get(tabId);
    if(stillSameTab.url!==boundUrl) throw Error('BOUND_TAB_CHANGED');
    try {
      await chrome.scripting.executeScript({target:{tabId,allFrames:false},files:['content.js']});
      answer=await receiverPreflight(tabId,boundUrl);
    } catch {
      throw Error('CHATGPT_SCRIPT_UNAVAILABLE_RELOAD_TAB');
    }
  }
  if(answer?.receiverVersion!==8) throw Error('RECEIVER_STALE_REFRESH_TAB');
  if(!answer.ready){
    const reason=answer?.reason||'UNKNOWN';
    if(reason==='EDITOR_NOT_FOUND') throw Error('EDITOR_NOT_FOUND (editable='+Number(answer.editableCount||0)+', textarea='+Number(answer.textareaCount||0)+', promptId='+Boolean(answer.promptIdFound)+')');
    if(['ASSISTANT_GENERATING','PAGE_BUSY','BOUND_TAB_CHANGED'].includes(reason)) throw Error(reason);
    throw Error('CHATGPT_PAGE_NOT_READY');
  }
  return true;
}
async function target() {
  const {armed,boundTabId,boundUrl}=await runtime();
  if(!armed||!boundTabId||!validUrl(boundUrl)) throw Error('NOT_ARMED');
  await preflight(boundTabId,boundUrl);
  return {tabId:boundTabId,url:boundUrl};
}
function kick() {
  if(loopTimer) clearTimeout(loopTimer);
  loopTimer=setTimeout(()=>{tick().catch(()=>{});},1200);
}
async function tick() {
  if(inFlight)return;
  const {armed}=await runtime();
  if(!armed)return;
  inFlight=true;
  try{
    // A long turn keeps the ChatGPT editor busy: heartbeat must not require
    // a free editor while the exact pinned tab is still generating.
    const active=await runtime();
    let who;
    if(active.activeEventId){
      const tab=await chrome.tabs.get(active.boundTabId);
      if(tab.url!==active.boundUrl)throw Error('BOUND_TAB_CHANGED');
      who={tabId:active.boundTabId,url:active.boundUrl};
    }else who=await target();
    await request('/extension/heartbeat',{...who,ready:true});
    if(active.activeEventId){
      const proof=await request('/extension/task-status',{...who,id:active.activeEventId});
      // Reconcile an ACK lost after a successful durable completion.
      if(proof.status==='SUCCEEDED'){
        await chrome.storage.session.set({activeEventId:null});
        kick();
        return;
      }
      if(['DELIVERY_UNKNOWN','REVIEWED_NO_REPLAY'].includes(proof.status)){
        await chrome.storage.session.set({activeEventId:null,armed:false,
          lastFailure:{stage:'BROKER_ACK',code:'BROWSER_RESULT_UNKNOWN'}});
        return;
      }
    }
    // The content script owns the long model turn. Do not hold this service
    // worker's message response open for minutes: it can be killed mid-turn.
    const session=await runtime();
    if(!session.activeEventId && !currentEvent){
      const result=await request('/extension/poll',who);
      if(result.event){
        currentEvent=result.event.id;
        let stage='BEFORE_BROWSER_SEND';
        try{
          if(!(await runtime()).armed)throw Error('STOPPED_AFTER_ASSIGNMENT');
          // Store the active ID BEFORE handing the irreversible task to the tab.
          await chrome.storage.session.set({activeEventId:result.event.id});
          stage='BROWSER_DELIVERY';
          const ack=await chrome.tabs.sendMessage(who.tabId,{
            action:'start-delivery',id:result.event.id,text:result.event.text,boundUrl:who.url
          });
          if(!ack?.accepted)throw Error(ack?.error||'BROWSER_RESULT_UNKNOWN');
          // Content script reports 'submitted' and 'completed' independently.
        }catch(error){
          const code=failureCode(error);
          try{await request('/extension/unknown',{...who,id:result.event.id,stage,code});}catch{}
          await chrome.storage.session.set({armed:false,lastFailure:{stage,code}});
          // If acknowledgement may have been lost, retain the active ID:
          // never replay an uncertain browser submission.
        }finally{currentEvent=null;}
      }
    }
  }catch{ /* A temporary tab/server outage is not a successful readiness proof. */ }
  finally{
    inFlight=false;
    const state=await runtime();
    if(state.armed) kick();
    else if(!currentEvent && !state.activeEventId && state.boundTabId && state.boundUrl){
      try{await request('/extension/disarm',{tabId:state.boundTabId,url:state.boundUrl});}catch{}
    }
  }
}
let autoBusy=false;
async function autoMaintain(){
 if(autoBusy)return;
 autoBusy=true;
 try{
   let desired;
   try{desired=await request('/extension/auto-state',{});}catch{return;}
   const state=await runtime();
   const existing=await chrome.storage.local.get(['manualAutoPause']);
   // Explicit manual Stop takes precedence over remote auto-start until
   // the owner manually arms again or the local pause control is cleared.
   if(!desired?.enabled || !validUrl(desired?.chatUrl) || existing.manualAutoPause===true){
     if(state.autoManaged && !inFlight && !currentEvent && !state.activeEventId){
       await chrome.storage.session.set({armed:false,autoManaged:false});
       try{await request('/extension/disarm',{tabId:state.boundTabId,url:state.boundUrl});}catch{}
     }
     return;
   }
   if(state.armed){
     // Auto-bound tabs can be closed or navigated while MV3 session state
     // still says armed. Revoke false readiness, but never interrupt an active
     // or possibly-submitted browser delivery.
     if(state.autoManaged && !state.activeEventId && !inFlight && !currentEvent){
       let currentTab;
       try{currentTab=await chrome.tabs.get(state.boundTabId);}catch{}
       let preflightOk=Boolean(currentTab&&currentTab.url===state.boundUrl&&
         state.boundUrl===desired.chatUrl);
       if(preflightOk){try{await preflight(state.boundTabId,state.boundUrl);}
         catch{preflightOk=false;}}
       if(!preflightOk){
         const latest=await runtime();
         if(latest.autoManaged && latest.armed && !latest.activeEventId &&
            !inFlight && !currentEvent && latest.boundTabId===state.boundTabId &&
            latest.boundUrl===state.boundUrl){
           await chrome.storage.session.set({armed:false,autoManaged:false,
             boundTabId:null,boundUrl:null});
           try{await request('/extension/disarm',{
             tabId:state.boundTabId,url:state.boundUrl});}catch{}
         }
         return;
       }
     }
     if(state.autoManaged)tick().catch(()=>{});
     return;
   }
   if(inFlight || currentEvent || state.activeEventId)return;
   // Restore only the URL pinned by the locally authorized always-on config;
   // never select a different ChatGPT conversation by browser tab order.
   let tabs=await chrome.tabs.query({});
   let candidates=tabs.filter(tab=>tab.url===desired.chatUrl);
   if(candidates.length>1)return;
   let selected=candidates[0];
   if(!selected){
     selected=await chrome.tabs.create({url:desired.chatUrl,active:false});
     return; // Wait for actual page load and preflight on the next alarm.
   }
   try{await preflight(selected.id,desired.chatUrl);}catch{return;}
   // Recheck the owner consent after the asynchronous preflight.
   const last=await request('/extension/auto-state',{});
   if(!last.enabled||last.chatUrl!==desired.chatUrl)return;
   await chrome.storage.session.set({armed:true,boundTabId:selected.id,boundUrl:desired.chatUrl,
     autoManaged:true});
   try{
     await request('/extension/heartbeat',{tabId:selected.id,url:desired.chatUrl,ready:true});
   }catch{
     await chrome.storage.session.set({armed:false,autoManaged:false});
     return;
   }
   tick().catch(()=>{});
 }finally{autoBusy=false;}
}
chrome.alarms.create('bridge-check',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='bridge-check')autoMaintain().then(()=>tick()).catch(()=>{});});
chrome.runtime.onStartup.addListener(()=>{
 chrome.storage.session.set({armed:false,autoManaged:false}).then(()=>autoMaintain()).catch(()=>{});
});
chrome.runtime.onInstalled?.addListener?.(()=>autoMaintain().catch(()=>{}));
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
  (async()=>{
    if(m.command==='save-key'){
      if(!/^[a-f0-9]{64}$/.test(m.key||''))return {message:'密钥应为 64 位小写十六进制'};
      await chrome.storage.local.set({localBridgeKey:m.key});return {message:'密钥已保存在扩展本地'};
    }
    if(m.command==='bind'){
      if((await runtime()).armed || (await runtime()).activeEventId || inFlight || currentEvent) return {message:'先停止现有接收并等待当前任务完成，再更换聊天窗口'};
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      if(!tab?.id||!validUrl(tab.url))return {message:'先切换到你要绑定的 chatgpt.com 标签页'};
      try{await preflight(tab.id,tab.url);}
      catch(error){
        const code=error?.message||'UNKNOWN';
        if(['CHATGPT_SCRIPT_UNAVAILABLE_RELOAD_TAB','RECEIVER_STALE_REFRESH_TAB'].includes(code)) return {message:'当前 ChatGPT 标签页的接收脚本需要刷新。请按 Ctrl+R，等页面加载后重新绑定。'};
        if(code==='ASSISTANT_GENERATING') return {message:'ChatGPT 还在生成回复，等结束后再点绑定。'};
        if(code==='PAGE_BUSY') return {message:'这个聊天窗口正在处理其他任务，稍后再试。'};
        if(code.startsWith('EDITOR_NOT_FOUND')) return {message:'页面已连接，但没找到可用的 ChatGPT 输入框。只读结构诊断：'+code+'。请把这行发给 LetterFerry 维护者排查。'};
        return {message:'绑定前检查失败：'+code};
      }
      await chrome.storage.session.set({armed:false,boundTabId:tab.id,boundUrl:tab.url});
      return {message:'已绑定当前标签页；尚未启动监听'};
    }
    if(m.command==='arm'){
      const old=await runtime();
      if(!old.boundTabId)return {message:'请先绑定标签页'};
      if(inFlight||currentEvent||old.activeEventId)
        return {message:'已有任务可能正在处理，未改变监听状态；请等待任务确认，不要重发。'};
      if(!validUrl(old.boundUrl))
        return {message:'原绑定窗口无效，未改变监听状态。'};
      try{
        // First validate the same bound tab and local Host. Do not set armed
        // until both checks finish; a hung receiver cannot imply readiness.
        await preflight(old.boundTabId,old.boundUrl);
        await request('/extension/heartbeat',
          {tabId:old.boundTabId,url:old.boundUrl,ready:true},4500);
      }catch(e){
        const code=e?.message==='RECEIVER_PREFLIGHT_TIMEOUT'?'页面接收脚本超时（4 秒），没有确认连接。'
          :e?.name==='TimeoutError'?'本地 Host 心跳超时，未启动新监听。'
          :'启动失败：'+(e?.message||'UNKNOWN');
        return {message:code+'未发送微信消息。'};
      }
      await chrome.storage.local.set({manualAutoPause:false});
      await chrome.storage.session.set({armed:true,autoManaged:false});
      tick().catch(()=>{});
      return {message:'网页标签页和本地 Host 均已连接；模型回复和微信送达仍待验证'};
    }
    if(m.command==='stop'){
      await chrome.storage.local.set({manualAutoPause:true});
      const prior=await runtime();
      await chrome.storage.session.set({armed:false});
      if(currentEvent || inFlight || prior.activeEventId) return {message:'已停止领取新任务；当前任务可能已发送，等待其完成或人工复核'};
      if(prior.boundTabId && prior.boundUrl){
        try{await request('/extension/disarm',{tabId:prior.boundTabId,url:prior.boundUrl});}
        catch{return {message:'本地 Host 无法确认停止，请检查状态；没有重新发送任何消息'};}
      }
      return {message:'已停止监听，本地 Host 已撤销网页就绪状态'};
    }
    if(m.command==='inspect'){
      const s=await runtime();
      if(!s.boundTabId||!validUrl(s.boundUrl))return {message:'先绑定指定 ChatGPT 对话，再做只读结构检查'};
      const tab=await chrome.tabs.get(s.boundTabId);
      if(tab.url!==s.boundUrl)return {message:'已绑定的聊天窗口已变化，请重新绑定'};
      let survey,timer;
      try{
        survey=await Promise.race([
          chrome.tabs.sendMessage(s.boundTabId,{action:'survey',boundUrl:s.boundUrl}),
          new Promise((_,reject)=>{
            timer=setTimeout(()=>reject(Error('SURVEY_TIMEOUT')),4500);
          })
        ]);
      }catch(error){
        return {message:error?.message==='SURVEY_TIMEOUT'
          ?'检查超时：页面接收脚本未在 4.5 秒内回复。没有更改监听或发送消息。'
          :'页面接收脚本没有响应。请先检查已绑定的 ChatGPT 页面，暂勿重启或重发。'};
      }finally{if(timer!==undefined)clearTimeout(timer);}
      if(survey?.receiverVersion!==8||!survey.ready)return {message:'接收脚本需要刷新，或绑定窗口发生了变化'};
      const safeNumber=name=>Number.isSafeInteger(survey[name])&&survey[name]>=0&&survey[name]<100_000?survey[name]:'?';
      return {message:'只读页面结构诊断（不包含聊天文字）：\n旧版助手标记：'+safeNumber('classicAssistant')+
        '\n新版助手标记：'+safeNumber('groupedAssistant')+
        '\n新版用户标记：'+safeNumber('groupedUser')+
        '\n识别到的助手消息：'+safeNumber('roleAssistant')+
        '\n识别到的用户消息：'+safeNumber('roleUser')+
        '\n最新助手固定正文节点：'+safeNumber('lastAssistantBodyNodes')+
        '\n最新助手可用段落／代码块：'+safeNumber('lastAssistantFallbackBlocks')+
        '\n最新助手正文可提取：'+safeNumber('lastAssistantRecognizedBody')+
        '\n最新助手仅有说话者标签：'+safeNumber('lastAssistantLabelOnly')+
        '\n最近抽样助手消息数：'+safeNumber('assistantBodySampled')+
        '\n抽样中可提取正文的数量：'+safeNumber('assistantsWithBody')+
        '\n最新助手内部元素数：'+safeNumber('lastAssistantDescendants')+
        '\n最新助手段落／块元素数：'+safeNumber('lastAssistantBlockElements')+
        '\n最新助手父容器正文节点数：'+safeNumber('lastAssistantParentBodyNodes')};
    }
    if(m.command==='status'){
      // Read-only diagnostic. No injection, binding, Host POST, or Weixin request.
      const s=await runtime(),k=await config();
      let host='离线',unresolved=false,queueKnown=false,ownerMatched=false;
      const keyOk=/^[a-f0-9]{64}$/.test(k.localBridgeKey||'');
      try{
        const response=await fetch(ROOT+'/health',{
          method:'GET',signal:AbortSignal.timeout(2500)
        });
        if(response.ok){
          const health=await response.json();
          host=health?.ok===true&&health.host==='HOST_READY'?'已收到浏览器心跳':
            health?.ok===true&&health.host==='HOST_UNVERIFIED'?'Host 在线、浏览器心跳未验证':
            '健康状态异常';
          const q=health?.queue||{};
          const knownStates=new Set(['QUEUED','ASSIGNED_UNKNOWN','BROWSER_SUBMITTED',
            'DELIVERY_UNKNOWN','SUCCEEDED','REVIEWED_NO_REPLAY']);
          queueKnown=health?.queue&&typeof health.queue==='object'&&
            !Array.isArray(health.queue)&&Object.entries(q).every(([name,count])=>
              knownStates.has(name)&&Number.isSafeInteger(count)&&count>=0);
          unresolved=!queueKnown||['QUEUED','ASSIGNED_UNKNOWN','BROWSER_SUBMITTED','DELIVERY_UNKNOWN']
            .some(name=>Number.isSafeInteger(q[name])&&q[name]>0);
        }
      }catch{}
      let tab='未绑定';
      if(Number.isSafeInteger(s.boundTabId)&&validUrl(s.boundUrl)){
        try{
          const found=await chrome.tabs.get(s.boundTabId);
          if(found.url!==s.boundUrl)tab='已绑定页面发生变化';
          else if(s.activeEventId)tab='任务处理中（不干扰）';
          else{
            try{
              const check=await chrome.tabs.sendMessage(s.boundTabId,{
                action:'preflight',boundUrl:s.boundUrl
              });
              tab=check?.receiverVersion!==8?'接收脚本版本不匹配':
                check.ready===true?'接收脚本与页面可用':
                ['ASSISTANT_GENERATING','PAGE_BUSY'].includes(check.reason)
                ?'页面正在生成或忙碌':'页面暂未就绪';
            }catch{tab='页面接收脚本未响应';}
          }
        }catch{tab='已绑定标签页不存在';}
      }
      if(keyOk&&Number.isSafeInteger(s.boundTabId)&&s.boundTabId>0&&validUrl(s.boundUrl)){
        try{
          const response=await fetch(ROOT+'/extension/owner-status',{
            method:'GET',
            headers:{authorization:'Bearer '+k.localBridgeKey,
              'x-bridge-tab-id':String(s.boundTabId),'x-bridge-url':s.boundUrl},
            signal:AbortSignal.timeout(2500)
          });
          if(response.ok){
            const proof=await response.json();
            ownerMatched=proof?.host==='HOST_READY'&&proof.ownerMatches===true&&
              proof.pendingBrowserDelivery===false;
          }
        }catch{}
      }
      const canClaimLocal=keyOk&&s.armed===true&&host==='已收到浏览器心跳'&&
        tab==='接收脚本与页面可用'&&queueKnown&&!unresolved&&!s.activeEventId&&ownerMatched;
      const detail=[
        '本地密钥：'+(keyOk?'已配置':'未配置'),
        'Host：'+host,
        'Host 所属标签页：'+(ownerMatched?'与本扩展精确匹配':'尚未核验或不匹配'),
        '浏览器页面：'+tab,
        '扩展监听：'+(s.armed===true?'已启动':'已停止'),
        '未决任务：'+(!queueKnown?'Host 状态未知':unresolved||Boolean(s.activeEventId)?'需要等待或人工核查':'未发现'),
        '本地检查：'+(canClaimLocal?'基础条件正常（尚未验证微信实收）':s.activeEventId?'正在处理任务（不应重启或重发）':'未完全就绪')
      ];
      const failure=s.lastFailure;
      if(failure && /^[A-Z0-9_:-]{1,90}$/.test(failure.code||''))
        detail.push('最近错误码：'+failure.code);
      return {message:detail.join('\n')};
    }
    if(['submitted','completed','delivery-unknown'].includes(m.command)){
      const s=await runtime();
      if(sender.tab?.id!==s.boundTabId||m.id!==s.activeEventId)return {ok:false};
      const who={tabId:s.boundTabId,url:s.boundUrl,id:m.id};
      if(m.command==='submitted'){
        await request('/extension/submitted',who);
        return {ok:true};
      }
      if(m.command==='completed'){
        if(typeof m.reply!=='string'||!m.reply.trim()||m.reply.length>2000)return {ok:false};
        await request('/extension/complete',{...who,reply:m.reply});
        await chrome.storage.session.set({activeEventId:null});
        kick();
        return {ok:true};
      }
      const stage='BROWSER_DELIVERY',code=browserFailureCodes.has(m.code)?m.code:'BROWSER_RESULT_UNKNOWN';
      await request('/extension/unknown',{...who,stage,code});
      await chrome.storage.session.set({activeEventId:null,armed:false,lastFailure:{stage,code}});
      return {ok:true};
    }
    return {message:'未知指令'};
  })().then(respond).catch(e=>respond({message:'操作失败：'+e.message,ok:false}));
  return true;
});
