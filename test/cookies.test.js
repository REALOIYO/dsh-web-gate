import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCookies,
  pickCookiesByPrefix,
  serializeCookie,
  timingSafeEqual,
} from '../lib/cookies.js';

test('parseCookies: 基本解析与空白容忍', () => {
  const c = parseCookies('  a=1 ;b=2;   c = 3  ');
  assert.equal(c.a, '1');
  assert.equal(c.b, '2');
  assert.equal(c.c, '3');
});

test('parseCookies: 空值与异常输入', () => {
  assert.deepEqual(Object.keys(parseCookies('')), []);
  assert.deepEqual(Object.keys(parseCookies(undefined)), []);
  assert.deepEqual(Object.keys(parseCookies(null)), []);
  assert.deepEqual(Object.keys(parseCookies('novalue')), []);
});

test('parseCookies: 值里含等号', () => {
  const c = parseCookies('a=b=c; d=e');
  assert.equal(c.a, 'b=c');
  assert.equal(c.d, 'e');
});

test('parseCookies: 同名取第一个', () => {
  assert.equal(parseCookies('a=1; a=2').a, '1');
});

test('parseCookies: 去掉双引号', () => {
  assert.equal(parseCookies('a="quoted"').a, 'quoted');
});

test('serializeCookie: 默认属性保守', () => {
  const s = serializeCookie('n', 'v');
  assert.match(s, /^n=v; Path=\/; HttpOnly; SameSite=Lax$/);
});

test('serializeCookie: maxAge 与 secure', () => {
  const s = serializeCookie('n', 'v', { maxAge: 60, secure: true, sameSite: 'Strict' });
  assert.match(s, /Max-Age=60/);
  assert.match(s, /SameSite=Strict/);
  assert.match(s, /Secure/);
});

test('serializeCookie: maxAge 为 0 表示立即过期', () => {
  assert.match(serializeCookie('n', '', { maxAge: 0 }), /Max-Age=0/);
});

test('timingSafeEqual: 相等/不等/类型', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual(undefined, 'abc'), false);
  assert.equal(timingSafeEqual('abc', undefined), false);
  assert.equal(timingSafeEqual('', ''), true);
});

test('pickCookiesByPrefix: 只挑指定前缀，忽略属性', () => {
  const picked = pickCookiesByPrefix(
    [
      'dsh-auth-abc=sess; Path=/; HttpOnly; SameSite=Strict',
      'other=1; Path=/',
      'dsh-auth-def=other-value; Path=/',
    ],
    'dsh-auth-',
  );
  assert.equal(picked.length, 2);
  assert.equal(picked[0].name, 'dsh-auth-abc');
  assert.equal(picked[0].value, 'sess');
  assert.equal(picked[1].name, 'dsh-auth-def');
  assert.equal(picked[1].value, 'other-value');
});

test('pickCookiesByPrefix: 非数组输入安全', () => {
  assert.deepEqual(pickCookiesByPrefix(undefined, 'x'), []);
  assert.deepEqual(pickCookiesByPrefix('nope', 'x'), []);
});
