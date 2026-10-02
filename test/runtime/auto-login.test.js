import {env,exports} from 'cloudflare:workers';
import {runInDurableObject, evictDurableObject} from 'cloudflare:test';
import {test, expect} from 'vitest';
import {CheckinEngine} from '../../src/engine.js';
import {createClient, SiteError} from '../../src/client.js';
import {decryptCookie} from '../../src/security.js';
import {SiteCookies} from '../../src/site-cookies.js';

const start=Date.parse('2026-10-02T08:17:00+08:00');
const date='2026-10-02';
const oldCookie=`uid=1; expire_in=${(start+7*86_400_000)/1000}; key=old`;
const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const settings={...env,COOKIE_ENCRYPTION_KEY:secret,IKUUU_EMAIL:'person@example.com',IKUUU_PASSWORD:'test-password'};

async function scenario(fn) {
  const stub=env.CHECKIN.getByName(crypto.randomUUID());
  await runInDurableObject(stub,async(_,ctx)=>{
    let now=start, posts=0, logins=0;
    const newCookie=()=>`uid=1; expire_in=${Math.floor((now+7*86_400_000)/1000)}; key=new`;
    const client={
      account:async()=>({remaining:'40 GB'}),
      checkin:async()=>{posts++;return {status:'success',gained:'100 MB'};},
      login:async()=>{logins++;return {cookie:newCookie(),remaining:'40 GB'};},
    };
    const sent=[];
    const engine=new CheckinEngine(ctx.storage,settings,{now:()=>now,client,mail:async(_,notice)=>{sent.push(notice);return 'accepted';}});
    await fn({engine,client,sent,ctx,advance:ms=>now+=ms,now:()=>now,newCookie,counts:()=>({posts,logins})});
    await ctx.storage.deleteAll();
  });
}

test('first status with Secrets schedules login and completes today without a manually supplied Cookie',async()=>{
  await scenario(async({engine,ctx,counts,now})=>{
    const s=await engine.status();
    expect(s.jobs).toEqual([{id:'login',type:'login',due:now()}]);
    await engine.alarm();
    expect((await engine.status()).todayRun).toMatchObject({status:'success',attempts:1});
    expect(counts()).toEqual({posts:1,logins:1});
    const state=await ctx.storage.get('state');
    expect(await decryptCookie(state.credentials.encrypted,secret)).toContain('key=new');
    expect(JSON.stringify(state)).not.toContain(settings.IKUUU_PASSWORD);
    expect(JSON.stringify(await engine.status())).not.toContain('key=new');
    expect((await engine.status()).autoLogin.nextAttemptAt).toBe(now()+6*86_400_000);
  });
});

test('early Cookie expiry accelerates scheduled renewal, preserves attempts and resumes the unfinished checkin',async()=>{
  await scenario(async({engine,client,counts})=>{
    await engine.updateCookie(oldCookie);
    let reads=0;
    client.account=async()=>{if(reads++===0)throw new SiteError('cookie','expired');return {remaining:'40 GB'};};
    await engine.alarm();
    expect(counts()).toEqual({posts:1,logins:1});
    expect((await engine.status()).todayRun).toMatchObject({version:2,attempts:2,status:'success'});
    expect((await engine.status()).blocked).toBe(false);
  });
});

test('Alarm renews at expiry minus 24 hours, and repeated manual renewal cannot create a rapid login loop',async()=>{
  await scenario(async({engine,ctx,advance,now,counts})=>{
    await engine.updateCookie(oldCookie);await engine.alarm();
    advance(6*86_400_000);await engine.alarm();
    expect(counts().logins).toBe(1);
    expect((await ctx.storage.get('state')).credentials.expiry*1000).toBe(now()+7*86_400_000);
    await expect(engine.renewCookie()).rejects.toMatchObject({status:429});
    expect(counts().logins).toBe(1);
  });
});

test('manual renewal executes immediately while today already succeeded; automatic changes cannot reset failed budget',async()=>{
  await scenario(async({engine,counts,advance})=>{
    await engine.updateCookie(oldCookie);await engine.alarm();
    await engine.renewCookie();await engine.alarm();
    expect(counts()).toEqual({posts:1,logins:1});
    expect((await engine.status()).lastSuccessDate).toBe(date);
    await engine.load();
    engine.state.lastSuccessDate=null;
    engine.state.runs[date]={version:2,date,status:'failed',attempts:4};
    await engine.save();advance(60_000);
    await engine.renewCookie();await engine.alarm();
    expect((await engine.status()).todayRun).toMatchObject({version:3,status:'failed',attempts:4});
    expect(counts().posts).toBe(1);
  });
});

