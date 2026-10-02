import {cookieExpiry, normalizeDomain, shanghaiDate} from './core.js';
import {createClient, SiteError} from './client.js';
import {decryptCookie, encryptCookie, fingerprint} from './security.js';
import {DAY_MS, MAIL_DELAYS_MS, nextDaily, retryAt, dayEnds} from './schedule.js';
import {sendNotification, mailConfigured} from './mail.js';

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const RECOVERY_MS = 4 * 60_000;

export class CheckinEngine {
  constructor(storage, env, {now = Date.now, client = createClient(), mail = sendNotification} = {}) {
    this.storage = storage;
    this.env = env;
    this.now = now;
    this.client = client;
    this.mail = mail;
  }

  async load() {
    this.state = await this.storage.get('state') || {
      schema:1, enabled:true, blocked:false, currentDomain:normalizeDomain(this.env.DEFAULT_DOMAIN || 'ikuuu.top'),
      credentials:null, lastSuccessDate:null, runs:{}, jobs:[], notices:[], events:[], publication:null,
    };
    this.state.autoLogin ||= {status:'idle',attempts:0};
  }

  loginConfigured() {
    return typeof this.env.IKUUU_EMAIL === 'string' && !!this.env.IKUUU_EMAIL.trim() &&
      typeof this.env.IKUUU_PASSWORD === 'string' && !!this.env.IKUUU_PASSWORD;
  }

  scheduleLogin(reason, due = this.now()) {
    if (!this.loginConfigured() || !this.state.enabled ||
      ['manual_required','invalid_credentials'].includes(this.state.autoLogin.status)) return false;
    const existing=this.state.jobs.find(job=>job.type==='login');
    if (existing) {
      if (reason==='expired' && existing.attempts===0 && existing.reason==='renewal' && !existing.cooldown) {
        existing.reason=reason;existing.due=this.now();this.state.autoLogin.reason=reason;
      }
      return false;
    }
    this.state.autoLogin = {...this.state.autoLogin,status:'pending',attempts:0,reason};
    this.putJob({id:'login',type:'login',reason,version:this.state.credentials?.version || 0,attempts:0,due});
    return true;
  }

  ensureLogin() {
    if (!this.loginConfigured()) {
      this.state.jobs = this.state.jobs.filter(job=>job.type!=='login');
      return;
    }
    if (!this.state.credentials || this.state.blocked) this.scheduleLogin(this.state.credentials ? 'expired' : 'initial');
    else this.scheduleLogin('renewal',Math.max(this.now(),this.state.credentials.expiry*1000-DAY_MS));
  }

  event(message) {
    console.log(JSON.stringify({component:'checkin',at:this.now(),message}));
    this.state.events.push({at:this.now(), message});
    this.state.events = this.state.events.slice(-200);
  }

  putJob(job) {
    this.state.jobs = this.state.jobs.filter(item => item.id !== job.id);
    this.state.jobs.push(job);
  }

  dropJob(id) { this.state.jobs = this.state.jobs.filter(job => job.id !== id); }

  ensureDaily() {
    if (this.state.credentials && this.state.enabled && !this.state.jobs.some(job => job.id === 'daily')) {
      this.putJob({id:'daily', type:'daily', due:nextDaily(this.now())});
    }
  }

  async save() {
    this.ensureLogin();
    this.ensureDaily();
    const cutoff = shanghaiDate(new Date(this.now() - 90 * 86_400_000));
    for (const date of Object.keys(this.state.runs)) if (date < cutoff) delete this.state.runs[date];
    this.state.notices = this.state.notices.filter(notice => notice.at > this.now() - 90 * 86_400_000 || notice.status === 'pending');
    const due = Math.min(...this.state.jobs.map(job => job.due));
    await this.storage.transaction(async tx => {
      await tx.put('state', this.state);
      if (Number.isFinite(due)) await tx.setAlarm(Math.max(this.now() + 100, due));
      else await tx.deleteAlarm();
    });
  }

  queueRun(date = shanghaiDate(new Date(this.now()))) {
    if (!this.state.enabled || this.state.blocked || !this.state.credentials || this.state.lastSuccessDate === date) return false;
    const version = this.state.credentials.version;
    const existing = this.state.runs[date];
    if (existing?.version === version && ['pending','running','retrying','failed','blocked_cookie'].includes(existing.status)) return false;
    this.state.runs[date] = {date, version, attempts:0, status:'pending', startedAt:this.now()};
    this.putJob({id:`run:${date}`,type:'run',date,version,due:this.now()});
    return true;
  }

