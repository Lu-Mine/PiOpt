---
name: PiOpt control console
description: The user asks to update, reinstall or download a PI-Desktop plugin, hits a plugin install failure such as PLUGIN_INTEGRITY or a 1626-byte HTML package, wants to tune PI-Desktop interface motion and animation presets, or asks for frosted glass, Mica, translucency or a window material on the interface.
---

# PiOpt

PiOpt bundles three features in one plugin:

- **插件市场 (market)** — the download-and-verify half of a plugin update.
  Installing stays a user action in the Plugins page.
- **外观 (appearance)** — how the window looks, in one view with two sections:
  **界面动效** (a master switch, a kill-all-animations switch, and strength /
  speed sliders) and **窗口材质** (an optional frosted-glass layer, a wallpaper
  with a recent list). They are one feature because they write one runtime
  theme; the view is one page, the sections are not separate panels. Each
  section has a 重置 button with a confirm step.
- **AI 网关 (gateway)** — one page in three sections (连接 / 上游 / 用量) under a
  pinned status bar: what both local panels expose and how to reach them, which
  accounts and credentials feed them, and how much has actually been used.

## Gateway: what the page does, and what it refuses to fake

- 连接: CLIProxyAPI (`:8317/management.html`) and wb2api (`:8318`) each get an
  "打开面板" button that hands the loopback URL to `shell.openExternal`; the
  plugin never embeds either UI, so their own logins keep working.
- 凭据全自动，页面上没有任何账号/口令填空：CLIProxyAPI 直接读本机
  `config.yaml` 的 `management.secret-key`；wb2api 用面板默认口令自动登录，
  401 时再试历史保存的那个。密钥从不写入页面、日志或截图；读不到就如实显示
  「缺少管理密钥」，不伪造成功，也不要让用户去填。
- API Key 的备注名只存在本插件设置里（按密钥 sha256 前 16 位索引），不写回
  CLIProxyAPI 配置；添加与删除是直接 PUT 整个 `access.api-keys` 数组。
- 用量: Antigravity 的三个分类（Gemini / Claude·GPT / Argon 4）来自
  `retrieveUserQuotaSummary`，取不到就显示「暂无配额数据」，绝不以 0% 冒充；
  wb2api 号池条把「剩余 / 总额」与「已使用」分色画在同一条上。
- 看板只读 wb2api 的 `/usage/*`：今日 / 近 3 日 / 本周 / 本月 / 近 30 天 /
  近一年。图表是原生 SVG，不引入图表库。
- 状态条常驻页面顶端（sticky），刷新与重启网关都在那里；网关进程、日志工具
  与重启语义保持不变。
- Clash 出海通道、积分自动化触发、独立模型页已从界面与代码中删除，不要给
  用户"其实还能用"的印象。

## Market: when to use

- The user wants to update an installed plugin, or reinstall one whose files
  are damaged.
- An install fails with `PLUGIN_INTEGRITY`, `PLUGIN_NETWORK`, or "package is
  1626 bytes" — that is the server answering with HTML, not a broken package.
- The user asks what updates exist.

### Market tools

- `list_plugin_updates` — installed plugins with a newer non-yanked catalog
  version, plus size, sha256 and changelog. Pass `includeInstalled: true` to see
  every installed plugin.
- `prepare_plugin_update` — takes `id` and an optional `version`. Downloads into
  the plugin's data folder, verifies `sizeBytes` and `sha256`, and returns the
  absolute `.piplug` path.

### Market rules

1. Report the returned `path` verbatim and tell the user to use
   Plugins → Install plugin package. Never say a plugin is installed or updated:
   this plugin cannot install.
2. Quote the original error text from `attempts`. Do not compress
   `SERVER_HTML`, `LINK_RESET`, `MIRROR_404` and `INTEGRITY` into "download
   failed" — they have different causes and different remedies.
3. Do not retry the same source in a loop. `jsDelivr` is the reliable channel
   here; `raw.githubusercontent.com` drops large transfers; `plugins.aiuo.net`
   serves its SPA for package paths; `cnb.cool` has no packages at all.
4. A hash mismatch is a real problem: do not offer the mismatched file, and do
   not claim the catalog is wrong without evidence.
5. Never edit `registry.json`, and never copy a package into
   `plugins/installed/` to fake an install.

## Appearance: where the two sections live

The view is **PiOpt → 外观** (one rail row, `Alt+2`). Two commands open it on a
section: `PiOpt: 打开外观` lands on 界面动效, `PiOpt: 打开窗口材质` scrolls to
窗口材质. Panel channels are `appearance.motion.*` and `appearance.glass.*`; the
older `motion.*` / `glass.*` names still answer, so an older guide is not wrong
about the calls, only about the prefix.

## Motion: when to use

- The user finds PI-Desktop animations too slow, too bouncy, too subtle, or
  wants them reduced.
- The user asks for a calmer or snappier interface, or wants motion stopped.

### Motion rules

1. There is no Agent tool for motion. Direct the user to the panel
   (**PiOpt → 外观 → 界面动效**) or the command `PiOpt: 打开外观`.
2. Settings apply live: the panel writes on change, about one debounce frame
   after the last input. Do not tell the user to press an "apply" button.
3. Applying appearance settings replaces the currently selected theme.
   PI-Desktop themes are mutually exclusive, so never promise that motion or the
   material stacks on another theme — touching either section switches to the
   `PiOpt Appearance` theme.
