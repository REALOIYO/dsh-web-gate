/**
 * dsh-web-gate 设置页客户端。
 *
 * 手写的单文件模块，**不经过打包**：面板只有一张卡片，React.createElement
 * 足够表达，省掉 esbuild 与 node_modules，改完即生效。
 *
 * 加载格式遵循 DSH 客户端模块约定（`window.__ModuleLoader__.load`），
 * react 由宿主提供，必须 `require('react')` 取，不能当全局用。
 *
 * 这里只做一件事：在设置侧栏注册一个「手机网关」入口。
 * 不碰主界面、不注入样式、不加 URL 标记 —— DSH 页面保持原样。
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-gate',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    /** 控制通道前缀，与 lib/rpc.js 的 RPC_PATH 一致。 */
    const API = '/_dsh-web-gate';

    const styles = {
      card: {
        background: 'var(--dsw-alias-bg-layer-1,#fff)',
        border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
        borderRadius: 12,
        padding: '16px 20px',
        maxWidth: 480,
      },
      head: { fontSize: 14, fontWeight: 600, margin: '0 0 4px' },
      muted: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.6 },
      err: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', fontSize: 12, lineHeight: 1.6 },
      block: {
        borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
        marginTop: 16,
        paddingTop: 14,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' },
      mono: {
        fontFamily: 'ui-monospace,Menlo,monospace',
        fontSize: 12,
        wordBreak: 'break-all',
        background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)',
        padding: '6px 8px',
        borderRadius: 6,
        flex: 1,
        color: 'var(--dsw-alias-label-primary,inherit)',
      },
      btn: {
        font: 'inherit',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2,#d1d5db)',
        background: 'var(--dsw-alias-bg-layer-1,#fff)',
        color: 'var(--dsw-alias-label-primary,inherit)',
        height: 30,
        padding: '0 12px',
        borderRadius: 999,
        fontSize: 12,
        whiteSpace: 'nowrap',
      },
    };

    /** 独立小按钮：点一下把 text 写进剪贴板。 */
    function CopyButton({ text }) {
      const [done, setDone] = useState(false);
      const onClick = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(String(text ?? ''));
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // 剪贴板不可用（非安全上下文等）就什么都不做
        }
      }, [text]);
      return h('button', { type: 'button', style: styles.btn, onClick }, done ? '已复制' : '复制');
    }

    function GateSection() {
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [rotating, setRotating] = useState(false);
      const [showPassword, setShowPassword] = useState(false);

      const load = useCallback(async () => {
        try {
          const res = await fetch(`${API}/status`, { headers: { accept: 'application/json' } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setState(await res.json());
          setError('');
        } catch (e) {
          setError(`读不到网关状态：${(e && e.message) || e}`);
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const rotate = useCallback(async () => {
        if (!window.confirm('换密码后，所有已登录的手机都要重新输入。继续？')) return;
        setRotating(true);
        try {
          const res = await fetch(`${API}/rotate`, { method: 'POST' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          setState((prev) => (prev ? { ...prev, password: data.password } : prev));
          setShowPassword(true);
          setError('');
        } catch (e) {
          setError(`换密码失败：${(e && e.message) || e}`);
        } finally {
          setRotating(false);
        }
      }, []);

      if (error && !state) return h('div', { style: styles.card }, h('div', { style: styles.err }, error));
      if (!state) return h('div', { style: styles.card }, h('div', { style: styles.muted }, '读取中…'));

      const password = String(state.password || '');
      const urls = (state.addresses || []).map((ip) => `http://${ip}:${state.port}`);

      return h(
        'div',
        { style: styles.card },
        h('div', { style: styles.head }, '手机网关'),
        h(
          'div',
          { style: styles.muted },
          '手机连同一个 WiFi，用浏览器打开下面的地址即可，密码在下面。DSH 的页面不会被改动。',
        ),

        h(
          'div',
          { style: styles.block },
          h('div', { style: styles.muted }, state.running ? `运行中 · ${state.host}:${state.port}` : '未启动'),
          urls.length === 0
            ? h('div', { style: styles.muted }, '没检测到局域网地址，确认电脑已连上 WiFi 或网线。')
            : urls.map((u) => h('div', { key: u, style: styles.row }, h('code', { style: styles.mono }, u), h(CopyButton, { text: u }))),
        ),

        h(
          'div',
          { style: styles.block },
          h('div', { style: styles.muted }, '访问密码'),
          h(
            'div',
            { style: styles.row },
            h('code', { style: styles.mono }, showPassword ? password : '•'.repeat(password.length || 8)),
            h(
              'button',
              { type: 'button', style: styles.btn, onClick: () => setShowPassword((v) => !v) },
              showPassword ? '隐藏' : '显示',
            ),
            h(CopyButton, { text: password }),
            h(
              'button',
              { type: 'button', style: styles.btn, onClick: rotate, disabled: rotating },
              rotating ? '换中…' : '换一个',
            ),
          ),
          h(
            'div',
            { style: styles.muted },
            '密码存放在电脑的 DSH 配置目录（dsh-web-gate/settings.json），只有本机可读。换密码会让所有已登录设备失效。',
          ),
        ),

        error ? h('div', { style: { ...styles.err, marginTop: 12 } }, error) : null,
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'web-gate',
            order: 3,
            label: () => '手机网关',
          },
          GateSection,
        ),
      );
    }

    exports.name = 'dsh-web-gate';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