  notice(type, subject, message, date = shanghaiDate(new Date(this.now()))) {
    const version = this.state.credentials?.version || 0;
    const key = type === 'expiry' || type === 'cookie' ? `${type}:${version}` : `${type}:${date}:${version}`;
    if (this.state.notices.some(item => item.key === key)) return;
    const url = this.env.ADMIN_URL || '请打开签到管理页面';
    this.state.notices.push({key,type,date,version,subject,text:[message,`北京时间：${new Date(this.now()).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`,`当前域名：${this.state.currentDomain}`,`管理入口：${url}`].join('\n'),at:this.now(),attempts:0,status:'pending'});
    this.putJob({id:`mail:${key}`,type:'mail',key,due:this.now()});
  }

  async updateCookie(raw) {
    await this.load();
    if(typeof raw !== 'string') throw new InputError('Cookie 必须是字符串');
    const cookie = raw.trim();
    if (!cookie || cookie.length > 16_384 || /[\r\n]/.test(cookie)) throw new InputError('Cookie 必须是一行完整值，长度不超过 16 KiB');
    let expiry;
    try { expiry = cookieExpiry(cookie); } catch { throw new InputError('Cookie 缺少有效 expire_in 时间戳'); }
    const hash = await fingerprint(cookie);
    if (this.state.credentials?.fingerprint === hash) return this.snapshot('Cookie 未变化，保留现有尝试次数');
    if (this.state.lastCookieUpdate && this.now() - this.state.lastCookieUpdate < 30_000) throw new InputError('请等待 30 秒再更新 Cookie',429);
    const encrypted = await encryptCookie(cookie, this.env.COOKIE_ENCRYPTION_KEY);
    let verified = false;
    try { await this.client.account(this.state.currentDomain, cookie); verified = true; }
    catch (error) {
      if (error.kind === 'cookie') throw new InputError('新 Cookie 已明确失效，未替换当前凭证');
    }
    const previousVersion = this.state.credentials?.version;
    this.state.credentials = {encrypted, fingerprint:hash, version:(previousVersion || 0) + 1, expiry, verified, updatedAt:this.now()};
    this.state.lastCookieUpdate = this.now();
    this.state.blocked = false;
    this.state.autoLogin = {...this.state.autoLogin,status:'idle',attempts:0,lastError:null};
    this.state.jobs = this.state.jobs.filter(job => !['run','expiry','refresh','login'].includes(job.type));
    for (const notice of this.state.notices) {
      if (notice.version === previousVersion && ['cookie','expiry','failed','auto-login'].includes(notice.type) && notice.status === 'pending') {
        notice.status = 'superseded';
        this.dropJob(`mail:${notice.key}`);
      }
    }
    if (this.state.importedExpiryNotified !== expiry) {
      this.putJob({id:'expiry',type:'expiry',version:this.state.credentials.version,due:Math.max(this.now(),expiry * 1000 - 86_400_000)});
    }
    this.queueRun();
    this.event(verified ? '已更新并验证 Cookie' : '已保存 Cookie，等待联网验证');
    await this.save();
    return this.snapshot(verified ? 'Cookie 已更新，当天未签到时会立即执行' : 'Cookie 已保存，网络验证暂未完成');
  }

  async initialize(imported = {}) {
    await this.load();
    if (this.state.credentials && Object.keys(imported).length) throw new InputError('已有凭证后不允许覆盖迁移状态');
    if (imported.currentDomain) {
      try {this.state.currentDomain = normalizeDomain(imported.currentDomain);} catch {throw new InputError('迁移域名格式无效');}
    }
    if (imported.lastCheckinDate) {
      if (!isDate(imported.lastCheckinDate) || imported.lastCheckinDate > shanghaiDate(new Date(this.now()))) throw new InputError('迁移日期无效或在未来');
      this.state.lastSuccessDate = imported.lastCheckinDate;
    }
    if (imported.expiryNotifiedFor) this.state.importedExpiryNotified = Number(imported.expiryNotifiedFor);
    this.ensureDaily();
    this.event('初始化并核对持久化任务');
    await this.save();
    return this.snapshot('已初始化');
  }

