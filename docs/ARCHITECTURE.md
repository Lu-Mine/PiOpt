# PiOpt 技术架构与实现说明

本文档收录自原 `README.md` 迁出的底层实现细节、平台限制、权限边界与开发调试指南。面向使用者的简介见 [README.md](../README.md)。

---

## 1. 外观：动效与窗口材质

### 1.1 对称减速度矩阵与可往返协调

| 场景 | 默认值 | 行为 |
|---|---:|---|
| 按压 (`instant`) | 85ms | 按钮下移 1px，释放即时对称回弹 |
| 控件与轻浮层 (`fast`) | 135ms | hover、focus、开关、分段器、箭头旋转、菜单与气泡弹出退回 |
| 内容与折叠 (`base`) | 195ms | 页面/标签页进入、消息与卡片、内联展开收缩、侧栏往返伸缩 |
| 空间弹层 (`slow`) | 260ms | Dialog、全局搜索、侧滑抽屉 Sheet 与工作面板往返伸缩 |
| 空间幅度 | 2 / 4 / 7 / 10 / 16 px | 微浮层 / 折叠与卡片 / 消息与对话框 / 面板 / 抽屉 |
| 弹层缩放 | 0.988 / 0.982 → 1 | 轻浮层 / 模态层建立层级，不弹跳 |

整套动画使用统一的对称减速度曲线 `--pm-ease-symmetric` 并全量桥接宿主 `--motion-duration-*`、`--motion-ease-*` 与 `--default-transition-duration`：

- 展开↔收缩、弹出↔退回共享同一时长（`exitRatio = 1`）与曲线。留在 DOM 树上的状态切换使用 CSS `transition` 与 `details::details-content`；宿主 React 直接卸载的折叠块与浮层，以及半途反向的侧栏/工作面板，由宿主窗口内 `renderer/motion-runtime.mjs` 在不触碰 React 真实节点的前提下用惰性克隆与三次贝塞尔瞬时进度采样完成对称退回与半空反向接力。
- 入场关键帧统一使用 `animation-fill-mode: backwards`（不用 `both`），避免最终帧的 `transform` 滞留在元素上导致宿主 `position: fixed` 浮层改变参照系。可能挂载子菜单的 `[role="menu"]` / 右键菜单仅做透明度过渡，菜单项不参与按压下移。
- **Backdrop Root 规避**：`opacity < 1` 在 CSS Filter Effects 2 中是 Backdrop Root，动画期间会导致内部 `backdrop-filter` 看不到背景图。因此 `.app-shell` 与 `.main-pane` 不挂入场动画，改为动画内部内容层；侧栏与工作面板进出场只做位移与宽度伸缩，不改 `opacity`。
- **完全禁用动画**将所有过渡压到 `1ms`（而非 `none`，因为宿主依赖 `animationend` 卸载进场节点）。
- **推理强度滑杆吸附**：拖动中宿主会把过渡设为 `none`，PiOpt 用更高优先级选择器压回 `--pm-fast` 带过冲曲线；`reduced` 预设与系统减弱动态不做过冲。
- **明暗自动基底读取**：系统值由插件进程直接读取（Windows 查注册表 `AppsUseLightTheme`，macOS 读 `AppleInterfaceStyle`，Linux 读 `gsettings`），避免切回 `system` 导致闪屏；仅在三者均不可用时才短暂交还宿主测量兜底。
- **主题互斥**：`PiOpt Appearance` 是唯一运行时主题，旧 `Motion Lab · Light` / `Motion Lab · Dark` 会被自动清理；外观层不能叠加在其他第三方主题上。`WebContentsView`（工作面板、内置浏览器等）有独立渲染进程，不受此主题 CSS 控制。

### 1.2 窗口材质与双层融合

| 质感 | 模糊 | 弹层模糊 | 侧栏底色 | 标题栏底色 | 弹层底色 | 光场 | 有图时内容区 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 轻薄 | 16px | 22px | 72% | 58% | 76% | 16% | 62% |
| 标准 | 28px | 38px | 82% | 66% | 82% | 22% | 74% |
| 厚重 | 44px | 59px | 90% | 74% | 88% | 28% | 86% |

