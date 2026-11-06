/**
 * 页面注入的测试。
 *
 * 重点不是「字符串里有 randomUUID 这几个字」，而是**把注入的脚本抠出来真的执行一遍**，
 * 确认手机那种环境下（没有原生 randomUUID / AbortSignal.any）它能补出可用的实现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GATE_INJECT, INJECT_MARK, injectInto, isCompressed, isHtmlRequest } from '../lib/inject.js';

/** 把注入内容里的 <script> 正文逐段抠出来。 */
function scriptSources() {
  return [...GATE_INJECT.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

test('注入内容包含两段脚本与判重标记', () => {
  assert.ok(GATE_INJECT.includes(INJECT_MARK), '应带判重标记');
  assert.equal(scriptSources().length, 2, '应为两段：secure-context polyfill + transport shim');
  assert.ok(GATE_INJECT.includes('randomUUID'));
  assert.ok(GATE_INJECT.includes('AbortSignal'));
  assert.ok(GATE_INJECT.includes('__DSH_TRANSPORT__'));
  assert.ok(GATE_INJECT.includes('ownsHost'));
  assert.ok(GATE_INJECT.includes('createApiClient'));
});

test('两段脚本都是合法 JS', () => {
  for (const src of scriptSources()) {
    assert.doesNotThrow(() => new Function(src), `脚本应能解析：${src.slice(0, 100)}`);
  }
});

test('randomUUID polyfill：缺原生实现时补出合法 v4 UUID', () => {
  const fakeCrypto = {
    getRandomValues(buf) {
      for (let i = 0; i < buf.length; i += 1) buf[i] = (i * 37 + 11) & 0xff;
      return buf;
    },
  };
  const sandbox = { crypto: fakeCrypto };
  new Function('self', scriptSources()[0])(sandbox);

  assert.equal(typeof fakeCrypto.randomUUID, 'function');
  const id = fakeCrypto.randomUUID();
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    `应形如 v4 UUID，实际 ${id}`,
  );
  assert.equal(id.length, 36);
});

test('randomUUID polyfill：原生已存在时绝不覆盖', () => {
  const native = () => 'native-implementation';
  const fakeCrypto = { randomUUID: native, getRandomValues: (b) => b };
  new Function('self', scriptSources()[0])({ crypto: fakeCrypto });
  assert.equal(fakeCrypto.randomUUID, native, '不该动原生实现');
});

test('AbortSignal.any polyfill：任一信号中止即整体中止，并带上 reason', () => {
  class FakeSignal {
    constructor() {
      this.aborted = false;
      this.reason = undefined;
      this.handlers = [];
    }

    addEventListener(event, fn) {
      if (event === 'abort') this.handlers.push(fn);
    }

    removeEventListener(event, fn) {
      this.handlers = this.handlers.filter((h) => h !== fn);
    }

    fire(reason) {
      this.aborted = true;
      this.reason = reason;
      for (const fn of [...this.handlers]) fn({ target: this });
    }
  }

  class FakeController {
    constructor() {
      this.signal = { aborted: false, reason: undefined };
    }

    abort(reason) {
      this.signal.aborted = true;
      this.signal.reason = reason;
    }
  }

  const sandbox = { crypto: { getRandomValues: (b) => b }, AbortSignal: FakeSignal };
  new Function('self', 'AbortController', scriptSources()[0])(sandbox, FakeController);

  const a = new FakeSignal();
  const b = new FakeSignal();
  const combined = FakeSignal.any([a, b]);
  assert.equal(combined.aborted, false, '初始不该是中止态');

  a.fire('first');
  assert.equal(combined.aborted, true);
  assert.equal(combined.reason, 'first');
});

test('AbortSignal.any polyfill：传入已中止的信号时立即中止', () => {
  class FakeSignal {
    constructor(aborted = false, reason) {
      this.aborted = aborted;
      this.reason = reason;
      this.handlers = [];
    }

    addEventListener(event, fn) {
      if (event === 'abort') this.handlers.push(fn);
    }

    removeEventListener() {}
  }
  class FakeController {
    constructor() {
      this.signal = { aborted: false, reason: undefined };
    }

    abort(reason) {
      this.signal.aborted = true;
      this.signal.reason = reason;
    }
  }

  const sandbox = { crypto: { getRandomValues: (b) => b }, AbortSignal: FakeSignal };
  new Function('self', 'AbortController', scriptSources()[0])(sandbox, FakeController);

  const combined = FakeSignal.any([new FakeSignal(true, 'already')]);
  assert.equal(combined.aborted, true);
  assert.equal(combined.reason, 'already');
});

test('transport shim：宿主已经给过 transport 时补上 ownsHost 与 createApiClient', () => {
  const existing = { something: 'kept' };
  const sandbox = { __DSH_TRANSPORT__: existing };
  new Function('self', scriptSources()[1])(sandbox);

  const got = sandbox.__DSH_TRANSPORT__;
  assert.equal(got.something, 'kept', '原有字段不该被动');
  assert.equal(got.ownsHost, true, '必须补 ownsHost，设置镜像据此选 host 模式');
  assert.equal(typeof got.createApiClient, 'function');
  assert.equal(got.createApiClient(), null, '返回 null 以触发宿主的 WebApiClient 兜底');
});

test('transport shim：宿主晚于脚本赋值时，赋值结果同样被修正', () => {
  const sandbox = {};
  new Function('self', scriptSources()[1])(sandbox);

  // 页面还没有 transport 时，读到的应该是一个带 ownsHost 的最小对象
  assert.equal(sandbox.__DSH_TRANSPORT__.ownsHost, true);

  // 宿主随后赋值 —— 走 setter，同样要被补
  sandbox.__DSH_TRANSPORT__ = { fromHost: true };
  const got = sandbox.__DSH_TRANSPORT__;
  assert.equal(got.fromHost, true);
  assert.equal(got.ownsHost, true);
  assert.equal(typeof got.createApiClient, 'function');
});

test('isHtmlRequest：按 sec-fetch-dest 与 accept 判定', () => {
  assert.equal(isHtmlRequest({ headers: { 'sec-fetch-dest': 'document' } }), true);
  assert.equal(isHtmlRequest({ headers: { accept: 'text/html,application/xhtml+xml' } }), true);
  assert.equal(isHtmlRequest({ headers: { accept: 'application/json', 'sec-fetch-dest': 'empty' } }), false);
  assert.equal(isHtmlRequest({ headers: {} }), false);
});

test('isCompressed：认得 gzip / br / deflate，identity 不算', () => {
  assert.equal(isCompressed({ 'content-encoding': 'gzip' }), true);
  assert.equal(isCompressed({ 'content-encoding': 'br' }), true);
  assert.equal(isCompressed({ 'content-encoding': 'deflate, gzip' }), true);
  assert.equal(isCompressed({ 'content-encoding': 'identity' }), false);
  assert.equal(isCompressed({}), false);
});

test('injectInto：插在 <head> 之后、<body> 之前', () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>hi</body></html>';
  const out = injectInto(html);
  assert.ok(out.includes(INJECT_MARK));
  assert.ok(out.indexOf(INJECT_MARK) > out.indexOf('<head>'), '应在 head 之后');
  assert.ok(out.indexOf(INJECT_MARK) < out.indexOf('<body>'), '应在 body 之前');
  assert.ok(out.endsWith('</html>'), '不该破坏原文档结构');
});

test('injectInto：已注入过就原样返回，不重复注入', () => {
  const once = injectInto('<html><head></head><body></body></html>');
  const twice = injectInto(once);
  assert.equal(twice, once);
  assert.equal(twice.split(INJECT_MARK).length - 1, 1, '标记只应出现一次');
});

test('injectInto：没有 head 的文档也能注入', () => {
  const out = injectInto('<body>bare</body>');
  assert.ok(out.includes(INJECT_MARK));
});
