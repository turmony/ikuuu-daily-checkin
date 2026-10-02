import {env, exports} from 'cloudflare:workers';
import {runInDurableObject, runDurableObjectAlarm, evictDurableObject} from 'cloudflare:test';
import {test, expect} from 'vitest';
import {CheckinEngine} from '../../src/engine.js';
import {SiteError, createClient} from '../../src/client.js';
import {encryptCookie} from '../../src/security.js';
import {dayEnds, nextDaily} from '../../src/schedule.js';

const start=Date.parse('2026-10-02T08:17:00+08:00');
const date='2026-10-02';
const cookie='uid=1; expire_in=1893456000; key=a';
const newCookie='uid=1; expire_in=1893456000; key=b';
const key='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const settings={...env,COOKIE_ENCRYPTION_KEY:key,SMTP_HOST:'smtp.126.com',MAIL_USER:'user@example.com',MAIL_APP_PASSWORD:'test',NOTIFY_TO:'user@example.com'};

async function scenario(fn) {
  const stub=env.CHECKIN.getByName(crypto.randomUUID());
  await runInDurableObject(stub,async(_,ctx)=>{
    let now=start;
    const client={account:async()=>({remaining:'42 GB'}),checkin:async()=>({status:'success',gained:'100 MB'}),discover:async()=>({updatedAt:'2026-09-11',domains:[]}),verifyDomain:async()=>({remaining:'42 GB'})};
    const sent=[];
    const engine=new CheckinEngine(ctx.storage,settings,{now:()=>now,client,mail:async(_,notice)=>{sent.push(notice);return 'accepted';}});
    await engine.updateCookie(cookie);
    await fn({engine,client,sent,ctx,advance:ms=>now+=ms,now:()=>now});
    await ctx.storage.deleteAll();
  });
}

test('four attempts use 10/30/100 minute delays, failure mail and next daily alarm persist',async()=>{
  await scenario(async({engine,client,sent,ctx,advance,now})=>{
    client.checkin=async()=>{throw new SiteError('server','HTTP 503');};
    for(const minutes of [10,30,100]) {
      await engine.alarm();
      const s=await engine.status();
      expect(s.todayRun.status).toBe('retrying');
      expect(s.jobs.find(j=>j.type==='run').due).toBe(now()+minutes*60_000);
      advance(minutes*60_000);
    }
    await engine.alarm();
    expect((await engine.status()).todayRun).toMatchObject({attempts:4,status:'failed'});
    expect(sent.filter(n=>n.type==='failed')).toHaveLength(1);
    await engine.runNow(); await engine.pause(true); await engine.pause(false); await engine.alarm();
    expect((await engine.status()).todayRun.attempts).toBe(4);
    expect(await ctx.storage.getAlarm()).toBe(nextDaily(now()));
  });
});

test('explicit cookie expiry stops requests and new cookie resumes today; same cookie preserves budget',async()=>{
  await scenario(async({engine,client,sent,advance})=>{
    client.account=async()=>{throw new SiteError('cookie','Cookie 已失效');};
    await engine.alarm();
    expect((await engine.status()).blocked).toBe(true);
    expect((await engine.status()).todayRun.attempts).toBe(1);
    expect(sent.map(n=>n.type)).toEqual(['cookie']);
    await engine.updateCookie(cookie);
    expect((await engine.status()).blocked).toBe(true);
    advance(30_000);client.account=async()=>({remaining:'40 GB'});
    await engine.updateCookie(newCookie);await engine.alarm();
    expect((await engine.status()).todayRun).toMatchObject({version:2,attempts:1,status:'success'});
    expect(sent.map(n=>n.type)).toEqual(['cookie','recovered']);
  });
});

test('successful checkin persists even when traffic read fails; SMTP retries do not repeat checkin',async()=>{
  await scenario(async({engine,client,advance})=>{
    let posts=0, reads=0, sends=0;
    client.account=async()=>{if(++reads>1)throw new SiteError('network','断线');return {remaining:'42 GB'};};
    client.checkin=async()=>{posts++;return {status:'success',gained:'100 MB'};};
    engine.mail=async()=>{sends++;throw new Error('SMTP unreachable');};
    await engine.load();engine.notice('test','test','test');await engine.save();
    await engine.alarm();
    expect((await engine.status()).lastSuccessDate).toBe(date);
    advance(60_000);await engine.alarm();advance(5*60_000);await engine.alarm();advance(30*60_000);await engine.alarm();
    expect(posts).toBe(1);expect(sends).toBe(4);
    expect((await engine.status()).notices.at(-1).status).toBe('failed');
  });
});

test('pause and resume preserve retry count and scheduled backoff',async()=>{
  await scenario(async({engine,client,advance,now})=>{
    client.checkin=async()=>{throw new SiteError('server','503');};
    await engine.alarm();const due=now()+10*60_000;
    await engine.pause(true);advance(60_000);await engine.pause(false);
    expect((await engine.status()).todayRun.attempts).toBe(1);
    expect((await engine.status()).jobs.find(j=>j.type==='run').due).toBe(due);
    advance(9*60_000);await engine.alarm();
    expect((await engine.status()).todayRun.attempts).toBe(2);
  });
});

test('interrupted attempt consumes its original budget and backs off rather than replaying POST',async()=>{
  await scenario(async({engine,client,advance,now})=>{
    let posts=0;client.checkin=async()=>{posts++;return {status:'success'};};
    await engine.load();engine.state.runs[date].status='running';engine.state.runs[date].attempts=1;
    engine.state.jobs.find(j=>j.type==='run').due=now();await engine.save();
    await engine.alarm();expect(posts).toBe(0);
    expect((await engine.status()).todayRun).toMatchObject({attempts:1,status:'retrying'});
    advance(10*60_000);await engine.alarm();expect(posts).toBe(1);
    expect((await engine.status()).todayRun.attempts).toBe(2);
  });
});

