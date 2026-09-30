import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import {
  classifyCheckin, cookieExpiry, decodedUserHtml, domainsFromReply,
  normalizeDomain, remainingTraffic, shanghaiDate, shanghaiHour,
} from './core.js';

const statePath = '.github/ikuuu-state.json';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cookie = (process.env.IKUUU_COOKIE || (existsSync('ikuuu-cookie.txt') ? await readFile('ikuuu-cookie.txt', 'utf8') : '')).trim();
if (!cookie || /[\r\n]/.test(cookie)) throw new Error('IKUUU_COOKIE 必须是一行完整 Cookie');

const state = JSON.parse(await readFile(statePath, 'utf8'));
state.currentDomain = normalizeDomain(state.currentDomain || 'ikuuu.top');
const problems = [];
const report = [];

async function saveState() {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function request(domain, path, { method = 'GET', authenticated = true } = {}) {
  const headers = { 'User-Agent': 'Mozilla/5.0', Accept: method === 'POST' ? 'application/json, text/javascript, */*; q=0.01' : 'text/html' };
  if (authenticated) headers.Cookie = cookie;
  if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
  const response = await fetch(`https://${normalizeDomain(domain)}${path}`, {
    method, headers, body: method === 'POST' ? '' : undefined,
    redirect: 'manual', signal: AbortSignal.timeout(20000),
  });
  return { status: response.status, location: response.headers.get('location') || '', body: await response.text() };
}

async function checkUser(domain) {
  let response;
  try { response = await request(domain, '/user'); }
  catch { return { kind: 'unreachable' }; }
  if (response.status >= 500 || response.status === 403 || response.status === 429) return { kind: 'unreachable' };
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    return { kind: /\/auth\/login/i.test(response.location) ? 'expired' : 'unreachable' };
  }
  if (response.status !== 200) return { kind: 'unreachable' };
  const html = decodedUserHtml(response.body);
  if (/name=["']password["']/i.test(html) && /Login/i.test(html)) return { kind: 'expired' };
  const remaining = remainingTraffic(response.body);
  return remaining ? { kind: 'authenticated', remaining } : { kind: 'unreachable' };
}

function mailSettings() {
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('缺少 MAIL_USER 或 MAIL_APP_PASSWORD');
  return { user, pass, to: process.env.NOTIFY_TO || user };
}

async function sendMail(to, subject, text) {
  const settings = mailSettings();
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: settings.user, pass: settings.pass },
    disableFileAccess: true, disableUrlAccess: true,
  });
  await transport.sendMail({ from: settings.user, to, subject, text });
  transport.close();
}

async function discoverDomainsByEmail(onSent) {
  const settings = mailSettings();
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.IMAP_PORT || 993), secure: true,
    auth: { user: settings.user, pass: settings.pass },
    logger: false,
  });
  await client.connect();
  try {
    await client.mailboxOpen('INBOX');
    const firstNewUid = client.mailbox.uidNext;
    await sendMail('find@ikuuu.pro', '查询 iKuuu VPN 最新官网地址', '请回复最新官网地址。');
    await onSent();
    const deadline = Date.now() + 120_000;
    const allowedFrom = (process.env.FIND_REPLY_FROM || 'find@ikuuu.pro').toLowerCase();
    while (Date.now() < deadline) {
      await sleep(10_000);
      const uids = await client.search({ since: new Date(Date.now() - 10 * 60_000) }, { uid: true });
      for (const uid of (uids || []).filter(uid => uid >= firstNewUid).sort((a, b) => b - a)) {
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!message?.source) continue;
        const parsed = await simpleParser(message.source);
        const senders = (parsed.from?.value || []).map(v => String(v.address || '').toLowerCase());
        if (!senders.includes(allowedFrom)) continue;
        const domains = domainsFromReply(`${parsed.text || ''}\n${parsed.html || ''}`);
        if (domains.length) return domains;
      }
    }
    throw new Error('等待官网自动回复超时');
  } finally {
    await client.logout().catch(() => {});
  }
}