  async runNow() {
    await this.load();
    if (!this.state.enabled) throw new InputError('签到已暂停，请先恢复');
    if (!this.state.credentials || this.state.blocked) {
      if (!this.loginConfigured()) throw new InputError('请先更新 Cookie，或配置自动登录账户');
      if (['manual_required','invalid_credentials'].includes(this.state.autoLogin.status)) throw new InputError(this.state.autoLogin.lastError || '自动登录需要人工处理');
      this.scheduleLogin(this.state.credentials ? 'expired' : 'initial');
      await this.save();
      return this.snapshot('已安排自动登录，成功后继续当天未完成的签到');
    }
    const queued = this.queueRun();
    await this.save();
    return this.snapshot(queued ? '已安排当天签到' : '当天已完成、已有任务或重试已耗尽');
  }

  async renewCookie() {
    await this.load();
    if (!this.loginConfigured()) throw new InputError('请在 Cloudflare 配置 IKUUU_EMAIL 和 IKUUU_PASSWORD');
    if (!this.state.enabled) throw new InputError('签到已暂停，请先恢复');
    const existing=this.state.jobs.find(job=>job.type==='login');
    if (existing) {
      if (existing.reason==='renewal' && existing.attempts===0 && !existing.cooldown) {
        if (this.state.autoLogin.lastAttemptAt && this.now()-this.state.autoLogin.lastAttemptAt<60_000) throw new InputError('请等待 1 分钟再尝试自动登录',429);
        existing.reason='manual';existing.due=this.now();this.state.autoLogin.reason='manual';
        await this.save();
        return this.snapshot('已安排立即自动登录并更新 Cookie');
      }
      return this.snapshot('自动登录任务已安排，请等待完成');
    }
    if (this.state.autoLogin.lastAttemptAt && this.now()-this.state.autoLogin.lastAttemptAt<60_000) throw new InputError('请等待 1 分钟再尝试自动登录',429);
    this.state.autoLogin.status='idle';
    this.scheduleLogin('manual');
    await this.save();
    return this.snapshot('已安排自动登录并更新 Cookie');
  }

  async pause(paused) {
    await this.load();
    this.state.enabled = !paused;
    if (paused) {
      this.state.jobs = this.state.jobs.filter(job => !['daily','run','refresh','login'].includes(job.type));
      if (['pending','retrying','running'].includes(this.state.autoLogin.status)) this.state.autoLogin.status='idle';
      for (const run of Object.values(this.state.runs)) if (['pending','running','retrying'].includes(run.status)) run.status = 'paused';
    } else {
      const date=shanghaiDate(new Date(this.now()));
      const run=this.state.runs[date];
      if(run?.status==='paused' && run.version===this.state.credentials?.version && !this.state.blocked) {
        if(run.attempts>=4) run.status='failed';
        else {
          run.status=run.attempts?'retrying':'pending';
          this.putJob({id:`run:${date}`,type:'run',date,version:run.version,due:Math.max(this.now(),run.nextAttemptAt || this.now())});
        }
      } else this.queueRun();
    }
    this.event(paused ? '暂停签到' : '恢复签到');
    await this.save();
    return this.snapshot(paused ? '已暂停签到' : '已恢复签到');
  }

  snapshot(message) {
    const {credentials, ...state} = this.state;
    return {
      message, enabled:state.enabled, blocked:state.blocked, currentDomain:state.currentDomain,
      lastSuccessDate:state.lastSuccessDate, today:shanghaiDate(new Date(this.now())),
      todayRun:state.runs[shanghaiDate(new Date(this.now()))] || null,
      credential:credentials ? {version:credentials.version,expiry:credentials.expiry,verified:credentials.verified,updatedAt:credentials.updatedAt} : null,
      nextTaskAt:state.jobs.length ? Math.min(...state.jobs.map(job=>job.due)) : null,
      jobs:state.jobs.map(({id,type,due})=>({id,type,due})),
      notices:state.notices.map(({key,type,at,status,attempts,lastError,messageId})=>({key,type,at,status,attempts,lastError,messageId})).slice(-30),
      history:Object.values(state.runs).sort((a,b)=>b.date.localeCompare(a.date)), events:state.events.slice(-50),
      publication:state.publication, mailConfigured:mailConfigured(this.env),
      autoLogin:{...state.autoLogin,configured:this.loginConfigured(),nextAttemptAt:state.jobs.find(job=>job.type==='login')?.due || null},
    };
  }

