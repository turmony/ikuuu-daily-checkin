export const DEFAULT_SITES = ['https://ikuuu.top','https://ikuuu.pw'];

export function configuration(workerUrl, token, sites) {
  const worker = new URL(workerUrl.trim());
  if (worker.protocol !== 'https:' || worker.username || worker.password || worker.search || worker.hash || !['','/'].includes(worker.pathname)) {
    throw new Error('签到服务地址须为完整 HTTPS 入口，例如 https://你的服务.workers.dev');
  }
  if (!/^sync_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('请粘贴管理页面生成的扩展配对令牌');
  const origins = [...new Set(sites.map(site => {
    const url = new URL(site.includes('://') ? site.trim() : 'https://'+site.trim());
    if (url.protocol !== 'https:' || !/^ikuuu\.[a-z]{2,24}$/.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) {
      throw new Error('网站地址须为 https://ikuuu.<后缀>，多个地址以逗号或换行分隔');
    }
    return url.origin;
  }))];
  if (!origins.length || origins.length>10 || origins.includes(worker.origin)) throw new Error('请填写 1–10 个 iKuuu 网站地址');
  return {workerOrigin:worker.origin,token,sites:origins};
}

export function cookieHeader(cookies, now = Date.now()) {
  const entries = new Map();
  // Prefer the cookie with the most specific matching path for duplicate names.
  for (const cookie of [...cookies].sort((a,b)=>(b.path?.length || 0)-(a.path?.length || 0))) {
    if (cookie.partitionKey || (cookie.expirationDate !== undefined && cookie.expirationDate*1000<=now) ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) || /[;\r\n\x00-\x1f\x7f]/.test(cookie.value) || entries.has(cookie.name)) continue;
    entries.set(cookie.name,cookie.value);
  }
  const expiry=Number(entries.get('expire_in'));
  if (!entries.get('uid') || !entries.get('key') || !Number.isSafeInteger(expiry) || expiry*1000<=now) return null;
  const value=[...entries].sort(([a],[b])=>a.localeCompare(b)).map(([name,value])=>`${name}=${value}`).join('; ');
  if (value.length>16_384) throw new Error('Cookie 长度超过同步限制');
  return value;
}

export async function cookieHash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
}

export function sourceOrigin(url, sites) {
  try {const origin=new URL(url).origin;return sites.includes(origin)?origin:null;} catch {return null;}
}

export function errorMessage(status) {
  if (status===401) return '配对已失效，请在管理页面生成新令牌并重新保存设置';
  if (status===409) return '浏览器账号不匹配或 Cookie 较旧，请登录正确账号后重试';
  if (status===422) return 'Cookie 未通过云端登录验证，请完成网站登录后重试';
  if (status===429) return '同步过于频繁，已安排稍后重试';
  if (status===403) return '同步请求被拒绝，请核对服务地址和扩展权限';
  return '暂时无法连接或验证签到服务，已安排重试';
}
