/**
 * 认证层：访问密码、会话 Cookie、登录限速。
 *
 * 设计要点
 * --------
 * 1. 会话 Cookie 的值 = HMAC-SHA256(secret, password)。
 *    - secret 持久在 settings.json → 密码不变则手机长期免输；
 *    - 改密码 → 所有旧 Cookie 立刻失效（合理且符合直觉）；
 *    - 服务端不需要存任何会话表。
 *
 * 2. 比较一律走常量时间，避免密码与时序侧信道。
 *
 * 3. 限速是内存态，随进程生命周期存在——和「重启后要重新输密码」的语义一致。
 */
import { createHmac } from 'node:crypto';
import { parseCookies, serializeCookie, timingSafeEqual } from './cookies.js';

/** 网关自己的会话 Cookie 名。刻意不用 dsh-auth- 前缀，避免和宿主混淆。 */
export const GATE_COOKIE = 'dsh_gate_session';

/** 会话有效期：30 天（秒）。 */
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export const DEFAULT_RATE_LIMIT = {
  windowMs: 60_000,
  maxFailures: 5,
  lockMs: 60_000,
  globalMaxFailures: 50,
  globalLockMs: 30_000,
};

/**
 * 派生会话 Cookie 值。
 *
 * @param {string} secret 持久密钥
 * @param {string} password 访问密码
 * @returns {string} base64url 摘要
 */
export function sessionValue(secret, password) {
  return createHmac('sha256', secret).update(String(password)).digest('base64url');
}

/**
 * 滑动窗口限速器（单 IP 一层 + 全局一层）。
 *
 * 只用来挡住「无限制重试穷举密码」，不做流量整形。
 *
 * @param {Partial<typeof DEFAULT_RATE_LIMIT>} [cfg]
 */
export function createRateLimiter(cfg = {}) {
  const c = { ...DEFAULT_RATE_LIMIT, ...cfg };
  /** @type {Map<string, {count: number, windowStart: number}>} */
  const failures = new Map();
  /** @type {Map<string, number>} */
  const locks = new Map();
  const global = { count: 0, windowStart: 0, lockedUntil: 0 };

  return {
    /**
     * 该 IP 当前是否被锁。
     * @param {string} ip
     * @returns {{locked: boolean, retryAfter: number}}
     */
    status(ip) {
      const now = Date.now();
      if (global.lockedUntil > now) {
        return { locked: true, retryAfter: Math.ceil((global.lockedUntil - now) / 1000) };
      }
      const until = locks.get(ip) ?? 0;
      if (until > now) {
        return { locked: true, retryAfter: Math.ceil((until - now) / 1000) };
      }
      return { locked: false, retryAfter: 0 };
    },

    /**
     * 记一次失败（密码错、或限速命中后的继续尝试）。
     * @param {string} ip
     */
    record(ip) {
      const now = Date.now();

      let rec = failures.get(ip);
      if (!rec || now - rec.windowStart > c.windowMs) {
        rec = { count: 0, windowStart: now };
      }
      rec.count += 1;
      failures.set(ip, rec);

      if (now - global.windowStart > c.windowMs) {
        global.count = 0;
        global.windowStart = now;
      }
      global.count += 1;

      if (rec.count >= c.maxFailures) locks.set(ip, now + c.lockMs);
      if (global.count >= c.globalMaxFailures) global.lockedUntil = now + c.globalLockMs;

      // 防内存膨胀：记录过多时清掉已出窗口的条目
      if (failures.size > 2000) {
        for (const [key, value] of failures) {
          if (now - value.windowStart > c.windowMs) failures.delete(key);
        }
      }
    },

    /**
     * 登录成功：清空该 IP 的计数与锁。
     * @param {string} ip
     */
    clear(ip) {
      failures.delete(ip);
      locks.delete(ip);
    },

    /** 仅供测试观察状态。 */
    _snapshot() {
      return { failures: failures.size, locks: locks.size, global: { ...global } };
    },
  };
}

/**
 * 建立认证器。
 *
 * @param {{password: string, secret: string, rateLimit?: object}} options
 */
export function createAuth({ password, secret, rateLimit = {} }) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('dsh-web-gate: password must be a non-empty string');
  }
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('dsh-web-gate: secret must be at least 16 characters');
  }

  let currentPassword = password;
  let expected = sessionValue(secret, currentPassword);
  const limiter = createRateLimiter(rateLimit);

  return {
    /** 会话 Cookie 名 */
    cookieName: GATE_COOKIE,

    /**
     * 请求是否已通过网关认证。
     * @param {string|undefined} cookieHeader
     */
    isAuthenticated(cookieHeader) {
      const got = parseCookies(cookieHeader)[GATE_COOKIE];
      return typeof got === 'string' && timingSafeEqual(got, expected);
    },

    /**
     * 校验用户提交的密码。
     * @param {unknown} input
     */
    checkPassword(input) {
      return timingSafeEqual(String(input ?? ''), currentPassword);
    },

    /** 登录成功后下发的 Set-Cookie。内存模式 + 同源，用 Lax 足够。 */
    sessionCookieHeader() {
      return serializeCookie(GATE_COOKIE, expected, {
        maxAge: SESSION_MAX_AGE,
        httpOnly: true,
        sameSite: 'Lax',
      });
    },

    /** 登出时清 Cookie。 */
    clearCookieHeader() {
      return serializeCookie(GATE_COOKIE, '', {
        maxAge: 0,
        httpOnly: true,
        sameSite: 'Lax',
      });
    },

    /**
     * 更换访问密码。会话值由密码派生，因此旧 Cookie 立刻全部失效。
     * @param {string} next
     */
    setPassword(next) {
      if (typeof next !== 'string' || next.length === 0) {
        throw new Error('dsh-web-gate: password must be a non-empty string');
      }
      currentPassword = next;
      expected = sessionValue(secret, next);
    },

    limiter,
  };
}
