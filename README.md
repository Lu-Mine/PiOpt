<div align="center">

# PiOpt

专为 PI-Desktop 打造的控制台插件，一站整合界面动效、磨砂材质、模型列表增强、局域网远程控制与插件市场。

![Version](https://img.shields.io/badge/version-1.1.2-2563eb?style=flat-square)
![PI-Desktop](https://img.shields.io/badge/PI--Desktop-%3E%3D0.21.0-0f172a?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-16a34a?style=flat-square)

</div>

> [!WARNING]
> 本项目由 Vibe Coding 开发，不保证可用性、安全性或特定用途适用性；使用风险由使用者自行承担。

## ✨ 核心功能

面板集成在侧栏左下角控制台入口，左侧按 `外观 / 行为 / 插件市场 / 远程` 四栏切换（支持 `Alt+1`–`Alt+4`）：

| 模块 | 面向用户的主要能力 |
|---|---|
| 🎨 **外观** | 注册统一的 `PiOpt Appearance` 主题：包含对称减速度动效预设（速度/强度调节、减弱动态跟随或 `1ms` 彻底禁用）与窗口内磨砂玻璃（模糊强度、本地背景图及 Wallpaper Engine `video`/`scene` 壁纸渲染） |
| 🧩 **行为** | 展开聊天框分页模型浮窗一次列出全部模型，支持 `默认 / 供应商 / 厂商 / 名称` 四种排列、内置品牌图标、圆角框选中态、中文推理强度译名、侧栏功能入口重排及临时会话文件右键打开 |
| 📦 **插件市场** | 读取本地已装插件与官方 catalog，按 `jsDelivr → raw → GitHub Blobs API → plugins.aiuo.net` 自动回退下载更新包，流式校验 `sizeBytes` 与 `sha256`，并提供通道诊断与风险分级权限说明 |
| 📱 **远程控制** | 同 Wi-Fi 下手机或电脑浏览器扫码 + 6 位配对码连接：查看项目与临时会话、发指令、中止运行、从历史消息分叉重问、提示等待人工确认的交互状态（不开放危险审批操作） |

## 🚀 安装与使用

### 正式安装

1. 确认宿主为 **PI-Desktop `0.21.0` 或更高版本**。
2. 在 PI-Desktop 的 **Plugins** 页面安装 `dist/local.piopt-1.1.2.piplug`，按提示授予扩展、网络、主题与会话相关权限。

### 开发模式

在 PI-Desktop 的 **Plugins → Load development plugin** 选择本仓库根目录即可启用保存即重载（权限变动需手动重载）：

```bash
node --test test/*.test.js
node --check main.js
```

### 常用命令面板入口

- `PiOpt: 打开控制台` — 打开面板并停在插件市场
- `PiOpt: 打开外观` / `PiOpt: 打开窗口材质` — 直达外观设置对应小节
- `PiOpt: 打开远程访问` — 打开局域网控制与配对二维码
- `Pimarket: 准备全部可用更新` — 串行下载并校验所有可更新插件

## 📚 相关文档

- [技术架构与实现说明](docs/ARCHITECTURE.md) — 动效曲线、双层磨砂原理、Wallpaper Engine 通道、权限边界与目录结构
- [版本与提交规范](VERSIONING.md) — 语义化版本规则与发布约束
- 许可证：MIT（项目清单声明；内置 `lobe-icons` 与 `WebWallGL` 遵循各自附带的 MIT 许可证）
