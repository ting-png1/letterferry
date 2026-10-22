(() => {
if (globalThis.__RIVEN_WEIXIN_WEB_RECEIVER_V2) return;
let occupied=false;
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
// Prefer canonical grouped turn nodes; fall back to one legacy convention at a time.
function turns(role) {
  // On the current grouped ChatGPT renderer, one message can match several
  // unrelated role selectors: the outer search-unit and nested accessibility
  // label nodes. Mixing them caused a 5 grouped / 9 recognized discrepancy,
  // with the last "assistant" being just the speaker label.
  const grouped=[...document.querySelectorAll('[data-content-search-unit-key$=":'+role+'"]')];
  if(grouped.length) return grouped;
  // Fall back to ONE structural role convention at a time. Mixing generic
  // [data-role] labels with full message wrappers can recreate false turns.
  const priority=[
    '[data-message-author-role="'+role+'"]',
    '[data-conversation-role="'+role+'"]',
    'article[data-turn="'+role+'"]',
    '[data-testid^="conversation-turn-"][data-turn="'+role+'"]',
    '[data-message-author="'+role+'"]',
    '[data-role="'+role+'"]',
    ...(role==='user'?['[data-user-message-bubble="true"]']:[])
  ];
  for(const selector of priority){
    const nodes=[...document.querySelectorAll(selector)];
    if(nodes.length)return nodes.filter(node=>!nodes.some(other=>other!==node&&node.contains?.(other)));
  }
  return [];
}
function turnKey(node) {
  for(const name of ['data-content-search-unit-key','data-message-id','data-turn-id','data-turn-key']) {
    const value=node.getAttribute?.(name);
    if(value) return name+':'+value;
  }
  return null;
}
const assistantBodySelector=[
  '[data-testid="message-text"]',
  '[data-testid="message-content"]',
  '[data-message-content]',
  '.markdown',
  '.prose'
].join(', ');
const textOf=node=>((node?.innerText||node?.textContent||'')+'').trim();
// Never treat UI speaker labels as an assistant response, even when the turn
// container appears or remains stable before actual model text renders.
function isSpeakerChrome(value) {
  const compact=(value||'').replace(/\s+/g,' ').trim();
  return /^(?:ChatGPT\s*(?:说|says|said)?|Assistant|助手)\s*[:：]?$/i.test(compact);
}
const assistantBlockSelector='p, pre, blockquote, li, [role="paragraph"]';
const nonBodyAncestor='button, nav, aside, header, footer, [role="toolbar"], [aria-hidden="true"], [data-testid="turn-actions"]';
function meaningfulBlocks(node,selector){
  const candidates=[...(node.querySelectorAll?.(selector)||[])];
  // Leaf-only: a blockquote containing a paragraph must not be read twice.
  const leaves=candidates.filter(item=>
    !candidates.some(other=>other!==item&&item.contains?.(other)) &&
    !item.closest?.(nonBodyAncestor));
  return leaves.map(textOf).filter(value=>
    Boolean(value) && !isSpeakerChrome(value) &&
    !/^ChatGPT\s*说[:：]/.test(value));
}
function assistantBodyParts(node){
  const bodies=meaningfulBlocks(node,assistantBodySelector);
  if(bodies.length)return bodies;
  // The 2026 grouped renderer can have real paragraphs without any .markdown
  // or .prose parent. Only inspect blocks INSIDE the verified assistant group,
  // never the whole page, and never use action/toolbar labels as model text.
  return meaningfulBlocks(node,assistantBlockSelector);
}
function turnText(node,role) {
  if(role==='user'){
    const body=node.querySelector?.('[data-user-message-bubble="true"], .whitespace-pre-wrap');
    return textOf(body||node);
  }
  const parts=assistantBodyParts(node);
  if(parts.length)return parts.join('\n').trim();
  // Legacy plain-text renderer: accept only a bare, non-UI assistant element.
  // Grouped wrappers can contain chrome and must have a verified block.
  if(node.getAttribute?.('data-content-search-unit-key'))return '';
  const fallback=textOf(node);
  return !fallback || isSpeakerChrome(fallback) || /^ChatGPT\s*说[:：]/.test(fallback) ? '' : fallback;
}
function snapshot(role) {
  return turns(role).map(node=>({node,key:turnKey(node),text:turnText(node,role)}));
}
function newOrChanged(node,role,before) {
  const key=turnKey(node);
  const prior=key ? before.find(item=>item.key===key) : before.find(item=>item.node===node);
  if(!prior) return true;
  return turnText(node,role)!==prior.text;
}
function structureSurvey(boundUrl) {
  if(location.href!==boundUrl) return {receiverVersion:8,ready:false,reason:'BOUND_TAB_CHANGED'};
  // Read-only structural counts; not a single character of user/model text leaves the tab.
  const count=selector=>document.querySelectorAll(selector).length;
  const assistants=turns('assistant'),lastAssistant=assistants[assistants.length-1];
  const bodyCandidates=[...(lastAssistant?.querySelectorAll?.(assistantBodySelector)||[])];
  return {
    receiverVersion:8,ready:true,
    classicAssistant:count('[data-message-author-role="assistant"]'),
    groupedAssistant:count('[data-content-search-unit-key$=":assistant"]'),
    groupedUser:count('[data-content-search-unit-key$=":user"]'),
    roleAssistant:assistants.length,
    roleUser:turns('user').length,
    lastAssistantBodyNodes:bodyCandidates.length,
    lastAssistantFallbackBlocks:lastAssistant?meaningfulBlocks(lastAssistant,assistantBlockSelector).length:0,
    lastAssistantRecognizedBody:lastAssistant?Number(Boolean(turnText(lastAssistant,'assistant'))):0,
    lastAssistantLabelOnly:lastAssistant?Number(isSpeakerChrome(textOf(lastAssistant))):0,
    // The survey must not rescan a huge historical conversation synchronously.
    // Count a bounded tail; delivery extraction itself is unchanged.
    assistantBodySampled:Math.min(assistants.length,24),
    assistantsWithBody:assistants.slice(-24).filter(node=>Boolean(turnText(node,'assistant'))).length,
    lastAssistantDescendants:lastAssistant?.querySelectorAll?.('*')?.length||0,
    lastAssistantBlockElements:lastAssistant?.querySelectorAll?.('p, pre, blockquote, li, [role="paragraph"]')?.length||0,
    lastAssistantParentBodyNodes:lastAssistant?.parentElement?.querySelectorAll?.(assistantBodySelector)?.length||0
  };
}
function usableEditor(node) {
  if (!node) return false;
  if (node.tagName === 'TEXTAREA') return !node.disabled && !node.readOnly;
  return node.isContentEditable === true || node.getAttribute?.('contenteditable') === 'true';
}
function editor() {
  // Keep fallback selectors scoped to the ChatGPT composer; never select an arbitrary editable.
  const candidates=[
    '#prompt-textarea',
    '[data-testid="composer-input"]',
    '[data-testid="prompt-textarea"]',
    '#prompt-textarea [contenteditable="true"]',
    '[data-testid="composer-input"] [contenteditable="true"]',
    '[data-testid="composer"] [contenteditable="true"]',
    'form [contenteditable="true"][role="textbox"]',
    'form [contenteditable="true"].ProseMirror',
    'form textarea'
  ];
  for(const selector of candidates) {
    const node=document.querySelector(selector);
    if(usableEditor(node)) return node;
    if(node) {
      const nested=node.querySelector?.('[contenteditable="true"], textarea');
      if(usableEditor(nested)) return nested;
    }
  }
  return null;
}
function diagnose(boundUrl,allowCurrentTask=false){
  if(location.href!==boundUrl) return {ready:false,reason:'BOUND_TAB_CHANGED'};
  if(occupied && !allowCurrentTask) return {ready:false,reason:'PAGE_BUSY'};
  if(stopping()) return {ready:false,reason:'ASSISTANT_GENERATING'};
  if(!editor()) return {
    ready:false,reason:'EDITOR_NOT_FOUND',
    // Structural counts only: never send or log conversation text, cookie or tokens.
    editableCount:document.querySelectorAll('[contenteditable="true"]').length,
    textareaCount:document.querySelectorAll('textarea').length,
    promptIdFound:Boolean(document.querySelector('#prompt-textarea'))
  };
  return {ready:true,reason:'READY'};
}
const sendLabels = new Set(['发送','发送消息','发送提示词','Send prompt','Send message','Send']);
const sendTestIds = new Set(['send-button','composer-send-button','submit-button','composer-submit-button']);
function sendCandidate(input) {
  const form=input.closest?.('form');
  // Explicit semantic selectors: avoid clicking an unrelated chat/sidebar control.
  const scope=form||input.closest?.('[data-testid="composer"]')||null;
  function matches(button) {
    if(!button||button.tagName!=='BUTTON')return false;
    const testId=button.getAttribute?.('data-testid');
    const aria=button.getAttribute?.('aria-label');
    const title=button.getAttribute?.('title');
    const type=button.getAttribute?.('type');
    if(sendTestIds.has(testId)||sendLabels.has(aria)||sendLabels.has(title))return true;
    return type==='submit'&&Boolean(form);
  }
  if(scope?.querySelectorAll) {
    const candidates=[...scope.querySelectorAll('button')].filter(matches);
    // Fail closed rather than choose randomly if multiple send-like buttons exist.
    if(candidates.length===1)return candidates[0];
    // Multiple matching controls are ambiguous; never pick one arbitrarily.
    // If the scoped composer has no candidate, check only the explicit
    // semantic global selectors below (portalled Send button layout).
    if(candidates.length>1)return null;
  }
  // A few ChatGPT layouts use a portalled button outside the containing form.
  const selectors=[
    'button[data-testid="send-button"]',
    'button[data-testid="composer-send-button"]',
    'button[data-testid="submit-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="发送"]',
    'button[aria-label="发送消息"]'
  ];
  const found=selectors.map(selector=>document.querySelector(selector)).filter(matches);
  return [...new Set(found)].length===1?found[0]:null;
}
async function waitForSend(input) {
  const until=Date.now()+4500;
  let sawButton=false;
  while(Date.now()<until){
    const candidate=sendCandidate(input);
    if(candidate){
      sawButton=true;
      if(!candidate.disabled && candidate.getAttribute?.('aria-disabled')!=='true')return candidate;
    }
    await pause(150);
  }
  throw Error(sawButton?'SEND_BUTTON_DISABLED':'SEND_BUTTON_NOT_FOUND');
}
const stopSelector='button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止"], button[aria-label="停止生成"], button[aria-label="Stop"]';
function stopping(){
  // Multiple ChatGPT conversations may coexist in floating panels. A stop
  // button outside the actual bound composer must not block this conversation.
  const input=editor();
  const scope=input?.closest?.('form, [data-testid="composer"]');
  // The fallback is deliberately fail-closed when no reliable composer exists:
  // a layout change must never falsely declare a generating page idle.
  if(!scope)return Boolean(document.querySelector(stopSelector));
  return Boolean(scope.querySelector?.(stopSelector));
}
// Rich-text composers can render a line break as two DOM blocks. In that
// layout, textContent concatenates the two lines without a newline even though
// innerText and the visible draft contain the complete message.
// Only CRLF/newline representations may differ: every other character must
// still match. This must never accept a truncated or extra non-newline draft.
function newlineShape(value){
  return String(value??'').replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ');
}
function sameExceptLineBreaks(expected,actual){
  const intended=newlineShape(expected),seen=newlineShape(actual);
  return seen===intended ||
    (intended.includes('\n') && seen.replace(/\n/g,'')===intended.replace(/\n/g,''));
}
function editorConfirmed(input,text){
  const rendered=input.tagName==='TEXTAREA'
    ? [input.value]
    : [input.innerText,input.textContent];
  return rendered.some(value=>sameExceptLineBreaks(text,value));
}
async function waitForEditorConfirmation(input,text,boundUrl){
  // Rich ChatGPT composers can settle asynchronously after insertText/input.
  // Observe the SAME verified editor, never paste twice or submit a partial draft.
  const deadline=Date.now()+3500;
  while(true){
    if(location.href!==boundUrl || stopping() || editor()!==input)
      throw Error('PAGE_NOT_READY');
    if(editorConfirmed(input,text))return;
    if(Date.now()>=deadline)throw Error('INPUT_NOT_CONFIRMED');
    await pause(150);
  }
}
function userTurnContains(node,text){
  const rendered=turnText(node,'user');
  const flattened=newlineShape(rendered),expected=newlineShape(text);
  return flattened.includes(expected) ||
    (expected.includes('\n') && flattened.replace(/\n/g,'').includes(expected.replace(/\n/g,'')));
}
function ready(boundUrl,allowCurrentTask=false){return diagnose(boundUrl,allowCurrentTask).ready;}
async function submit(id,text,boundUrl){
  if(!ready(boundUrl,true))throw Error('PAGE_NOT_READY');
  if(typeof text!=='string'||!text.trim()||text.length>2000)throw Error('INVALID_TEXT');
  const input=editor();
  const occupiedText=input.tagName==='TEXTAREA'?input.value:input.textContent;
  if((occupiedText||'').trim())throw Error('COMPOSER_NOT_EMPTY');
  const beforeAssistant=snapshot('assistant');
  const beforeUser=snapshot('user');
  input.focus();
  if(input.tagName==='TEXTAREA'){
    const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')?.set;
    if(setter) setter.call(input,text); else input.value=text;
  }else{
    // Background tabs may retain their selection in a floating conversation.
    // Anchor the caret INSIDE the exact editor before inserting text.
    try{
      const selection=globalThis.getSelection?.();
      const range=document.createRange?.();
      if(!selection||!range)throw Error('NO_EDITOR_SELECTION');
      range.selectNodeContents(input);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      if(selection.rangeCount<1 || !input.contains(selection.anchorNode))
        throw Error('EDITOR_CARET_NOT_INSIDE_INPUT');
    }catch{
      throw Error('INPUT_NOT_CONFIRMED');
    }
    if(!document.execCommand('insertText',false,text))throw Error('INPUT_NOT_ACCEPTED');
  }
  input.dispatchEvent(new Event('input',{bubbles:true}));
  await waitForEditorConfirmation(input,text,boundUrl);
  // ChatGPT often renders/enables the send button asynchronously after an editor update.
  const button=await waitForSend(input);
  if(location.href!==boundUrl||stopping()||!editorConfirmed(input,text))throw Error('PAGE_NOT_READY');
  button.click();  // This is the irreversible browser action.
  try{await chrome.runtime.sendMessage({command:'submitted',id});}catch{}
  // Long agent/tool tasks may last far beyond 180 seconds. This is a
  // detached content-script job; no extension message callback is held open.
  const deadline=Date.now()+2*60*60_000;
  let last='',stableAt=0,hasNew=false,submittedUserSeen=false;
  while(Date.now()<deadline) {
    if(location.href!==boundUrl)throw Error('BOUND_TAB_NAVIGATED');
    // Proof of a NEW user turn matching our sent text is needed before accepting
    // any assistant content. This prevents a prior answer being returned as new.
    submittedUserSeen ||= turns('user').some(node=>
      newOrChanged(node,'user',beforeUser) && userTurnContains(node,text));
    if(submittedUserSeen){
      const responses=turns('assistant').filter(node=>newOrChanged(node,'assistant',beforeAssistant));
      if(responses.length){
        hasNew=true;
        // A single Weixin prompt can produce several assistant turns when ChatGPT
        // interleaves tool work or staged final messages. Preserve every new
        // assistant body in order, never only the newest visible bubble.
        const value=responses.map(message=>turnText(message,'assistant')).filter(Boolean).join('\n\n');
        if(value!==last){last=value;stableAt=Date.now();}
        if(value && value.length<=2000 && !stopping() && Date.now()-stableAt>=7500)return value;
        if(value.length>2000)throw Error('REPLY_TOO_LONG');
      }
    }
    await pause(500);
  }
  throw Error(!submittedUserSeen?'SUBMITTED_USER_TURN_NOT_FOUND':hasNew&&!last?'ASSISTANT_BODY_NOT_FOUND':hasNew?'REPLY_COMPLETION_UNVERIFIED':'ASSISTANT_TURN_NOT_FOUND');
}
chrome.runtime.onMessage.addListener((msg,_sender,respond)=>{
  if(msg.action==='preflight'){respond({receiverVersion:8,...diagnose(msg.boundUrl)});return false;}
  if(msg.action==='survey'){respond(structureSurvey(msg.boundUrl));return false;}
  if(msg.action==='start-delivery'){
    if(occupied){respond({accepted:false,error:'PAGE_BUSY'});return false;}
    occupied=true;
    // The callback returns immediately. Completion is posted back separately;
    // a restarted service worker never causes a second browser submission.
    respond({accepted:true});
    submit(msg.id,msg.text,msg.boundUrl)
      .then(async reply=>{
        const ack=await chrome.runtime.sendMessage({command:'completed',id:msg.id,reply});
        if(!ack?.ok)throw Error('BROKER_ACK_FAILED');
      })
      .catch(async e=>{
        const code=/^[A-Z_]{2,70}$/.test(e?.message||'')?e.message:'BROWSER_RESULT_UNKNOWN';
        try{await chrome.runtime.sendMessage({command:'delivery-unknown',id:msg.id,code});}
        catch{ /* Host's unresolved assignment remains blocked, never replayed. */ }
      })
      .finally(()=>{occupied=false;});
    return false;
  }
  if(msg.action==='deliver'){
    // Keep the bounded one-shot's legacy synchronous receiver contract.
    if(occupied){respond({ok:false,error:'PAGE_BUSY'});return false;}
    occupied=true;
    submit(msg.id,msg.text,msg.boundUrl)
      .then(reply=>respond({ok:true,reply}))
      .catch(e=>respond({ok:false,error:/^[A-Z_]{2,70}$/.test(e.message)?e.message:'DELIVERY_UNKNOWN'}))
      .finally(()=>{occupied=false;});
    return true;
  }
  return false;
});
globalThis.__RIVEN_WEIXIN_WEB_RECEIVER_V2 = true;
})();
