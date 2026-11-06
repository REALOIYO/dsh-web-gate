# dsh-web-gate

[![dsh plugin](https://img.shields.io/badge/dsh-plugin-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![license](https://img.shields.io/badge/license-MIT-3DA639?style=flat-square)](LICENSE)

为 DeepSeek Harness 提供带密码认证的局域网网关。同一网段内的设备可通过浏览器访问运行在桌面端的 DSH 实例。

不修改 DSH 界面。仅注入一段 polyfill——非安全上下文下写入路径不可用，见下文。

## 背景

`dsh --profile web` 只监听 loopback。官方反代方案（`--public-url` + `--trusted-host`）不适用于桌面版：

- Host 由 Electron 拉起，无法追加命令行参数；
- 端口每次启动动态分配，无法预先写入反代配置；
- 根路径需携带仅存在于进程内存中的 `?token=` 才能换取会话 Cookie。

网关因此实现在 Host 进程内，可直接读取 `ctx.webServer.port` 与 `ctx.connection.authenticatedUrl()`。

## 安装

尚未发布至 npm，从仓库安装：

```sh
dsh plugin --profile desktop add github:REALOIYO/dsh-web-gate
```

安装后重启 DSH。监听地址与密码写入日志，同时显示在 **设置 → 手机网关**（支持复制与改密）。客户端与主机处于同一网段时，浏览器访问 `http://<主机局域网IP>:3082` 并输入密码。

## 配置

配置文件为 `$DSH_HOME/dsh-web-gate/settings.json`，修改后重启生效。

| 键 | 默认值 | 说明 |
|---|---|---|
| `port` | `3082` | 监听端口 |
| `host` | `"0.0.0.0"` | 监听地址 |
| `password` | 随机 10 位 | 访问密码，最少 8 位，可在设置页自定义 |
| `secret` | 随机 32 字节 | 会话签名密钥，修改将使全部会话失效 |

优先级：profile patch 中的 `config` > `settings.json` > 随机生成。

会话 Cookie 由 `HMAC(secret, password)` 派生，因此改密等同于注销全部已登录设备。

## 实现

**token 握手。** 网关先在内部以 launch token 请求 `/` 并取得会话 Cookie，再转发外部请求，客户端不会观察到 303。

**上游 Cookie 拦截。** DSH 的认证 Cookie 名为 `dsh-auth-<sha256(host:port)>`，含端口成分；桌面版每次启动端口变化且不清理旧 Cookie，条目持续累积。累积至 71 个时 Cookie 头约 16.4 KB，触及 Node 的 16 KB 请求头上限，返回 **HTTP 431**，表现为 DSH 报「Web authentication failed」而无法启动。网关拦截全部上游 `Set-Cookie`，仅在内存中保留当前一个；客户端侧只存在 `dsh_gate_session`。

**polyfill 注入。** 客户端经 `http://<局域网IP>` 访问时，两个前提不成立：

- 非安全上下文：`crypto.randomUUID` 为 `undefined`，而 DSH 连接层用它生成 connectionId / sessionId / messageId；`AbortSignal.any` 在部分浏览器亦缺失。缺失时表现为可读不可写。
- hostname 非回环：DSH 将设置持久化方式绑定于该判定（`isLoopback ? 'host' : 'memory'`），镜像退化为内存模式，写入不落后端，界面持续提示无法保存。

注入仅在 API 缺失时执行，不覆盖原生实现，以 `data-dsh-gate-polyfill` 属性判重。文本注入要求响应体未压缩，故文档请求移除 `accept-encoding`；JS / CSS / 字体保持压缩。

## 安全

- 密码为唯一凭证。网关可在主机上执行代码，凭据不应外传。
- 登录限速：单 IP 每分钟 5 次失败锁定 60 秒，全局每分钟 50 次失败锁定 30 秒。会话 Cookie 为 `HttpOnly` + `SameSite=Lax`，校验使用常量时间比较。
- 流量为明文 HTTP，同网段可嗅探密码，仅应在可信局域网内使用。跨网络部署需叠加 WireGuard / Tailscale 等隧道，不应直接暴露公网。
- 密码以明文存于 `settings.json`（0600）用于派生会话密钥，同机其他管理员账户可读。

## 限制

- 不提供公网隧道与移动端适配。
- 不生成二维码（安装 `qrcode-terminal` 时输出）。
- WebSocket 认证仅在握手阶段校验一次，与浏览器直连行为一致。
- `Host` / `Origin` / `Referer` / `Sec-Fetch-Site` 统一改写为 loopback。若部署依赖真实 Host，需相应调整。

## 开发

```sh
node --test test/*.test.js
```

共 60 项测试。`test/proxy.test.js` 启动真实 HTTP 服务并以假上游模拟 DSH 的 401 / 303+Cookie / 200 响应，覆盖握手、头改写、Cookie 卫生与限速；`test/inject.test.js` 实际执行注入脚本，验证 polyfill 生成的 UUID 符合 RFC 4122、原生实现存在时不覆盖、transport shim 在宿主先赋值与后赋值两种时序下均生效。

## License

MIT

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
