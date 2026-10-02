import {env,exports} from 'cloudflare:workers';
import {runInDurableObject,evictDurableObject} from 'cloudflare:test';
import {test,expect} from 'vitest';
import {AuthManager,SESSION_MS} from '../../src/auth.js';
import {CheckinEngine} from '../../src/engine.js';

const password='Test password 123!';
const nextPassword='Changed password 456!';
const recovery=env.ADMIN_TOKEN;

async function scenario(action) {
  const stub=env.CHECKIN.getByName(crypto.randomUUID());
  await runInDurableObject(stub,async(instance,ctx)=>{
    let now=Date.now();
    const auth=new AuthManager(ctx.storage,env,{now:()=>now});
    await action({auth,ctx,instance,advance:ms=>now+=ms});
    await ctx.storage.deleteAll();
  });
}

test('first setup needs recovery code; hashes passwords and stores only session digests',async()=>{
  await scenario(async({auth,ctx})=>{
    expect(await auth.status('')).toEqual({configured:false,authenticated:false,expiresAt:null});
    await expect(auth.login(password,'a')).rejects.toMatchObject({status:409});
    await expect(auth.recover('wrong',password,'a')).rejects.toMatchObject({status:401});
    await auth.recover(recovery,password,'a');
    const session=await auth.login(password,'a');
    expect((await auth.status(session.token)).authenticated).toBe(true);
    const state=await ctx.storage.get('auth');
    expect(state.password.iterations).toBe(100_000);
    const stored=JSON.stringify(state);expect(stored).not.toContain(password);expect(stored).not.toContain(recovery);expect(stored).not.toContain(session.token);
  });
});

test('changing password invalidates ALL sessions immediately and leaves scheduler state and Alarm unchanged',async()=>{
  await scenario(async({auth,ctx})=>{
    const client={account:async()=>({remaining:'42 GB'})};
    const engine=new CheckinEngine(ctx.storage,env,{client});
    await engine.updateCookie('uid=1; expire_in=1893456000; key=test');
    const before=await ctx.storage.get('state');const alarm=await ctx.storage.getAlarm();
    await auth.recover(recovery,password,'a');
    const a=await auth.login(password,'a');const b=await auth.login(password,'b');
    await expect(auth.change(a.token,'incorrect',nextPassword,'a')).rejects.toMatchObject({status:400});
    expect((await auth.status(a.token)).authenticated).toBe(true);
    await auth.change(a.token,password,nextPassword,'a');
    expect((await auth.status(a.token)).authenticated).toBe(false);
    expect((await auth.status(b.token)).authenticated).toBe(false);
    await expect(auth.login(password,'a')).rejects.toMatchObject({status:401});
    expect((await auth.login(nextPassword,'a')).token).toBeTruthy();
    expect(await ctx.storage.get('state')).toEqual(before);expect(await ctx.storage.getAlarm()).toBe(alarm);
  });
});

test('recovery can reset forgotten password repeatedly and never creates a new login session',async()=>{
  await scenario(async({auth})=>{
    await auth.recover(recovery,password,'a');
    const a=await auth.login(password,'a');const b=await auth.login(password,'b');
    await auth.recover(recovery,nextPassword,'a');
    await expect(auth.requireSession(a.token)).rejects.toMatchObject({status:401});
    await expect(auth.requireSession(b.token)).rejects.toMatchObject({status:401});
    expect(await auth.status('')).toMatchObject({configured:true,authenticated:false});
    await auth.recover(recovery,password,'a');
    expect((await auth.login(password,'a')).token).toBeTruthy();
  });
});

test('recovery code cannot be used as a management session even before initial setup',async()=>{
  await scenario(async({auth})=>{
    await expect(auth.requireSession(recovery)).rejects.toMatchObject({status:401});
    await auth.recover(recovery,password,'a');
    await expect(auth.requireSession(recovery)).rejects.toMatchObject({status:401});
  });
});

test('logout revokes its session; expired sessions cannot access management',async()=>{
  await scenario(async({auth,advance})=>{
    await auth.recover(recovery,password,'a');
    const a=await auth.login(password,'a');const b=await auth.login(password,'b');
    await auth.logout(a.token);
    expect((await auth.status(a.token)).authenticated).toBe(false);
    expect((await auth.status(b.token)).authenticated).toBe(true);
    advance(SESSION_MS);await expect(auth.requireSession(b.token)).rejects.toMatchObject({status:401});
  });
});

