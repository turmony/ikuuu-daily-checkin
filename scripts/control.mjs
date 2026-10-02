import {readFile,writeFile,unlink} from 'node:fs/promises';
import {emitKeypressEvents} from 'node:readline';

const command=process.argv[2] || 'status';
let local={};try {local=JSON.parse(await readFile('.migration-secrets.json','utf8'));}catch { /* Environment variables can configure remote control. */ }
const url=process.env.WORKER_URL || local.WORKER_URL;
if(!url) throw new Error('请配置 WORKER_URL');
const origin=new URL(url).origin;
const sessionFile='.admin-session.json';
let session={};try {session=JSON.parse(await readFile(sessionFile,'utf8'));}catch { /* Login creates this local ignored file. */ }
const token=session.origin===origin && session.expiresAt>Date.now()?session.token:null;
const removeSession=()=>unlink(sessionFile).catch(()=>{});

async function password(label,environment) {
  if(process.env[environment]) return process.env[environment];
  if(!process.stdin.isTTY) throw new Error(`需要交互终端输入密码，或设置 ${environment} 环境变量`);
  process.stdout.write(label+'：');
  emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';
    const finish=(error)=>{process.stdin.off('keypress',onKey);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');error?reject(error):resolve(value);};
    const onKey=(input,key)=>{
      if(key?.ctrl && key.name==='c') finish(new Error('输入已取消'));
      else if(key?.name==='return' || key?.name==='enter') finish();
      else if(key?.name==='backspace') {if(value){value=[...value].slice(0,-1).join('');process.stdout.write('\b \b');}}
      else if(input && !key?.ctrl && !/[\r\n\x1b]/.test(input)){value+=input;process.stdout.write('*'.repeat([...input].length));}
    };
    process.stdin.on('keypress',onKey);
  });
}

async function request(path,body,auth=token) {
  const response=await fetch(new URL('/api/'+path,origin),{method:body===undefined?'GET':'POST',redirect:'manual',
    headers:{...(auth?{Authorization:`Bearer ${auth}`} : {}),'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90_000)});
  if(response.status>=300 && response.status<400) throw new Error('管理接口发生重定向，请核对 WORKER_URL');
  const data=await response.json();
  if(!response.ok){if(response.status===401 && auth)await removeSession();throw new Error(data.error || `HTTP ${response.status}`);}
  return {response,data};
}

let result;
if(command==='auth-status') result=(await request('auth/status')).data;
else if(command==='login') {
  const {response,data}=await request('auth/login',{password:await password('登录密码','ADMIN_PASSWORD')},null);
  const value=response.headers.get('set-cookie')?.match(/__Host-ikuuu_session=([^;]+)/)?.[1];
  if(!value) throw new Error('登录成功但未返回会话');
  await writeFile(sessionFile,JSON.stringify({origin,token:value,expiresAt:data.expiresAt})+'\n',{mode:0o600});
  result=data;
} else if(command==='recover') {
  const recoveryCode=process.env.ADMIN_TOKEN || local.ADMIN_TOKEN;
  if(!recoveryCode) throw new Error('请在本地密钥文件配置恢复码 ADMIN_TOKEN');
  result=(await request('auth/recover',{recoveryCode,password:await password('设置新密码','ADMIN_NEW_PASSWORD')},null)).data;
  await removeSession();
} else {
  if(!token) throw new Error('请先执行 node scripts/control.mjs login');
  if(command==='logout'){result=(await request('auth/logout',{})).data;await removeSession();}
  else if(command==='change-password'){
    result=(await request('auth/change-password',{currentPassword:await password('当前密码','ADMIN_PASSWORD'),newPassword:await password('新密码','ADMIN_NEW_PASSWORD')})).data;
    await removeSession();
  } else {
    const actions=['status','run','pause','resume','cookie','renew-cookie','initialize','test-email'];
    if(!actions.includes(command))throw new Error('命令：auth-status、login、logout、recover、change-password、status、run、pause、resume、cookie、renew-cookie、initialize、test-email');
    let body;
    if(command==='cookie')body={cookie:(await readFile(process.argv[3] || 'ikuuu-cookie.txt','utf8')).trim()};
    else if(command==='initialize')body=JSON.parse(await readFile(process.argv[3] || '.github/ikuuu-state.json','utf8'));
    else if(command!=='status')body={};
    result=(await request(command,body)).data;
  }
}
console.log(JSON.stringify(result,null,2));
