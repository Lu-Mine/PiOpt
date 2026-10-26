# PiOpt

PI-Desktop 的控制台插件：一个插件，两个功能。

| 功能 | 做什么 |
|---|---|
| **插件市场** | 读取已装插件与官方 catalog，经 jsDelivr / raw / GitHub Blobs API 下载更新包，按 `sizeBytes` 与 `sha256` 逐位校验后再交给你在 Plugins 页安装。 |
| **动效实验室** | 用四套克制预设调校 PI-Desktop 界面动效，实时预览、即时生效，并尊重系统减弱动态。 |

两者在同一个面板里，通过顶部的「插件市场 / 动效实验室」切换；也可以分别用命令直接打开对应视图。

## 插件市场

- **更新**：列出已装插件与 catalog 里最新非撤回版本，显示体积、发布时间、更新说明。
- **准备**：按 `jsDelivr → raw → GitHub Blobs API → 官方地址` 依次尝试，每个候选 3 次重试 + 指数退避。
- **校验**：边下载边算 sha256，只有 `sizeBytes` 与 `shasum` 与 catalog 一致才从 `.part` 改名为正式文件。
- **诊断**：对指定版本逐个通道取前 1 KB，报告 HTTP 状态、content-type、体积、耗时与错误码。
- **详情**：版本卡、主页、仓库/提交/构建者、安全说明、按风险分级的权限说明、完整版本列表与 changelog。
- **可安装**：列出 catalog 里本机尚未安装的插件，同样可以准备包。
- **队列**：下载进度、阶段、来源、失败时每个通道的原始错误。

下载位置：

```
data/local.piopt/downloads/<id>-<version>.piplug
```

失败码：`SERVER_HTML`、`LINK_RESET`、`MIRROR_404`、`RATE_LIMIT`、`TIMEOUT`、`DNS`、`HTTP_ERROR`、`INTEGRITY`、`TOO_LARGE`、`CANCELLED`、`NO_SOURCE`、`WRITE_FAILED`。

## 动效实验室

| 场景 | 默认值 | 行为 |
|---|---:|---|
| 按压 | 80ms | 按钮下移 1px |
| 控件 | 130ms | hover、focus、开关与菜单 |
| 内容 | 190ms | 页面、列表、消息进入 |
| 弹层 | 260ms | Dialog、抽屉与工作面板 |
| 位移 | 3 / 7 px | 小内容 / 消息与弹层 |
| 弹层缩放 | 0.985 → 1 | 建立层级，不弹跳 |

四套预设：

- **敏捷**：时长约为基准的 0.78 倍，位移 0.8 倍。
- **平衡**：默认 token。
- **柔和**：时长约为基准的 1.18 倍，位移不增加。
- **减弱**：位移归零、缩放归一、持续动画停止，只保留 70–90ms 淡变。

速度滑杆只影响时长；强度滑杆只影响位移与缩放。拖动滑块、切换预设或明暗基底后**自动生效**：面板先即时更新预览，再在 80ms 防抖后写入并应用宿主主题。连续拖动只提交最后一版参数，同步进行中的新改动会补发。

状态点与标题栏显示「正在同步 / 实时应用已就绪 / 实时同步失败」。失败时参数保留在本地，调整任一选项即可重试。

插件写两套运行时主题：

- `Motion Lab · Light`
- `Motion Lab · Dark`

它们只含动效规则，不覆盖任何 `--ds-*` 颜色 token。

## 安装与使用
打包时校验器会给出两类提示，都不代表功能缺失：

- `permission.high-risk`：`net.fetch`、`agent.tool.register`、`agent.prompt.inject` 需要在安装时由你明确授权，这是设计如此。
- `permission.unused`：校验器只扫描 `main.js`，而实际调用位于 `features/market/index.js`（`net.fetch`、`clipboard.writeText`、`agent.registerTool`）。权限声明与真实调用一致。
1. 在 PI-Desktop 的 Plugins 页安装 `dist/local.piopt-1.0.0.piplug`。
2. 命令面板运行 **PiOpt: 打开控制台**，或直接运行功能命令：

| 命令 | 效果 |
|---|---|
| `PiOpt: 打开控制台` | 打开面板，进入插件市场 |
| `PiMarke: 准备全部可用更新` → `Pimarket: 准备全部可用更新` | 打开面板并串行准备所有可用更新 |
| `PiOpt: 打开动效实验室` | 打开面板，进入动效视图 |

面板内也可以点顶部切换；`Alt+1` / `Alt+2` 快速切换。

## 权限与边界