test('verification requirement retains usable old Cookie, sends one notice and stops automatic login attempts',async()=>{
  await scenario(async({engine,client,ctx,counts,sent,advance})=>{
    await engine.updateCookie(oldCookie);await engine.alarm();
    let logins=0;
    client.login=async()=>{logins++;throw new SiteError('verification','网站要求验证码');};
    await engine.renewCookie();await engine.alarm();
    const s=await engine.status();
    expect(s.autoLogin.status).toBe('manual_required');
    expect(s.blocked).toBe(false);
    expect(s.jobs.some(j=>j.type==='login')).toBe(false);
    expect(await decryptCookie((await ctx.storage.get('state')).credentials.encrypted,secret)).toBe(oldCookie);
    advance(60_000);await engine.alarm();await engine.status();
    expect(logins).toBe(1);expect(counts().posts).toBe(1);
    expect(sent.filter(n=>n.type==='auto-login')).toHaveLength(1);
  });
});

test('login network retry uses a separate durable 10/30/100 minute budget and backs off for a day after exhaustion',async()=>{
  await scenario(async({engine,client,advance,now,counts,sent})=>{
    let attempts=0;
    client.login=async()=>{attempts++;throw new SiteError('network','断线');};
    await engine.status();
    for(const minutes of [10,30,100]) {
      await engine.alarm();
      expect((await engine.status()).autoLogin.nextAttemptAt).toBe(now()+minutes*60_000);
      advance(minutes*60_000);
    }
    await engine.alarm();
    expect(attempts).toBe(4);expect(counts().posts).toBe(0);
    expect((await engine.status()).autoLogin).toMatchObject({status:'failed',attempts:4,nextAttemptAt:now()+86_400_000});
    expect(sent.filter(n=>n.type==='auto-login')).toHaveLength(1);
    await engine.runNow();await engine.alarm();expect(attempts).toBe(4);
  });
});

test('wrong credentials stop retries; updating a different manual Cookie can recover',async()=>{
  await scenario(async({engine,client,advance,newCookie})=>{
    client.login=async()=>{throw new SiteError('login','账户或密码错误');};
    await engine.status();await engine.alarm();
    expect((await engine.status()).autoLogin.status).toBe('invalid_credentials');
    expect((await engine.status()).jobs.some(j=>j.type==='login')).toBe(false);
    advance(60_000);await engine.updateCookie(newCookie());await engine.alarm();
    expect((await engine.status()).todayRun.status).toBe('success');
  });
});

test('expiry cannot bypass the 24-hour login cooldown after renewal exhausts its budget',async()=>{
  await scenario(async({engine,client,advance,now})=>{
    await engine.updateCookie(oldCookie);await engine.alarm();
    let logins=0;
    client.login=async()=>{logins++;throw new SiteError('network','断线');};
    advance(6*86_400_000);
    for(const minutes of [10,30,100]) {await engine.alarm();advance(minutes*60_000);}
    await engine.alarm();
    expect(logins).toBe(4);
    const cooldown=now()+86_400_000;
    advance(start+7*86_400_000-now());
    client.account=async()=>{throw new SiteError('cookie','expired');};
    await engine.alarm();await engine.renewCookie();await engine.runNow();await engine.alarm();
    expect(logins).toBe(4);
    expect((await engine.status()).autoLogin.nextAttemptAt).toBe(cooldown);
  });
});

test('short-lived new Cookie never replaces the old credential or creates an immediate login loop',async()=>{
  await scenario(async({engine,client,ctx,now})=>{
    await engine.updateCookie(oldCookie);await engine.alarm();
    client.login=async()=>({cookie:`uid=1; expire_in=${(now()+1000)/1000}; key=short`});
    await engine.renewCookie();await engine.alarm();
    expect((await engine.status()).autoLogin.status).toBe('retrying');
    expect(await decryptCookie((await ctx.storage.get('state')).credentials.encrypted,secret)).toBe(oldCookie);
  });
});

test('passive Set-Cookie renewal keeps credential version and attempt count',async()=>{
  await scenario(async({engine,client,newCookie,ctx,counts})=>{
    await engine.updateCookie(oldCookie);
    client.account=async()=>({remaining:'40 GB',cookie:newCookie()});
    await engine.alarm();
    expect((await engine.status()).todayRun).toMatchObject({version:1,attempts:1,status:'success'});
    expect(counts()).toEqual({posts:1,logins:0});
    expect(await decryptCookie((await ctx.storage.get('state')).credentials.encrypted,secret)).toBe(newCookie());
  });
});

test('paused service performs no automatic login, and an interrupted login keeps its original attempt budget',async()=>{
  await scenario(async({engine,ctx,counts,now})=>{
    await engine.status();await engine.pause(true);await engine.alarm();
    expect(counts().logins).toBe(0);
    await engine.pause(false);await engine.load();
    const job=engine.state.jobs.find(j=>j.type==='login');job.attempts=1;job.running=true;job.due=now();
    await engine.save();await engine.alarm();
    expect(counts().logins).toBe(0);
    expect((await ctx.storage.get('state')).jobs.find(j=>j.type==='login')).toMatchObject({attempts:1,due:now()+600_000,running:false});
  });
});

