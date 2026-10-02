import {env,exports} from 'cloudflare:workers';
import {runInDurableObject,evictDurableObject} from 'cloudflare:test';
import {test,expect} from 'vitest';
import {AuthManager} from '../../src/auth.js';
import {CheckinEngine} from '../../src/engine.js';
import {SiteError} from '../../src/client.js';
import {decryptCookie} from '../../src/security.js';

const start=Date.parse('2026-10-02T08:17:00+08:00');
const cookie='uid=1; expire_in=1893456000; key=browser';
const nextCookie='uid=1; expire_in=1893456001; key=next';
const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const password='browser-test-password';
const settings={...env,IKUUU_EMAIL:'test@example.com',IKUUU_PASSWORD:'website-password',COOKIE_ENCRYPTION_KEY:secret};

async function scenario(action) {
  const stub=env.CHECKIN.getByName(crypto.randomUUID());
  await runInDurableObject(stub,async(instance,ctx)=>{
    let now=start,reads=0,posts=0;
    const client={account:async()=>{reads++;return {remaining:'40 GB'};},verifyDomain:async()=>({remaining:'40 GB'}),checkin:async()=>{posts++;return {status:'success',gained:'100 MB'};}};
    instance.engine=new CheckinEngine(ctx.storage,settings,{now:()=>now,client,mail:async()=> 'accepted'});
    instance.auth=new AuthManager(ctx.storage,settings,{now:()=>now});
    await instance.recover(env.ADMIN_TOKEN,password,'test');
    const admin=(await instance.login(password,'test')).data.token;
    const device=(await instance.manage('sync/pair',{name:'Chrome'},admin)).data;
    const sync=(value=cookie,reason='login',domain='ikuuu.top')=>instance.syncCookie({cookie:value,reason,domain},device.token);
    await action({instance,ctx,client,admin,device,sync,advance:ms=>now+=ms,now:()=>now,counts:()=>({reads,posts})});
    await ctx.storage.deleteAll();
  });
}

test('pairing disables password login and a device can only sync credentials, not access management',async()=>{
  await scenario(async({instance,device,ctx,admin,sync})=>{
    expect((await instance.manage('status',{},admin)).data).toMatchObject({credentialMode:'browser',autoLogin:{configured:false}});
    expect((await instance.manage('status',{},device.token)).status).toBe(401);
    expect((await instance.syncCookie({cookie,domain:'ikuuu.top'},admin)).status).toBe(401);
    expect((await sync()).ok).toBe(true);
    const auth=await ctx.storage.get('auth');
    expect(JSON.stringify(auth)).not.toContain(device.token);
    expect(JSON.stringify(auth)).not.toContain('website-password');
    const listed=(await instance.manage('sync/devices',{},admin)).data;
    expect(listed.devices[0]).toMatchObject({name:'Chrome',lastSyncAt:start});
    expect(JSON.stringify(listed)).not.toContain(auth.devices[0].hash);
    const result=(await instance.engine.status());
    expect(JSON.stringify(result)).not.toContain('key=browser');
    expect(result.jobs.some(job=>job.type==='login')).toBe(false);
    expect(await decryptCookie((await ctx.storage.get('state')).credentials.encrypted,secret)).toBe(cookie);
  });
});

test('each website login revalidates and records even unchanged Cookie without repeating checkin',async()=>{
  await scenario(async({instance,sync,advance,counts,now})=>{
    await sync();await instance.alarm();
    const before=counts().reads;
    advance(6_000);
    const result=await sync();
    expect(result.data).toMatchObject({ok:true,changed:false,syncedAt:now()});
    await instance.alarm();
    expect(counts().reads).toBe(before+1);expect(counts().posts).toBe(1);
    expect((await instance.engine.status()).credential.version).toBe(1);
  });
});

test('device pairing remains usable after the seven-day admin session expires',async()=>{
  await scenario(async({instance,admin,sync,advance})=>{
    advance(8*86_400_000);
    expect((await instance.manage('status',{},admin)).status).toBe(401);
    expect((await sync()).ok).toBe(true);
  });
});

test('revocation and password reset immediately revoke extension tokens without changing saved Cookie',async()=>{
  await scenario(async({instance,admin,device,sync,ctx})=>{
    await sync();const before=await ctx.storage.get('state');
    await instance.manage('sync/revoke',{id:device.id},admin);
    expect((await sync()).status).toBe(401);
    const second=(await instance.manage('sync/pair',{name:'Edge'},admin)).data;
    await instance.recover(env.ADMIN_TOKEN,'changed-password','test');
    expect((await instance.syncCookie({cookie,domain:'ikuuu.top'},second.token)).status).toBe(401);
    expect((await ctx.storage.get('state')).credentials).toEqual(before.credentials);
  });
});

test('new browser credentials resume blocked runs without resetting attempts or failed budgets',async()=>{
  await scenario(async({instance,sync,client,advance})=>{
    await sync();client.account=async()=>{throw new SiteError('cookie','expired');};
    await instance.alarm();
    expect((await instance.engine.status()).todayRun).toMatchObject({attempts:1,status:'blocked_cookie'});
    client.account=async()=>({remaining:'40 GB'});advance(6_000);
    await sync(nextCookie);await instance.alarm();
    expect((await instance.engine.status()).todayRun).toMatchObject({version:2,attempts:2,status:'success'});
    await instance.engine.load();instance.engine.state.lastSuccessDate=null;
    instance.engine.state.runs['2026-10-02'].status='failed';instance.engine.state.runs['2026-10-02'].attempts=4;
    await instance.engine.save();advance(6_000);
    await sync(nextCookie.replace('key=next','key=third'));await instance.alarm();
    expect((await instance.engine.status()).todayRun).toMatchObject({version:3,status:'failed',attempts:4});
  });
});

