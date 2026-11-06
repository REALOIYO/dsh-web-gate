/**
 * Cookie 工具：解析、序列化、常量时间比较。
 *
 * 本文件不依赖任何第三方包，也不碰 Node 的 http 模块，方便单独测试。
 */
import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

/**
 * 解析 `Cookie:` 请求头。
 *
 * 容错策略：
 *   - 空串/非字符串 → 空对象
 *   - 无 `=` 的片段直接跳过（而不是把整段当名字）
 *   - 同名只取第一个（浏览器通常不会发重名，但代理链路可能）
 *   - 允许值带双引号（RFC 6265 的 quoted-string 形式）
 *
 * @param {string|undefined|null} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header.length === 0) return out;

  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=');
    if (eq < 0) continue;

    const name = segment.slice(0, eq).trim();
    if (name.length === 0) continue;

    let value = segment.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    if (!(name in out)) out[name] = value;
  }

  return out;
}

/**
 * 序列化一个 Set-Cookie 值。
 *
 * 只实现本插件用得到的属性；默认按最保守的组合来（HttpOnly + SameSite=Lax）。
 *
 * @param {string} name
 * @param {string} value
 * @param {{maxAge?: number, path?: string, httpOnly?: boolean, sameSite?: string|false, secure?: boolean}} [opts]
 * @returns {string}
 */
export function serializeCookie(name, value, opts = {}) {
  const {
    maxAge,
    path = '/',
    httpOnly = true,
    sameSite = 'Lax',
    secure = false,
  } = opts;

  const parts = [`${name}=${value}`];
  if (typeof maxAge === 'number' && Number.isFinite(maxAge)) {
    parts.push(`Max-Age=${Math.trunc(maxAge)}`);
  }
  if (path) parts.push(`Path=${path}`);
  if (httpOnly) parts.push('HttpOnly');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * 常量时间字符串比较。
 *
 * 长度不同时也先走一次比较，避免把「长度不等」做成可测量的早期返回。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    nodeTimingSafeEqual(left, left);
    return false;
  }
  return nodeTimingSafeEqual(left, right);
}

/**
 * 从一堆 Set-Cookie 头里，筛出带指定前缀的那些。
 *
 * @param {string[]} setCookieHeaders
 * @param {string} prefix
 * @returns {Array<{name: string, value: string}>}
 */
export function pickCookiesByPrefix(setCookieHeaders, prefix) {
  const found = [];
  for (const raw of Array.isArray(setCookieHeaders) ? setCookieHeaders : []) {
    if (typeof raw !== 'string') continue;
    const pair = raw.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!name.startsWith(prefix)) continue;
    found.push({ name, value: pair.slice(eq + 1).trim() });
  }
  return found;
}