- 侧栏底色（`--pg-sidebar-alpha`）刻意高于内容区（`--pg-canvas-alpha`），使 `--ds-bg-under` 在浅色背景下仍深于主框体。
- `.app-shell::before` 铺背景图或柔光场（`z-index: -1`）。
- 顶栏材质由 `chromeFill` 统一覆盖 `.main-titlebar`、`.conversation-topbar`、`.window-controls`、`.work-panel-header`。
- `.work-panel::before` 用分段渐变保证顶部 `--ds-toolbar-height` 区域与主内容区采样底色一致，且放在 `::before` 上避免拦截后代 `backdrop-filter`；同时材质层始终抑制宿主的 `work-panel-in` 动画以消除静止色差。
- **弹层双画法**：不会再开子浮层的单层容器（如模型菜单、自动补全、二级菜单）滤镜直接挂在自身；可能开二级菜单的容器（`.context-menu`、`.sidebar-row-menu`、各类 composer 菜单）与 `.composer-shell` 将磨砂画在 `::before`，防止破坏内部视口坐标 `position: fixed` 定位。`test/glass.test.js` 通过剥离注释后检查确保玻璃层不引入 `transform:`。

### 1.3 背景图与 Wallpaper Engine

- **本地图片**：渲染进程通过 `<input type="file">` 读字节转 base64 交给插件进程写入数据目录 `wallpaper.<ext>`，CSS 写绝对路径由宿主 `themes.upsert` 重写为 `plugin-asset://`，不占用 256 KB 主题 CSS 预算（上限受宿主 4 MB 资源上限约束）。缩略图在面板内缩成 96px 中心方图 PNG 随设置保存；迁移旧图时按需向主进程取原图字节补画。图片丢失会在加载和 `glass.getState` 时自动清理引用。
- **Wallpaper Engine 定位与分类**：通过注册表与 `libraryfolders.vdf` 定位 Steam 创意工坊目录 `431960`。
  - `video`（mp4/webm）：在 `.app-shell` 插入原生 `<video>`，通过 `file:` URL 由 Chromium 硬解播放（因宿主 CSP 允许 `media-src` 覆盖 `file:` 而不允许 `plugin-asset:`），暗化层由容器 `::after` 绘制 `--pg-scrim`。
  - `scene`（带 `scene.pkg`）：主进程将包转为 `scene-payload-<id>.js` 写入插件数据目录，渲染端用 `<script src="file://...">` 加载，绕过 `plugin.call` 的 64 KB/10次每秒限流，交由内置 MIT 协议的 [WebWallGL 3.0.1](https://github.com/oneincase/webwallgl) 在 WebGL2 中以 30 fps 渲染。因宿主 CSP 禁止 `'unsafe-eval'`，挂载时传 `scripts: false`，禁用 SceneScript（粒子/视差/时钟等脚本驱动效果不运行）。
  - `web` / `application` / `preset`：受限于宿主 `frame-src pi-genui:` 或独立 `.exe` 机制，卡片可展示封面但不可选中。
- **Win11 平台限制**：PI-Desktop 窗口创建时使用 `transparent: false` 换取 DWM 圆角，Chromium 不透明合成层会遮住 `DWMWA_SYSTEMBACKDROP_TYPE`（Mica）。因此 PiOpt 的磨砂属于**窗口内分层**，无法透出桌面壁纸。

### 1.4 主题合成架构

`features/appearance/index.js` 的 `applyTheme` 统一拼接动效与玻璃样式表（`motion.buildThemeCss(...) + glassLayer`），任何一边变更都会整张重建，防止出现半张主题。

---

## 2. 行为：模型选择器与窗口入口

### 2.1 模型选择器（`renderer/model-picker.mjs`）

- **全量读取与缓存**：打开浮窗时逐格遍历左栏供应商（`MutationObserver` 最多等 400ms/组）拼出完整清单并切回原分组，按左栏指纹缓存在 `piopt.modelPicker.rows.v1`。若用户已在搜索框输入则立即让位。
- **不搬动 React 节点**：按宿主 DOM 结构重建统一视图，点击某行时再切回原生所属组触发原按钮，避免破坏 React `insertBefore` 参照。
- **品牌图标**：内置 `lobe-icons`（MIT）生成的 `renderer/model-logos/icons.mjs`，优先按模型名/ID 匹配品牌，其次按供应商名，均未命中时生成首字母彩块；增补品牌可编辑 `tools/build-model-icons.js` 重新生成。
- **同步翻译防闪烁**：滑杆与思考 chip 的英文→中文档位映射在 `MutationObserver` 中同步完成，未回写 `data-piopt-mp-level` 的刻度先 `visibility:hidden`。

### 2.2 窗口入口（`renderer/nav-entries.mjs`）

- 开启后在 `.sidebar-header-actions`（侧栏展开）或 `.ct-lead` / `.titlebar-nav`（侧栏收起）注入「收起/切换、新建任务、搜索」入口，原位宿主按钮以内联 `display:none !important` 隐藏防重绘闪烁；`.app-work-panel-toggle` 图标按盒子中心差自动偏移回正中。
- 状态读取结合挂载、窗口聚焦与 1.2 秒轮询（隐藏时跳过），`MutationObserver` 在 microtask 同步复位被宿主冲掉的注入按钮。控制台可执行 `__pioptNavEntries.inspect()` 排查挂载与偏移状态。

---

## 3. 远程（局域网控制）与安全边界

- 开关打开时监听 `0.0.0.0`（默认端口 `8790`），热重载时按 `remoteAutostart` 自动恢复。
- 配对接口按来源地址限速（1 分钟 5 次）；`Origin` 仅允许本机地址；除页面外所有接口校验设备令牌；令牌以原子写（临时文件+重命名）保存在插件数据目录 `remote-devices.json` 中，避免开发态重载丢失已配对设备。
- 对话正文从对应会话 `.jsonl` 读取，尾部 256 KB 按文件大小缓存并增量解析；列表元数据来自 `pi.session.*`，发送与中止经 `pi.desktop.invoke`（`agent/prompt`、`agent/abort`）。
- 宿主的 `dangerous` 审批操作（`agent/askTool/resolve`、`tool/resolvePermission`、`plans/resolve`）、删除/改名/切换项目均不开放。

---

## 4. 权限声明与代码结构

### 4.1 权限范围

声明权限：`ui.panel`、`renderer.extension`、`ui.theme`、`clipboard.write`、`net.fetch`、`shell.openExternal`、`agent.tool.register`、`agent.prompt.inject`、`desktop.control`、`session.read`。

- **数据目录**：仅写入 `~/.pi-desktop/plugins/data/local.piopt/`。
- **市场边界**：不安装/卸载插件、不改 `registry.json`；下载仅限 `https` 与固定 4 个白名单主机（`cdn.jsdelivr.net`、`raw.githubusercontent.com`、`api.github.com`、`plugins.aiuo.net`），重定向同样复核白名单，单包上限 50 MB，HTML 响应按 `SERVER_HTML` 丢弃。
- **文件右键打开**：仅允许白名单内非可执行文件，解析真实路径后严格限制在当前会话 scratch 目录或当前项目目录内。
- **`agent.prompt.inject`**：仅按需收录 `skills/piopt.md`，不自动往对话注入内容。

### 4.2 目录结构

```text
PiOpt/
├─ manifest.json                统一清单：6 条命令、4 个 agent 工具、10 项权限
├─ main.js                      组装四个功能，按通道前缀路由面板 RPC
├─ features/
│  ├─ market/                   市场（index.js / core.js / downloader.js / permissions.js）
│  ├─ appearance/               外观（index.js / motion.js / glass.js / engine.js）
│  ├─ behavior/                 行为（index.js / model-picker.js）
│  └─ remote/                   远程（index.js / server.js / mobile/*）
├─ renderer/                    面板 UI、entry.mjs、motion-runtime.mjs、wallpaper-runtime.mjs、model-picker.mjs、vendor/
├─ skills/piopt.md              Agent 使用规则
├─ tools/build-model-icons.js   模型品牌图标生成脚本
└─ test/                        结构、面板、动效、玻璃层与模型浮窗测试
```

---

## 5. 本地开发与迁移说明

- **免打包热重载**：在 PI-Desktop 的 `Plugins → Load development plugin` 选择本目录，保存即生效（仅修改 `manifest.json` 权限或 `fs` 范围时需显式重载）。
- **冲突提示**：开发期间请禁用已安装的 `local.pimarket` 与 `local.pi-modify` 以免命令 ID 与主题冲突。
- **独立预览**：直接用浏览器打开 `renderer/index.html` 可在无宿主 bridge 下进入独立预览模式。
- **校验与打包**：
  ```bash
  node --test test/*.test.js
  node --check main.js
  ```
  正式分发的 `.piplug` 为 store-only zip，需通过 PI-Desktop 的 `PluginPack` 生成。
- **仓库迁移历史**：本仓库由 `Pi-Market` 与 `Pi-Modify` 合并而来，原临时存档目录已清理，历史自 `feat: merge Pi-Market and Pi-Modify into the PiOpt console` 起记。
