import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';

// Secret values stay in local ignored files and stdin, never argv or console output.
let local;
try {local=JSON.parse(await readFile('.migration-secrets.json','utf8'));}
catch(error) {
  if(error.code!=='ENOENT') throw new Error('本地密钥文件无法读取，停止以防覆盖密钥');
  local={ADMIN_TOKEN:randomBytes(32).toString('base64url'),COOKIE_ENCRYPTION_KEY:randomBytes(32).toString('base64')};
  await writeFile('.migration-secrets.json',JSON.stringify(local,null,2)+'\n',{flag:'wx',mode:0o600});
}
if(typeof local.ADMIN_TOKEN!=='string' || local.ADMIN_TOKEN.length<32 || Buffer.from(local.COOKIE_ENCRYPTION_KEY || '', 'base64').length!==32) throw new Error('本地密钥格式无效');
let smtp;
try {smtp=JSON.parse(await readFile('smtp.local.json','utf8'));}
catch {throw new Error('smtp.local.json 无法读取或不是有效 JSON，请在本地检查格式');}
if(!smtp.password?.trim() || smtp.port!==465 || !/^[a-z0-9.-]+$/i.test(smtp.host) || !/^[^\s<>@]+@[^\s<>@]+\.[a-z]+$/i.test(smtp.user)) throw new Error('请填写有效 SMTP 地址、465 端口、发件邮箱和授权码');
const secrets={ADMIN_TOKEN:local.ADMIN_TOKEN,COOKIE_ENCRYPTION_KEY:local.COOKIE_ENCRYPTION_KEY,SMTP_HOST:smtp.host,SMTP_PORT:String(smtp.port),MAIL_USER:smtp.user,MAIL_APP_PASSWORD:smtp.password.trim()};
const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','secret','bulk'],{stdio:['pipe','inherit','inherit']});
child.stdin.on('error',()=>{});
child.stdin.end(JSON.stringify(secrets));
const code=await new Promise((resolve,reject)=>{child.on('error',()=>reject(new Error('无法启动 Wrangler')));child.on('close',resolve);});
if(code!==0) process.exitCode=code || 1;
