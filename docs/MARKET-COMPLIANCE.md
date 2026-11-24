# 上架合规说明

面向 PI-Desktop 官方插件目录（`plugins.aiuo.net`）的审查：这个插件声明了什么、实际做了什么、边界在哪里。每条都能在仓库里点开对应文件核对，不引用外部文档。

## 1. 基本信息

| 项 | 值 |
|---|---|
| 插件 ID | `pi.piopt`（更早的公开条目 `local.piopt` 已归档，本条目是替代它的 2.0.0） |
| 名称 | PiOpt（面板标题 `PiOpt 控制台`） |
| 版本 | 2.0.0 |
| 许可 | MIT（内置 `lobe-icons` 与 `WebWallGL` 遵循各自附带的 MIT 许可） |
| 源码仓库 | `https://github.com/Lu-Mine/PiOpt`，发布 tag 即目录里的 source pin |
| 最低宿主 | `>=0.21.0` |
| 包 | store-only zip（`.piplug`），由官方 `pi-plugin pack` 生成，无 `node_modules`、无 `.git`、无符号链接 |
| 面板 | `renderer/index.html`，1180×800，四个视图共用一页 |
| 宿主窗口模块 | `renderer/entry.mjs`（`renderer.extension`） |

功能面向用户的能力见 [README](../README.md)，实现细节见 [ARCHITECTURE](ARCHITECTURE.md)。

## 2. 权限逐条

| 权限 | 声明原因 | 实际调用点 | 边界 |
|---|---|---|---|
| `ui.panel` | 控制台需要一个面板窗口 | `pi.ui.openPanel`（`main.js`） | 只有 `renderer/index.html` 这一个面板 |
| `renderer.extension` | 侧栏控制台入口、聊天框模型浮窗、动效克隆、壁纸层都在宿主窗口里 | `renderer/entry.mjs`、`renderer/model-picker.mjs`、`renderer/motion-runtime.mjs`、`renderer/wallpaper-runtime.mjs` | 只回应 `plugin.call`（见 `rendererCallMethods` 白名单）；模块自身不读文件、不发网络请求 |
| `ui.theme` | 界面动效与窗口材质必须写成一张运行时主题 | `pi.themes.upsert` / `remove`（`features/appearance`） | 只注册 `PiOpt Appearance` 一张主题；不含颜色 token；主题 CSS 不含外链资源 |
| `clipboard.write` | 复制已下载插件包的路径 | `pi.clipboard.writeText`（`features/market/index.js`） | 只写用户点「复制路径」时那一个字符串 |
| `net.fetch` | 读取官方目录、镜像元数据 | 宿主网关未被使用；实际出站走插件进程的 `node:https`（`features/market/downloader.js`） | 四个硬编码主机（见 §3），重定向逐跳复核白名单 |
| `shell.openExternal` | 打开插件主页/发布页、打开下载目录、用系统程序打开会话文件 | `features/market/index.js`、`features/open-output.js` | 只开 `https` 链接与自己数据目录下的目录；文件打开见 §5 白名单 |
| `agent.tool.register` | 四个工具：`list_plugin_updates`、`prepare_plugin_update`、`remote_status`、`remote_control` | `features/market/index.js`、`features/remote/index.js` | 前两个只读 + 下载校验；后两个只开关本机网关与换配对码 |
| `agent.prompt.inject` | 让 Agent 按需加载 `skills/piopt.md` | manifest `contributes.skills` | 不主动往任何对话注入内容 |
| `desktop.control` | 远程网关要列会话、读一条会话、发指令、中止 | `pi.desktop.invoke`：`session/list`、`session/get`、`session/create`、`session/fork`、`agent/prompt`、`agent/abort`、`agent/getStatus`、`agent/pendingInteractive`、`plans/pending`、`project/list` | 不调用任何 `dangerous` 操作：不批准权限、不批准计划、不删除、不改名、不切项目 |
| `session.read` | 会话列表需要标题与项目，正文需要读该会话自己的 `.jsonl` | `session/list`、`session/get`；`features/remote/index.js` 读 `<id>.jsonl` 尾部 256 KB | 只读；按文件大小缓存，增量解析；不写、不导出、不上传 |

没有 `fs.*` 权限：`manifest.permissions` 里不含任何 `fs.` 项（`test/piopt.test.js` 对此有断言）。文件访问都发生在插件进程内，路径见 §4、§5。

## 3. 网络出口

`manifest.net.domains` 与代码里的白名单是同一张表，`test/piopt.test.js` 对整张表做等值断言，改动会失败。

| 主机 | 用途 | 校验 |
|---|---|---|
| `plugins.aiuo.net` | 官方市场目录 `catalog.json` | 只当 JSON 读，返回 HTML 时按 `SERVER_HTML` 丢弃 |
| `cdn.jsdelivr.net` | 包镜像（首选通道） | 流式下载并同时算 sha256，与目录 `shasum` 比对 |
| `raw.githubusercontent.com` | 包镜像（次选） | 同上；短读视为链路失败 |
| `api.github.com` | GitHub Blobs API 取包、GitHub 内容 API 元数据 | 同上 |

- 只允许 `https`；`http`、非白名单主机、超过 5 跳的重定向一律拒绝（`features/market/downloader.js` 的 `openStream`）。
- 单包上限 50 MB；响应前 1 KB 做 HTML 嗅探；`content-length` 与实际字节不一致按链路断开处理，不保存半截文件。
- 没有任何遥测、统计上报、崩溃上报或「匿名使用数据」。

