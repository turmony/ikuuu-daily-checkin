const encoder = new TextEncoder();
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));

export async function fingerprint(cookie) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(cookie)))].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function encryptionKey(secret) {
  let raw;
  try { raw = decode(secret); } catch { throw new Error('COOKIE_ENCRYPTION_KEY 必须是 32 字节密钥的 Base64'); }
  if (raw.length !== 32) throw new Error('COOKIE_ENCRYPTION_KEY 必须是 32 字节密钥的 Base64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptCookie(cookie, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: encoder.encode('ikuuu-cookie-v1')}, await encryptionKey(secret), encoder.encode(cookie));
  return {iv: encode(iv), data: encode(data)};
}

export async function decryptCookie(value, secret) {
  const data = await crypto.subtle.decrypt({name: 'AES-GCM', iv: decode(value.iv), additionalData: encoder.encode('ikuuu-cookie-v1')}, await encryptionKey(secret), decode(value.data));
  return new TextDecoder().decode(data);
}

export async function authorized(header, token) {
  if (!token || token.length < 32 || !header?.startsWith('Bearer ')) return false;
  const [supplied, expected] = await Promise.all([header.slice(7),token].map(value => crypto.subtle.digest('SHA-256',encoder.encode(value))));
  return crypto.subtle.timingSafeEqual(supplied,expected);
}
