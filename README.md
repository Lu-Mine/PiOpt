# PiOpt

PI-Desktop 的控制台插件：一个插件，两个功能。

| 功能 | 做什么 |
|---|---|
| **插件市场** | 读取已装插件与官方 catalog，经 jsDelivr / raw / GitHub Blobs API 下载更新包，按 `sizeBytes` 与 `sha256` 逐位校验后再交给你在 Plugins 页安装。 |
| **动效实验室** | 用四套克制预设调校 PI-Desktop 界面动效，改完即时生效，并尊重系统减弱动态。 |
| **窗口材质** | 用轻薄 / 标准 / 厚重三档质感给界面加磨砂玻璃分层（侧栏、标题栏与弹层），可选一张背景图做底并支持五种填充方式，磨砂与底图各自独立开关。 |

四者在同一个面板里，通过左侧菜单的「插件市场 / 动效实验室 / AI 网关 / 窗口材质」切换；也可以分别用命令直接打开对应视图。

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

入场动画统一用 `animation-fill-mode: backwards`，**不用 `both`**：`both` 会保留最终帧，而最终帧里的 `transform` 会永久留在元素上，让宿主的 `position: fixed` 浮层（右键菜单、侧栏二级菜单）改以它为参照，位置就错了。因此根容器 `.app-shell` 与所有浮层（`[role="menu"]`、tooltip、popover）只做透明度淡入，不做位移；菜单项（`[role="menuitem"]`）也不参与“按下去 1px”。

四套预设：

- **敏捷**：时长约为基准的 0.78 倍，位移 0.8 倍。
- **平衡**：默认 token。
- **柔和**：时长约为基准的 1.18 倍，位移不增加。
- **减弱**：位移归零、缩放归一、持续动画停止，只保留 70–90ms 淡变。

速度滑杆只影响时长；强度滑杆只影响位移与缩放。面板分两张卡：左边调预设与两把滑杆，右边是外观基底、减弱动态开关和实时 token 读数。拖动滑块、切换预设或明暗基底后**自动生效**：面板先即时更新读数，再在 80ms 防抖后写入并应用宿主主题。连续拖动只提交最后一版参数，同步进行中的新改动会补发。
两把滑杆的范围是速度 0.60–1.60×、强度 50–150%（5% 一档）；1.00× 落在速度滑杆的 40% 处，因为区间两端并不对称。
明暗底色交叉淡变是**例外**：它固定 1.00×（160ms，减弱预设 90ms），不随速度与预设伸缩——换色属于系统级变化，跟着调慢只会让整个窗口显得迟钝。

状态点与标题栏显示「正在同步 / 实时应用已就绪 / 实时同步失败」。失败时参数保留在本地，调整任一选项即可重试。

插件只写**一个**运行时主题 `Motion Lab`，它的基底由上面那三档决定：

- **自动**：跟随系统外观（浅/深），面板打开或点它时读取系统真实值；
- **浅色 / 深色**：固定使用该基底，不再看系统。

“自动”要读系统的真实深浅。宿主会把 `nativeTheme.themeSource` 设成当前主题的基底，于是面板里的 `prefers-color-scheme` 只是在回显我们自己写进去的值。所以系统值改由插件进程直接读：Windows 查注册表 `AppsUseLightTheme`，macOS 读 `AppleInterfaceStyle`，Linux 读 `gsettings` 的 `color-scheme`。这只是一次几毫秒的读取，不动当前主题，因此打开面板不会再整窗换色闪一下。只有三种方式都读不到时（无 shell、未知桌面），才退回旧做法：把主题短暂交还宿主（`system`）、读一次、再接管回来——那一步会闪，所以只是兜底。拖滑杆不会重复测量。

同一时刻宿主里只会出现这一个 Motion Lab 主题，旧版本注册的 `Motion Lab · Light` / `Motion Lab · Dark` 会被自动移除。它只含动效规则，不覆盖任何 `--ds-*` 颜色 token。

## 窗口材质

