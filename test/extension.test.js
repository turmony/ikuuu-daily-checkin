import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {cookieHeader,configuration} from '../extension/core.js';
import {createSyncController} from '../extension/sync.js';

const token='sync_'+'a'.repeat(43);
const cookie=()=>[
  {name:'uid',value:'1',path:'/'},
  {name:'expire_in',value:'1893456000',path:'/'},
  {name:'key',value:'http-only-secret',path:'/',httpOnly:true},
];
const input={workerUrl:'https://own.workers.dev',token,sites:['https://ikuuu.top']};
function fixture(fetcher) {
  let offset=0,cookies=cookie(),permitted=true;
  const data={},alarms=new Map(),calls=[],scripts=[];
  const now=()=>Date.now()+offset;
  const api={
    storage:{local:{get:async key=>({[key]:structuredClone(data[key])}),set:async value=>{Object.assign(data,structuredClone(value));}}},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},
    alarms:{create:async(name,value)=>{alarms.set(name,value);},clear:async name=>alarms.delete(name)},
    permissions:{contains:async()=>permitted},
    scripting:{unregisterContentScripts:async()=>{scripts.length=0;},registerContentScripts:async value=>{scripts.push(...value);}},
    cookies:{getAll:async()=>cookies,getAllCookieStores:async()=>[{id:'0',tabIds:[7]}]},
  };
  const fetch=async(url,options)=>{calls.push({url,options});return fetcher?fetcher(url,options,now()):Response.json({ok:true,syncedAt:now()});};
  const fresh=()=>createSyncController(api,fetch,now);
  const sender=(documentId='doc-1',url='https://ikuuu.top/user')=>({documentId,url,tab:{id:7,url,incognito:false}});
  return {controller:fresh(),fresh,api,calls,data,alarms,scripts,sender,now,advance:ms=>offset+=ms,setCookies:value=>cookies=value,setPermissions:value=>permitted=value};
}

test('configuration restricts HTTPS origins; Cookie collection includes HttpOnly and excludes expired or partitioned credentials',()=>{
  assert.throws(()=>configuration('http://own.example',token,input.sites));
  assert.throws(()=>configuration(input.workerUrl,token,['https://ikuuu.top.evil.example']));
  assert.throws(()=>configuration(input.workerUrl,token,['https://ikuuu.top:8443']));
  assert.throws(()=>configuration(input.workerUrl,'admin-token',input.sites));
  const value=cookieHeader([...cookie(),{name:'bad',value:'old',expirationDate:1,path:'/'},{name:'key',value:'partitioned',partitionKey:{topLevelSite:'https://other'},path:'/user'}]);
  assert.ok(value.includes('key=http-only-secret'));assert.ok(!value.includes('partitioned'));assert.ok(!value.includes('bad='));
  assert.equal(cookieHeader(cookie().filter(c=>c.name!=='key')),null);
});

test('pairing immediately syncs existing login and never exposes tokens through status or sends them in Cookie headers',async()=>{
  const f=fixture();await f.controller.configure(input);
  assert.equal(f.calls.length,1);assert.equal(f.scripts[0].matches[0],'https://ikuuu.top/*');
  const {url,options}=f.calls[0];
  assert.equal(url,'https://own.workers.dev/api/sync/cookie');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  assert.equal(options.headers.Authorization,'Bearer '+token);assert.equal(options.headers.Cookie,undefined);
  assert.ok(JSON.parse(options.body).cookie.includes('http-only-secret'));
  assert.ok(!JSON.stringify(await f.controller.status()).includes(token));
  assert.ok(!JSON.stringify(f.data).includes('http-only-secret'));
});

test('successful site login forces one update even when Cookie is unchanged; duplicate document signals are coalesced',async()=>{
  const f=fixture();await f.controller.configure(input);
  await f.controller.login(f.sender());
  assert.equal(f.calls.length,2);assert.equal(JSON.parse(f.calls[1].options.body).reason,'login');
  f.advance(6_000);await f.controller.login(f.sender());assert.equal(f.calls.length,2);
  await f.controller.login(f.sender('doc-2'));assert.equal(f.calls.length,3);
});

