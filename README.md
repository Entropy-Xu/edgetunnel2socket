# edgetunnel2socket

`edgetunnel2socket` 是一个基于 `edgetunnel` 的 Cloudflare Workers/Pages 版本，重点增加了 sing-box SOCKS5 适配器能力：在 Worker 后台把 edgetunnel 生成的 VLESS 订阅转换为 sing-box 配置，然后在本地或服务器上运行 sing-box，提供标准 SOCKS5 动态代理入口。

它不会、也不能把 Cloudflare Worker 本身变成一个对外监听任意 TCP 端口的 SOCKS5 服务端。Worker 只负责原有 VLESS/WS/TLS 代理和配置转换；真正的 SOCKS5 监听发生在运行 sing-box 的设备上。

网络路径：

```text
应用 -> 本地 SOCKS5 -> sing-box -> VLESS/WS/TLS -> CF 优选 IP -> edgetunnel Worker -> 目标站点
```

## 功能

- 保留 edgetunnel 原有 Worker/Pages 部署、管理后台、订阅生成和 VLESS/WS/TLS 代理能力。
- 新增后台页面 `/admin/socks-adapter`，可把 VLESS 订阅转换为 sing-box SOCKS5 动态代理配置。
- 支持粘贴订阅 URL，也支持粘贴 base64 订阅或明文 `vless://` 链接。
- 多个 VLESS 节点自动生成 sing-box `urltest` outbound；单节点直接作为 `route.final`。
- 新增本地无依赖脚本 `tools/generate-singbox-config.mjs`，可在 Worker 外生成同样的 sing-box 配置。

## 部署

### Cloudflare Workers

1. 在 Cloudflare Workers 控制台创建 Worker。
2. 将 `_worker.js` 的内容部署到 Worker。
3. 添加环境变量：
   - `ADMIN`：后台登录密码。
   - `KEY`：可选，快速订阅路径密钥。
   - `UUID`：可选，固定节点 UUID，必须是 UUIDv4。
4. 绑定 KV Namespace：
   - 绑定名必须是 `KV`。
5. 绑定自定义域后访问后台：

```text
https://你的域名/admin
```

### Cloudflare Pages

Pages 部署同样需要配置 `ADMIN` 环境变量，并绑定名为 `KV` 的 KV Namespace。部署后访问：

```text
https://你的域名/admin
```

如果看到 `noADMIN`，说明没有配置 `ADMIN`。如果看到 `noKV`，说明没有绑定名为 `KV` 的 KV Namespace。

## 后台登录

后台没有用户名，只使用 `ADMIN` 环境变量作为密码。

1. 打开 `https://你的域名/admin`。
2. 页面会跳转到 `/login`。
3. 输入 `ADMIN` 的值。
4. 登录成功后会写入 `auth` cookie。

登录后即可访问：

```text
https://你的域名/admin/socks-adapter
```

## 生成 SOCKS5 动态代理配置

### 使用 Worker 面板

打开：

```text
https://你的域名/admin/socks-adapter
```

面板支持两种方式：

- 填入订阅 URL，由 Worker 拉取订阅并转换。
- 粘贴订阅内容，内容可以是 base64 订阅或明文 `vless://` 链接。

生成后复制或下载 `sing-box.generated.json`。

也可以调用受后台登录 cookie 保护的接口：

```bash
curl 'https://你的域名/admin/socks-adapter/config?raw=1' \
  -H 'Content-Type: application/json' \
  -H 'Cookie: auth=你的后台登录Cookie' \
  --data '{"sub":"https://你的域名/sub?token=你的TOKEN","listen":"127.0.0.1","port":1080}' \
  -o sing-box.generated.json
```

### 使用本地脚本

从订阅 URL 拉取：

```bash
node tools/generate-singbox-config.mjs \
  --sub 'https://你的域名/sub?token=你的TOKEN' \
  --listen 127.0.0.1 \
  --port 1080 \
  --out sing-box.generated.json
```

从本地文件读取：

```bash
node tools/generate-singbox-config.mjs \
  --input subscription.txt \
  --listen 127.0.0.1 \
  --port 1080 \
  --out sing-box.generated.json
```

## 运行 sing-box

检查配置：

```bash
sing-box check -c sing-box.generated.json
```

启动本地 SOCKS5：

```bash
sing-box run -c sing-box.generated.json
```

应用侧代理设置为：

```text
SOCKS5 127.0.0.1:1080
```

curl 测试：

```bash
curl --socks5-hostname 127.0.0.1:1080 https://cloudflare.com/cdn-cgi/trace
```

## 注意事项

- 不能把 CF 优选 IP 直接改写成 `socks5://IP:443`。这些地址是 VLESS/WS/TLS 节点入口，不是 SOCKS5 服务端。
- Worker 面板只生成配置，不提供本地端口监听。
- 如果订阅里包含 Trojan、Shadowsocks、VMess 等非 VLESS 链接，转换器会忽略它们并输出提示。
- 更完整说明见 [docs/socks-adapter.md](docs/socks-adapter.md)。

## 来源

本项目基于 [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) 修改，保留原有 Worker 代理核心逻辑，并增加 sing-box SOCKS5 适配器面板和本地生成脚本。

## 免责声明

本项目仅供教育、科学研究及个人安全测试使用。使用者需自行遵守所在地区法律法规，并承担使用本项目产生的一切风险。