test('password and recovery brute-force limits persist, reset and do not lock other clients',async()=>{
  await scenario(async({auth,advance})=>{
    await auth.recover(recovery,password,'a');
    for(let i=0;i<5;i++)await expect(auth.login('wrong','a')).rejects.toMatchObject({status:401});
    await expect(auth.login(password,'a')).rejects.toMatchObject({status:429});
    expect((await auth.login(password,'b')).token).toBeTruthy();
    for(let i=0;i<5;i++)await expect(auth.recover('wrong',password,'a')).rejects.toMatchObject({status:401});
    await expect(auth.recover(recovery,password,'a')).rejects.toMatchObject({status:429});
    advance(600_001);expect((await auth.login(password,'a')).token).toBeTruthy();
    await auth.recover(recovery,nextPassword,'a');
  });
});

test('password policy rejects invalid values without clearing active sessions',async()=>{
  await scenario(async({auth})=>{
    await expect(auth.recover(recovery,'short','a')).rejects.toMatchObject({status:400});
    await auth.recover(recovery,password,'a');const session=await auth.login(password,'a');
    await expect(auth.change(session.token,password,'x'.repeat(129),'a')).rejects.toMatchObject({status:400});
    expect((await auth.status(session.token)).authenticated).toBe(true);
  });
});

test('password and sessions survive object eviction; revocation has no cached authorization',async()=>{
  const stub=env.CHECKIN.getByName(crypto.randomUUID());
  expect((await stub.recover(recovery,password,'a')).ok).toBe(true);
  const {data:session}=await stub.login(password,'a');
  await evictDurableObject(stub);
  expect((await stub.manage('status',{},session.token)).ok).toBe(true);
  await stub.recover(recovery,nextPassword,'a');
  expect((await stub.manage('status',{},session.token)).status).toBe(401);
  await runInDurableObject(stub,async(_,ctx)=>ctx.storage.deleteAll());
});

test('HTTP login uses secure cookies; change and recovery reject all old session cookies and bearer sessions',async()=>{
  const stub=env.CHECKIN.getByName(env.ACCOUNT_NAME || 'primary-account');
  await runInDurableObject(stub,async(_,ctx)=>ctx.storage.deleteAll());
  const request=(path,body,cookie='',extra={})=>exports.default.fetch('https://test/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  expect((await request('auth/recover',{recoveryCode:recovery,password})).status).toBe(200);
  const first=await request('auth/login',{password});const set=first.headers.get('set-cookie');
  expect(set).toContain('Secure');expect(set).toContain('HttpOnly');expect(set).toContain('SameSite=Strict');expect(set).toContain('Path=/');
  expect(JSON.stringify(await first.json())).not.toContain(set.split('=')[1].split(';')[0]);
  const a=set.split(';')[0];const second=await request('auth/login',{password});const b=second.headers.get('set-cookie').split(';')[0];
  expect((await request('status',undefined,a)).status).toBe(200);
  expect((await request('auth/change-password',{currentPassword:password,newPassword:nextPassword},a)).headers.get('set-cookie')).toContain('Max-Age=0');
  expect((await request('status',undefined,a)).status).toBe(401);
  expect((await request('status',undefined,b)).status).toBe(401);
  expect((await request('status',undefined,'',{Authorization:'Bearer '+a.split('=')[1]})).status).toBe(401);
  expect((await request('status',undefined,'',{Authorization:'Bearer '+recovery})).status).toBe(401);
  const third=await request('auth/login',{password:nextPassword});const c=third.headers.get('set-cookie').split(';')[0];
  expect((await request('auth/recover',{recoveryCode:recovery,password})).status).toBe(200);
  expect((await request('status',undefined,c)).status).toBe(401);
  expect((await request('auth/login',{password},'',{Origin:'https://other'})).status).toBe(403);
  expect((await request('auth/recover',{recoveryCode:recovery,password},'',{'Content-Type':'text/plain'})).status).toBe(415);
  await runInDurableObject(stub,async(_,ctx)=>ctx.storage.deleteAll());
});