## 4. 插件自己写的位置

只在 `~/.pi-desktop/plugins/data/pi.piopt/` 下（由宿主分配，自更新类操作不可越界）：

| 文件 | 内容 | 何时写 |
|---|---|---|
| `settings.json` | 插件设置 | 宿主代为写入 |
| `wallpaper.<ext>` | 用户选的背景图（原始字节） | 用户在面板选图时 |
| `wallpaper.engine-<id>.jpg` | Wallpaper Engine 项目封面缩略图 | 选择壁纸项目时 |
| `scene-payload-<id>.js` | 一个 `scene.pkg` 转成的 base64 载荷，只留最近一份 | 选择 scene 壁纸时 |
| `engine-status.json` / `engine-stats.json` | 渲染状态与实测帧率（渲染进程回报，用于面板显示） | 运行时 |
| `remote-devices.json` | 已配对设备令牌（原子写：临时文件 + 重命名） | 配对新设备/撤销时 |
| `downloads/<id>-<version>.piplug` | 下载并校验通过的插件包 | 用户点「准备/下载」时 |

## 5. 只读访问与系统命令

| 路径 / 命令 | 用途 | 说明 |
|---|---|---|
| `~/.pi-desktop/plugins/registry.json` | 读已装插件列表 | 只读，从不写；安装始终由用户在 Plugins 页面完成 |
| `~/.pi-desktop/plugins/market/catalog.json` | 宿主缓存的官方目录 | 只读；插件自己刷新时写自己的数据目录 |
| `~/.pi-desktop/sessions/<id>.jsonl` | 远程页面显示对话正文 | 只读尾部 256 KB，按文件大小缓存；不写、不导出 |
| `<Steam 库>/steamapps/workshop/content/431960/` | 列 Wallpaper Engine 项目、读 `project.json` 与方形封面 | 只读；`scene.pkg` 只读一次 |
| `reg query`（Windows）、`defaults read`（macOS）、`gsettings get`（Linux） | 读系统浅/深色偏好，避免切回 `system` 时闪屏 | 只读，2 秒超时，`windowsHide` |
| `powershell.exe -EncodedCommand` + `Start-Process`（Windows）、`open` / `xdg-open` | 用系统默认程序打开**当前会话临时目录或当前项目目录内**的白名单文件 | 扩展名白名单（`.pdf .txt .md .csv .json .png .jpg .mp4 …` 共 30 项）；先 `realpath` 再校验包含关系，拒绝越界与可执行文件；路径经 base64 传入，不拼进 PowerShell 语法 |

## 6. 明确不做的事

- 不安装、不卸载、不启用/禁用任何插件，不写 `registry.json`。市场功能只下载 + 校验 + 告知路径。
- 不打开危险审批：`agent/askTool/resolve`、`tool/resolvePermission`、`plans/resolve` 一律不调（远程页面只能看到「等你回答」，不能替用户点）。
- 不收集、不发送任何用户数据；不含账号、密钥、令牌；代码里没有硬编码凭据。
- 不加载远程代码：面板没有外链 `<script>` / `<link>`，主题 CSS 只有背景填充与 `backdrop-filter`。
- 不常驻后台进程：远程网关只在用户打开开关时监听，卸载或关开关即停止。

## 7. 已知攻击面与缓解

| 面 | 缓解 |
|---|---|
| 局域网 HTTP 服务（`features/remote/server.js`） | 只由用户开关启动；除页面外所有接口校验设备令牌；配对码 6 位、按来源地址限速（1 分钟 5 次）；`Origin` 仅允许本机；令牌以原子写保存在插件数据目录；不开放任何审批操作 |
| 改写宿主 DOM（模型浮窗、侧栏入口、动效克隆） | 只克隆/隐藏宿主节点，不搬动 React 真实节点；不触碰其他插件的界面；卸载时全部还原 |
| 壁纸渲染 | `video` 由宿主的 `<video>` 解码；`scene` 由随包分发的 WebWallGL（MIT）在 WebGL2 里渲染，30 fps，窗口隐藏或系统要求减弱动态时暂停 |
| 打包产物里的 `new Function` | 只出现在 `renderer/vendor/webwallgl.mjs`（上游引擎用 `new Function` 编译 Wallpaper Engine 的 SceneScript）。宿主 CSP 不含 `'unsafe-eval'`，且挂载时显式传 `scripts: false`，该分支在本插件里不会执行；它不处理本插件自己的任何代码 |
| 市场下载 | 见 §3：固定主机、重定向复核、大小与 sha256 双向校验、HTML 丢弃、失败即删 |

## 8. 打包与体积

- 由官方 devkit `pack` 生成 store-only zip，安装器接受的正是这个形状；仓库里没有自建 zip 脚本。
- 实测（`v1.1.2` tag 打包）：99 个文件 / 约 2.4 MB，远低于 2000 文件 / 50 MB 的上限。
- 约 1.1 MB 的 `renderer/vendor/webwallgl.mjs` 是最大的单个文件，为 scene 壁纸的渲染引擎（MIT，附 `LICENSE-webwallgl.txt`）。

## 9. 版本与发布

- 版本以 `manifest.json` 为准，规则见 [VERSIONING](../VERSIONING.md)；发布 tag 与清单版本一致（`v2.0.0` ↔ `2.0.0`），CI 校验后调用官方 packer 打包并上传到 Release。
- 目录里的 source pin 就是这个 tag 对应的 commit；每个版本在目录中记录 `permissions`、`minPiDesktop`、`shasum`、`sizeBytes`。
