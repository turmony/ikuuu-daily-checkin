export function cookieEntries(raw) {
  const entries = new Map();
  for (const part of raw.trim().split(';')) {
    const i = part.indexOf('=');
    if (i > 0) entries.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return entries;
}

export function cookieExpiry(raw) {
  const value = cookieEntries(raw).get('expire_in');
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1_000_000_000 || seconds > 9_999_999_999) {
    throw new Error('Cookie 中没有有效的 expire_in 时间戳');
  }
  return seconds;
}

export function normalizeDomain(host) {
  const value = String(host).trim().toLowerCase();
  if (!/^ikuuu\.[a-z]{2,24}$/.test(value)) throw new Error('域名格式不符合 ikuuu.<后缀>');
  return value;
}

export function domainsFromReply(text) {
  const domains = [];
  for (const match of String(text).matchAll(/https:\/\/ikuuu\.([a-z]{2,24})(?=[\/?#\s"'<>]|$)/gi)) {
    const host = normalizeDomain(`ikuuu.${match[1]}`);
    if (!domains.includes(host)) domains.push(host);
  }
  return domains;
}

export function decodedUserHtml(body) {
  const match = String(body).match(/var\s+originBody\s*=\s*"([A-Za-z0-9+/=]+)"/);
  return match ? Buffer.from(match[1], 'base64').toString('utf8') : String(body);
}

export function remainingTraffic(body) {
  const text = decodedUserHtml(body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const match = text.match(/剩余流量\s*([\d,.]+)\s*(KB|MB|GB|TB)/i);
  return match ? `${match[1]} ${match[2].toUpperCase()}` : null;
}

export function classifyCheckin(body) {
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('签到接口未返回 JSON'); }
  const message = String(data.msg ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 240);
  if (Number(data.ret) === 1) {
    const amount = message.match(/([\d,.]+)\s*(KB|MB|GB|TB|K|M|G|T)\b/i);
    return { status: 'success', message, gained: amount ? `${amount[1]} ${amount[2].toUpperCase()}` : null };
  }
  if (/已.{0,4}签到|签到过|already\s+checked/i.test(message)) {
    return { status: 'already', message, gained: null };
  }
  throw new Error(`签到未成功：${message || '未知响应'}`);
}

export function shanghaiDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function shanghaiHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

export class CookieExpiredError extends Error {}

export const RETRY_DELAYS_MS = [10, 30, 100].map(minutes => minutes * 60_000);

export async function withCheckinRetries(attempt, { wait, onRetry = () => {}, delays = RETRY_DELAYS_MS } = {}) {
  for (let index = 0; ; index++) {
    try {
      return await attempt(index + 1);
    } catch (error) {
      if (error instanceof CookieExpiredError || index >= delays.length) throw error;
      await onRetry(error, index + 1, delays[index]);
      await wait(delays[index]);
    }
  }
}
