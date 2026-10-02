import {authorized, fingerprint} from './security.js';
import {InputError} from './engine.js';

const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode = value => Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const encoder = new TextEncoder();
const ITERATIONS = 100_000;
export const SESSION_MS = 7 * 86_400_000;

function validPassword(value) {
  if(typeof value!=='string' || value.length<6 || value.length>128 || !value.trim()) {
    throw new InputError('密码须为 6–128 个字符');
  }
}

async function derive(password, salt, pepper) {
  if(typeof pepper!=='string' || pepper.length<32) throw new Error('未配置恢复码');
  // A server secret protects the stored hash if the database alone is exposed.
  const secret=await crypto.subtle.importKey('raw',encoder.encode(pepper),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const material=await crypto.subtle.sign('HMAC',secret,encoder.encode('ikuuu-password-v1\0'+password));
  const key=await crypto.subtle.importKey('raw',material,'PBKDF2',false,['deriveBits']);
  return crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:decode(salt),iterations:ITERATIONS},key,256);
}

async function hashPassword(password, pepper) {
  validPassword(password);
  const salt=encode(crypto.getRandomValues(new Uint8Array(16)));
  return {salt,hash:encode(await derive(password,salt,pepper)),iterations:ITERATIONS};
}

async function verifyPassword(password, record, pepper) {
  if(typeof password!=='string' || password.length>128 || !record) return false;
  const actual=await derive(password,record.salt,pepper);
  return crypto.subtle.timingSafeEqual(actual,decode(record.hash));
}

export class AuthManager {
  constructor(storage,env,{now=Date.now}={}) {this.storage=storage;this.env=env;this.now=now;}
  async load() {
    return await this.storage.get('auth') || {schema:1,password:null,version:0,sessions:[],failures:{}};
  }
  prune(state) {
    state.sessions=state.sessions.filter(s=>s.expiresAt>this.now() && s.version===state.version);
    state.failures=Object.fromEntries(Object.entries(state.failures).filter(([,f])=>f.updatedAt>this.now()-3_600_000).sort((a,b)=>b[1].updatedAt-a[1].updatedAt).slice(0,100));
  }
  guard(state,key) {
    if((state.failures[key]?.until || 0)>this.now()) throw new InputError('尝试次数过多，请 10 分钟后重试',429);
  }
  async fail(state,key,message,status=401) {
    this.prune(state);
    const previous=state.failures[key];
    const count=previous && this.now()-previous.updatedAt<600_000 ? previous.count+1 : 1;
    state.failures[key]={count,updatedAt:this.now(),until:count>=5?this.now()+600_000:0};
    await this.storage.put('auth',state);
    throw new InputError(message,status);
  }
  async session(state,token) {
    if(typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash=await fingerprint(token);
    return state.sessions.find(s=>crypto.subtle.timingSafeEqual(encoder.encode(s.hash),encoder.encode(hash)) && s.version===state.version && s.expiresAt>this.now()) || null;
  }
  async requireSession(token) {
    const state=await this.load();
    if(!await this.session(state,token)) throw new InputError('请登录，或会话已失效',401);
    return state;
  }
  async status(token) {
    const state=await this.load();const session=await this.session(state,token);
    return {configured:!!state.password,authenticated:!!session,expiresAt:session?.expiresAt || null};
  }
  async login(password,clientKey) {
    const state=await this.load();const key=`login:${clientKey}`;
    this.guard(state,key);
    if(!state.password) throw new InputError('请先使用恢复码设置密码',409);
    if(!await verifyPassword(password,state.password,this.env.ADMIN_TOKEN)) return this.fail(state,key,'密码不正确');
    this.prune(state);delete state.failures[key];
    const token=encode(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
    const expiresAt=this.now()+SESSION_MS;
    state.sessions=state.sessions.slice(-19);
    state.sessions.push({hash:await fingerprint(token),version:state.version,expiresAt});
    await this.storage.put('auth',state);
    return {token,expiresAt};
  }
  async recover(code,password,clientKey) {
    const state=await this.load();const key=`recover:${clientKey}`;
    this.guard(state,key);
    if(typeof code!=='string' || code.length>256 || !await authorized(`Bearer ${code}`,this.env.ADMIN_TOKEN)) return this.fail(state,key,'恢复码不正确');
    const record=await hashPassword(password,this.env.ADMIN_TOKEN);
    state.password=record;state.version++;state.sessions=[];delete state.failures[key];
    state.passwordChangedAt=this.now();
    // Auth is separate from scheduler storage; no writes to state or Alarm here.
    await this.storage.put('auth',state);
    return {message:'密码已设置，全部登录会话已失效，请使用新密码登录'};
  }
  async change(token,currentPassword,newPassword,clientKey) {
    const state=await this.requireSession(token);const key=`change:${clientKey}`;
    this.guard(state,key);
    if(!await verifyPassword(currentPassword,state.password,this.env.ADMIN_TOKEN)) return this.fail(state,key,'当前密码不正确',400);
    state.password=await hashPassword(newPassword,this.env.ADMIN_TOKEN);
    state.version++;state.sessions=[];delete state.failures[key];state.passwordChangedAt=this.now();
    await this.storage.put('auth',state);
    return {message:'密码已修改，全部登录会话已失效，请重新登录'};
  }
  async logout(token) {
    const state=await this.load();const session=await this.session(state,token);
    if(session) {state.sessions=state.sessions.filter(s=>s.hash!==session.hash);await this.storage.put('auth',state);}
    return {message:'已退出登录'};
  }
}
