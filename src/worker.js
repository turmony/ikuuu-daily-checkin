import {fingerprint} from './security.js';
import {html, css, js} from './page.js';
import {boundedText} from './body.js';
import {SESSION_MS} from './auth.js';
export {CheckinObject} from './checkin-object.js';

const headers = {
  'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const COOKIE='__Host-ikuuu_session';
const cookie=value=>`${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${value?SESSION_MS/1000:0}`;
const json=(data,status=200,extra={})=>Response.json(data,{status,headers:{...headers,...extra}});
const tokenFrom=request=>request.headers.get('Authorization')?.replace(/^Bearer /,'') || request.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-ikuuu_session=([^;]*)/)?.[1] || '';

export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(request.method==='GET' && ['/', '/app.css','/app.js'].includes(url.pathname)) {
      const content=url.pathname==='/'?html:url.pathname==='/app.css'?css:js;
      return new Response(content,{headers:{...headers,'Content-Type':url.pathname==='/'?'text/html; charset=utf-8':url.pathname==='/app.css'?'text/css; charset=utf-8':'text/javascript; charset=utf-8'}});
    }
    if(!url.pathname.startsWith('/api/')) return json({error:'未找到页面'},404);
    if(!['GET','POST'].includes(request.method)) return json({error:'请求方法不支持'},405);
    if(request.method==='POST' && ((request.headers.get('Origin') && request.headers.get('Origin')!==url.origin) || request.headers.get('Sec-Fetch-Site')==='cross-site')) return json({error:'拒绝跨站修改'},403);
    if(request.method==='POST' && request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json') return json({error:'请求必须使用 application/json'},415);
    const stub=env.CHECKIN.getByName(env.ACCOUNT_NAME || 'primary-account');
    const token=tokenFrom(request);
    try {
      let body={};
      if(request.method==='POST') {
        let text;try {text=await boundedText(request,20_000);}catch {return json({error:'请求内容过大或无法读取'},413);}
        try {body=JSON.parse(text || '{}');}catch {return json({error:'请求必须为 JSON'},400);}
        if(!body || typeof body!=='object' || Array.isArray(body)) return json({error:'请求必须为 JSON 对象'},400);
      }
      let result,clear=false,login=false;
      const path=url.pathname;
      if(request.method==='GET' && path==='/api/auth/status') result=await stub.authStatus(token);
      else if(request.method==='POST' && path.startsWith('/api/auth/')) {
        const clientKey=await fingerprint(env.ADMIN_TOKEN+'\0'+(request.headers.get('CF-Connecting-IP') || 'local-client'));
        if(path==='/api/auth/login') {result=await stub.login(body.password,clientKey);login=true;}
        else if(path==='/api/auth/recover') {result=await stub.recover(body.recoveryCode,body.password,clientKey);clear=true;}
        else if(path==='/api/auth/change-password') {result=await stub.changePassword(token,body.currentPassword,body.newPassword,clientKey);clear=true;}
        else if(path==='/api/auth/logout') {result=await stub.logout(token);clear=true;}
      } else if((request.method==='GET' && ['/api/status','/api/history'].includes(path)) || (request.method==='POST' && ['/api/cookie','/api/initialize','/api/run','/api/test-email','/api/pause','/api/resume'].includes(path))) {
        result=await stub.manage(path.slice(5),body,token);
      }
      if(!result) return json({error:'接口或请求方法不正确'},404);
      if(!result.ok) return json({error:result.error},result.status,result.status===401?{'Set-Cookie':cookie('')}:{});
      if(login) return json({message:'已登录',expiresAt:result.data.expiresAt},200,{'Set-Cookie':cookie(result.data.token)});
      return json(result.data,200,clear?{'Set-Cookie':cookie('')}:{});
    } catch {return json({error:'服务暂时异常，请稍后重试'},503);}
  }
};