test('sync stores new credentials while paused and cannot unpause the scheduler',async()=>{
  await scenario(async({instance,sync,counts})=>{
    await instance.pause(true);expect((await sync()).ok).toBe(true);await instance.alarm();
    const s=await instance.engine.status();
    expect(s.enabled).toBe(false);expect(counts().posts).toBe(0);
    expect(s.jobs.some(job=>['run','daily','login'].includes(job.type))).toBe(false);
    await instance.pause(false);await instance.alarm();expect(counts().posts).toBe(1);
  });
});

test('invalid, foreign-account, stale and unverifiable Cookies never replace saved credentials',async()=>{
  await scenario(async({instance,sync,ctx,advance,client})=>{
    await sync();const before=(await ctx.storage.get('state')).credentials;
    for(const [value,domain,status] of [
      ['uid=1; key=bad','ikuuu.top',422],
      [nextCookie,'evil.example',422],
      [nextCookie.replace('uid=1','uid=2'),'ikuuu.top',409],
      [cookie.replace('1893456000','1893455999'),'ikuuu.top',409],
    ]) {
      advance(6_000);expect((await sync(value,'login',domain)).status).toBe(status);
      expect((await ctx.storage.get('state')).credentials).toEqual(before);
    }
    client.account=async()=>{throw new SiteError('network','offline');};
    advance(6_000);expect((await sync(nextCookie)).status).toBe(503);
    expect((await ctx.storage.get('state')).credentials).toEqual(before);
    client.account=async()=>{throw new SiteError('cookie','expired');};
    advance(6_000);expect((await sync(nextCookie)).status).toBe(422);
    expect((await ctx.storage.get('state')).credentials).toEqual(before);
  });
});

test('a changed website domain must be verified before becoming current',async()=>{
  await scenario(async({instance,sync,advance,client})=>{
    await sync();advance(6_000);client.verifyDomain=async()=>{throw new SiteError('domain','unverified');};
    expect((await sync(nextCookie,'login','ikuuu.pw')).status).toBe(503);
    expect((await instance.engine.status()).currentDomain).toBe('ikuuu.top');
    advance(6_000);client.verifyDomain=async()=>({remaining:'40 GB'});
    expect((await sync(nextCookie,'login','ikuuu.pw')).ok).toBe(true);
    expect((await instance.engine.status()).currentDomain).toBe('ikuuu.pw');
  });
});

test('paired device authorization persists across object eviction',async()=>{
  const stub=env.CHECKIN.getByName(crypto.randomUUID());
  await stub.recover(env.ADMIN_TOKEN,password,'eviction');
  const login=await stub.login(password,'eviction');
  const device=(await stub.manage('sync/pair',{name:'Chrome'},login.data.token)).data;
  await evictDurableObject(stub);
  await runInDurableObject(stub,async(instance,ctx)=>{
    expect((await instance.auth.requireDevice(device.token)).id).toBe(device.id);
    await ctx.storage.deleteAll();
  });
});

test('HTTP extension sync permits only extension CORS and device Bearer auth, with no credential or history disclosure',async()=>{
  const stub=env.CHECKIN.getByName(env.ACCOUNT_NAME || 'primary-account');
  await runInDurableObject(stub,async(instance,ctx)=>{
    await ctx.storage.deleteAll();instance.engine.now=()=>start;
    instance.engine.client={account:async()=>({remaining:'40 GB'})};
  });
  await stub.recover(env.ADMIN_TOKEN,password,'http');
  const admin=(await stub.login(password,'http')).data.token;
  const call=(path,method='POST',token='',origin='',body={cookie,domain:'ikuuu.top',reason:'login'})=>exports.default.fetch('https://test/api/'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(origin?{Origin:origin}:{})},...(method==='POST'?{body:JSON.stringify(body)}:{})});
  const device=await (await call('sync/pair','POST',admin,'https://test',{name:'Chrome'})).json();
  const origin='chrome-extension://'+'a'.repeat(32);
  const preflight=await call('sync/cookie','OPTIONS','',origin);
  expect(preflight.status).toBe(204);expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  expect((await call('sync/cookie','POST',device.token,'https://evil.example')).status).toBe(403);
  expect((await call('sync/cookie','POST',admin,origin)).status).toBe(401);
  expect((await call('sync/cookie','POST','',origin)).status).toBe(401);
  const response=await call('sync/cookie','POST',device.token,origin);
  expect(response.status).toBe(200);expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  const value=await response.text();expect(value).not.toContain('key=browser');expect(value).not.toContain('history');
  expect((await call('sync/cookie','POST',device.token,origin)).status).toBe(429);
  expect((await call('sync/devices','GET',device.token)).status).toBe(401);
  expect((await call('sync/cookie','POST',device.token,origin,[])).status).toBe(400);
  await runInDurableObject(stub,async(_,ctx)=>ctx.storage.deleteAll());
});
