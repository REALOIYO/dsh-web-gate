# dsh-web-gate

给 **DeepSeek Harness** 的 Web UI 加一层带密码的局域网网关：手机连同一个 WiFi，浏览器打开就能用电脑上的 DSH。

**不注入任何页面代码**，DSH 的界面从头到尾保持原样。

---

## 为什么需要它

`dsh --profile web` 只监听 loopback，同一局域网里的手机连不上。官方文档《在反向代理之后发布 Web UI》给的路子是：

```
dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
```

但**桌面版走不了这条路**：

- DSH Desktop 用 Electron 拉起 Host，命令行参数你碰不到；
- 端口每次启动都换（实测 52185 / 59209 / 65124 …），没法写死进反代配置；
- 而 Host 自带一层认证——根路径必须带一次 `?token=` 才能换到会话 Cookie，
  这个 token 只在进程内存里，外部反代拿不到。

所以正确的做法不是在外面套一个反代，而是**在 Host 进程里**做一个网关。

## 它怎么工作

```
手机浏览器 ──HTTP──▶ dsh-web-gate（*:3082）  ──loopback──▶  DSH Host（127.0.0.1:<随机端口>）
     ▲                      │
     │                      ├─ 密码认证（独立页面，只有一张表单）
     │                      ├─ 拿 launch token，自己完成握手
     └── 只有一个 Cookie ────┴─ 上游 Cookie 全部扣在服务端
```

三件事值得单独说：

**1. 自己做 token 握手**

网关通过 `ctx.connection.authenticatedUrl()` 拿到带 launch token 的 URL，内部先请求一次完成「token → 会话 Cookie」交换，再转发你的请求。所以手机端**看不到那个 303**，落地就是页面。

**2. 上游 Cookie 全部扣在服务端**（最重要的一条）

DSH 的本地认证 Cookie 名是 `dsh-auth-<sha256(host:port)>`——**名字里带端口**。桌面版每次启动端口都变，旧 Cookie 又不会被清理，于是会越攒越多。

攒到 71 个时，仅 Cookie 请求头就约 16.4 KB，直接撞穿 Node 的 16 KB 请求头上限，返回 **HTTP 431**，DSH 会以「Web authentication failed」的面目起不来。

所以本网关：上游的 `Set-Cookie` **一律拦下存内存**，转发时也只注入当前那一个。手机侧永远只有网关自己的 `dsh_gate_session` 一个 Cookie，不存在累积。

**3. 不改页面**

`package.json` 里刻意没有 `dsh.client` 段落，所以 DSH 不会往浏览器加载任何本插件的脚本。网关只做转发 + 认证，不碰 DOM、不加 URL 参数、不做移动端适配。界面窄屏下好不好看，那是 DSH 自己的事。

## 安装

```sh
dsh plugin --profile desktop add dsh-web-gate
```

装完重启 DSH。启动日志里会打印访问地址和密码：

```
[dsh-web-gate] 网关已启动，DSH 页面未被改动
[dsh-web-gate]   手机访问：http://192.168.1.5:3082
[dsh-web-gate]   访问密码：k7mQx2vRtB
[dsh-web-gate]   配置文件：C:\Users\you\.dsh\dsh-web-gate
```

手机连同一个 WiFi，浏览器打开那个地址，输密码即可。

## 配置

改 `$DSH_HOME/dsh-web-gate/settings.json` 后重启：

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `3082` | 网关监听端口（手机访问这个端口） |
| `host` | `"0.0.0.0"` | 监听地址；填某个局域网 IP 可限定只监听它 |
| `password` | 随机 10 位 | 访问密码，至少 8 位 |
| `secret` | 随机 32 字节 | 会话 Cookie 的签名密钥，**别改**（改了等于全体登出） |

也可以在 profile 的 patch 里给（优先级更高）：

```yaml
- id: dsh-web-gate
  name: dsh-web-gate
  config:
    port: 3082
    password: "your-password"
```

**换密码 = 所有已登录设备立刻失效**（会话 Cookie 是 `HMAC(secret, password)`）。这是特性，不是 bug。

## 安全

- **密码是唯一的一道门**。网关会执行你电脑上的代码，别把地址和密码发到群里。
- 登录限速：单 IP 一分钟错 5 次锁 60 秒；全局一分钟错 50 次锁 30 秒。
- 会话 Cookie 是 `HttpOnly` + `SameSite=Lax`，值走常量时间比较。
- **默认只该在可信局域网里用**。它走明文 HTTP——同一个网络里能嗅探的人可以抓到密码。
  要跨网络用，上面叠一层 WireGuard/Tailscale 之类的加密隧道，别直接往公网开。
- 密码明文存在 `settings.json`（权限 0600），因为要拿它派生会话密钥。同机其他管理员账户能读到。

## 与 dsh-pocket 的关系

[dsh-pocket](https://github.com/shaobeichen/dsh-pocket) 解决的是同一类问题，功能多得多（公网隧道、固定域名、移动端适配套件、二维码）。

这个项目的取舍不同：

| | dsh-web-gate | dsh-pocket |
|---|---|---|
| 页面注入 | **无** | 有（移动端适配、polyfill、桌面端兼容层） |
| 上游 Cookie | **扣在服务端** | 透传给客户端 |
| 公网访问 | 不做 | cloudflared 隧道 |
| 依赖 | 零运行时依赖 | qrcode 等 |

两边都是独立实现，没有代码上的继承关系。

## 已知限制

- **没有二维码**。装了 `qrcode-terminal` 会打印，没装就只给地址。
- **不做公网**。设计上只面向局域网，要出门用请叠 VPN。
- **WebSocket 认证只在握手时检查一次**。连接建立后靠上游自己维持——和浏览器直连的行为一致。
- 上游把 `Host` 当权威来源，所以网关一律改写 `Host` / `Origin` / `Referer` 为 loopback。
  如果你的部署依赖真实 Host（比如 `--trusted-host`），这套改写逻辑需要相应调整。

## 开发

```sh
node --test test/*.test.js
```

33 个测试，含一个跑真实 HTTP 的集成测试：用假上游模拟 DSH 的 401 / 303+Cookie / 200 三种行为，
验证握手、头改写、Cookie 卫生和限速。

## License

MIT