给界面加一层磨砂玻璃：侧栏与标题栏改用半透明底色并模糊其后内容，菜单、对话框与弹出层用更强的模糊。开关和两档参数都在面板里，改完即时生效。开关只管"表面是否磨砂"，底图与内容区透视独立于它——关掉开关照片照样在，只是不再模糊。

| 参数 | 默认 | 说明 |
|---|---|---|
| 启用 | 关 | 只控制表面是否模糊；关掉时背景图仍然显示，表面保持清晰 |
| 质感 | 标准 | 轻薄 / 标准 / 厚重，决定模糊半径与底色不透明度 |
| 强度 | 100% | 60–160%，放大模糊与光场；底色随强度略微变厚，保证小字仍有底 |
| 背景图 | 无 | 选一张图片做玻璃背后的底；没有图时用柔光场。与开关无关，关着玻璃也照样显示 |
| 填充 | 拉伸填满 | 拉伸填满 / 等比适应 / 等比铺满 / 原始尺寸 / 等比不放大 |

三档质感对应的初始 token：

| 质感 | 模糊 | 弹层模糊 | 侧栏底色 | 标题栏底色 | 弹层底色 | 光场 | 有图时内容区 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 轻薄 | 16px | 22px | 72% | 58% | 76% | 16% | 62% |
| 标准 | 28px | 38px | 82% | 66% | 82% | 22% | 74% |
| 厚重 | 44px | 59px | 90% | 74% | 88% | 28% | 86% |

侧栏底色（`--pg-sidebar-alpha`）**刻意高于内容区**（`--pg-canvas-alpha`）。宿主自己给侧栏的是整块界面里最深的那个色（暗色 `--ds-bg-under` = `#000`，主框体 `--ds-bg-primary` = `#181818`），它只有在基本遮住背后的图时才仍然比主框体深。alpha 给低了，浅色照片会把侧栏冲亮到主框体亮度的两倍（实测 63–65 对 34–35），看上去像"侧栏才是浅的那个"。所以侧栏读的是 `--ds-bg-under`，且 alpha 高于内容区。

四条规则各自解决一个问题：

1. `.app-shell::before` 铺背景层：有背景图时就是那张图，没有时是一层柔光场。宿主界面底色是一整块纯色，半透明表面盖上去只能看到同一个颜色，`backdrop-filter` 也没有东西可模糊。`z-index:-1` 让它落在 `.app-shell` 自己背景之上、内容之下，不改动任何层级。
2. 侧栏（`.sidebar-surface` / `.sidebar-rail`）、右侧工作面板（`.work-panel`）都用半透明底色加模糊：它们各自铺的是宿主的 `--ds-bg-under` / `--ds-bg-dock`，换成同色但带 alpha 的混色后，背后的图或光场就透出来了。侧栏额外复用宿主写给 macOS 的两支 sheen 变量（`--ds-sidebar-glass-sheen-top` / `-bottom`）做顶部高光。

   窗口标题栏 `.main-titlebar`、会话顶部条 `.conversation-topbar`、右上角窗口按钮区 `.window-controls` 与工作面板表头 `.work-panel-header` 共用同一条 `chromeFill` 规则：同一份半透明底色与底部分隔线，且**都不加 `backdrop-filter`**。原因是模糊取样的是各自背后的内容——同一条 46px 高度上，左边是侧栏玻璃、中间是主内容区、右边是侧工作面板，三者不同，分别磨砂就会得到三种颜色（实测 0.21.0 / 2120px：窗口按钮区 rgb(17,52,62)，旁边面板表头 rgb(20,43,52)）。去掉滤镜后四处实测同为 rgb(24,24,24)。工作面板顶部的工具栏区域不再铺 `--ds-bg-dock` 深色底层，面板自身也不再加模糊。


   模糊只加在这几个"界面家具"上：宿主的所有浮层（右键菜单、二级菜单、通知、用量气泡等）都 portal 到 `document.body`，不是它们的后代，所以 `backdrop-filter` 不会把那些弹层重新锚定。
