import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE_COOKIE,
  createAuth,
  createRateLimiter,
  sessionValue,
} from '../lib/auth.js';

const PASSWORD = 'correct-horse-battery';
const SECRET = 'a'.repeat(32);

function makeAuth(overrides = {}) {
  return createAuth({ password: PASSWORD, secret: SECRET, ...overrides });
}

test('sessionValue: 确定且随密码变化', () => {
  const a = sessionValue(SECRET, PASSWORD);
  assert.equal(a, sessionValue(SECRET, PASSWORD));
  assert.notEqual(a, sessionValue(SECRET, 'other'));
  assert.notEqual(a, sessionValue('b'.repeat(32), PASSWORD));
});

test('createAuth: 拒绝空密码与短密钥', () => {
  assert.throws(() => createAuth({ password: '', secret: SECRET }), /password/);
  assert.throws(() => createAuth({ password: PASSWORD, secret: 'short' }), /secret/);
});

test('isAuthenticated: 只认自己签发的值', () => {
  const auth = makeAuth();
  const good = auth.sessionCookieHeader();
  const value = good.split(';')[0].split('=').slice(1).join('=');

  assert.equal(auth.isAuthenticated(`${GATE_COOKIE}=${value}`), true);
  assert.equal(auth.isAuthenticated(`${GATE_COOKIE}=wrong`), false);
  assert.equal(auth.isAuthenticated(''), false);
  assert.equal(auth.isAuthenticated(undefined), false);
  assert.equal(auth.isAuthenticated('other=1'), false);
});

test('checkPassword: 正确与错误', () => {
  const auth = makeAuth();
  assert.equal(auth.checkPassword(PASSWORD), true);
  assert.equal(auth.checkPassword('nope'), false);
  assert.equal(auth.checkPassword(undefined), false);
  assert.equal(auth.checkPassword(null), false);
});

test('sessionCookieHeader: HttpOnly + SameSite + 30 天', () => {
  const header = makeAuth().sessionCookieHeader();
  assert.match(header, new RegExp(`^${GATE_COOKIE}=`));
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Max-Age=2592000/);
});

test('clearCookieHeader: 立即过期', () => {
  const header = makeAuth().clearCookieHeader();
  assert.match(header, /Max-Age=0/);
});

test('createRateLimiter: 达阈值后锁定，成功后清空', () => {
  const limiter = createRateLimiter({ maxFailures: 3, lockMs: 60_000 });
  const ip = '10.0.0.1';

  assert.equal(limiter.status(ip).locked, false);
  limiter.record(ip);
  limiter.record(ip);
  assert.equal(limiter.status(ip).locked, false);

  limiter.record(ip);
  const locked = limiter.status(ip);
  assert.equal(locked.locked, true);
  assert.ok(locked.retryAfter > 0);

  limiter.clear(ip);
  assert.equal(limiter.status(ip).locked, false);
});

test('createRateLimiter: 全局阈值影响所有 IP', () => {
  const limiter = createRateLimiter({ maxFailures: 999, globalMaxFailures: 2, globalLockMs: 60_000 });
  limiter.record('1.1.1.1');
  limiter.record('2.2.2.2');
  assert.equal(limiter.status('3.3.3.3').locked, true);
});

test('createRateLimiter: 不同 IP 互不牵连', () => {
  const limiter = createRateLimiter({ maxFailures: 1, lockMs: 60_000 });
  limiter.record('1.1.1.1');
  assert.equal(limiter.status('1.1.1.1').locked, true);
  assert.equal(limiter.status('2.2.2.2').locked, false);
});
