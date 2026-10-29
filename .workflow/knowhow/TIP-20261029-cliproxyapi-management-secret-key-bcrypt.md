---
id: "TIP-20261029-cliproxyapi-management-secret-key-bcrypt"
title: "CLIProxyAPI 的 management.secret-key 是 bcrypt 时绝不能发出去"
keywords: ["bcrypt", "管理密钥", "secret-key", "CLIProxyAPI", "401", "IP封禁", "封禁", "config.yaml", "management", "凭据", "gateway", "密钥"]
status: active
created: 2026-10-29
source: pi-desktop
---

CLIProxyAPI 启动时会把 config.yaml 里的明文管理密钥哈希后回写。哈希无法反推明文，直接拿去请求必然 401；而连续失败会让管理接口按 IP 临时封禁 30 分钟——这件事在本机真实发生过。

所以读到 secret-key 后，只要匹配 /^\$2[aby]\$/ 就当作没有密钥：返回空、当场抛「缺少管理密钥」，一次请求都不发。回归测试守着这条：test/gateway.test.js 的 "bcrypt management key is never sent, so no request can trip the IP ban" 断言 /v8/management 命中数为 0。

取密钥的正确顺序：PiOpt 设置里填的明文 > config.yaml 里尚未被哈希的明文 > 如实报缺密钥。报错要能指导操作：请填明文，或把 config.yaml 改回明文后重启网关。

同类教训：凡是要发凭据的地方，先把「读到的到底是不是可用的东西」校验一遍再发，别把一次必然失败的重试留给服务端的封禁计数。

文件：features/gateway/services.js、test/gateway.test.js
