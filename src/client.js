import {classifyCheckin, decodedUserHtml, normalizeDomain, remainingTraffic} from './core.js';
import {parseRetryAfter} from './schedule.js';
import {extractDomains} from './domain-source.js';
import {boundedText} from './body.js';

export class SiteError extends Error {
  constructor(kind, message, retryAfterMs = 0) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export function createClient(fetcher = fetch) {
  async function request(domain, path, cookie, method = 'GET') {
    const headers = {'User-Agent':'Mozilla/5.0', Accept:method === 'POST' ? 'application/json' : 'text/html'};
    if (cookie) headers.Cookie = cookie;
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    let response;
    try {
      response = await fetcher(`https://${normalizeDomain(domain)}${path}`, {
        method, headers, body:method === 'POST' ? '' : undefined,
        redirect:'manual', signal:AbortSignal.timeout(20_000),
      });
    } catch {
      throw new SiteError('network', '网站连接失败或超时');
    }
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location') || '';
      if (/\/auth\/login(?:[/?#]|$)/i.test(location) && path !== '/auth/login') throw new SiteError('cookie', '网站要求重新登录，Cookie 已失效');
      throw new SiteError('domain', '网站发生重定向，需要重新验证域名');
    }
    if (response.status === 429) throw new SiteError('limited', '网站限流 HTTP 429', parseRetryAfter(response.headers.get('retry-after'), Date.now()));
    if (response.status === 403) throw new SiteError('blocked', '网站拒绝访问 HTTP 403（不能据此判断 Cookie 失效）');
    if (response.status !== 200) throw new SiteError(response.status >= 500 ? 'server' : 'response', `网站返回 HTTP ${response.status}`);
    let body;
    try { body = await boundedText(response,1_000_000); } catch { throw new SiteError('network','读取网站响应失败或超过限制'); }
    return body;
  }

  async function account(domain, cookie) {
    const body = await request(domain, '/user', cookie);
    const html = decodedUserHtml(body);
    if (/name=["']password["']/i.test(html) && /Login|登录/i.test(html)) throw new SiteError('cookie','Cookie 已失效，请重新登录');
    if (/cf-chl|Just a moment|challenge-platform/i.test(html)) throw new SiteError('blocked','网站要求浏览器验证');
    const remaining = remainingTraffic(body);
    if (!remaining) throw new SiteError('response','无法识别账号页面或剩余流量');
    return {remaining};
  }

  async function checkin(domain, cookie) {
    const body = await request(domain, '/user/checkin', cookie, 'POST');
    let data;
    try {data=JSON.parse(body);} catch { /* The classifier reports malformed responses. */ }
    if(data && /未登录|请先登录|登录已过期|会话已过期|not logged in|session expired/i.test(String(data.msg || ''))) {
      throw new SiteError('cookie','签到接口明确要求重新登录，Cookie 已失效');
    }
    try { return classifyCheckin(body); }
    catch { throw new SiteError('response','签到接口未返回可确认的成功结果'); }
  }

  async function discover() {
    let response;
    try { response = await fetcher('https://ikuuu.win/', {redirect:'manual',signal:AbortSignal.timeout(20_000)}); }
    catch { throw new SiteError('discovery','无法访问域名发布页，保留已验证域名'); }
    if (response.status !== 200) throw new SiteError('discovery',`域名发布页 HTTP ${response.status}`);
    try { return extractDomains(await boundedText(response,1_000_000)); }
    catch { throw new SiteError('discovery','发布页解析失败，保留已验证域名'); }
  }

  async function verifyDomain(domain, cookie) {
    const html = decodedUserHtml(await request(domain, '/auth/login'));
    if (!/name=["']password["']/i.test(html) || !/Login|登录/i.test(html)) throw new SiteError('domain','候选域名未通过登录页面验证');
    return account(domain, cookie);
  }
  return {account, checkin, discover, verifyDomain};
}
