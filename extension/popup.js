import {DEFAULT_SITES,configuration} from './core.js';

const get=id=>document.getElementById(id);
const time=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚未同步';
let current;
async function send(type,config) {
  const reply=await chrome.runtime.sendMessage({type,config});
  if (!reply?.ok) throw new Error(reply?.error || '扩展暂时无法响应');
  return reply.data;
}
function render(state,fill=false) {
  current=state;
  const facts={'配对状态':state.authInvalid?'已失效':state.paired?'已启用':'尚未配对','最近同步':time(state.lastSyncAt),'网站':state.lastDomain || '—','等待任务':state.pending,'同步提示':state.lastError || '—'};
  get('status').replaceChildren();
  for(const [key,value] of Object.entries(facts)){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=String(value);get('status').append(dt,dd);}
  if (fill) {get('worker').value=state.workerOrigin;get('sites').value=(state.sites.length?state.sites:DEFAULT_SITES).join('\n');}
}
async function act(action) {
  document.querySelectorAll('button').forEach(button=>button.disabled=true);
  try {await action();}catch(error){get('message').textContent=error.message;get('message').className='error';}
  finally{document.querySelectorAll('button').forEach(button=>button.disabled=false);}
}
get('settings').onsubmit=event=>{
  event.preventDefault();
  act(async()=>{
    const input={workerUrl:get('worker').value,token:get('token').value.trim(),sites:get('sites').value.split(/[,，\s]+/).filter(Boolean)};
    // Request only selected hosts in a user gesture; no access to unrelated sites.
    const placeholder='sync_'+'a'.repeat(43);
    const parsed=configuration(input.workerUrl,input.token || (current?.paired && new URL(input.workerUrl).origin===current.workerOrigin?placeholder:''),input.sites);
    const allowed=await chrome.permissions.request({origins:[parsed.workerOrigin,...parsed.sites].map(origin=>origin+'/*')});
    if (!allowed) throw new Error('需要允许访问所选网站与签到服务，才能自动同步 Cookie');
    render(await send('configure',input),true);get('token').value='';get('message').className=current.lastError?'error':'';get('message').textContent=current.lastError || '设置已保存；已登录的网站会自动同步。';
  });
};
get('sync').onclick=()=>act(async()=>{render(await send('sync-now'));get('message').className=current.lastError?'error':'';get('message').textContent=current.lastError || (current.lastSyncAt?'同步任务已处理':'请先登录当前网站');});
get('forget').onclick=()=>act(async()=>{render(await send('forget'),true);get('token').value='';get('message').className='';get('message').textContent='已清除本机配对。如需撤销令牌，请在管理页面撤销该设备。';});
act(async()=>render(await send('status'),true));
const refresh=setInterval(()=>send('status').then(state=>render(state)).catch(()=>{}),2000);
window.addEventListener('pagehide',()=>clearInterval(refresh));
