/**
 * 登录页。
 *
 * 这是一个**独立页面**：网关自己吐出来的一张表单，
 * 不是往 DSH 的界面里注入任何东西——DSH 的页面从头到尾保持原样。
 */

/**
 * HTML 转义（登录页里唯一的外部输入是回跳路径，必须转）。
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#f3f4f6;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;
  color:#111827;padding:24px;padding:max(24px,env(safe-area-inset-top)) 24px max(24px,env(safe-area-inset-bottom))}
.card{width:100%;max-width:380px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;
  padding:28px 24px;box-shadow:0 1px 3px rgba(0,0,0,.06),0 8px 24px rgba(0,0,0,.04)}
h1{margin:0 0 6px;font-size:19px;font-weight:600;letter-spacing:.01em}
p.hint{margin:0 0 20px;font-size:13px;color:#6b7280;line-height:1.5}
label{display:block;font-size:13px;font-weight:500;margin-bottom:8px;color:#374151}
input{width:100%;padding:12px 14px;font-size:16px;font-family:inherit;border:1px solid #d1d5db;
  border-radius:9px;background:#fff;color:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:#4d6bfe;box-shadow:0 0 0 3px rgba(77,107,254,.14)}
button{width:100%;margin-top:18px;padding:12px 16px;font-size:15px;font-weight:600;font-family:inherit;
  color:#fff;background:#4d6bfe;border:0;border-radius:9px;cursor:pointer;transition:background .15s}
button:hover{background:#3f5ae8}
button:active{background:#3a52d4}
.err{margin:0 0 18px;padding:10px 12px;font-size:13px;color:#b91c1c;background:#fef2f2;
  border:1px solid #fecaca;border-radius:9px}
.foot{margin-top:18px;font-size:12px;color:#9ca3af;text-align:center;line-height:1.5}
@media (prefers-color-scheme:dark){
  body{background:#0b0c0f;color:#e8eaed}
  .card{background:#16181d;border-color:#2a2d35;box-shadow:none}
  p.hint{color:#9aa0a6}
  label{color:#c4c8cf}
  input{background:#0f1115;border-color:#333842}
  .err{color:#fca5a5;background:#2a1416;border-color:#5b1f22}
  .foot{color:#6b7280}
}
`;

/**
 * 渲染登录页。
 *
 * @param {{error?: string, next?: string, lockedFor?: number}} [opts]
 * @returns {string} HTML
 */
export function renderLoginPage(opts = {}) {
  const { error, next = '/', lockedFor = 0 } = opts;

  const errorBlock = lockedFor > 0
    ? `<div class="err">尝试次数过多，请在 ${escapeHtml(lockedFor)} 秒后重试。</div>`
    : (error ? `<div class="err">${escapeHtml(error)}</div>` : '');

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>DSH 网关 · 访问验证</title>
<style>${STYLE}</style>
</head>
<body>
<form class="card" method="POST" action="/_gate/login">
  <h1>DSH 网关</h1>
  <p class="hint">输入访问密码以打开这台电脑上的 DeepSeek Harness。</p>
  ${errorBlock}
  <label for="pw">访问密码</label>
  <input id="pw" name="password" type="password" required autofocus
         autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false">
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <button type="submit">进入</button>
  <p class="foot">密码存在这台电脑的 DSH 配置目录里，只有本机可读。</p>
</form>
</body>
</html>
`;
}
