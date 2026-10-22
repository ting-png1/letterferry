const status=document.getElementById('status');
let requestSerial=0;
let mutationPending=false;
const write=(serial,message)=>{
  if(serial===requestSerial)status.textContent=message;
};
async function call(command,other={}) {
  const mutates=['save-key','bind','arm','stop'].includes(command);
  if(mutates&&mutationPending){
    status.textContent='上一次操作仍在等待后台确认。请勿重复点击，以免改变监听状态。';
    return;
  }
  const serial=++requestSerial;
  if(mutates)mutationPending=true;
  const readable={
    'inspect':'正在检查页面结构（只读）…',
    'status':'正在读取连接状态（只读）…',
    'arm':'正在启动网页接收，请勿重复点击…',
    'stop':'正在申请停止领取新任务…',
    'bind':'正在核对当前标签页…',
    'save-key':'正在保存本地密钥…'
  };
  write(serial,readable[command]||'正在联系扩展后台…');
  let timer;
  const duration=mutates?10000:command==='inspect'?6000:6500;
  const timeoutMessage=mutates
    ? '操作超过 10 秒仍无回执。结果未知，后台可能已执行！请勿重试或刷新扩展；先查看只读状态，必要时联系 LetterFerry 维护者。'
    : command==='inspect'
      ? '检查超时：页面接收脚本或扩展后台没有及时回应；本次只读检查不会发微信。'
      : '状态检查超时：扩展后台没有及时回应，连接状态尚未验证。';
  try {
    const response=await Promise.race([
      chrome.runtime.sendMessage({command,...other}),
      new Promise(resolve=>{
        timer=setTimeout(()=>resolve({message:timeoutMessage,timedOut:true}),duration);
      })
    ]);
    write(serial,response?.message||'扩展没有返回可用状态');
  } catch {
    write(serial,mutates
      ? '扩展后台未响应；操作结果尚不确定，请勿重复点击或发送测试微信。'
      : '扩展后台暂时不可用；无法验证状态。');
  } finally {
    if(timer!==undefined)clearTimeout(timer);
    if(mutates)mutationPending=false;
  }
}
document.getElementById('save').onclick=()=>call('save-key',{key:document.getElementById('key').value.trim()});
document.getElementById('bind').onclick=()=>call('bind');
document.getElementById('arm').onclick=()=>call('arm');
document.getElementById('stop').onclick=()=>call('stop');
document.getElementById('inspect').onclick=()=>call('inspect');
document.getElementById('statusCheck').onclick=()=>call('status');
call('status');
