/**
 * 设置页控制通道的测试。
 *
 * 用一个假的 ctx（只实现 webServer.register / connection.requestRejection）
 * 驱动 route.handler，不启动真实服务器也不碰真实 DSH。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAuth } from '../lib/auth.js';
import { RPC_PATH, installGateRpc } from '../lib/rpc.js';

const PASSWORD = 'gate-pw-123456';
const SECRET = 'c'.repeat(48);
const silent = { info() {}, warn() {}, error() {} };

/** 假 ctx：抓住注册进来的 route。 */
function fakeCtx(options = {}) {
  let route = null;
  const ctx = {
    webServer: {
      register(candidate) {
        route = candidate;
        return () => {
          route = null;
        };
      },
    },
  };
  if (options.rejection !== undefined) {
    ctx.connection = { requestRejection: () => options.rejection };
  }
  return { ctx, currentRoute: () => route };
}

/** 假 ServerResponse：记下状态码、响应头和 body。 */
function fakeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    get headersSent() {
      return this.statusCode !== 0;
    },
    setHeader() {},
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
      return this;
    },
    end(chunk) {
      if (chunk) this.body += String(chunk);
    },
  };
}

/**
 * 假 IncomingMessage。
 *
 * `readBody` 是**订阅式**的（先 on('data')/on('end')，再由事件驱动回调），
 * 所以 body 必须在监听器注册完之后才投递 —— 放到微任务里。
 */
function fakeReq(url, method = 'GET', body = '') {
  const listeners = new Map();
  const req = {
    url,
    method,
    headers: {},
    readableEnded: false,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return req;
    },
    destroy() {},
    setTimeout() {},
  };
  queueMicrotask(() => {
    if (body) for (const fn of listeners.get('data') ?? []) fn(body);
    for (const fn of listeners.get('end') ?? []) fn();
  });
  return req;
}

/** 驱动一次请求。因为 readBody 是异步投递的，响应要等一个宏任务。 */
async function call(route, url, method = 'GET', body = '') {
  const res = fakeRes();
  route.handler(fakeReq(url, method, body), res);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return res;
}

function setup(options = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'dsh-web-gate-rpc-'));
  const settings = {
    port: 3082,
    host: '0.0.0.0',
    password: PASSWORD,
    secret: SECRET,
    dir,
  };
  const auth = createAuth({ password: PASSWORD, secret: SECRET });
  const gate = {
    server: { listening: options.listening !== false },
    upstreamCookieName: () => options.upstreamCookie ?? null,
  };
  const { ctx, currentRoute } = fakeCtx(options);
  const remove = installGateRpc(ctx, { gate, auth, settings, log: silent });
  return { dir, settings, auth, gate, remove, currentRoute, ownedDir: options.dir === undefined };
}

test('注册到 webServer，路径与 kind 正确', async (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const route = s.currentRoute();
  assert.ok(route, '应该注册了一个 route');
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, RPC_PATH);
  assert.equal(typeof route.handler, 'function');

  s.remove();
  assert.equal(s.currentRoute(), null, '清理函数应该注销 route');
});

test('status 返回端口、地址与密码', async (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const res = await call(s.currentRoute(), `${RPC_PATH}/status`);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);

  const data = JSON.parse(res.body);
  assert.equal(data.running, true);
  assert.equal(data.port, 3082);
  assert.equal(data.host, '0.0.0.0');
  assert.equal(data.password, PASSWORD);
  assert.equal(data.upstreamBound, false);
  assert.ok(Array.isArray(data.addresses));
});

test('status 反映上游会话与监听状态', async (t) => {
  const s = setup({ listening: false, upstreamCookie: 'dsh-auth-xyz' });
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const data = JSON.parse((await call(s.currentRoute(), `${RPC_PATH}/status`)).body);
  assert.equal(data.running, false);
  assert.equal(data.upstreamBound, true);
});