test('manual sync after logout does not report an earlier upload as current success',async()=>{
  const f=fixture();await f.controller.configure(input);f.setCookies([]);
  const status=await f.controller.manual(f.sender().tab);
  assert.ok(status.lastSyncAt);assert.equal(status.pending,0);
  assert.match(status.lastError,/没有有效登录 Cookie/);assert.equal(f.calls.length,1);
});

test('a content script on another origin, login page or private window cannot trigger a sync',async()=>{
  const f=fixture();await f.controller.configure(input);f.advance(6_000);
  await f.controller.login(f.sender('evil','https://evil.example/user'));
  await f.controller.login(f.sender('login','https://ikuuu.top/auth/login'));
  const sender=f.sender();sender.tab.incognito=true;await f.controller.login(sender);
  assert.equal(f.calls.length,1);
});

test('Cookie overwrite notifications coalesce and logout never uploads an empty or deleted session',async()=>{
  const f=fixture();await f.controller.configure(input);
  f.setCookies(cookie().map(c=>c.name==='key'?{...c,value:'changed'}:c));
  const change={cookie:{name:'key',domain:'.ikuuu.top',storeId:'0'}};
  await Promise.all([f.controller.changed({...change,removed:true,cause:'overwrite'}),f.controller.changed({...change,removed:false,cause:'explicit'})]);
  assert.equal(f.calls.length,2);
  f.setCookies([]);await f.controller.changed({...change,removed:true,cause:'explicit'});assert.equal(f.calls.length,2);
});

test('network retry survives a service-worker restart and retains its attempt budget',async()=>{
  let attempts=0;
  const f=fixture((_,__,now)=>{if(++attempts===1)throw new Error('network');return Response.json({ok:true,syncedAt:now});});
  await f.controller.configure(input);
  assert.equal(f.data.ikuuuSync.jobs[0].attempts,1);assert.ok(f.alarms.has('ikuuu-sync-retry'));
  f.advance(61_000);const restarted=f.fresh();await restarted.flush();
  assert.equal(attempts,2);assert.equal((await restarted.status()).pending,0);assert.ok((await restarted.status()).lastSyncAt);
});

test('revoked pairing stops background attempts until the user configures a new token',async()=>{
  const f=fixture(()=>Response.json({error:'revoked'},{status:401}));await f.controller.configure(input);
  assert.equal((await f.controller.status()).authInvalid,true);
  f.advance(60_000);await f.controller.login(f.sender());await f.controller.flush();assert.equal(f.calls.length,1);
});

test('interruption after the fourth reserved upload never starts a fifth request',async()=>{
  const f=fixture();await f.controller.configure(input);
  f.data.ikuuuSync.jobs=[{origin:input.sites[0],storeId:'0',reason:'manual',attempts:4,due:f.now()-1}];
  await f.fresh().flush();assert.equal(f.calls.length,1);assert.equal(f.data.ikuuuSync.jobs.length,0);
});

test('removed host permissions stop uploads and forgetting pairing clears pending jobs and token',async()=>{
  const f=fixture();await f.controller.configure(input);f.advance(6_000);f.setPermissions(false);
  await f.controller.login(f.sender());assert.equal(f.calls.length,1);assert.equal((await f.controller.status()).pending,0);
  await f.controller.forget();assert.equal(f.data.ikuuuSync.config,null);assert.equal(f.scripts.length,0);
});

test('login detector reports an asynchronously rendered account page once and never reads document.cookie',()=>{
  const messages=[],body={textContent:''};let callback;
  const document={body,documentElement:{},get cookie(){throw new Error('Cookie must only be read by the background API');}};
  const context={document,location:{pathname:'/user'},MutationObserver:class{constructor(fn){callback=fn;}observe(){}disconnect(){}},
    chrome:{runtime:{sendMessage:message=>{messages.push(message);return Promise.resolve();}}},setTimeout:()=>1,clearTimeout:()=>{}};
  vm.runInNewContext(readFileSync(new URL('../extension/login-detector.js',import.meta.url),'utf8'),context);
  assert.equal(messages.length,0);body.textContent='剩余流量 40 GB';callback();callback();assert.equal(messages.length,1);assert.equal(messages[0].type,'site-login');
});
