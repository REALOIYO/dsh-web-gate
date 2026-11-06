/**
 * 网关反代核心。
 *
 * 它解决的问题
 * ------------
 * `dsh --profile web` 只监听 loopback，局域网里的手机连不上。官方的做法是
 * 「前面放一个反向代理 + `--trusted-host`」，但桌面版由 Electron 启动，
 * 命令行参数和端口都不受用户控制，那条路走不通。
 *
 * 本网关跑在 Host 进程内部，因此能做外部反代做不到的两件事：
 *   1. 从 `ctx.webServer.port` 直接拿到上游端口；
 *   2. 从 `ctx.connection.authenticatedUrl()` 拿到带 launch token 的 URL，
 *      自己完成「token → 会话 cookie」握手。
 *
 * 三条设计约束
 * ------------
 * 1. **不改 DSH 页面**：不注入脚本、不改 HTML、不加 URL 标记。对 DSH 来说，
 *    进来的就是一个普通 loopback 浏览器。
 *
 * 2. **上游 Cookie 一律扣在服务端**（本文件最重要的一条）。
 *    DSH 的本地认证 Cookie 名是 `dsh-auth-<sha256(host:port)>`——**名字里带端口**。
 *    桌面版每次启动端口都变（实测 52185 / 59209 / …），旧 Cookie 不会被清理，
 *    于是手机上会越攒越多；累积到 71 个时仅 Cookie 头就约 16.4 KB，直接撞穿
 *    Node 的 16 KB 请求头上限，返回 HTTP 431（本工作区 docs/incidents/ 有两份
 *    完整事故档案）。所以：上游的 `Set-Cookie` 全部拦下存内存，转发时也只注入
 *    当前这一个。手机侧只持有网关自己的 `dsh_gate_session`，永远只有一个 Cookie。
 *
 * 3. **握手由网关自己完成**：第一次请求时若还没有上游 Cookie，网关先内部请求一次
 *    带 token 的 `/`，抓到 Cookie 再转发原始请求。客户端看不到 303，
 *    也就避开了「http + 纯 IP 源上 3xx 下发的 Cookie 被浏览器丢弃」那类坑。
 */
import http from 'node:http';
import { pickCookiesByPrefix } from './cookies.js';
import { renderLoginPage } from './login-page.js';

/** 网关自己的保留路径前缀，先于一切转发处理。 */
export const GATE_PATH_PREFIX = '/_gate/';

/** DSH 本地认证 Cookie 的前缀。 */
export const UPSTREAM_COOKIE_PREFIX = 'dsh-auth-';

export const DEFAULT_GATE_PORT = 3082;

/** 登录表单 body 上限，防被灌爆。 */
const MAX_BODY_BYTES = 32 * 1024;

/** 逐跳头，转发时两端都要摘掉。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * 读取请求体（带上限）。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<string>}
 */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 只接受站内相对路径，挡掉开放重定向。
 * @param {unknown} value
 * @returns {string}
 */
export function safeNextPath(value) {
  const raw = String(value ?? '');
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/';
  if (raw.startsWith('/\\')) return '/';
  return raw;
}

/**
 * 构建发往上游的请求头。
 *
 * - `host` / `origin` / `referer` 一律改写成 loopback 权威，让宿主的 Host 栅栏放行；
 * - `cookie` 完全替换成网关持有的那一个上游会话 Cookie（客户端带来的一律丢弃）；
 * - 其余逐跳头摘掉。
 *
 * @param {import('node:http').IncomingHttpHeaders} src
 * @param {{upstreamHost: string, upstreamPort: number, cookie: {name: string, value: string}|null, keepUpgrade?: boolean}} opts
 * @returns {Record<string, string|string[]>}
 */