  async status() {
    await this.load();
    const jobs=JSON.stringify(this.state.jobs);
    this.ensureLogin();this.ensureDaily();
    if (JSON.stringify(this.state.jobs)!==jobs) await this.save();
    return this.snapshot();
  }

  async rotateCookie(raw) {
    if (!raw || !this.state.credentials) return;
    let expiry;
    try { expiry=cookieExpiry(raw); } catch { return; }
    const hash=await fingerprint(raw);
    if (hash===this.state.credentials.fingerprint) return;
    this.state.credentials={...this.state.credentials,encrypted:await encryptCookie(raw,this.env.COOKIE_ENCRYPTION_KEY),fingerprint:hash,expiry,verified:true,updatedAt:this.now()};
    this.putJob({id:'expiry',type:'expiry',version:this.state.credentials.version,due:Math.max(this.now(),expiry*1000-DAY_MS)});
    // Passive renewal keeps the existing run and its attempt budget intact.
    const login=this.state.jobs.find(job=>job.type==='login');
    if (login?.reason==='renewal' && login.attempts===0 && !login.cooldown) this.dropJob(login.id);
  }

  async performLogin(job) {
    if (!this.loginConfigured() || !this.state.enabled || job.version!==(this.state.credentials?.version || 0)) {
      this.dropJob(job.id);await this.save();return;
    }
    const interrupted=job.running;
    if (!interrupted) job.attempts++;
    job.running=true;job.due=this.now()+RECOVERY_MS;
    this.state.autoLogin={...this.state.autoLogin,status:'running',attempts:job.attempts,reason:job.reason,lastAttemptAt:this.now()};
    await this.save();
    try {
      if (interrupted) throw new SiteError('network','上次自动登录执行中断，按退避恢复');
      const result=await this.client.login(this.state.currentDomain,this.env.IKUUU_EMAIL.trim(),this.env.IKUUU_PASSWORD);
      const expiry=cookieExpiry(result.cookie);
      // Near-expired responses must not create an immediate, unbounded login loop.
      if (expiry*1000<=this.now()+DAY_MS) throw new SiteError('response','网站新 Cookie 有效期不足 24 小时，保留原凭证并稍后重试');
      const previousVersion=this.state.credentials?.version || 0;
      const version=previousVersion+1;
      const encrypted=await encryptCookie(result.cookie,this.env.COOKIE_ENCRYPTION_KEY);
      this.state.credentials={encrypted,fingerprint:await fingerprint(result.cookie),version,expiry,verified:true,updatedAt:this.now()};
      this.state.blocked=false;
      this.dropJob(job.id);
      this.state.autoLogin={status:'success',attempts:job.attempts,reason:job.reason,lastAttemptAt:this.state.autoLogin.lastAttemptAt,lastSuccessAt:this.now(),lastError:null};
      const today=shanghaiDate(new Date(this.now()));
      const run=this.state.runs[today];
      for (const pending of this.state.jobs) if (['run','refresh'].includes(pending.type) && pending.version===previousVersion) pending.version=version;
      if (run?.version===previousVersion) {
        run.version=version;
        if (run.status==='blocked_cookie' && run.attempts<4 && this.state.lastSuccessDate!==today) {
          run.status='retrying';run.nextAttemptAt=this.now();
          this.putJob({id:`run:${today}`,type:'run',date:today,version,due:this.now()});
        } else if (run.status==='blocked_cookie') run.status='failed';
      }
      for (const notice of this.state.notices) {
        if (notice.version===previousVersion && ['cookie','expiry','auto-login'].includes(notice.type) && notice.status==='pending') {
          notice.status='superseded';this.dropJob(`mail:${notice.key}`);
        }
      }
      this.putJob({id:'expiry',type:'expiry',version,due:expiry*1000-DAY_MS});
      this.queueRun();
      this.event('已自动登录并验证新 Cookie');
      await this.save();
    } catch (error) {
      const permanent=['login','verification','cookie'].includes(error.kind);
      const message=error.kind ? error.message : '自动登录发生异常，请检查服务配置';
      this.state.autoLogin.lastError=message;
      job.running=false;
      const delay=[10,30,100][job.attempts-1];
      if (!permanent && delay!==undefined) {
        this.state.autoLogin.status='retrying';job.due=this.now()+Math.max(delay*60_000,error.retryAfterMs || 0);this.putJob(job);
      } else {
        this.dropJob(job.id);
        this.state.autoLogin.status=error.kind==='verification' ? 'manual_required' : permanent ? 'invalid_credentials' : 'failed';
        this.notice('auto-login','iKuuu 自动登录未完成',`${message}\n原 Cookie 已保留。请在管理页面检查状态；需要验证时手动登录网站并更新 Cookie。`);
        if (!permanent) this.putJob({id:'login',type:'login',reason:job.reason,version:job.version,attempts:0,cooldown:true,due:this.now()+DAY_MS});
      }
      this.event(`自动登录：${this.state.autoLogin.status}`);
      await this.save();
    }
  }

