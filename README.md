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
两把滑杆的范围是速度 0.60–1.60×、强度 50–150%（5% 一档）；1.00× 落在速度滑杆的 40% 处，因为区间两端并不对称。
明暗底色交叉淡变是**例外**：它固定 1.00×（160ms，减弱预设 90ms），不随速度与预设伸缩——换色属于系统级变化，跟着调慢只会让整个窗口显得迟钝。

状态点与标题栏显示「正在同步 / 实时应用已就绪 / 实时同步失败」。失败时参数保留在本地，调整任一选项即可重试。

插件只写**一个**运行时主题 `Motion Lab`，它的基底由上面那三档决定：

- **自动**：跟随系统外观（浅/深），面板打开或点它时读取系统真实值；
- **浅色 / 深色**：固定使用该基底，不再看系统。

“自动”要读系统的真实深浅。宿主会把 `nativeTheme.themeSource` 设成当前主题的基底，于是面板里的 `prefers-color-scheme` 只是在回显我们自己写进去的值。所以系统值改由插件进程直接读：Windows 查注册表 `AppsUseLightTheme`，macOS 读 `AppleInterfaceStyle`，Linux 读 `gsettings` 的 `color-scheme`。这只是一次几毫秒的读取，不动当前主题，因此打开面板不会再整窗换色闪一下。只有三种方式都读不到时（无 shell、未知桌面），才退回旧做法：把主题短暂交还宿主（`system`）、读一次、再接管回来——那一步会闪，所以只是兜底。拖滑杆不会重复测量。

同一时刻宿主里只会出现这一个 Motion Lab 主题，旧版本注册的 `Motion Lab · Light` / `Motion Lab · Dark` 会被自动移除。它只含动效规则，不覆盖任何 `--ds-*` 颜色 token。

## 侧边栏入口

PI-Desktop 左下角那排按钮里，PiOpt 的入口排在第二个（插件）之后：

- 图标就是面板标题栏里 PiOpt 名字左边那三根竖条（6 / 13 / 9 px，3px 柱、2px 间距），用当前图标的颜色画，所以静止时和相邻四个一样灰、悬停一起变亮；命中区仍是宿主的 32×32 `.footer-action`，悬停显示「PiOpt 控制台」。
- 点一下打开 PiOpt 面板，停在上次看到的视图（命令 `PiOpt: 打开控制台` 才会固定切到市场）。
- 宿主没有给这个位置提供插槽，所以入口由 `renderer/entry.mjs` 直接挂在宿主窗口里：定位 `.sidebar-footer .footer-actions`，插到 `[data-nav="plugins"]` 之后，宿主重新渲染把它冲掉时自动补回，插件卸载时移除。
- 宿主要是改了底部按钮栏的结构、找不到那个锚点，入口退回放在这一排的末尾而不消失。
- 面板自己声明 `pi-plugin-chrome: v3`（paint-through）：顶部 46px 仍归宿主，由它按可交互元素切成拖拽段，并且**不再插那行「开发提示 · 顶部 46px 为拖拽区」**——v2 面板才会显示。

## 安装与使用

要求 PI-Desktop **0.21.0 或更高**（`manifest.engines` 据此声明）：面板的 `pi-plugin-chrome: v3` 与左下角入口都依赖这一代宿主。
打包时校验器会给出两类提示，都不代表功能缺失：

- `permission.high-risk`：`renderer.extension`、`net.fetch`、`agent.tool.register`、`agent.prompt.inject` 需要在安装时由你明确授权，这是设计如此。
- `permission.unused`：校验器只扫描 `main.js`，而实际调用位于 `features/market/index.js`（`net.fetch`、`clipboard.writeText`、`agent.registerTool`）。权限声明与真实调用一致。
1. 在 PI-Desktop 的 Plugins 页安装 `dist/local.piopt-1.0.0.piplug`。
2. 命令面板运行 **PiOpt: 打开控制台**，或直接运行功能命令：