test('imported success survives eviction and keeps separate account identities isolated',async()=>{
  const a=env.CHECKIN.getByName(crypto.randomUUID());const b=env.CHECKIN.getByName(crypto.randomUUID());
  expect((await a.initialize({lastCheckinDate:date,currentDomain:'ikuuu.top'})).ok).toBe(true);
  await evictDurableObject(a);
  expect((await a.status()).data.lastSuccessDate).toBe(date);
  expect((await b.status()).data.lastSuccessDate).toBeNull();
  await runInDurableObject(a,async(_,ctx)=>{expect((await ctx.storage.get('state')).lastSuccessDate).toBe(date);expect(ctx.storage.sql.exec('SELECT 1 AS n').one().n).toBe(1);await ctx.storage.deleteAll();});
});

test('actual Alarm dispatch performs and persists a run then schedules daily recurrence',async()=>{
  const stub=env.CHECKIN.getByName(crypto.randomUUID());
  await runInDurableObject(stub,async(instance,ctx)=>{
    instance.engine.now=()=>start;
    instance.engine.client={account:async()=>({remaining:'42 GB'}),checkin:async()=>({status:'success',gained:'100 MB'})};
    instance.engine.mail=async()=> 'test';
    await instance.engine.load();
    instance.engine.state.credentials={encrypted:await encryptCookie(cookie,key),version:1,expiry:1893456000};
    instance.engine.queueRun();await instance.engine.save();
    await ctx.storage.setAlarm(Date.now()+60_000);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect((await stub.status()).data.lastSuccessDate).toBe(date);
  await runInDurableObject(stub,async(_,ctx)=>{expect(await ctx.storage.getAlarm()).toBe(nextDaily(start));await ctx.storage.deleteAll();});
});

test('Retry-After extends backoff and retry cannot cross Beijing midnight',async()=>{
  await scenario(async({engine,client,advance})=>{
    client.checkin=async()=>{throw new SiteError('limited','429',20*60_000);};
    await engine.alarm();expect((await engine.status()).todayRun.nextAttemptAt).toBe(start+20*60_000);
    advance(dayEnds(date)-start-60_000);await engine.alarm();
    expect((await engine.status()).todayRun.status).toBe('failed');
  });
});

test('403 is retryable; login redirect expires credentials without forwarding cookie to redirected host',async()=>{
  const calls=[];
  const client=createClient(async(url,options)=>{calls.push({url,options});return new Response('',{status:403});});
  await expect(client.account('ikuuu.top',cookie)).rejects.toMatchObject({kind:'blocked'});
  const expired=createClient(async()=>new Response('',{status:302,headers:{location:'https://ikuuu.top/auth/login'}}));
  await expect(expired.account('ikuuu.top',cookie)).rejects.toMatchObject({kind:'cookie'});
  expect(calls[0].options.redirect).toBe('manual');
  const postExpired=createClient(async()=>Response.json({ret:0,msg:'请先登录'}));
  await expect(postExpired.checkin('ikuuu.top',cookie)).rejects.toMatchObject({kind:'cookie'});
});

test('domain recovery verifies candidates once, within the existing retry budget',async()=>{
  await scenario(async({engine,client,advance})=>{
    let discoveries=0,posts=0;
    client.checkin=async(host)=>{posts++;if(host==='ikuuu.top')throw new SiteError('network','断线');return {status:'success',gained:'100 MB'};};
    client.discover=async()=>{discoveries++;return {updatedAt:'2026-09-11',domains:[{host:'ikuuu.top'},{host:'ikuuu.pw'}]};};
    await engine.alarm();advance(10*60_000);await engine.alarm();
    expect(posts).toBe(2);expect(discoveries).toBe(1);
    expect((await engine.status()).currentDomain).toBe('ikuuu.pw');
    expect((await engine.status()).todayRun).toMatchObject({status:'success',attempts:2});
  });
});

test('new credential version cancels stale pending expiry and failure notifications',async()=>{
  await scenario(async({engine,advance,ctx})=>{
    await engine.load();engine.notice('cookie','expired','expired');engine.notice('expiry','expiry','expiry');engine.notice('failed','failed','failed');await engine.save();
    advance(30_000);await engine.updateCookie(newCookie);
    const state=await ctx.storage.get('state');
    expect(state.notices.every(n=>n.status==='superseded')).toBe(true);
    expect(state.jobs.filter(j=>j.type==='mail')).toHaveLength(0);
    expect(state.jobs.find(j=>j.type==='expiry').version).toBe(2);
  });
});

test('admin API rejects invalid tokens, cross-site changes and non-object JSON',async()=>{
  expect((await exports.default.fetch('https://test/api/status')).status).toBe(401);
  const headers={Authorization:`Bearer ${env.ADMIN_TOKEN}`,'Content-Type':'application/json'};
  expect((await exports.default.fetch('https://test/api/cookie',{method:'POST',headers:{...headers,Origin:'https://other'},body:'{}'})).status).toBe(403);
  expect((await exports.default.fetch('https://test/api/cookie',{method:'POST',headers,body:'null'})).status).toBe(400);
  const response=await exports.default.fetch('https://test/api/status',{headers});expect(response.status).toBe(200);
  expect(await response.text()).not.toContain(key);
});
