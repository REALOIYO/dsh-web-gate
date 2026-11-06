/**
 * 设置页控制通道：浏览器 ⇄ 网关。
 *
 * 挂到 DSH 自己的 webServer 上（`kind: 'prefix'`），所以天然落在宿主认证之后：
 * 能打到这里的请求已经过了 DSH 的会话校验。再补一次 `requestRejection` 检查是因为
 * 判定里还包含 trusted host 之类的规则。
 *
 * 注意必须用 `.call()` 绑 this —— 它是类方法，抽成裸函数会丢 this、在内部抛错，
 * 最后被兜底成 403，表现为「设置页一直显示未就绪」。DSH 自己的 /api 路由也是
 * 以方法形式调用的。
 */
import { lanAddresses } from './net.js';
import { generatePassword, writeSettings } from './settings.js';

/** 控制通道路径前缀。 */
export const RPC_PATH = '/_dsh-web-gate';

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
});

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * 与 DSH 自己的 /api 路由同一套判定。返回 `undefined` 表示放行。
 */
function rejectionFor(ctx, req) {
  const connection = ctx?.connection;
  if (typeof connection?.requestRejection !== 'function') return undefined;
  try {
    return connection.requestRejection.call(connection, req);
  } catch {
    return 403;
  }
}

/**
 * 安装控制通道。
 *
 * @param {any} ctx
 * @param {{gate: any, auth: any, settings: any, log?: any}} options
 * @returns {() => void} 清理函数
 */
export function installGateRpc(ctx, { gate, auth, settings, log = console }) {
  const webServer = ctx?.webServer;
  if (!webServer || typeof webServer.register !== 'function') return () => {};

  const handler = (req, res) => {
    try {
      const rejection = rejectionFor(ctx, req);
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }

      const url = new URL(req.url ?? '/', 'http://gate.invalid');
      const action = url.pathname.slice(RPC_PATH.length).replace(/^\/+/, '');

      if (action === '' || action === 'status') {
        const wildcard = settings.host === '0.0.0.0' || settings.host === '::';
        sendJson(res, 200, {
          running: Boolean(gate.server?.listening),
          port: settings.port,
          host: settings.host,
          addresses: wildcard ? lanAddresses() : [settings.host],
          password: settings.password,
          upstreamBound: gate.upstreamCookieName() !== null,
        });
        return;
      }

      if (action === 'rotate') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        const next = generatePassword();
        settings.password = next;
        try {
          writeSettings(settings.dir, {
            secret: settings.secret,
            password: next,
            port: settings.port,
            host: settings.host,
          });
        } catch (error) {
          log.error?.(`[dsh-web-gate] 新密码落盘失败：${error?.message ?? error}`);
        }
        auth.setPassword(next);
        log.info?.('[dsh-web-gate] 访问密码已更换，所有已登录设备需重新验证');
        sendJson(res, 200, { password: next });
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      log.error?.(`[dsh-web-gate] 控制通道异常：${error?.message ?? error}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    }
  };

  const registered = webServer.register({ kind: 'prefix', path: RPC_PATH, handler });

  // register 可能返回 disposer / Promise<disposer> / undefined（仅写路由表）
  if (typeof registered === 'function') {
    return () => {
      try {
        registered();
      } catch {
        // 已清理
      }
    };
  }
  if (registered && typeof registered.then === 'function') {
    return () => {
      registered.then(
        (disposer) => {
          if (typeof disposer === 'function') disposer();
        },
        () => {},
      );
    };
  }
  return () => {};
}
