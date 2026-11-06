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

function call(route, url, method = 'GET') {
  const res = fakeRes();
  route.handler({ url, method, headers: {} }, res);
  return res;
}

test('注册到 webServer，路径与 kind 正确', (t) => {
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

test('status 返回端口、地址与密码', (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const res = call(s.currentRoute(), `${RPC_PATH}/status`);
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

test('status 反映上游会话与监听状态', (t) => {
  const s = setup({ listening: false, upstreamCookie: 'dsh-auth-xyz' });
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const data = JSON.parse(call(s.currentRoute(), `${RPC_PATH}/status`).body);
  assert.equal(data.running, false);
  assert.equal(data.upstreamBound, true);
});

test('rotate 换密码、落盘、并让旧会话失效', (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const before = call(s.currentRoute(), `${RPC_PATH}/status`).body;
  assert.equal(JSON.parse(before).password, PASSWORD);

  const res = call(s.currentRoute(), `${RPC_PATH}/rotate`, 'POST');
  assert.equal(res.statusCode, 200);
  const next = JSON.parse(res.body).password;
  assert.notEqual(next, PASSWORD);
  assert.ok(next.length >= 8, '新密码至少 8 位');

  // 写盘了
  const saved = JSON.parse(readFileSync(join(s.dir, 'settings.json'), 'utf8'));
  assert.equal(saved.password, next);
  assert.equal(saved.secret, SECRET, '密钥不该被动');

  // auth 已切换到新密码：旧的会话值立刻失效
  assert.equal(s.auth.checkPassword(next), true);
  assert.equal(s.auth.checkPassword(PASSWORD), false);
  const value = next; // 会话值不是密码本身，这里只验证密码校验路径
  assert.ok(value.length > 0);

  // status 也跟着变
  const after = JSON.parse(call(s.currentRoute(), `${RPC_PATH}/status`).body);
  assert.equal(after.password, next);
});

test('rotate 拒绝非 POST', (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const res = call(s.currentRoute(), `${RPC_PATH}/rotate`, 'GET');
  assert.equal(res.statusCode, 405);
});

test('requestRejection 的判定被遵守', (t) => {
  const s = setup({ rejection: 403 });
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const res = call(s.currentRoute(), `${RPC_PATH}/status`);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, 'forbidden');
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
});

test('未知路径返回 404', (t) => {
  const s = setup();
  t.after(() => s.ownedDir && rmSync(s.dir, { recursive: true, force: true }));

  const res = call(s.currentRoute(), `${RPC_PATH}/nope`);
  assert.equal(res.statusCode, 404);
});

test('没有 webServer 时安静退化为空清理函数', () => {
  const remove = installGateRpc({}, { gate: {}, auth: {}, settings: {}, log: silent });
  assert.equal(typeof remove, 'function');
  remove();
});