3. 内容区（`.main-pane`）只改底色不透明度，不加滤镜——它里面有 composer 等固定层，加 `backdrop-filter` 会改变它们的包含块。没有背景图时这一项是 100%，等于不改。
4. 菜单、对话框、弹出层用更强的模糊——这是唯一"真正磨砂"的地方：它们本来就浮在活动内容之上，模糊在做事而不是在装饰颜色。

### 背景图

选一张图片做玻璃背后的底。图片**不是**内联进 CSS 的：

1. 面板用 `<input type="file">` 读出字节。渲染进程拿不到文件路径（Electron 已移除 `File.path`），所以按 base64 交给插件进程。
2. 插件把它写进自己的数据目录：`~/.pi-desktop/plugins/data/local.piopt/wallpaper.<ext>`，同一时间只保留一张。
3. 主题 CSS 里写的是**绝对路径** `url("C:/…/wallpaper.png")`。宿主在 `themes.upsert` 时校验扩展名与 4 MB 上限，再把它重写成 `plugin-asset://…` 注入窗口。

这样 256 KB 的主题 CSS 预算完全不受图片大小影响，图片上限就是宿主自己的 4 MB 资源上限。

| 界面上的名字 | 内部值 | CSS | 行为 |
|---|---|---|---|
| 拉伸填满 | `fill` | `background-size:100% 100%` | 铺满整个窗口，比例会变形 |
| 等比适应 | `contain` | `contain` + 居中 | 整张图完整显示 |
| 等比铺满 | `cover` | `cover` + 居中 | 铺满窗口，超出部分裁切 |
| 原始尺寸 | `none` | `auto` + 居中 | 按图片原始像素显示，超出裁切 |
| 等比不放大 | `scale-down` | 限宽高的盒子 + `contain` | 缩小到放得下，但不放大 |


`scale-down` 是唯一 CSS 表达不了的：`background-size` 读不到图片的自然尺寸。所以插件读图时顺手从文件头解析宽高（PNG 的 IHDR、JPEG 的 SOF、WebP 的 VP8/VP8L/VP8X、SVG 的 `width` 或 `viewBox`），把 `::before` 的盒子压到 `min(100%, 自然尺寸)` 再用 `inset` + `margin: auto` 居中（不用 `transform`），最后由 `contain` 填满这个盒子——等价于 `object-fit: scale-down`。读不到尺寸时（AVIF）退回 `contain`：会放大，但不会错位。

图片上还压着一层 `--pg-scrim`（轻薄 12% / 标准 20% / 厚重 28%）。压暗做在背景图层里，而不是靠表面的 `background-color`：实测同一次渲染里，侧栏上半段叠上了底色、下半段没有——`background-color` 与 `backdrop-filter` 的合成顺序在分块边界上并不稳定。把压暗放进图层之后，不管哪个表面透出来，看到的都是同一个亮度。

背景图的显示与开关**无关**。开关只决定表面是否磨砂（`backdrop-filter` 与半透明底色），底图、内容区透视与表面不透明度由"有没有图"决定：无图且关掉玻璃时生成器直接返回空字符串，界面与原来逐像素一致。所以关掉玻璃时，照片仍铺在整个窗口底下，内容区仍是半透明的，只是表面不模糊了。用 400×300 的测试图在 1828×1216 的窗口里实测（玻璃关闭）：

- `fill`：窗口左边缘就是图片的蓝色；
- `scale-down`：左右各留约 104px 露出光场，图片居中。

图片被删除或移动后，插件在加载时和每次 `glass.getState` 都会发现，并清掉这个引用——留着它会让 `themes.upsert` 直接失败，连带动效层一起掉。

### 平台限制：插件不能让窗口透出桌面

PI-Desktop 在 Windows 11 上以**不透明窗口**运行，插件改不了这一点：