4. The four presets are 敏捷 / 平衡 / 柔和 / 减弱. 减弱 removes spatial movement
   and stops continuous animation; do not describe it as "slower motion".
5. Never claim motion is applied to plugin panels, the terminal or browser
   views: those are separate documents that theme CSS cannot reach.

## Glass: when to use

- The user asks for Windows 11 Mica / acrylic / frosted glass, a translucent
  window, or for the interface to show what is behind it.
- The user wants the glass layer turned on or off, or wants it lighter or
  heavier.

### Glass rules

1. There is no Agent tool for glass. Direct the user to the panel
   (**PiOpt → 外观 → 窗口材质**) or the command `PiOpt: 打开窗口材质` (it
   scrolls to that section), or `Alt+2` then scroll.
2. Never promise that the window shows the desktop. PI-Desktop builds its main
   window opaque on Windows 11 — `transparent: false` is what buys it native
   rounded corners, and `transparent` is a BrowserWindow construction flag that
   cannot be changed afterwards. A plugin makes glass *inside* the window, over
   a soft light field; the Mica backdrop the window already carries stays
   covered by the compositor. Say that plainly instead of calling it Windows
   Mica.
3. The layer rides the one `PiOpt Appearance` runtime theme — the same sheet
   the motion rules live in — so it only exists while PI-Desktop has that theme
   selected. Switching to another theme removes the
   glass; the stored on/off setting survives and comes back with the theme.
   The surfaces it covers are the left sidebar, the right work panel body and
   the chrome bars. Three chrome surfaces share one recipe via the `chromeFill`
   string, emitted into a single selector rule: `.main-titlebar`,
   `.conversation-topbar` and `.window-controls`. Not copies — a copy is how
   they drift apart.
   `.window-controls` is the minimise / maximise / close strip: the host gives
   it a `position: fixed` solid block and even swaps it to
   `--ds-bg-dock-raised` whenever a work panel is open, which is exactly why
   that corner used to read as a different material from the bar beside it.
   `.work-panel-header` is NOT in that list: it sits on the panel's own glass,
   and a second translucent fill in the same 46px made a doubled, muddier strip
   (light theme: rgb(238,246,255) stacked against rgb(210,226,251) for the panel
   body, with the seam plainly visible). The header now paints only the hairline
   and lets the panel's single frosted layer show through; while a panel is open
   `.window-controls` steps aside the same way, so the whole right column is one
   continuous glass. With no panel open the base chromeFill still applies.
   That layer lives on `.work-panel::before`, never on `.work-panel`: an element
   with a backdrop-filter is a Backdrop Root, so a descendant's blur would see
   only what is painted inside it instead of the photo.
   For the same Backdrop Root reason, no ancestor of a frosted surface may
   animate `opacity` (`opacity < 1` cuts off descendant `backdrop-filter` until
   the animation finishes): `.app-shell` and `.main-pane` do not animate, their
   inner `.chat-surface` / `.route-page` / `.settings-content` do, and the
   sidebar and work panel keyframes (including the `sidebar-in-pm` /
   `work-panel-out-pm` overrides for the host's own enter/exit rules) slide and
   resize without touching `opacity`.
   This protection must also exist when motion is off. Otherwise the host's
   `work-panel-in ... both` retains an opacity effect after its 1ms run and
   becomes a permanent Backdrop Root, bringing the colour mismatch back even
   at rest. Glass therefore disables that entry and supplies an opacity-free
   `work-panel-out-glass` exit independently of the motion switches.
   Blur is safe on all of them because the host portals every popup (context
   Never put a blur filter on a menu. The host nests its context submenu inside
   the parent menu (`sidebar-submenu` lives inside `sidebar-floating-menu`) and
   positions both from `getBoundingClientRect` / `innerWidth` / `innerHeight`,
   i.e. viewport coordinates. A blur — like a transform — makes the parent the
   containing block for that fixed child, so the submenu resolves those numbers
   against the parent and appears trapped inside the menu that opened it.
   Popups therefore get the translucent fill only, never the frosting.
   The blur on the sidebar, the title bars and `work-panel::before` is safe: none of
   them is the parent of a host popup.
   The "no transform" rule in `test/glass.test.js` checks property declarations
   only (comments are stripped first). Prose may say `transform` — the rule is
   about behaviour, not vocabulary.
4. Settings apply live, about one debounce frame after the last input. Do not
   tell the user to press an apply button.
5. 轻薄 / 标准 / 厚重 are glass recipes, not motion presets. The switch only
   decides whether the surfaces are frosted (`backdrop-filter` plus translucent
   fills). With no wallpaper and the switch off the generator returns an empty
   string, so the interface is pixel-identical to the stock one — that is also
   the honest answer to "did it work?" when nothing is visible on a dark theme.
6. A wallpaper is uploaded from the panel, stored in the plugin data folder,
   and referenced by absolute path; the host rewrites that to a
   `plugin-asset:` URL with a 4 MB ceiling. Five fill modes, labelled in Chinese
   in the panel: 拉伸填满 (fill), 等比适应 (contain), 等比铺满 (cover),
   原始尺寸 (none), 等比不放大 (scale-down). The photo is independent of the
   switch: it stays visible with the glass off, only the frosting goes away. A
   missing or moved file is dropped on load and on
   `appearance.glass.getState`, because a dead reference makes `themes.upsert`
   fail and takes the motion layer with it. Resetting the material keeps the
   photo: it is the user's own file, not part of the recipe.
