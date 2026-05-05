# 本地 SOCKS5 适配器

Cloudflare Worker 不能对外监听任意 TCP 端口，所以不要把 edgetunnel Worker 改造成标准 SOCKS5 服务端。本方案保留 Worker 现有 VLESS/WS/TLS 能力，在本地或服务器上运行 sing-box，把 edgetunnel 订阅里的 VLESS 节点转换成本机 SOCKS5 动态代理。

网络路径如下：

```text
应用 -> 本地 SOCKS5 -> sing-box -> VLESS/WS/TLS -> CF 优选 IP -> edgetunnel Worker -> 目标站点
```

这也意味着，不能把图片或订阅里的 CF 优选 IP 直接改写成 `socks5://IP:443`。这些 IP:端口是给 VLESS over WebSocket/TLS 使用的入口，不是一个正在监听 SOCKS5 握手的服务端。

## 获取订阅 URL

1. 打开已部署站点的后台：`https://你的域名/admin`。
2. 输入管理员密码登录。
3. 在后台找到订阅接口或订阅地址，复制完整的订阅 URL。
4. 如果配置了 `KEY` 环境变量，也可以访问 `https://你的域名/KEY值`，Worker 会跳转到带 `token` 的 `/sub?...` 订阅地址，复制跳转后的 URL。

建议优先使用 `mixed`/默认订阅，脚本会自动识别 base64 订阅并只提取其中的 `vless://` 链接。

## 生成 sing-box 配置

### 后台面板生成

部署更新后的 Worker 后，登录后台并打开：

```text
https://你的域名/admin/socks-adapter
```

面板支持两种输入：

- 粘贴订阅 URL，由 Worker 后台请求订阅内容并生成配置。
- 粘贴订阅内容，内容可以是 base64 订阅或明文 `vless://` 链接。

生成结果会显示为 sing-box JSON，可直接复制或下载为 `sing-box.generated.json`。这个面板仍然只是配置转换器；真正的 SOCKS5 监听发生在运行 sing-box 的本地电脑或服务器上。

也可以直接调用受后台登录 cookie 保护的接口生成：

```bash
curl 'https://你的域名/admin/socks-adapter/config?raw=1' \
  -H 'Content-Type: application/json' \
  -H 'Cookie: auth=你的后台登录Cookie' \
  --data '{"sub":"https://你的域名/sub?token=你的TOKEN","listen":"127.0.0.1","port":1080}' \
  -o sing-box.generated.json
```

### 本地脚本生成

从订阅 URL 拉取：

```bash
node tools/generate-singbox-config.mjs \
  --sub 'https://你的域名/sub?token=你的TOKEN' \
  --listen 127.0.0.1 \
  --port 1080 \
  --out sing-box.generated.json
```

从本地文本文件读取，文件内容可以是 base64 订阅，也可以是明文 `vless://` 链接：

```bash
node tools/generate-singbox-config.mjs \
  --input subscription.txt \
  --listen 127.0.0.1 \
  --port 1080 \
  --out sing-box.generated.json
```

脚本会忽略 Trojan、Shadowsocks、VMess 等非 VLESS 链接，并在命令行输出提示。多个 VLESS 节点会生成 `urltest` outbound，单节点会直接把 `route.final` 指向该节点。

## 检查和运行

```bash
sing-box check -c sing-box.generated.json
sing-box run -c sing-box.generated.json
```

运行后，应用侧把代理设置为 SOCKS5：

```text
127.0.0.1:1080
```

也可以用 curl 验证：

```bash
curl --socks5-hostname 127.0.0.1:1080 https://cloudflare.com/cdn-cgi/trace
```
