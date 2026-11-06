/**
 * 网关集成测试。
 *
 * 用一个假上游模拟 DSH Host 的认证行为：
 *   - 无会话、无 token        → 401
 *   - `GET /?token=<launch>`  → 303 + Set-Cookie: dsh-auth-*（换会话）
 *   - 带 dsh-auth-* Cookie    → 200
 *
 * 重点验证两条设计约束：
 *   A. 上游下发的 Set-Cookie 一律扣在服务端，不进客户端响应；
 *   B. 客户端带来的 Cookie 一律丢弃，上游只收到网关持有的那一个。
 *      （A + B 共同保证手机侧永远不会累积 dsh-auth-* —— 那正是 HTTP 431 的成因）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createAuth, GATE_COOKIE } from '../lib/auth.js';
import { UPSTREAM_COOKIE_PREFIX, createGateProxy } from '../lib/proxy.js';

const PASSWORD = 'gate-password-123';
const SECRET = 'f'.repeat(48);
const LAUNCH_TOKEN = 'launch-token-abc';
const UPSTREAM_COOKIE_NAME = `${UPSTREAM_COOKIE_PREFIX}${'k'.repeat(43)}`;
const UPSTREAM_COOKIE_VALUE = 'upstream-session-value';

const silent = { info() {}, warn() {}, error() {} };

/** 起一个假 DSH Host。 */
function startFakeDsh() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake.invalid');
    const cookie = req.headers.cookie ?? '';
    seen.push({
      path: url.pathname + url.search,
      host: req.headers.host,
      origin: req.headers.origin,
      referer: req.headers.referer,
      cookie,
    });

    if (url.searchParams.get('token') === LAUNCH_TOKEN) {
      res.writeHead(303, {
        location: '/',
        'set-cookie': `${UPSTREAM_COOKIE_NAME}=${UPSTREAM_COOKIE_VALUE}; Path=/; HttpOnly; SameSite=Strict`,
      });
      res.end();
      return;
    }

    const authed = cookie.includes(`${UPSTREAM_COOKIE_NAME}=${UPSTREAM_COOKIE_VALUE}`);
    if (authed) {
      if (url.pathname === '/api/data') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      // 故意多带一个 Set-Cookie，验证网关把所有 Set-Cookie 都扣下
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'some-other-cookie=1; Path=/',
      });
      res.end('<html><body>DSH UI</body></html>');
      return;
    }

    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('dsh web authentication required');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, seen, port: server.address().port });
    });
  });
}

/** 发一个请求并收全响应。 */
function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** 建一整套：假上游 + 网关。 */
async function setup({ launchToken = LAUNCH_TOKEN } = {}) {
  const fake = await startFakeDsh();
  const auth = createAuth({ password: PASSWORD, secret: SECRET });
  const gate = createGateProxy({
    port: 0,
    host: '127.0.0.1',
    upstreamPort: fake.port,
    auth,
    getLaunchToken: () => launchToken,
    logger: silent,
  });
  const address = await gate.listen();

  return {
    fake,
    gate,
    auth,
    gatePort: address.port,
    async stop() {
      await gate.close();
      await new Promise((resolve) => fake.server.close(resolve));
    },
  };
}

/** 走一遍登录，返回网关会话 Cookie（`name=value`）。 */
async function login(gatePort, password = PASSWORD) {
  const res = await request(gatePort, '/_gate/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, next: '/' }).toString(),
  });
  const raw = res.headers['set-cookie']?.[0] ?? '';
  return { res, cookie: raw.split(';')[0] };
}

test('未认证时返回登录页，且不碰上游', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.stop());

  const res = await request(ctx.gatePort, '/');
  assert.equal(res.status, 200);
  assert.match(res.body, /访问密码/);
  assert.equal(ctx.fake.seen.length, 0, '未认证请求不应转发到上游');
});

test('密码错误返回 401', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.stop());

  const { res } = await login(ctx.gatePort, 'wrong-password');
  assert.equal(res.status, 401);
  assert.match(res.body, /密码不正确/);
});

test('密码正确下发网关会话 Cookie 并跳转', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.stop());

  const { res, cookie } = await login(ctx.gatePort);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
  assert.match(cookie, new RegExp(`^${GATE_COOKIE}=`));

  const raw = res.headers['set-cookie'][0];
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
});

test('登录后能取到 DSH 页面，且响应里没有上游 Cookie', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.stop());

  const { cookie } = await login(ctx.gatePort);
  const res = await request(ctx.gatePort, '/', { headers: { cookie } });

  assert.equal(res.status, 200);
  assert.match(res.body, /DSH UI/);
  assert.equal(res.headers['set-cookie'], undefined, '上游 Set-Cookie 必须全部扣下');
});