export function buildUpstreamHeaders(src, { upstreamHost, upstreamPort, cookie, keepUpgrade = false }) {
  const authority = `${upstreamHost}:${upstreamPort}`;
  /** @type {Record<string, string|string[]>} */
  const out = {};

  for (const [key, value] of Object.entries(src)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'cookie') continue;              // 由网关接管
    if (HOP_BY_HOP.has(lower) && !(keepUpgrade && (lower === 'connection' || lower === 'upgrade'))) continue;
    if (lower === 'host') continue;
    if (lower === 'origin') continue;
    if (lower === 'referer') continue;
    out[key] = value;
  }

  out.host = authority;
  if (src.origin !== undefined) out.origin = `http://${authority}`;
  if (src.referer !== undefined) out.referer = `http://${authority}/`;

  if (cookie) out.cookie = `${cookie.name}=${cookie.value}`;

  if (keepUpgrade) {
    out.connection = 'Upgrade';
    out.upgrade = typeof src.upgrade === 'string' ? src.upgrade : 'websocket';
  }

  return out;
}

/**
 * 把响应头筛成可转发给客户端的集合。
 *
 * `set-cookie` 一律丢弃：上游的认证 Cookie 由网关在服务端持有，
 * 不能让它在客户端侧累积（见文件头第 2 条约束）。
 *
 * @param {import('node:http').IncomingHttpHeaders} src
 * @returns {Record<string, string|string[]>}
 */
export function buildDownstreamHeaders(src) {
  /** @type {Record<string, string|string[]>} */
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'set-cookie') continue;
    out[key] = value;
  }
  return out;
}

/**
 * 创建网关。
 *
 * @param {{
 *   port?: number,
 *   host?: string,
 *   upstreamHost?: string,
 *   upstreamPort: number,
 *   auth: ReturnType<import('./auth.js').createAuth>,
 *   getLaunchToken?: () => string,
 *   logger?: {info?: Function, warn?: Function, error?: Function},
 * }} options
 */
