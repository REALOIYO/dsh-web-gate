/**
 * dsh-web-gate 插件入口。
 *
 * 在 Host 进程内部起一个带密码的局域网网关，让手机浏览器能访问 DSH Web UI。
 *
 * 为什么必须是插件
 * ----------------
 * 外部反代做不到两件事：拿不到 `ctx.webServer.port`（桌面版端口每次启动都变），
 * 也拿不到 `ctx.connection.authenticatedUrl()`（那里面有换会话 Cookie 用的 launch token）。
 * 跑在 Host 进程里就都拿到了，而且**不必给 DSH 传任何命令行参数**。
 *
 * 本插件**不声明 client**——不注入脚本、不改页面、不加 URL 标记。
 */
import { createAuth } from './auth.js';
import { lanAddresses } from './net.js';
import { createGateProxy, DEFAULT_GATE_PORT } from './proxy.js';
import { installGateRpc } from './rpc.js';
import { gateHome, resolveSettings } from './settings.js';

export const name = 'dsh-web-gate';

/** 只注入宿主服务；刻意没有 dsh.client，因此页面不会被改动。 */
export const inject = ['connection', 'webServer'];

export { createAuth } from './auth.js';
export { createGateProxy, DEFAULT_GATE_PORT } from './proxy.js';
export { gateHome, resolveSettings, generatePassword } from './settings.js';

/**
 * 取一个能用的日志器。
 * @param {any} ctx
 */
function pickLogger(ctx) {
  // 注意：cordis 对**未 inject 的服务**会在属性 getter 里直接抛错，
  // 可选链挡不住——`ctx?.log` 一样抛 `cannot get property "log" without inject`。
  // 所以只能逐项 try/catch；拿不到就退回 console（它同样会进宿主日志）。
  // 刻意不把 log 写进 inject：万一某个 profile 下没有这个服务，
  // 插件会永久 pending（等一个不会出现的服务），那比没有日志器糟得多。
  for (const name of ['logger', 'log']) {
    try {
      const candidate = ctx?.[name];
      if (candidate && typeof candidate.info === 'function') return candidate;
    } catch {
      // 该服务未被 inject，跳过
    }
  }
  return console;
}

export { lanAddresses } from './net.js';
export { installGateRpc, RPC_PATH } from './rpc.js';

/**
 * 尽力打印二维码；没装 qrcode-terminal 就安静跳过。
 * @param {any} logger
 * @param {string} url
 */
async function printQr(logger, url) {
  try {
    const mod = await import('qrcode-terminal');
    const generate = mod?.default?.generate ?? mod?.generate;
    if (typeof generate !== 'function') return;
    generate(url, { small: true }, (qr) => logger.info?.(`\n${qr}`));
  } catch {
    // 可选依赖，装没装都能用
  }
}

/**
 * 插件主体。
 *
 * @param {any} ctx cordis 上下文
 * @param {{port?: number, host?: string, password?: string, home?: string}} [config]
 */
export function apply(ctx, config = {}) {
  const logger = pickLogger(ctx);
  const upstreamPort = Number(ctx?.webServer?.port);

  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
    logger.warn?.('[dsh-web-gate] 读不到 dsh web 端口，网关未启动');
    return undefined;
  }

  const dir = gateHome(config.home);

  let settings;
  try {
    settings = resolveSettings({
      dir,
      port: config.port,
      host: config.host,
      password: config.password,
    });
  } catch (error) {
    logger.error?.(`[dsh-web-gate] 配置初始化失败：${error?.message ?? error}`);
    return undefined;
  }

  const auth = createAuth({ password: settings.password, secret: settings.secret });

  /**
   * 从宿主的 connection 服务实时取 launch token。
   * 每次请求现取，因为 DSH 重启后 token 会变。
   */
  const getLaunchToken = () => {
    try {
      const fn = ctx?.connection?.authenticatedUrl;
      if (typeof fn !== 'function') return '';
      const url = new URL(fn.call(ctx.connection, `http://127.0.0.1:${upstreamPort}`));
      return url.searchParams.get('token') ?? '';
    } catch {
      return '';
    }
  };

  const gate = createGateProxy({
    port: settings.port,
    host: settings.host,
    upstreamPort,
    auth,
    getLaunchToken,
    logger,
  });

  gate
    .listen()
    .then((address) => {
      const boundPort = typeof address === 'object' && address ? address.port : settings.port;
      const hosts = settings.host === '0.0.0.0' || settings.host === '::'
        ? lanAddresses()
        : [settings.host];

      logger.info?.('[dsh-web-gate] 网关已启动，DSH 页面未被改动');
      if (hosts.length === 0) {
        logger.warn?.('[dsh-web-gate] 没检测到局域网地址，确认已连上 WiFi/网线');
      }
      for (const ip of hosts) {
        logger.info?.(`[dsh-web-gate]   手机访问：http://${ip}:${boundPort}`);
      }
      if (Array.isArray(hosts) && hosts.length > 0) {
        void printQr(logger, `http://${hosts[0]}:${boundPort}`);
      }
      logger.info?.(`[dsh-web-gate]   访问密码：${settings.password}`);
      if (settings.generated.password) {
        logger.info?.('[dsh-web-gate]   （密码已写入 settings.json，可自行修改后重启）');
      }
      logger.info?.(`[dsh-web-gate]   配置文件：${settings.dir}`);
    })
    .catch((error) => {
      const code = error?.code ?? '';
      if (code === 'EADDRINUSE') {
        logger.error?.(`[dsh-web-gate] 端口 ${settings.port} 已被占用，请改配置后重启`);
      } else {
        logger.error?.(`[dsh-web-gate] 监听失败：${error?.message ?? error}`);
      }
    });

  const removeRpc = installGateRpc(ctx, { gate, auth, settings, log: logger });

  const dispose = () => {
    removeRpc();
    gate.close().catch(() => {});
  };
  if (typeof ctx?.on === 'function') ctx.on('dispose', dispose);

  return gate;
}