test('网关自己完成 token 握手，客户端看不到 303', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.stop());

  const { cookie } = await login(ctx.gatePort);
  const res = await request(ctx.gatePort, '/', { headers: { cookie } });

  assert.equal(res.status, 200, '客户端应直接拿到页面，而不是被 303 弹回去');

  const handshake = ctx.fake.seen.find((r) => r.path.includes('token='));
  assert.ok(handshake, '网关应先发起一次带 token 的握手');
  assert.equal(handshake.path, `/?token=${LAUNCH_TOKEN}`);

  const forwarded = ctx.fake.seen.find((r) => r.path === '/' && r.cookie.includes(UPSTREAM_COOKIE_NAME));
  assert.ok(forwarded, '随后转发的请求应带上握手拿到的会话');
});

test('上游收到的 Host / Origin 被改写成 loopback', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.stop());

  const { cookie } = await login(ctx.gatePort);
  await request(ctx.gatePort, '/api/data', {
    headers: { cookie, origin: 'http://192.168.1.50:3082', referer: 'http://192.168.1.50:3082/' },
  });

  const hit = ctx.fake.seen.find((r) => r.path === '/api/data');
  assert.ok(hit);
  assert.equal(hit.host, `127.0.0.1:${ctx.fake.port}`, 'Host 必须是 loopback 权威，否则会被宿主栅栏拦下');
  // 客户端没发 origin 时不会补；这里发了，应被改写成 loopback
  assert.equal(hit.origin, `http://127.0.0.1:${ctx.fake.port}`);
});

test('客户端的一堆 dsh-auth-* Cookie 不会流到上游（431 防护）', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.stop());

  const { cookie } = await login(ctx.gatePort);
  // 模拟「手机上攒了一大堆历史 dsh-auth-* Cookie」
  const polluted = [
    cookie,
    'dsh-auth-old0000000000000000000000000000000000000000=aaa',
    'dsh-auth-old1111111111111111111111111111111111111111=bbb',
    'dsh-auth-old2222222222222222222222222222222222222222=ccc',
    `other=${'x'.repeat(400)}`,
  ].join('; ');

  const res = await request(ctx.gatePort, '/api/data', { headers: { cookie: polluted } });
  assert.equal(res.status, 200);

  const hit = ctx.fake.seen.find((r) => r.path === '/api/data');
  assert.ok(hit);

  const upstreamCookies = hit.cookie.split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(upstreamCookies.length, 1, '上游只应收到网关注入的那一个 Cookie');
  assert.ok(upstreamCookies[0].startsWith(UPSTREAM_COOKIE_NAME));
  assert.ok(!hit.cookie.includes('old000000000000000000'), '客户端的历史 Cookie 必须被丢弃');
  assert.ok(!hit.cookie.includes('other='), '网关不认识的 Cookie 也不应透传');
});

test('会话失效（上游 401）后会重新握手', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.stop());

  const { cookie } = await login(ctx.gatePort);
  await request(ctx.gatePort, '/', { headers: { cookie } });
  const before = ctx.fake.seen.length;

  // 模拟 DSH 重启：会话作废
  ctx.gate.resetUpstream();

  const res = await request(ctx.gatePort, '/', { headers: { cookie } });
  assert.equal(res.status, 200);
  const after = ctx.fake.seen.slice(before);
  assert.ok(after.some((r) => r.path.includes('token=')), '应重新走一次 token 握手');
});

test('API 请求正常转发', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.stop());

  const { cookie } = await login(ctx.gatePort);
  const res = await request(ctx.gatePort, '/api/data', { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.body, '{"ok":true}');
});

test('登出清除会话 Cookie', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.stop());

  const res = await request(ctx.gatePort, '/_gate/logout');
  assert.equal(res.status, 302);
  assert.match(res.headers['set-cookie'][0], /Max-Age=0/);
});

test('next 参数挡住开放重定向', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.stop());

  for (const evil of ['//evil.example.com', 'http://evil.example.com', '/\\evil']) {
    const res = await request(ctx.gatePort, '/_gate/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PASSWORD, next: evil }).toString(),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/', `next=${evil} 应被归一化为 /`);
  }
});

test('连续输错密码触发限速', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.stop());

  let last;
  for (let i = 0; i < 6; i += 1) {
    last = await login(ctx.gatePort, 'nope');
  }
  assert.equal(last.res.status, 429);
  assert.match(last.res.body, /尝试次数过多/);
});

test('没有 launch token 时仍能转发（老版本 DSH 兼容）', async (t) => {
  const ctx = await setup({ launchToken: '' });
  t.after(() => ctx.stop());

  const { cookie } = await login(ctx.gatePort);
  const res = await request(ctx.gatePort, '/', { headers: { cookie } });

  // 假上游在没有 token 的情况下会 401，网关如实转发状态码
  assert.equal(res.status, 401);
  assert.equal(ctx.fake.seen.length, 1, '没有 token 时不应多发一次握手请求');
});