  async testEmail() {
    await this.load();
    if(!mailConfigured(this.env)) throw new InputError('请先配置 SMTP 发件凭证');
    this.notice('test','iKuuu Cloudflare 邮件通知测试','签到任务的 SMTP 通知配置已启用。此邮件用于核对实际送达。');
    await this.save();
    return this.snapshot('测试邮件已加入发送任务');
  }

  async recoverDomain(cookie) {
    let publication;
    try { publication = await this.client.discover(); }
    catch { this.event('域名发布页访问或解析失败，保留上次域名'); return; }
    this.state.publication = {...publication, fetchedAt:this.now()};
    const candidates = publication.domains.filter(item=>item.host !== this.state.currentDomain).slice(0,2);
    for (const candidate of candidates) {
      try {
        await this.client.verifyDomain(candidate.host, cookie);
        this.state.currentDomain = candidate.host;
        this.event(`已验证并切换域名：${candidate.host}`);
        return;
      } catch { /* Candidate failure does not prove the current cookie expired. */ }
    }
  }

  async performRun(job) {
    const today = shanghaiDate(new Date(this.now()));
    const run = this.state.runs[job.date];
    if (job.date !== today || !run || job.version !== this.state.credentials?.version || this.state.lastSuccessDate === today || !this.state.enabled || this.state.blocked) {
      this.dropJob(job.id);
      if (run && job.date !== today && ['pending','running','retrying'].includes(run.status)) run.status = 'expired';
      await this.save(); return;
    }
    const interrupted = run.status === 'running';
    if (!interrupted) run.attempts++;
    run.status = 'running';
    run.lastAttemptAt = this.now();
    job.due = this.now() + RECOVERY_MS;
    this.putJob(job);
    await this.save(); // Persist recovery before issuing an external request.
    try {
      if(interrupted) throw new SiteError('network','上次执行中断，按既定退避恢复');
      let cookie = await decryptCookie(this.state.credentials.encrypted, this.env.COOKIE_ENCRYPTION_KEY);
      if (run.attempts >= 2 && ['network','domain','server'].includes(run.errorKind) && !run.discoveryTried) {
        run.discoveryTried = true;
        await this.recoverDomain(cookie);
      }
      const account=await this.client.account(this.state.currentDomain, cookie);
      await this.rotateCookie(account.cookie);
      cookie=account.cookie || cookie;
      this.state.credentials.verified = true;
      const result = await this.client.checkin(this.state.currentDomain, cookie);
      run.status = 'success'; run.completedAt = this.now(); run.gained = result.gained; run.result = result.status;
      delete run.lastError; delete run.errorKind; delete run.nextAttemptAt;
      this.state.lastSuccessDate = today;
      this.dropJob(job.id);
      this.putJob({id:`refresh:${today}`,type:'refresh',date:today,version:job.version,attempts:0,due:this.now()});
      this.event(`签到已完成，尝试次数 ${run.attempts}`);
      if (this.state.notices.some(notice=>['cookie','auto-login'].includes(notice.type) && notice.status === 'sent' && notice.version < job.version)) {
        this.notice('recovered','iKuuu 签到已恢复',`今日签到完成，领取：${result.gained || '未知（网站已签到）'}`,today);
      }
      await this.save(); // Success stays durable even if traffic refresh fails.
      try { await this.rotateCookie(result.cookie); await this.save(); }
      catch { this.event('签到成功，响应 Cookie 暂未保存'); }
    } catch (error) {
      run.lastError = error.kind ? error.message : '执行异常，请检查服务配置和日志';
      run.errorKind = error.kind || 'internal';
      if (error.kind === 'cookie') {
        run.status = 'blocked_cookie'; this.state.blocked = true; this.dropJob(job.id);
        if (!this.loginConfigured() || ['manual_required','invalid_credentials'].includes(this.state.autoLogin.status)) {
          this.notice('cookie','iKuuu Cookie 已失效',`${run.lastError}\n本轮已停止，请更新 Cookie；更新后会恢复当天未完成的签到。`,today);
        } else this.scheduleLogin('expired');
      } else {
        const due = retryAt(this.now(),run.attempts,today,error.retryAfterMs);
        if (due) {
          run.status='retrying'; run.nextAttemptAt=due; job.due=due; this.putJob(job);
        } else {
          run.status='failed'; this.dropJob(job.id);
          this.notice('failed','iKuuu 今日签到最终失败',`尝试次数：${run.attempts}\n${run.lastError}`,today);
        }
      }
      this.event(`签到尝试 ${run.attempts}：${run.status}`);
      await this.save();
    }
  }

