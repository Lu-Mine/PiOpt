# PiOpt

PI-Desktop 的控制台插件：外观（界面动效与窗口磨砂材质）、行为（聊天框模型浮窗）、插件市场、局域网远程控制，四栏合在一个面板里。

当前版本 `2.0.0` · 需要 PI-Desktop `0.21.0` 或更高 · MIT

> **注意**：本项目由 Vibe Coding 开发，不保证可用性、安全性或特定用途适用性；使用风险由使用者自行承担。

## 核心功能

面板挂在侧栏左下角的控制台入口后面，左侧按「外观 / 行为 / 插件市场 / 远程」切换，`Alt+1`–`Alt+4` 直达。

| 模块 | 能做什么 |
|---|---|
| 外观 | 注册统一的 `PiOpt Appearance` 主题：对称减速度动效预设（强度 50–150%、速度 0.40–2.00×、减弱动态跟随或彻底禁用），以及窗口内磨砂玻璃（模糊强度、本地背景图、Wallpaper Engine `video` 与 `scene` 壁纸） |
| 行为 | 聊天框的模型浮窗一次列出全部模型，可按默认顺序 / 供应商 / 厂商 / 名称排列；品牌图标、圆角框选中态、中文推理强度、把新建任务与搜索搬进侧边栏、会话文件右键打开 |
| 插件市场 | 读取官方目录，按 jsDelivr → raw → GitHub Blobs API → plugins.aiuo.net 的顺序回退下载更新包，流式校验 `sizeBytes` 与 `sha256`，并给出通道诊断与权限风险分级 |
| 远程 | 同一 Wi-Fi 下用手机或另一台电脑的浏览器连接：扫码 + 6 位配对码，看项目与会话、发指令、中止运行、从历史消息分叉重问 |

## 安装

1. 确认宿主是 PI-Desktop `0.21.0` 或更高版本。
2. 在 **Plugins → 市场**里搜索 PiOpt 安装，按提示授予扩展、网络、主题与会话相关权限。
3. 想用离线包：从 Releases 下载 `pi.piopt-2.0.0.piplug`，在 Plugins 页面选择安装包。

### 开发模式

在 **Plugins → Load development plugin** 里选本仓库根目录，保存即重载；改动 `manifest.json` 的权限时需要手动重载一次。

```
node --test test/*.test.js
node --check main.js
```

## 常用入口

命令面板里：

- `PiOpt: 打开控制台`：回到上次停留的那一栏
- `PiOpt: 打开外观` / `PiOpt: 打开窗口材质`：直达外观的两个小节
- `PiOpt: 打开远程访问`：打开局域网配对与二维码
- `Pimarket: 准备全部可用更新`：串行下载并校验所有可更新的插件

## 文档

- [技术架构与实现说明](https://github.com/Lu-Mine/PiOpt/blob/main/docs/ARCHITECTURE.md)：动效曲线、双层磨砂原理、Wallpaper Engine 通道、权限边界与目录结构
- [上架合规说明](https://github.com/Lu-Mine/PiOpt/blob/main/docs/MARKET-COMPLIANCE.md)：每条权限的实际调用点、网络出口、写入位置与已知攻击面
- [版本与提交规范](https://github.com/Lu-Mine/PiOpt/blob/main/VERSIONING.md)：语义化版本规则与发布约束

## 许可

MIT。内置 `lobe-icons` 与 `WebWallGL` 遵循各自附带的 MIT 许可证。