test('persisted login work survives Durable Object eviction',async()=>{
  const stub=env.CHECKIN.getByName(crypto.randomUUID());
  await runInDurableObject(stub,async(instance,ctx)=>{
    instance.engine.env=settings;instance.engine.now=()=>start;
    await instance.engine.status();
    await ctx.storage.setAlarm(Date.now()+60_000);
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub,async(_,ctx)=>{
    expect((await ctx.storage.get('state')).jobs.find(j=>j.type==='login')).toMatchObject({attempts:0,due:start});
    await ctx.storage.deleteAll();
  });
});

test('login matches the live form and carries all session Cookies across GET, POST and account verification',async()=>{
  const calls=[];
  const client=createClient(async(url,options)=>{
    calls.push({url,options});
    if(calls.length===1) return new Response('<input name="password">Login',{headers:{'Set-Cookie':'PHPSESSID=initial; Path=/; HttpOnly'}});
    if(calls.length===2) {
      const headers=new Headers({'Content-Type':'application/json'});
      for(const value of ['uid=1; Path=/','key=secret; Path=/','expire_in=1893456000; Path=/','PHPSESSID=rotated; Path=/']) headers.append('Set-Cookie',value);
      return new Response(JSON.stringify({phase:'authenticated'}),{headers});
    }
    return new Response('<div>剩余流量 40 GB</div>',{headers:{'Set-Cookie':'key=new; Path=/; Expires=Tue, 01 Jan 2030 00:00:00 GMT'}});
  });
  const result=await client.login('ikuuu.top','person@example.com','a&b=中文');
  const form=new URLSearchParams(calls[1].options.body);
  expect(form.get('passwd')).toBe('a&b=中文');expect(form.get('phase')).toBe('password');expect(form.get('remember_me')).toBe('on');
  expect(calls[1].options.headers.Cookie).toBe('PHPSESSID=initial');
  expect(calls[2].options.headers.Cookie).toContain('PHPSESSID=rotated');
  expect(result.cookie).toContain('key=new');expect(result.remaining).toBe('40 GB');
  expect(calls.every(c=>c.options.redirect==='manual')).toBe(true);
});

test('login recognizes verification phases and legacy success, rejects missing Cookie and never echoes a server message',async()=>{
  for(const reply of [{phase:'totp'},{phase:'email_code'},{phase:'reverse_email_verify'},{phase:'password',result:'captcha_failed',msg:settings.IKUUU_PASSWORD}]) {
    let calls=0;
    const client=createClient(async()=>++calls===1 ? new Response('<input name="password">Login') : Response.json(reply));
    await expect(client.login('ikuuu.top',settings.IKUUU_EMAIL,settings.IKUUU_PASSWORD)).rejects.toMatchObject({kind:'verification'});
  }
  let calls=0;
  const client=createClient(async()=>{
    calls++;
    if(calls===1)return new Response('<input name="password">Login');
    if(calls===2)return Response.json({ret:1},{headers:{'Set-Cookie':'key=new; Path=/'}});
    return new Response('剩余流量 40 GB');
  });
  await expect(client.login('ikuuu.top',settings.IKUUU_EMAIL,settings.IKUUU_PASSWORD)).rejects.toMatchObject({kind:'response'});
  const denied=createClient(async()=>new Response('',{status:302,headers:{Location:'https://example.com/'}}));
  await expect(denied.login('ikuuu.top',settings.IKUUU_EMAIL,settings.IKUUU_PASSWORD)).rejects.toMatchObject({kind:'domain'});
});

test('Cookie collection honors deletions, expiry dates, paths and domains without splitting Expires commas',()=>{
  const jar=new SiteCookies('ikuuu.top','key=old; uid=1',start);
  const headers=new Headers();
  for(const value of ['key=new; Path=/; Expires=Tue, 01 Jan 2030 00:00:00 GMT','uid=; Path=/; Max-Age=0','auth=only; Path=/auth','bad=secret; Domain=example.com; Path=/']) headers.append('Set-Cookie',value);
  jar.receive(headers,'/auth/login');
  expect(jar.header('/user')).toBe('key=new');
  expect(jar.header('/auth/login')).toBe('key=new; auth=only');
  expect(jar.header('/authentication')).toBe('key=new');
});

test('renew-cookie management endpoint requires a session and safely reports missing Secrets',async()=>{
  const origin='https://test';
  const request=token=>exports.default.fetch(origin+'/api/renew-cookie',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:'{}'});
  expect((await request()).status).toBe(401);
  const stub=env.CHECKIN.getByName(env.ACCOUNT_NAME || 'primary-account');
  await stub.recover(env.ADMIN_TOKEN,'test-password','renew-endpoint');
  const login=await stub.login('test-password','renew-endpoint');
  const response=await request(login.data.token);
  expect(response.status).toBe(400);
  expect(await response.text()).toContain('IKUUU_EMAIL');
  await runInDurableObject(stub,async(_,ctx)=>{await ctx.storage.deleteAll();});
});
