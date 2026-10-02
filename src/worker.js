import {authorized} from './security.js';
import {html, css, js} from './page.js';
import {boundedText} from './body.js';
export {CheckinObject} from './checkin-object.js';

const headers = {
  'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const json = (data,status=200) => Response.json(data,{status,headers});

export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if (request.method==='GET' && ['/', '/app.css','/app.js'].includes(url.pathname)) {
      const content=url.pathname==='/'?html:url.pathname==='/app.css'?css:js;
      return new Response(content,{headers:{...headers,'Content-Type':url.pathname==='/'?'text/html; charset=utf-8':url.pathname==='/app.css'?'text/css; charset=utf-8':'text/javascript; charset=utf-8'}});
    }
    if(!url.pathname.startsWith('/api/')) return json({error:'未找到页面'},404);
    if(!await authorized(request.headers.get('Authorization'),env.ADMIN_TOKEN)) return json({error:'管理令牌无效或未配置'},401);
    if(request.method !== 'GET' && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({error:'拒绝跨站修改'},403);
    const stub=env.CHECKIN.getByName(env.ACCOUNT_NAME || 'primary-account');
    try {
      let result;
      if(request.method==='GET' && ['/api/status','/api/history'].includes(url.pathname)) result=await stub.status();
      else if(request.method==='POST') {
        let text; try {text=await boundedText(request,20_000);} catch {return json({error:'请求内容过大或无法读取'},413);}
        let body;try{body=JSON.parse(text||'{}');}catch{return json({error:'请求必须为 JSON'},400);}
        if(!body || typeof body!=='object' || Array.isArray(body)) return json({error:'请求必须为 JSON 对象'},400);
        if(url.pathname==='/api/cookie') result=await stub.updateCookie(body.cookie);
        else if(url.pathname==='/api/initialize') result=await stub.initialize(body);
        else if(url.pathname==='/api/run') result=await stub.runNow();
        else if(url.pathname==='/api/test-email') result=await stub.testEmail();
        else if(url.pathname==='/api/pause') result=await stub.pause(true);
        else if(url.pathname==='/api/resume') result=await stub.pause(false);
      }
      if(!result) return json({error:'接口或请求方法不正确'},404);
      return result.ok ? json(result.data) : json({error:result.error},result.status);
    } catch { return json({error:'服务暂时异常，请稍后重试'},503); }
  }
};
