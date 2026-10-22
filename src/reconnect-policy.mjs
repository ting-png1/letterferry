export function reconnectDecision({enabled,paused,daemonRunning,hostRunning,hostResponds,hostState,unresolved}={}){
 if(enabled!==true)return 'DISABLED_BY_OWNER';
 if(paused===true)return 'PAUSED_BY_OWNER';
 if(hostResponds&&!hostRunning)return 'UNRECOGNIZED_LOCAL_HOST_PROCESS';
 if(unresolved===true)return 'UNRESOLVED_DELIVERY_REVIEW_REQUIRED';
 if(daemonRunning&&hostResponds){
  return hostState==='HOST_READY'?'ALREADY_CONNECTED':'BROWSER_BUSY_OR_WAITING';
 }
 if(hostRunning&&!hostResponds)return 'HOST_PROCESS_UNRESPONSIVE';
 if(daemonRunning&&!hostRunning)return 'START_MISSING_HOST';
 if(!daemonRunning)return 'START_MISSING_DAEMON';
 return 'MANUAL_DIAGNOSIS_REQUIRED';
}
