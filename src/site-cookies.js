import {cookieEntries} from './core.js';

// A request-local jar. Never share website sessions between Worker requests.
export class SiteCookies {
  constructor(domain, raw = '', now = Date.now()) {
    this.domain = domain;
    this.now = now;
    this.entries = new Map([...cookieEntries(raw)].map(([name,value]) => [name,{value,path:'/'}]));
  }

  receive(headers, requestPath) {
    const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : headers.getAll('Set-Cookie');
    for (const raw of values) {
      const [pair,...parts] = raw.split(';');
      const equal = pair.indexOf('=');
      if (equal < 1) continue;
      const name = pair.slice(0,equal).trim(), value = pair.slice(equal+1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) continue;
      const attrs = new Map(parts.map(part => {
        const index = part.indexOf('=');
        return index < 0 ? [part.trim().toLowerCase(),''] : [part.slice(0,index).trim().toLowerCase(),part.slice(index+1).trim()];
      }));
      const domain = attrs.get('domain')?.replace(/^\./,'').toLowerCase();
      if (domain && domain !== this.domain) continue;
      const defaultPath = requestPath.slice(0,requestPath.lastIndexOf('/')) || '/';
      const path = attrs.get('path')?.startsWith('/') ? attrs.get('path') : defaultPath;
      const age = attrs.get('max-age');
      const expires = age !== undefined && /^-?\d+$/.test(age) ? this.now + Number(age)*1000 : Date.parse(attrs.get('expires') || '');
      if (Number.isFinite(expires) && expires <= this.now) this.entries.delete(name);
      else this.entries.set(name,{value,path,expires});
    }
  }

  header(path) {
    const value = [...this.entries].filter(([,cookie]) =>
      (!Number.isFinite(cookie.expires) || cookie.expires > this.now) &&
      (path === cookie.path || path.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path+'/'))
    ).map(([name,cookie]) => `${name}=${cookie.value}`).join('; ');
    if (value.length > 16_384) throw new Error('网站 Cookie 超过长度限制');
    return value;
  }
}
