import {configuration, cookieHeader, cookieHash, sourceOrigin, errorMessage} from './core.js';

const STORAGE='ikuuuSync',ALARM='ikuuu-sync-retry';
const DELAYS=[60_000,300_000,1_800_000];
const initial=()=>({config:null,jobs:[],sent:{},authInvalid:false,lastSyncAt:null,lastDomain:null,lastError:null});

// State and pending retry jobs survive Manifest V3 service-worker suspension.
export function createSyncController(api, fetcher=fetch, now=Date.now) {
  let pending=Promise.resolve();
  const exclusive=action=>{const result=pending.then(action);pending=result.catch(()=>{});return result;};
  const read=async()=>({...initial(),...(await api.storage.local.get(STORAGE))[STORAGE]});
  const write=async state=>{
    await api.storage.local.set({[STORAGE]:state});
    await api.action.setBadgeText({text:state.lastError?'!':state.jobs.length?'…':state.lastSyncAt?'✓':''});
    await api.action.setBadgeBackgroundColor({color:state.lastError?'#aa2634':'#265bcb'});
    if (state.jobs.length) await api.alarms.create(ALARM,{when:Math.max(now()+30_000,Math.min(...state.jobs.map(job=>job.due)))});
    else await api.alarms.clear(ALARM);
  };

  async function flushInternal() {
    const state=await read();
    if (!state.config || state.authInvalid) return;
    for (const job of [...state.jobs].filter(job=>job.due<=now())) {
      const key=job.origin+'|'+(job.storeId || 'default');
      if (job.attempts>=4) {
        state.jobs=state.jobs.filter(item=>item!==job);
        state.lastError='同步重试次数已耗尽，请完成网站登录或点击同步按钮重试';
        await write(state);continue;
      }
      job.attempts++;
      try {
        const origins=[state.config.workerOrigin+'/*',job.origin+'/*'];
        if (!await api.permissions.contains({origins})) throw Object.assign(new Error('网站或服务权限已移除，请重新保存扩展设置'),{permanent:true});
        const cookies=await api.cookies.getAll({url:job.origin+'/user',...(job.storeId?{storeId:job.storeId}:{})});
        const cookie=cookieHeader(cookies,now());
        if (!cookie) {
          if (['login','manual'].includes(job.reason)) state.lastError='浏览器中没有有效登录 Cookie，请先登录当前网站';
          state.jobs=state.jobs.filter(item=>item!==job);continue;
        }
        const hash=await cookieHash(cookie),sent=state.sent[key];
        if (hash===sent?.hash && (!['login','manual'].includes(job.reason) ||
          (job.reason==='login' && sent.documentId===job.documentId))) {
          if (job.documentId) state.sent[key].documentId=job.documentId;
          state.jobs=state.jobs.filter(item=>item!==job);continue;
        }
        // Persist before starting I/O; a terminated worker retries with its used budget.
        job.due=now()+60_000;await write(state);
        const response=await fetcher(state.config.workerOrigin+'/api/sync/cookie',{
          method:'POST',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20_000),
          headers:{'Content-Type':'application/json',Authorization:'Bearer '+state.config.token},
          body:JSON.stringify({cookie,domain:new URL(job.origin).hostname,reason:job.reason}),
        });
        if (!response.ok) {
          const error=Object.assign(new Error(errorMessage(response.status)),{permanent:response.status>=400 && response.status<500 && ![408,429].includes(response.status),unauthorized:response.status===401});
          const seconds=Number(response.headers.get('Retry-After'));
          if (Number.isFinite(seconds) && seconds>0) error.retryAfter=Math.min(seconds*1000,86_400_000);
          throw error;
        }
        const reply=await response.json();
        if (reply.ok!==true || !Number.isFinite(reply.syncedAt)) throw new Error('无法识别签到服务响应');
        state.sent[key]={hash,at:now(),documentId:job.documentId || null};
        state.lastSyncAt=reply.syncedAt;state.lastDomain=new URL(job.origin).hostname;state.lastError=null;
        state.jobs=state.jobs.filter(item=>item!==job);
      } catch (error) {
        state.lastError=error.permanent?error.message:job.attempts>=4?'同步重试次数已耗尽，请完成网站登录或点击同步按钮重试':'暂时无法同步，正在按 1、5、30 分钟间隔重试';
        if (error.unauthorized) {state.authInvalid=true;state.jobs=[];break;}
        const delay=DELAYS[Math.max(0,job.attempts-1)];
        if (error.permanent || job.attempts>=4) state.jobs=state.jobs.filter(item=>item!==job);
        else job.due=now()+Math.max(delay,error.retryAfter || 0);
      }
      await write(state);
    }
    await write(state);
  }

  const flush=()=>exclusive(flushInternal);
  async function enqueue(origin,{storeId,reason='change',documentId}={}) {
    await exclusive(async()=>{
      const state=await read();
      if (!state.config || state.authInvalid || !state.config.sites.includes(origin)) return;
      const existing=state.jobs.find(job=>job.origin===origin && job.storeId===storeId);
      if (existing && !['login','manual'].includes(reason)) return;
      state.jobs=state.jobs.filter(job=>job!==existing);
      state.jobs.push({origin,storeId,reason,documentId,attempts:0,due:now()+(['login','manual'].includes(reason)?0:700)});
      await write(state);
    });
    if (!['login','manual'].includes(reason)) await new Promise(resolve=>setTimeout(resolve,750));
    await flush();
  }

  async function forTab(tab) {
    const state=await read();
    if (!state.config || !tab || tab.incognito) return null;
    const origin=sourceOrigin(tab.url,state.config.sites);
    if (!origin) return null;
    const stores=await api.cookies.getAllCookieStores();
    return {origin,storeId:stores.find(store=>store.tabIds.includes(tab.id))?.id};
  }

  return {
    flush,
    async status() {
      const state=await read();
      return {workerOrigin:state.config?.workerOrigin || '',sites:state.config?.sites || [],paired:!!state.config,authInvalid:state.authInvalid,
        lastSyncAt:state.lastSyncAt,lastDomain:state.lastDomain,lastError:state.lastError,pending:state.jobs.length};
    },
    async configure(input) {
      await exclusive(async()=>{
        const state=await read();
        const token=input.token || (state.config?.workerOrigin===new URL(input.workerUrl).origin?state.config.token:'');
        const config=configuration(input.workerUrl,token,input.sites);
        if (!await api.permissions.contains({origins:[config.workerOrigin,...config.sites].map(origin=>origin+'/*')})) throw new Error('请允许访问所选网站和签到服务');
        await api.scripting.unregisterContentScripts();
        await api.scripting.registerContentScripts([{id:'ikuuu-login-detector',matches:config.sites.map(origin=>origin+'/*'),js:['login-detector.js'],runAt:'document_idle',allFrames:false}]);
        await write({...initial(),config});
      });
      const state=await read();
      const stores=await api.cookies.getAllCookieStores();
      for (const origin of state.config.sites) await enqueue(origin,{reason:'startup',storeId:stores[0]?.id});
      return this.status();
    },
    async login(sender) {
      const source=await forTab(sender.tab);
      if (!source || !/^\/user(?:\/|$)/.test(new URL(sender.url || sender.tab.url).pathname) || sourceOrigin(sender.url || sender.tab.url,[source.origin])!==source.origin) return;
      return enqueue(source.origin,{...source,reason:'login',documentId:sender.documentId || String(sender.tab.id)+':'+sender.url});
    },
    async changed(change) {
      if (!['uid','key','expire_in','PHPSESSID'].includes(change.cookie.name)) return;
      const state=await read(),domain=change.cookie.domain.replace(/^\./,'');
      const origin=state.config?.sites.find(site=>new URL(site).hostname===domain);
      if (origin) await enqueue(origin,{storeId:change.cookie.storeId,reason:'change'});
    },
    async manual(tab) {
      const source=await forTab(tab);
      if (!source) throw new Error('请先在当前标签页打开已配置的 iKuuu 网站并登录');
      await enqueue(source.origin,{...source,reason:'manual'});
      return this.status();
    },
    async startup() {
      await exclusive(async()=>{await write(await read());});
      await flush();
    },
    async forget() {
      await exclusive(async()=>{
        await api.scripting.unregisterContentScripts();
        await write(initial());
      });
      return this.status();
    },
  };
}
