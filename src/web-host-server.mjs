import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { WebHostStore } from './web-host-store.mjs';

export function getWebHostKey(path = resolve('data/web-host.key')) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const key = readFileSync(path, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('WEB_HOST_KEY_INVALID');
    return key;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const key = randomBytes(32).toString('hex');
    writeFileSync(path,key,{flag:'wx', mode:0o600});
    return key;
  }
}
function json(res, code, value) {
  res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(value));
}
async function body(req) {
  let parts=[],size=0;
  for await (const chunk of req) { size+=chunk.length; if(size>10000) throw new Error('BODY_TOO_LARGE'); parts.push(chunk); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new Error('INVALID_JSON'); }
}
function validChatUrl(value) {
  try {
    const url=new URL(value);
    return url.protocol==='https:' && url.hostname==='chatgpt.com' && !url.username && !url.password
      && !url.hash && /^(?:\/c\/|\/g\/[^/]+\/c\/)[0-9a-f-]{36}\/?$/i.test(url.pathname);
  } catch {return false;}
}
// Edge MV3 alarms run at roughly 30s intervals; 25s would expire between
// healthy checks. Keep a bounded grace, never bypass exact tab ownership.
export const HOST_HEARTBEAT_TTL_MS=75_000;
export function createWebHostServer({store,key,now=()=>Date.now(),host='127.0.0.1',port=8799,autoState=()=>({enabled:false})}) {
  if (!store || !/^[a-f0-9]{64}$/.test(key)) throw new Error('WEB_HOST_CONFIGURATION_INVALID');
  if (host!=='127.0.0.1') throw new Error('WEB_HOST_LOOPBACK_ONLY');
  let currentHost=null;
  function alive() {return currentHost && now()-currentHost.lastSeen<HOST_HEARTBEAT_TTL_MS;}
  function hostState() { return alive() ? 'HOST_READY' : 'HOST_UNVERIFIED'; }
  const server=http.createServer(async (req,res)=>{
    try {
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname==='/health' && req.method==='GET') return json(res,200,{ok:true,host:hostState(),queue:store.counts(),weixinDeliveryVerified:false});
      const origin=req.headers.origin||'';
      if(/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
        res.setHeader('access-control-allow-origin',origin);
        res.setHeader('vary','Origin');
        res.setHeader('access-control-allow-headers','authorization, content-type, x-bridge-tab-id, x-bridge-url');
        res.setHeader('access-control-allow-methods','POST, OPTIONS');
        if(req.method==='OPTIONS' && url.pathname.startsWith('/extension/')){res.writeHead(204);return res.end();}
      }
      const isBridge=url.pathname.startsWith('/bridge-'+key+'/');
      if(!isBridge) {
        const expected=Buffer.from('Bearer '+key), provided=Buffer.from(req.headers.authorization||'');
        if(expected.length!==provided.length || !timingSafeEqual(expected,provided)) return json(res,404,{error:'NOT_FOUND'});
      }
      if(!isBridge && !url.pathname.startsWith('/extension/')) return json(res,404,{error:'NOT_FOUND'});
      if(url.pathname==='/extension/owner-status' && req.method==='GET'){
        const rawId=req.headers['x-bridge-tab-id'];
        const rawUrl=req.headers['x-bridge-url'];
        const tabId=typeof rawId==='string'&&/^[1-9][0-9]{0,12}$/.test(rawId)?Number(rawId):null;
        if(!Number.isSafeInteger(tabId)||typeof rawUrl!=='string'||!validChatUrl(rawUrl))
          throw Error('INVALID_HOST_OWNER_QUERY');
        // Authenticated read-only proof; never returns the pinned URL, tab ID or task content.
        return json(res,200,{
          host:hostState(),
          ownerMatches:Boolean(alive()&&currentHost.tabId===tabId&&currentHost.url===rawUrl),
          pendingBrowserDelivery:Boolean(store.counts().ASSIGNED_UNKNOWN||
            store.counts().BROWSER_SUBMITTED||store.counts().DELIVERY_UNKNOWN)
        });
      }
      if(url.pathname==='/extension/auto-state' && req.method==='POST'){
        const state=autoState();
        return json(res,200,{enabled:state?.enabled===true,chatUrl:state?.enabled===true?state.chatUrl:null});
      }
      if(isBridge && url.pathname==='/bridge-'+key+'/api/send' && req.method==='POST'){
        const row=store.enqueue(await body(req));
        return json(res,200,{eventId:row.id,status:'QUEUED'});
      }
      if(isBridge && url.pathname.startsWith('/bridge-'+key+'/api/event/') && req.method==='GET'){
        const id=url.pathname.slice(('/bridge-'+key+'/api/event/').length);
        const row=store.get(id);
        const diagnostic=row?.status==='DELIVERY_UNKNOWN'?store.diagnostic(id):null;
        return json(res,row?200:404,row?{
          status:row.status==='DELIVERY_UNKNOWN'?'TIMED_OUT_UNKNOWN':['ASSIGNED_UNKNOWN','BROWSER_SUBMITTED'].includes(row.status)?'DISPATCHED':row.status,
          replyText:row.status==='SUCCEEDED'?row.reply_text:null,
          ...(row.status==='DELIVERY_UNKNOWN'?{diagnostic:diagnostic?{stage:diagnostic.stage,code:diagnostic.code}:{stage:'UNKNOWN_STAGE',code:'LEGACY_UNKNOWN'}}:{})
        }:{error:'NOT_FOUND'});
      }
      if(url.pathname==='/extension/heartbeat' && req.method==='POST'){
        const data=await body(req);
        if(!Number.isSafeInteger(data.tabId)||data.tabId<1||!validChatUrl(data.url)||data.ready!==true) throw new Error('INVALID_HOST_HEARTBEAT');
        const counts=store.counts();
        const unresolved=Boolean(counts.ASSIGNED_UNKNOWN || counts.BROWSER_SUBMITTED || counts.DELIVERY_UNKNOWN);
        if(currentHost && (alive() || unresolved)
           && (currentHost.tabId!==data.tabId || currentHost.url!==data.url)) throw new Error('HOST_OWNERSHIP_CONFLICT');
        currentHost={tabId:data.tabId,url:data.url,lastSeen:now()};
        return json(res,200,{status:'HOST_READY'});
      }
      if(url.pathname==='/extension/disarm' && req.method==='POST'){
        const data=await body(req);
        if(currentHost && (currentHost.tabId!==data.tabId || currentHost.url!==data.url)) throw new Error('HOST_OWNERSHIP_CONFLICT');
        const pending=store.counts();
        if(pending.ASSIGNED_UNKNOWN || pending.BROWSER_SUBMITTED) throw new Error('HOST_HAS_UNRESOLVED_EVENT');
        currentHost=null;
        return json(res,200,{status:'STOPPED'});
      }
      if(url.pathname==='/extension/poll' && req.method==='POST'){
        const data=await body(req);
        if(!alive()||currentHost.tabId!==data.tabId||currentHost.url!==data.url) throw new Error('HOST_UNVERIFIED');
        const row=store.claim();
        return json(res,200,row?{event:{id:row.id,text:row.text}}:{event:null});
      }
      if(url.pathname==='/extension/task-status' && req.method==='POST'){
        const data=await body(req);
        if(!currentHost||currentHost.tabId!==data.tabId||currentHost.url!==data.url)
          throw Error('HOST_OWNERSHIP_CONFLICT');
        if(typeof data.id!=='string'||!/^[a-f0-9-]{36}$/i.test(data.id))
          throw Error('INVALID_EVENT_ID');
        const row=store.get(data.id);
        return json(res,row?200:404,row?{status:row.status}:{error:'EVENT_NOT_FOUND'});
      }
      if(url.pathname==='/extension/submitted' && req.method==='POST'){
        const data=await body(req);
        // An active ChatGPT turn may run longer than the heartbeat TTL.
        if(!currentHost||currentHost.tabId!==data.tabId||currentHost.url!==data.url) throw new Error('HOST_OWNERSHIP_CONFLICT');
        store.submitted(data.id);
        return json(res,200,{status:'BROWSER_SUBMITTED'});
      }
      if(url.pathname==='/extension/complete' && req.method==='POST'){
        const data=await body(req);
        if(!currentHost||currentHost.tabId!==data.tabId||currentHost.url!==data.url) throw new Error('HOST_OWNERSHIP_CONFLICT');
        store.complete(data.id,data.reply);
        return json(res,200,{status:'SUCCEEDED'});
      }
      if(url.pathname==='/extension/unknown' && req.method==='POST'){
        const data=await body(req);
        if(!currentHost||currentHost.tabId!==data.tabId||currentHost.url!==data.url) throw new Error('HOST_OWNERSHIP_CONFLICT');
        store.unknown(data.id,{stage:data.stage,code:data.code});
        return json(res,200,{status:'DELIVERY_UNKNOWN'});
      }
      return json(res,404,{error:'NOT_FOUND'});
    } catch(error) {
      const message=/^[A-Z0-9_]{1,80}$/.test(error?.message||'')?error.message:'REQUEST_REJECTED';
      return json(res,409,{error:message});
    }
  });
  return {server,start:()=>new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,host,()=>{server.off('error',fail);ok(server.address());});}),stop:()=>new Promise(ok=>server.close(ok)),hostState};
}