  async performMail(job) {
    const notice = this.state.notices.find(item=>item.key === job.key);
    if (!notice || notice.status !== 'pending') {this.dropJob(job.id);await this.save();return;}
    if(notice.attempts>=4) {notice.status='failed';notice.lastError='邮件发送中断且重试次数已耗尽';this.dropJob(job.id);await this.save();return;}
    notice.attempts++;
    job.due = this.now() + RECOVERY_MS; this.putJob(job); await this.save();
    try {
      notice.messageId = await this.mail(this.env,notice);
      notice.status='sent'; notice.acceptedAt=this.now(); delete notice.lastError;
      this.dropJob(job.id);
    } catch(error) {
      notice.lastError = error.permanent ? error.message : '邮件发送暂时失败';
      const delay=MAIL_DELAYS_MS[notice.attempts-1];
      if (!error.permanent && delay !== undefined) {job.due=this.now()+delay;this.putJob(job);}
      else {notice.status='failed';this.dropJob(job.id);}
    }
    await this.save();
  }

  async refresh(job) {
    this.dropJob(job.id);
    if (job.version !== this.state.credentials?.version) {await this.save();return;}
    try {
      const cookie=await decryptCookie(this.state.credentials.encrypted,this.env.COOKIE_ENCRYPTION_KEY);
      const account=await this.client.account(this.state.currentDomain,cookie);
      const run=this.state.runs[job.date]; if(run) run.remaining=account.remaining;
      await this.rotateCookie(account.cookie);
    } catch {
      job.attempts++;
      if (job.attempts <= 2 && this.now()+60_000 < dayEnds(job.date)) {job.due=this.now()+60_000;this.putJob(job);}
      else this.event('签到成功，剩余流量暂未读取到');
    }
    await this.save();
  }

  async alarm() {
    await this.load();
    try {
      for (let count=0;count<4;count++) {
        const job=this.state.jobs.filter(item=>item.due<=this.now()).sort((a,b)=>a.due-b.due)[0];
        if(!job) break;
        if(job.type==='run') await this.performRun(job);
        else if(job.type==='login') await this.performLogin(job);
        else if(job.type==='mail') await this.performMail(job);
        else if(job.type==='refresh') await this.refresh(job);
        else {
          this.dropJob(job.id);
          if(job.type==='daily') this.queueRun();
          if(job.type==='expiry' && job.version===this.state.credentials?.version && !this.state.blocked && !this.loginConfigured()) {
            const date=new Date(this.state.credentials.expiry*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});
            this.notice('expiry','iKuuu Cookie 到期提醒',`Cookie 到期标记：${date}（北京时间）。请更新凭证；是否失效以实际登录验证为准。`);
          }
          await this.save();
        }
      }
      await this.save();
    } catch {
      // Preserve the chain when recoverable internal errors outlive platform retries.
      this.event('调度发生异常，已安排恢复检查');
      for(const job of this.state.jobs) if(job.due<=this.now()) job.due=this.now()+60_000;
      await this.save();
    }
  }
}