async function recoverDomain() {
  if (state.lastRecoveryRequestDate === shanghaiDate()) throw new Error('今天已请求过官网地址，等待下次运行');
  const domains = await discoverDomainsByEmail(async () => {
    state.lastRecoveryRequestDate = shanghaiDate();
    await saveState();
  });
  for (const domain of domains) {
    // 先无凭证确认候选网站在运行，再检查同一 Cookie 是否可以登录。
    let publicPage;
    try { publicPage = await request(domain, '/auth/login', { authenticated: false }); }
    catch { continue; }
    if (publicPage.status !== 200 || !/Geetest|Login|登录/i.test(publicPage.body)) continue;
    const account = await checkUser(domain);
    if (account.kind === 'authenticated') {
      state.currentDomain = domain;
      await saveState();
      return { domain, account };
    }
  }
  throw new Error('自动回复中的域名均未能验证登录状态');
}

async function maybeNotifyExpiry() {
  const expiry = cookieExpiry(cookie);
  const remainingMs = expiry * 1000 - Date.now();
  const expiryText = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short' }).format(new Date(expiry * 1000));
  report.push(`Cookie 到期标记：${expiryText}（北京时间）`);
  if (remainingMs <= 24 * 60 * 60_000 && state.expiryNotifiedFor !== expiry) {
    const subject = remainingMs > 0 ? 'iKuuu Cookie 将在 24 小时内到期' : 'iKuuu Cookie 已到期';
    await sendMail(mailSettings().to, subject, `当前域名：${state.currentDomain}\nCookie 到期标记：${expiryText}（北京时间）\n请重新登录并更新 GitHub Actions Secret IKUUU_COOKIE。`);
    state.expiryNotifiedFor = expiry;
    await saveState();
    report.push('到期提醒：已发送');
  }
}

async function ensureUsableCookie() {
  const domain = state.currentDomain;
  const account = await checkUser(domain);
  if (account.kind === 'authenticated') return;
  if (account.kind === 'expired') throw new Error('Cookie 已失效，请重新登录并更新 Secret');
  report.push(`当前域名 ${domain} 无法访问，已请求官网自动回复`);
  const recovered = await recoverDomain();
  report.push(`已切换域名：${recovered.domain}`);
}

async function runCheckin() {
  const today = shanghaiDate();
  const hour = shanghaiHour();
  const scheduledHours = [8, 16];
  if (state.lastCheckinDate === today && process.env.FORCE_CHECKIN !== 'true') {
    report.push('签到：今天已由本工具完成');
    return;
  }
  if (!scheduledHours.includes(hour) && process.env.FORCE_CHECKIN !== 'true') {
    report.push('签到：等待北京时间 08:17 或 16:17');
    return;
  }
  const domain = state.currentDomain;
  const checkin = await request(domain, '/user/checkin', { method: 'POST' });
  if (checkin.status !== 200) throw new Error(`签到接口 HTTP ${checkin.status}`);
  const result = classifyCheckin(checkin.body);
  const freshAccount = await checkUser(domain);
  if (freshAccount.kind !== 'authenticated') throw new Error('签到后未能读取首页剩余流量');
  report.push(`签到：${result.status === 'success' ? '成功' : '今日已签到'}`);
  report.push(`今日领取：${result.gained || '未知（' + result.message + '）'}`);
  report.push(`剩余流量：${freshAccount.remaining}`);
  state.lastCheckinDate = today;
  await saveState();
}

try {
  await ensureUsableCookie();
  try { await maybeNotifyExpiry(); } catch (error) { problems.push(`到期提醒失败：${error.message}`); }
  try { await runCheckin(); } catch (error) { problems.push(`签到失败：${error.message}`); }
} catch (error) {
  problems.push(`Cookie 验证失败：${error.message}`);
}
report.unshift(`当前域名：${state.currentDomain}`);
const summary = `# iKuuu 每日签到\n\n${report.map(v => `- ${v}`).join('\n')}${problems.length ? `\n\n## 需要处理\n\n${problems.map(v => `- ${v}`).join('\n')}` : ''}\n`;
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
if (problems.length) process.exitCode = 1;