声明：`ui.panel`、`ui.theme`、`clipboard.write`、`net.fetch`、`agent.tool.register`、`agent.prompt.inject`。

| `Pimarket: 准备全部可用更新` | 打开面板并串行准备所有可用更新 |

- 只写自己的数据目录：`~/.pi-desktop/plugins/data/local.piopt/`（市场可在设置里改）。
- 市场功能不安装、不卸载、不启用/禁用、不改 `registry.json`、不启动任何进程。
- 下载只允许 `https`，主机硬编码为 `cdn.jsdelivr.net`、`raw.githubusercontent.com`、`api.github.com`、`plugins.aiuo.net`，每一次重定向都按同一白名单复核；单包上限 50 MB。
- 内置文件是 HTML 的响应按 `SERVER_HTML` 丢弃，绝不当作包。
- 动效功能不访问网络与文件；`ui.theme` 只用于两套动效主题。
- `agent.prompt.inject` 只用于收录 `skills/piopt.md`（按需加载），不会自动往消息里注入内容。

### 主题互斥

PI-Desktop 一次只能选择一个主题，动画层不能叠加在另一个第三方主题上。应用动效实验室会切换到匹配的宿主 Light/Dark 基底再附加动效规则，原先选中的第三方主题不会继续生效。

工作面板、浏览器等原生 `WebContentsView` 有独立渲染进程，主题 CSS 无法跨文档控制其内部动画。

## 结构

```text
PiOpt/
├─ manifest.json            统一清单：4 条命令、2 个 agent 工具、6 项权限
├─ main.js                  组装两个功能，按通道前缀路由面板 RPC
├─ features/
│  ├─ market/               市场功能
│  │  ├─ index.js           面板 RPC、命令、agent 工具、任务表
│  │  ├─ core.js            路径、semver、registry/catalog 读取、失败分类
│  │  ├─ downloader.js      四源候选、重试、流式 sha256、探测
│  │  └─ permissions.js     权限中文名、说明与风险分级
│  └─ motion/               动效功能
│     ├─ index.js           生命周期、运行时主题注册、面板 RPC
│     └─ motion.js          预设、token、主题 CSS 生成器
├─ renderer/
│  ├─ index.html            外壳 + 两个功能视图
│  ├─ tokens.css            共享设计 token
│  ├─ base.css              外壳布局与产品栏
│  ├─ market.css            市场视图样式（@scope 隔离）
│  ├─ motion.css            动效视图样式（@scope 隔离）
│  ├─ market.js             市场视图逻辑
│  ├─ motion.js             动效视图逻辑
│  └─ shell.js              视图切换与按需启动
├─ skills/piopt.md          Agent 使用规则
└─ test/                    结构测试与动效模型测试
```

两个功能互不调用：面板通道按 `market.` / `motion.` 前缀分发，各自的设置、状态与失败处理相互独立。

## 开发（免打包热重载）

改代码不需要 `.piplug`。PI-Desktop 的 **Plugins → Load development plugin** 会直接从目录加载并监听改动：

1. 在 Plugins 页点 **Load development plugin**，选择本目录 `E:\AgentProjects\PiOpt`。
2. 之后保存任何文件，宿主自动重载插件，不需要重新打包、也不需要重新安装。
3. 只有 `manifest.json` 的 `permissions`（或 `manifest.fs` 范围）变化时才需要显式重新加载一次——这是宿主的授权设计，不是缓存问题。

注意：

- 开发期间请**禁用**已安装的 `local.pimarket` 与 `local.pi-modify`。PiOpt 复用了 `pimarket.open`、`pi-modify.open` 等命令 id，同时启用会出现重复命令，插件列表里也会多出一套旧的 Motion Lab 主题。
- 面板是独立窗口，保存文件触发的重载会关闭当前面板，重新打开即可。
- 纯界面迭代可以先用浏览器打开 `renderer/index.html` 看布局：没有宿主 bridge 时会自动进入独立预览模式。

校验与测试：

```bash
node --test test/*.test.js
node --check main.js
```

只有要发布或交给别人安装时才打包，且必须由 PI-Desktop 的 `PluginPack` 生成（`.piplug` 是 store-only zip，不能用普通 zip/tar 代替）。

## 迁移说明

本仓库由 `Pi-Market`（市场）与 `Pi-Modify`（动效）合并而来。两个原始目录曾作为来源存档留在磁盘上，已于清理时删除（它们当时没有 remote，历史随目录一并丢弃）；合并后的功能全部在本仓库，当前历史从 `feat: merge Pi-Market and Pi-Modify into the PiOpt console` 开始。
