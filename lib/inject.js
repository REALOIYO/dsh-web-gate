/**
 * HTML 注入：补上「非安全上下文 + 非回环 hostname」缺掉的东西。
 *
 * 为什么非做不可
 * --------------
 * 手机是通过 `http://<局域网IP>:<端口>` 进来的，两个前提都不成立：
 *
 *   1. **不是安全上下文**。`crypto.randomUUID` 在这种页面里是 undefined，而 DSH
 *      连接层拿它 mint connectionId / sessionId / messageId，缺失直接抛错。
 *      同一类的还有 `AbortSignal.any`——部分安卓厂商浏览器和旧 Chrome 没有原生实现，
 *      而 DSH 发送消息时会调它，缺了就发不出去。
 *
 *   2. **hostname 不是回环**。DSH 客户端把「设置能不能写」绑在这个判定上：
 *      `ctx.remote.$host.isLoopback ? 'host' : 'memory'`。手机进来的 hostname 永远
 *      不是回环，于是设置镜像退化成 memory 模式——写入只进内存、不回后端，表现就是
 *      「暂时无法保存确认状态」这类报错，点多少次都一样。判定来自连接层的
 *      `transport?.ownsHost === true || pageLocation === undefined || isLoopbackHostname(...)`，
 *      而浏览器侧拿不到 transport，所以这里补一个 `ownsHost: true`。
 *      更早的同类症状还有「设置 → 模型」显示 settings unavailable。
 *
 * 两段脚本都**只在缺失时生效**，不覆盖原生实现。注入用 `INJECT_MARK` 判重，
 * 不去搜 `crypto.randomUUID` 字样——页面源码里可能恰好出现该字符串，会误判成已注入。
 *
 * 思路参考 dsh-pocket（GPL-2.0）处理同类问题的方向，实现为独立编写。
 */

/** 注入标记。判重只认它。 */
export const INJECT_MARK = 'data-dsh-gate-polyfill="1"';

// ---------------------------------------------------------------------------
// 1. 非安全上下文缺失的 Web API
// ---------------------------------------------------------------------------
// 刻意用 ES5 写：注入的脚本要在手机浏览器里最早执行，不赌对新语法支持。
const SECURE_API_POLYFILL = '<script ' + INJECT_MARK + '>'
  + '(function(){try{'
  // ---- crypto.randomUUID（RFC 4122 v4）
  + 'var c=self.crypto;'
  + 'if(c&&!c.randomUUID&&c.getRandomValues){'
  + 'c.randomUUID=function(){'
  + 'var b=c.getRandomValues(new Uint8Array(16));'
  + 'b[6]=(b[6]&15)|64;'
  + 'b[8]=(b[8]&63)|128;'
  + 'var s="";'
  + 'for(var i=0;i<16;i++){'
  + 'if(i===4||i===6||i===8||i===10)s+="-";'
  + 's+=(b[i]+256).toString(16).slice(1);'
  + '}'
  + 'return s;'
  + '};'
  + '}'
  // ---- AbortSignal.any
  + 'var A=self.AbortSignal;'
  + 'if(A&&!A.any){'
  + 'A.any=function(signals){'
  + 'var ctl=new AbortController();'
  + 'var list=Array.prototype.slice.call(signals||[]);'
  + 'function fire(e){'
  + 'var r=e&&e.target?e.target.reason:undefined;'
  + 'try{ctl.abort(r);}catch(err){ctl.abort();}'
  + '}'
  + 'for(var i=0;i<list.length;i++){'
  + 'if(list[i].aborted){fire({target:list[i]});break;}'
  + 'list[i].addEventListener("abort",fire,{once:true});'
  + '}'
  + 'return ctl.signal;'
  + '};'
  + '}'
  + '}catch(e){}})();'
  + '</script>';

// ---------------------------------------------------------------------------
// 2. 让设置镜像退回 host 模式（ownsHost）
// ---------------------------------------------------------------------------
// 宿主会把 __DSH_TRANSPORT__ 挂到 window 上。这里劫持它的存取器，
// 无论宿主什么时候给、给的是什么，出去的对象都带着：
//   - createApiClient：缺失时补一个返回 null 的实现，正好触发宿主那条
//     `?? new WebApiClient()` 兜底分支；宿主自己有就绝不覆盖。
//   - ownsHost: true：设置镜像据此决定用 host 还是 memory 模式。
//     ownsHost 在客户端只有 isLoopback 一个消费者，rpc / fetch / streamBaseUrl
//     都走 ?. 与 ?? 兜底，取值与「没有 transport」完全一致。
const TRANSPORT_SHIM = '<script data-dsh-gate-transport="1">'
  + '(function(){try{'
  + 'var K="__DSH_TRANSPORT__";'
  + 'function fix(t){'
  + 'if(!t||typeof t!=="object")return t;'
  + 'try{'
  + 'if(typeof t.createApiClient!=="function"){'
  + 'Object.defineProperty(t,"createApiClient",{'
  + 'value:function(){return null;},writable:true,configurable:true'
  + '});'
  + '}'
  + '}catch(e){}'
  + 'try{'
  + 'if(t.ownsHost!==true){'
  + 'Object.defineProperty(t,"ownsHost",{'
  + 'value:true,writable:true,configurable:true,enumerable:true'
  + '});'
  + '}'
  + '}catch(e){}'
  + 'return t;'
  + '}'
  + 'var cur=fix(self[K]===undefined?{ownsHost:true}:self[K]);'
  + 'Object.defineProperty(self,K,{'
  + 'configurable:true,enumerable:true,'
  + 'get:function(){return cur;},'
  + 'set:function(t){cur=fix(t);}'
  + '});'
  + '}catch(e){}})();'
  + '</script>';

/** 注入到经网关的 HTML 文档里的全部内容。 */
export const GATE_INJECT = SECURE_API_POLYFILL + TRANSPORT_SHIM;

// ---------------------------------------------------------------------------
// 判定与注入
// ---------------------------------------------------------------------------

/**
 * 这个请求要的是 HTML 文档吗？
 * 只对文档请求去掉压缩——JS/CSS/字体照常压缩，别再浪费带宽。
 *
 * @param {import('node:http').IncomingMessage} req
 */
export function isHtmlRequest(req) {
  const dest = String(req.headers['sec-fetch-dest'] ?? '');
  if (dest === 'document') return true;
  const accept = String(req.headers.accept ?? '');
  return accept.includes('text/html');
}

/**
 * 上游响应是否被压缩过。压缩流不能做文本注入，硬改会损坏页面。
 *
 * @param {import('node:http').IncomingHttpHeaders} headers
 */
export function isCompressed(headers) {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers['content-encoding'] ?? ''));
}

/**
 * 在 `<head>` 之后插入注入脚本。已经注入过就原样返回。
 *
 * @param {string} html
 * @returns {string}
 */
export function injectInto(html) {
  if (html.includes(INJECT_MARK)) return html;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (tag) => tag + GATE_INJECT);
  }
  // 极少数没有 <head> 的文档，退而求其次塞到最前面
  return GATE_INJECT + html;
}
