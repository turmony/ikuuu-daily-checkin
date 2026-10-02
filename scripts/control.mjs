import {readFile} from 'node:fs/promises';

const command=process.argv[2] || 'status';
let local={};
try {local=JSON.parse(await readFile('.migration-secrets.json','utf8'));}catch { /* Environment variables can configure remote control. */ }
const url=process.env.WORKER_URL || local.WORKER_URL;
const token=process.env.ADMIN_TOKEN || local.ADMIN_TOKEN;
if(!url || !token) throw new Error('请设置 WORKER_URL 和 ADMIN_TOKEN 环境变量');
const actions={status:'status',run:'run',pause:'pause',resume:'resume',cookie:'cookie',initialize:'initialize','test-email':'test-email'};
if(!actions[command]) throw new Error('命令：status、run、pause、resume、cookie、initialize');
let body;
if(command==='cookie') {
  body={cookie:(await readFile(process.argv[3] || 'ikuuu-cookie.txt','utf8')).trim()};
} else if(command==='initialize') {
  body=JSON.parse(await readFile(process.argv[3] || '.github/ikuuu-state.json','utf8'));
} else if(command !== 'status') body={};
const response=await fetch(new URL(`/api/${actions[command]}`,url),{
  method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
  body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(90_000),
});
const data=await response.json();
if(!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
console.log(JSON.stringify(data,null,2));
