/**
 * 配置持久化。
 *
 * 落点：`$DSH_HOME/dsh-web-gate/settings.json`（默认 `~/.dsh/dsh-web-gate/`）。
 *
 * 只存网关自己的东西（持久密钥、密码、端口），不碰 DSH 的任何状态。
 * 文件按 0600 创建，避免同机其他用户读到密码。
 */
import { randomBytes, randomInt } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 直接排除 0/O/1/l/I 这类抄下来容易认错的字符。 */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * 解析网关数据目录。
 * @param {string} [dshHome]
 * @returns {string}
 */
export function gateHome(dshHome) {
  const base = dshHome || process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(base, 'dsh-web-gate');
}

/**
 * 生成随机访问密码。
 * @param {number} [length]
 * @returns {string}
 */
export function generatePassword(length = 10) {
  const size = Math.max(8, Math.trunc(length) || 10);
  let out = '';
  for (let i = 0; i < size; i += 1) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}

/** 自定义密码的长度下限，与随机生成的默认长度无关。 */
export const MIN_PASSWORD_LENGTH = 8;

/** 长度上限，避免把超长字符串塞进配置文件。 */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * 校验一个自定义密码。
 *
 * 刻意只做「长度 + 控制字符」两项：用户想用短语、符号、中文都随他，
 * 网关这边没有理由规定字符集——随机生成时才需要挑不易认错的字符。
 *
 * @param {unknown} value
 * @returns {string} 通过返回空字符串，否则返回能直接展示给用户的原因
 */
export function validatePassword(value) {
  if (typeof value !== 'string' || value.length === 0) return '密码不能为空';
  if (value.length < MIN_PASSWORD_LENGTH) return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  if (value.length > MAX_PASSWORD_LENGTH) return `密码最长 ${MAX_PASSWORD_LENGTH} 位`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return '密码不能包含控制字符';
  return '';
}

/**
 * 生成持久密钥。
 * @returns {string} 32 字节 hex
 */
export function generateSecret() {
  return randomBytes(32).toString('hex');
}

/**
 * 读取配置。文件不存在或损坏时返回空对象（由调用方补默认值）。
 *
 * @param {string} dir
 * @returns {Record<string, unknown>}
 */
export function readSettings(dir) {
  const file = join(dir, 'settings.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 写入配置。目录自动创建，文件权限收紧到 0600。
 *
 * @param {string} dir
 * @param {Record<string, unknown>} data
 */
export function writeSettings(dir, data) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 基本是空操作，失败不影响功能
  }
  return file;
}

/**
 * 把「配置项 → 持久值」合并好，需要时落盘。
 *
 * 优先级：显式配置 > 已存 settings.json > 新生成的随机值。
 *
 * @param {{dir: string, port?: number, host?: string, password?: string}} options
 * @returns {{port: number, host: string, password: string, secret: string, dir: string, generated: {password: boolean, secret: boolean}}}
 */
export function resolveSettings({ dir, port, host, password }) {
  const stored = readSettings(dir);
  const generated = { password: false, secret: false };

  let secret = typeof stored.secret === 'string' && stored.secret.length >= 16 ? stored.secret : '';
  if (!secret) {
    secret = generateSecret();
    generated.secret = true;
  }

  let finalPassword = typeof password === 'string' && password.length > 0
    ? password
    : (typeof stored.password === 'string' && stored.password.length > 0 ? stored.password : '');
  if (!finalPassword) {
    finalPassword = generatePassword();
    generated.password = true;
  }

  const finalPort = Number.isInteger(port) ? port : (Number.isInteger(stored.port) ? stored.port : 3082);
  const finalHost = typeof host === 'string' && host.length > 0
    ? host
    : (typeof stored.host === 'string' && stored.host.length > 0 ? stored.host : '0.0.0.0');

  const next = {
    ...stored,
    secret,
    password: finalPassword,
    port: finalPort,
    host: finalHost,
  };
  // 只有真的变了才写盘，避免每次启动都动文件
  const changed = stored.secret !== next.secret
    || stored.password !== next.password
    || stored.port !== next.port
    || stored.host !== next.host;
  if (changed) writeSettings(dir, next);

  return {
    port: finalPort,
    host: finalHost,
    password: finalPassword,
    secret,
    dir,
    generated,
  };
}