export function createGateProxy(options) {
  const {
    port = DEFAULT_GATE_PORT,
    host = '0.0.0.0',
    upstreamHost = '127.0.0.1',
    upstreamPort,
    auth,
    getLaunchToken = () => '',
    logger = console,
  } = options ?? {};

  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
    throw new Error('dsh-web-gate: upstreamPort must be a positive integer');
  }
  if (!auth) throw new Error('dsh-web-gate: auth is required');

  const log = (level, message) => {
    try {
      const fn = logger[level];
      if (typeof fn === 'function') fn.call(logger, `[dsh-web-gate] ${message}`);
    } catch {
      // 日志失败不该影响转发
    }
  };

  /** 服务端持有的上游会话 Cookie。 */
  let upstreamCookie = null;
  /** 进行中的握手，避免并发重复。 */
  let handshake = null;

  /** 客户端真实 IP（限速身份键）。只信 socket 地址，不信可伪造的头。 */
  function clientIp(req) {
    const addr = req.socket?.remoteAddress ?? '';
    if (addr.startsWith('::ffff:')) return addr.slice(7);
    return addr || 'unknown';
  }

  /**
   * 上游是否还没握手过（没有 Cookie，或刚被 401 清掉）。
   */
  function needsHandshake() {
    return upstreamCookie === null;
  }

  /**
   * 自己完成一次「launch token → 会话 Cookie」握手。
   *
   * 拿不到 token（老版本 DSH）时返回 null，由调用方按原样转发。
   *
   * @returns {Promise<{name: string, value: string}|null>}
   */
  function ensureUpstreamCookie() {
    if (upstreamCookie) return Promise.resolve(upstreamCookie);
    if (handshake) return handshake;

    let token = '';
    try {
      token = String(getLaunchToken() ?? '');
    } catch (error) {
      log('warn', `launch token 获取失败：${error?.message ?? error}`);
    }

    // 拿不到 token 就别白跑一次：需要认证的宿主这时候必然给 401，
    // 不需要认证的部署直接转发本来就能通。
    if (!token) return Promise.resolve(null);

    handshake = (async () => {
      const path = `/?token=${encodeURIComponent(token)}`;

      return await new Promise((resolve) => {
        const req = http.request(
          {
            host: upstreamHost,
            port: upstreamPort,
            path,
            method: 'GET',
            headers: { host: `${upstreamHost}:${upstreamPort}`, accept: 'text/html' },
          },
          (res) => {
            const found = pickCookiesByPrefix(res.headers['set-cookie'] ?? [], UPSTREAM_COOKIE_PREFIX);
            if (found.length > 0) {
              upstreamCookie = found[found.length - 1];
              log('info', `上游会话已建立（cookie ${upstreamCookie.name.slice(0, 20)}…）`);
            } else if (res.statusCode !== 200 && res.statusCode !== 303) {
              log('warn', `握手未拿到会话 cookie，上游返回 ${res.statusCode}`);
            }
            res.resume(); // 丢弃 body，只为拿 cookie
            res.on('end', () => resolve(upstreamCookie));
          },
        );
        req.on('error', (error) => {
          log('warn', `握手请求失败：${error?.message ?? error}`);
          resolve(null);
        });
        req.setTimeout(8000, () => req.destroy(new Error('handshake timeout')));
        req.end();
      });
    })().finally(() => {
      handshake = null;
    });

    return handshake;
  }

  // ---------- 网关自身路径 ----------

  function sendHtml(res, status, html) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(html),
    });
    res.end(html);
  }

  function loginPage(res, status, opts) {
    sendHtml(res, status, renderLoginPage(opts));
  }

  async function handleLogin(req, res, url) {
    const ip = clientIp(req);
    const limit = auth.limiter.status(ip);
    if (limit.locked) {
      loginPage(res, 429, { lockedFor: limit.retryAfter, next: safeNextPath(url.searchParams.get('next')) });
      return;
    }

    let body = '';
    try {
      body = await readBody(req);
    } catch {
      loginPage(res, 413, { error: '请求过大。' });
      return;
    }

    const form = new URLSearchParams(body);
    const next = safeNextPath(form.get('next'));

    if (!auth.checkPassword(form.get('password'))) {
      auth.limiter.record(ip);
      log('warn', `登录失败（${ip}）`);
      loginPage(res, 401, { error: '密码不正确。', next });
      return;
    }

    auth.limiter.clear(ip);
    log('info', `登录成功（${ip}）`);
    res.writeHead(302, {
      location: next,
      'set-cookie': auth.sessionCookieHeader(),
      'cache-control': 'no-store',
    });
    res.end();
  }

  function handleLogout(res) {
    res.writeHead(302, {
      location: '/',
      'set-cookie': auth.clearCookieHeader(),
      'cache-control': 'no-store',
    });
    res.end();
  }

  // ---------- 转发 ----------

  /**
   * 转发一个普通 HTTP 请求。
   */
  async function forward(req, res, url) {
    const isRootGet = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html');

    // 先把上游会话握好再转发，客户端就不会看到 303。
    // 不限于根路径：手机可能在深链接（例如 /api/...）上落地。
    if (needsHandshake()) {
      await ensureUpstreamCookie();
    }

    const cookie = upstreamCookie;
    let path = url.pathname + url.search;

    // 还没有会话时，退回「请求里带 token」的老办法（老版本 DSH 也能用）
    if (!cookie && isRootGet) {
      let token = '';
      try {
        token = String(getLaunchToken() ?? '');
      } catch {
        token = '';
      }
      if (token) {
        const withToken = new URL(url.pathname + url.search, 'http://upstream.invalid');
        withToken.searchParams.set('token', token);
        path = withToken.pathname + withToken.search;
      }
    }

    const headers = buildUpstreamHeaders(req.headers, { upstreamHost, upstreamPort, cookie });

    const upstreamReq = http.request(
      { host: upstreamHost, port: upstreamPort, path, method: req.method, headers },
      (upstreamRes) => {
        // 会话失效：清掉，下一次根路径访问会重新握手
        if (upstreamRes.statusCode === 401) {
          if (upstreamCookie) log('warn', '上游返回 401，丢弃本地会话缓存');
          upstreamCookie = null;
        }

        // 顺手把上游新下发的会话 Cookie 收下（例如 token 握手那条路径）
        const issued = pickCookiesByPrefix(upstreamRes.headers['set-cookie'] ?? [], UPSTREAM_COOKIE_PREFIX);
        if (issued.length > 0) upstreamCookie = issued[issued.length - 1];

        const outHeaders = buildDownstreamHeaders(upstreamRes.headers);
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, outHeaders);
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on('error', (error) => {
      log('error', `转发失败：${error?.message ?? error}`);
      if (!res.headersSent) {
        sendHtml(res, 502, '<!doctype html><meta charset="utf-8"><title>DSH 网关</title>'
          + '<body style="font:16px/1.7 -apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;padding:40px;color:#111827">'
          + '<h1 style="font-size:18px">连不上 DSH</h1>'
          + '<p style="color:#6b7280">网关没能连上本机的 DSH 服务。它可能正在重启，或者已经退出。</p></body>');
      } else {
        res.destroy();
      }
    });

    req.pipe(upstreamReq);
  }

  // ---------- WebSocket ----------

  function handleUpgrade(req, socket, head) {
    if (!auth.isAuthenticated(req.headers.cookie)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://gate.invalid');
    const headers = buildUpstreamHeaders(req.headers, {
      upstreamHost,
      upstreamPort,
      cookie: upstreamCookie,
      keepUpgrade: true,
    });

    const upstreamReq = http.request({
      host: upstreamHost,
      port: upstreamPort,
      path: url.pathname + url.search,
      method: 'GET',
      headers,
    });

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 101} Switching Protocols`];
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue;
        if (value instanceof Array) {
          for (const item of value) lines.push(`${key}: ${item}`);
        } else {
          lines.push(`${key}: ${value}`);
        }
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);

      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);

      const teardown = () => {
        socket.destroy();
        upstreamSocket.destroy();
      };
      socket.on('error', teardown);
      upstreamSocket.on('error', teardown);
    });

    upstreamReq.on('response', (upstreamRes) => {
      if (upstreamRes.statusCode === 401) upstreamCookie = null;
      socket.write(`HTTP/1.1 ${upstreamRes.statusCode} Unauthorized\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    });

    upstreamReq.on('error', () => socket.destroy());
    upstreamReq.end();
  }

  // ---------- 服务器 ----------

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://gate.invalid');

    if (url.pathname.startsWith(GATE_PATH_PREFIX)) {
      const action = url.pathname.slice(GATE_PATH_PREFIX.length);
      if (action === 'login' && req.method === 'POST') {
        handleLogin(req, res, url).catch((error) => {
          log('error', `登录处理异常：${error?.message ?? error}`);
          if (!res.headersSent) loginPage(res, 500, { error: '内部错误。' });
        });
        return;
      }
      if (action === 'logout') {
        handleLogout(res);
        return;
      }
      sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><title>404</title><body>Not found</body>');
      return;
    }

    if (!auth.isAuthenticated(req.headers.cookie)) {
      const next = url.pathname + url.search;
      loginPage(res, 200, { next });
      return;
    }

    forward(req, res, url).catch((error) => {
      log('error', `转发异常：${error?.message ?? error}`);
      if (!res.headersSent) sendHtml(res, 502, '<!doctype html><meta charset="utf-8"><body>Bad gateway</body>');
    });
  });

  server.on('upgrade', handleUpgrade);

  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return {
    server,
    port,
    host,
    upstreamPort,
    /** 当前上游 Cookie 名字（诊断用，不含值）。 */
    upstreamCookieName: () => upstreamCookie?.name ?? null,
    /** 主动丢弃上游会话（诊断/测试用）。 */
    resetUpstream: () => {
      upstreamCookie = null;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
