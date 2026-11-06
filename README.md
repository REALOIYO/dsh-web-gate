# dsh-web-gate

[![dsh plugin](https://img.shields.io/badge/dsh-plugin-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![license](https://img.shields.io/badge/license-MIT-3DA639?style=flat-square)](LICENSE)

给 **DeepSeek Harness** 加一层带密码的局域网网关：手机连同一个 WiFi，浏览器打开就能用电脑上的 DSH。

不改 DSH 的界面。只往 HTML 里注入一小段 polyfill——手机页面不是安全上下文，少了它**只能读不能写**（见下）。

## 为什么需要

`dsh --profile web` 只监听 loopback，局域网里的手机连不上。官方那条反代路子（`--public-url` + `--trusted-host`）**桌面版走不了**：

- Electron 拉起 Host，命令行参数你碰不到；
- 端口每次启动都换，写不进反代配置；
- 根路径必须带一次只在进程内存里的 `?token=` 才能换到会话 Cookie。

所以得**在 Host 进程里**做网关。本插件就跑在 Host 进程内，能直接拿到 `ctx.webServer.port` 与 `ctx.connection.authenticatedUrl()`。

## 安装

```sh
dsh plugin --profile desktop add dsh-web-gate
```

装完重启 DSH。地址和密码会打进日志，也出现在 **设置 → 手机网关**（带复制与换密码）。

手机连同一个 WiFi，浏览器打开 `http://<电脑局域网IP>:3082`，输密码。

## 配置

写在 `$DSH_HOME/dsh-web-gate/settings.json`，改完重启：

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `3082` | 监听端口 |
| `host` | `"0.0.0.0"` | 监听地址 |
| `password` | 随机 10 位 | 访问密码，至少 8 位；设置页里也能自定义 |
| `secret` | 随机 32 字节 | 会话签名密钥，**别改**（改了等于全体登出） |

优先级：profile patch 里的 `config` > `settings.json` > 新生成的随机值。

**换密码 = 所有已登录设备立刻失效**（会话 Cookie = `HMAC(secret, password)`）。这是特性，不是 bug。

## 它做的三件事

**1. 自己完成 token 握手。** 网关内部先请求一次带 launch token 的 `/`，换来会话 Cookie 再转发你的请求——手机端看不到那个 303。

**2. 上游 Cookie 全部扣在服务端。** DSH 的认证 Cookie 名是 `dsh-auth-<sha256(host:port)>`，**名字里带端口**；桌面版每次启动端口都变、旧 Cookie 又不清理，于是越攒越多。攒到 71 个时仅 Cookie 头就约 16.4 KB，撞穿 Node 的 16 KB 请求头上限 → **HTTP 431**，DSH 以「Web authentication failed」的面目起不来。所以上游的 `Set-Cookie` 一律拦下存内存、只注入当前那一个；手机侧永远只有一个 `dsh_gate_session`。

**3. 注入一段 polyfill（必须的）。** 手机从 `http://<局域网IP>` 进来，两个前提都不成立：

- **不是安全上下文** → `crypto.randomUUID` 是 `undefined`，而 DSH 连接层拿它 mint connectionId / sessionId / messageId；`AbortSignal.any` 在部分安卓浏览器上也缺失。缺了就是「能读不能写」。
- **hostname 不是回环** → DSH 把「设置能不能写」绑在这个判定上（`isLoopback ? 'host' : 'memory'`），设置镜像于是退化成内存模式，写入不回后端——表现就是「暂时无法保存确认状态」，点多少次都一样。

注入只在 API 缺失时生效、不覆盖原生实现，用 `data-dsh-gate-polyfill` 标记判重。为了能注入，**文档请求会去掉 `accept-encoding`**（压缩流上做文本注入会损坏页面），JS/CSS/字体照常压缩。

## 安全

- **密码是唯一那道门。** 网关能执行你电脑上的代码，别把地址和密码发到群里。
- 登录限速：单 IP 一分钟错 5 次锁 60 秒，全局一分钟错 50 次锁 30 秒。会话 Cookie 为 `HttpOnly` + `SameSite=Lax`，校验走常量时间比较。
- **默认只该在可信局域网里用**——它走明文 HTTP，同网段能嗅探的人可以抓到密码。要跨网络用，叠一层 WireGuard / Tailscale，别直接开公网。
- 密码明文存在 `settings.json`（0600），因为要拿它派生会话密钥，同机其他管理员账户可读。

## 已知限制

- 不做公网隧道，也不做移动端适配；窄屏下好不好看是 DSH 自己的事。
- 没有二维码（装了 `qrcode-terminal` 就会打印）。
- WebSocket 认证只在握手时检查一次，之后靠上游维持——与浏览器直连的行为一致。
- 一律把 `Host` / `Origin` / `Referer` / `Sec-Fetch-Site` 改写成 loopback。若你的部署依赖真实 Host（比如用了 `--trusted-host`），这套改写需要相应调整。

## 开发

```sh
node --test test/*.test.js
```

60 个测试。`test/proxy.test.js` 会起真实 HTTP，用假上游模拟 DSH 的 401 / 303+Cookie / 200，验证握手、头改写、Cookie 卫生与限速；`test/inject.test.js` 会把注入的脚本**真的执行一遍**，确认 polyfill 产出的 UUID 合法、原生存在时不覆盖、transport shim 在「宿主已赋值」与「宿主晚赋值」两种时序下都生效。

## License

MIT

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