- 宿主创建窗口时用 `transparent: false` 换取 DWM 原生圆角，而 `transparent` 是 `BrowserWindow` 的构造参数，建好之后无法更改。`setBackgroundColor` 在非透明窗口上忽略 alpha，宿主还额外用 `toOpaqueElectronBackgroundColor` 把 alpha 混掉。
- 窗口上的 `DWMWA_SYSTEMBACKDROP_TYPE` 其实已经是 `2`（Mica），`WS_EX_NOREDIRECTIONBITMAP` 也已设置——Mica 层一直都在，只是被 Chromium 的不透明合成层整个遮住。
- 实测（0.21.0 / Windows 11 26H2，build 26300）：用 `renderer.extension` 把 `html`、`body`、`#root`、`.app-shell`、`.main-pane`、`.sidebar-surface` 全部改成透明，侧栏的纯黑确实消失，但露出来的是 Chromium 不透明根层的默认深色 `#121212`，不是桌面壁纸。

所以这一节做的是**窗口内的磨砂分层**：玻璃背后是上面那层柔光场，不是桌面或其它窗口。要真正透出桌面只能改宿主、把窗口建成透明窗口，那已经超出插件边界，而且每次升级 PI-Desktop 都要重打。

### 为什么玻璃跟着动效主题走

`pi.themes.upsert` 是插件往宿主窗口注入样式的唯一通道（`renderer.extension` 只能改自己挂的那几个节点，不能当样式表用）。所以玻璃规则和动效规则写在同一个 `Motion Lab` 主题里，由 `features/motion/index.js` 拼接、`features/glass/glass.js` 生成：

```js
const css = `${motion.buildThemeCss(config, base)}${await readGlassCss()}`;
```

这意味着**玻璃需要 PI-Desktop 选中 `Motion Lab` 主题**才生效；切到别的主题时玻璃一并消失，但开关状态存在插件设置里，切回来就恢复。两个功能不互相 import：`main.js` 把 `motion.refreshTheme` 交给 `glass.bindTheme`，玻璃改动后由它重新注册一次主题（CSS 没变时宿主不会重绘）。

玻璃层只用 `--pg-*` 变量，不重定义任何 `--ds-*` 颜色 token，也不使用 `transform`——`transform` 与 `backdrop-filter` 都会让元素成为 `position: fixed` 后代的包含块。这条约束由 `test/glass.test.js` 守住，且只检查**属性声明**、不检查注释：注释里讨论 `transform` 是正常的事，不该让散文触发一条关于行为的规则（测试会先剥掉 `/* … */` 再匹配 `transform:`）。

这条规矩背后是实测踩过的坑。宿主**把二级菜单嵌在父菜单内部**（`.sidebar-submenu` 是 `.sidebar-floating-menu` 的子元素），两级的坐标都由 JS 从 `getBoundingClientRect` / `innerWidth` / `innerHeight` 算出来，是**视口坐标**。所以只要给父菜单加了 `backdrop-filter`，子菜单的 `top`/`left` 就不再相对视口，而是相对父菜单——表现为二级菜单“被关在上一级窗口里出不来”。弹层因此只上底色、不上模糊。

侧栏、标题栏、`.work-panel` 上的模糊是安全的：它们的 `position: fixed` 后代不会是宿主浮层，浮层虽嵌在父菜单里，但父菜单本身不带模糊。

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
| `PiOpt: 打开窗口材质` | 打开面板，进入窗口材质视图 |

面板左侧菜单最上方有一个展开/收起按钮：收起时只显示图标，展开后菜单加宽并写出「插件市场」「动效实验室」「AI 网关」「窗口材质」四个名字，选择记在面板本地，下次打开保持。菜单里点一下或 `Alt+1` / `Alt+2` / `Alt+3` / `Alt+4` 都能切换视图。
切换时选中指示条在两项之间滑过去（160ms），新视图淡入并从下方 4px 归位；系统开启「减少动态效果」时两者都关掉。

## 权限与边界

声明：`ui.panel`、`renderer.extension`、`ui.theme`、`clipboard.write`、`net.fetch`、`agent.tool.register`、`agent.prompt.inject`。