| 命令 | 效果 |
|---|---|
| `PiOpt: 打开控制台` | 打开面板，进入插件市场 |
| `PiMarke: 准备全部可用更新` → `Pimarket: 准备全部可用更新` | 打开面板并串行准备所有可用更新 |
| `PiOpt: 打开动效实验室` | 打开面板，进入动效视图 |

面板左侧菜单最上方有一个展开/收起按钮：收起时只显示图标，展开后菜单加宽并写出「插件市场」「动效实验室」两个名字，选择记在面板本地，下次打开保持。菜单里点一下或 `Alt+1` / `Alt+2` 都能切换视图。
切换时选中指示条在两项之间滑过去（160ms），新视图淡入并从下方 4px 归位；系统开启「减少动态效果」时两者都关掉。

## 权限与边界

声明：`ui.panel`、`renderer.extension`、`ui.theme`、`clipboard.write`、`net.fetch`、`agent.tool.register`、`agent.prompt.inject`。

| `Pimarket: 准备全部可用更新` | 打开面板并串行准备所有可用更新 |

- 只写自己的数据目录：`~/.pi-desktop/plugins/data/local.piopt/`（市场可在设置里改）。
- 市场功能不安装、不卸载、不启用/禁用、不改 `registry.json`、不启动任何进程。
- 下载只允许 `https`，主机硬编码为 `cdn.jsdelivr.net`、`raw.githubusercontent.com`、`api.github.com`、`plugins.aiuo.net`，每一次重定向都按同一白名单复核；单包上限 50 MB。
- 内置文件是 HTML 的响应按 `SERVER_HTML` 丢弃，绝不当作包。
- 动效功能不访问网络与文件；`ui.theme` 只用于那一个 `Motion Lab` 主题（基底随设定切换）。
- `agent.prompt.inject` 只用于收录 `skills/piopt.md`（按需加载），不会自动往消息里注入内容。
- `renderer.extension` 只用于一个渲染模块：在宿主窗口左下角的按钮栏里挂一个入口按钮，点击经 `plugin.call` 交回插件进程打开面板；不读文件、不访问网络、不改动其他插件的界面，卸载时移除自己挂的东西。

### 主题互斥

PI-Desktop 一次只能选择一个主题，动画层不能叠加在另一个第三方主题上。应用动效实验室会切换到匹配的宿主 Light/Dark 基底再附加动效规则，原先选中的第三方主题不会继续生效。

工作面板、浏览器等原生 `WebContentsView` 有独立渲染进程，主题 CSS 无法跨文档控制其内部动画。

## 结构

```text
PiOpt/
├─ manifest.json            统一清单：4 条命令、2 个 agent 工具、7 项权限
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
│  ├─ shell.js              视图切换与按需启动
│  └─ entry.mjs             宿主窗口侧边栏的入口按钮（renderer.extension）
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
- 入口按钮用的是 `renderer.extension`：它是权限项，宿主在授权变化后不会热更新，所以首次加载或改动权限后要重新加载一次插件（必要时重启）按钮才会出现。
- 纯界面迭代可以先用浏览器打开 `renderer/index.html` 看布局：没有宿主 bridge 时会自动进入独立预览模式。

校验与测试：

```bash
node --test test/*.test.js
node --check main.js
```

只有要发布或交给别人安装时才打包，且必须由 PI-Desktop 的 `PluginPack` 生成（`.piplug` 是 store-only zip，不能用普通 zip/tar 代替）。

## 迁移说明

本仓库由 `Pi-Market`（市场）与 `Pi-Modify`（动效）合并而来。两个原始目录曾作为来源存档留在磁盘上，已于清理时删除（它们当时没有 remote，历史随目录一并丢弃）；合并后的功能全部在本仓库，当前历史从 `feat: merge Pi-Market and Pi-Modify into the PiOpt console` 开始。