test('rotate 换密码、落盘、并让旧会话失效', async (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const before = (await call(s.currentRoute(), `${RPC_PATH}/status`)).body;
  assert.equal(JSON.parse(before).password, PASSWORD);

  const res = await call(s.currentRoute(), `${RPC_PATH}/rotate`, 'POST');
  assert.equal(res.statusCode, 200);
  const next = JSON.parse(res.body).password;
  assert.notEqual(next, PASSWORD);
  assert.ok(next.length >= 8, '新密码至少 8 位');

  // 写盘了
  const saved = JSON.parse(readFileSync(join(s.dir, 'settings.json'), 'utf8'));
  assert.equal(saved.password, next);
  assert.equal(saved.secret, SECRET, '密钥不该被动');

  // auth 已切换到新密码
  assert.equal(s.auth.checkPassword(next), true);
  assert.equal(s.auth.checkPassword(PASSWORD), false);

  // status 也跟着变
  const after = JSON.parse((await call(s.currentRoute(), `${RPC_PATH}/status`)).body);
  assert.equal(after.password, next);
});

test('rotate 支持自定义密码（用户自己定，不用随机串）', async (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const custom = 'my-own-pass-2026';
  const res = await call(
    s.currentRoute(),
    `${RPC_PATH}/rotate`,
    'POST',
    JSON.stringify({ password: custom }),
  );
  assert.equal(res.statusCode, 200);

  const data = JSON.parse(res.body);
  assert.equal(data.password, custom, '返回的应该就是自定义值，不是随机串');
  assert.equal(data.custom, true, '应该标明这是自定义密码');

  const saved = JSON.parse(readFileSync(join(s.dir, 'settings.json'), 'utf8'));
  assert.equal(saved.password, custom);
  assert.equal(saved.secret, SECRET, '密钥不该被动');

  assert.equal(s.auth.checkPassword(custom), true);
  assert.equal(s.auth.checkPassword(PASSWORD), false);

  const status = JSON.parse((await call(s.currentRoute(), `${RPC_PATH}/status`)).body);
  assert.equal(status.password, custom);
});

test('rotate 支持中文与符号的自定义密码', async (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const custom = '今天天气不错-2026!';
  const res = await call(
    s.currentRoute(),
    `${RPC_PATH}/rotate`,
    'POST',
    JSON.stringify({ password: custom }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).password, custom);
  assert.equal(s.auth.checkPassword(custom), true);
  assert.equal(
    JSON.parse(readFileSync(join(s.dir, 'settings.json'), 'utf8')).password,
    custom,
  );
});

test('rotate 拒绝太短的自定义密码，并且什么都不改', async (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const res = await call(
    s.currentRoute(),
    `${RPC_PATH}/rotate`,
    'POST',
    JSON.stringify({ password: 'short' }),
  );
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /至少 8 位/);

  assert.equal(s.settings.password, PASSWORD, '被拒时不该改动内存里的密码');
  assert.equal(s.auth.checkPassword(PASSWORD), true, '旧密码应该仍然有效');
});

test('rotate 拒绝控制字符的自定义密码', async (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const res = await call(
    s.currentRoute(),
    `${RPC_PATH}/rotate`,
    'POST',
    JSON.stringify({ password: 'long-enough\u0000but-bad' }),
  );
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /控制字符/);
  assert.equal(s.auth.checkPassword(PASSWORD), true);
});

test('rotate 不带自定义值时仍然随机生成', async (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const res = await call(s.currentRoute(), `${RPC_PATH}/rotate`, 'POST', JSON.stringify({}));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.custom, false);
  assert.ok(data.password.length >= 8);
  assert.notEqual(data.password, PASSWORD);
});

test('rotate 容忍非 JSON 请求体，退回随机生成', async (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const res = await call(s.currentRoute(), `${RPC_PATH}/rotate`, 'POST', 'not-json-at-all');
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).custom, false);
  assert.notEqual(JSON.parse(res.body).password, PASSWORD);
});

test('rotate 拒绝非 POST', async (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const res = await call(s.currentRoute(), `${RPC_PATH}/rotate`, 'GET');
  assert.equal(res.statusCode, 405);
});

test('requestRejection 的判定被遵守', async (t) => {
  const s = setup({ rejection: 403 });
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const res = await call(s.currentRoute(), `${RPC_PATH}/status`);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, 'forbidden');
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
});

test('未知路径返回 404', async (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const res = await call(s.currentRoute(), `${RPC_PATH}/nope`);
  assert.equal(res.statusCode, 404);
});

test('没有 webServer 时安静退化为空清理函数', async () => {
  const remove = installGateRpc({}, { gate: {}, auth: {}, settings: {}, log: silent });
  assert.equal(typeof remove, 'function');
  remove();
});