| `Pimarket: 准备全部可用更新` | 打开面板并串行准备所有可用更新 |

- 只写自己的数据目录：`~/.pi-desktop/plugins/data/local.piopt/`（市场可在设置里改）。
- 市场功能不安装、不卸载、不启用/禁用、不改 `registry.json`、不启动任何进程。
- 下载只允许 `https`，主机硬编码为 `cdn.jsdelivr.net`、`raw.githubusercontent.com`、`api.github.com`、`plugins.aiuo.net`，每一次重定向都按同一白名单复核；单包上限 50 MB。
- 内置文件是 HTML 的响应按 `SERVER_HTML` 丢弃，绝不当作包。
- 动效与窗口材质共用一个运行时主题：CSS 里只有动效规则与玻璃层（背景填充、渐变、`backdrop-filter`），不含颜色 token、不访问网络与文件；`ui.theme` 只用于这一个 `Motion Lab` 主题（基底随设定切换）。
- `agent.prompt.inject` 只用于收录 `skills/piopt.md`（按需加载），不会自动往消息里注入内容。
- `renderer.extension` 只用于一个渲染模块：在宿主窗口左下角的按钮栏里挂一个入口按钮，点击经 `plugin.call` 交回插件进程打开面板；不读文件、不访问网络、不改动其他插件的界面，卸载时移除自己挂的东西。

### 主题互斥

PI-Desktop 一次只能选择一个主题，动画层不能叠加在另一个第三方主题上。应用动效实验室会切换到匹配的宿主 Light/Dark 基底再附加动效规则，原先选中的第三方主题不会继续生效。

工作面板、浏览器等原生 `WebContentsView` 有独立渲染进程，主题 CSS 无法跨文档控制其内部动画。

## 结构

```text
PiOpt/
├─ manifest.json            统一清单：6 条命令、5 个 agent 工具、7 项权限
├─ main.js                  组装四个功能，按通道前缀路由面板 RPC
├─ features/
│  ├─ market/               市场功能
│  │  ├─ index.js           面板 RPC、命令、agent 工具、任务表
│  │  ├─ core.js            路径、semver、registry/catalog 读取、失败分类
│  │  ├─ downloader.js      四源候选、重试、流式 sha256、探测
│  │  └─ permissions.js     权限中文名、说明与风险分级
│  ├─ motion/               动效功能
│  │  ├─ index.js           生命周期、运行时主题注册、面板 RPC
│  │  └─ motion.js          预设、token、主题 CSS 生成器
│  ├─ glass/                窗口材质
│  │  ├─ index.js           生命周期、设置读写、面板 RPC
│  │  └─ glass.js           玻璃预设、token 与玻璃 CSS 生成器
│  └─ gateway/              AI 网关控制
│     └─ index.js           进程探测、重启、日志、面板 RPC
├─ renderer/
│  ├─ index.html            外壳 + 四个功能视图
│  ├─ tokens.css            共享设计 token
│  ├─ base.css              外壳布局与产品栏
│  ├─ market.css            市场视图样式（@scope 隔离）
│  ├─ motion.css            动效视图样式（@scope 隔离）
│  ├─ glass.css             材质视图样式（@scope 隔离）
│  ├─ gateway.css           网关视图样式（@scope 隔离）
│  ├─ market.js             市场视图逻辑
│  ├─ motion.js             动效视图逻辑
│  ├─ glass.js              材质视图逻辑
│  ├─ gateway.js            网关视图逻辑
│  ├─ shell.js              视图切换与按需启动（Alt+1…4）
│  └─ entry.mjs             宿主窗口侧边栏的入口按钮（renderer.extension）
├─ skills/piopt.md          Agent 使用规则
└─ test/                    结构、动效模型与玻璃层测试
```

四个功能互不调用：面板通道按 `market.` / `motion.` / `glass.` / `gateway.` 前缀分发，各自的设置、状态与失败处理相互独立。唯一的协作是玻璃层随动效主题下发，由 `main.js` 把两者接上。

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
