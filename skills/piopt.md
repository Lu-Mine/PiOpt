---
name: PiOpt control console
description: The user asks to update, reinstall or download a PI-Desktop plugin, hits a plugin install failure such as PLUGIN_INTEGRITY or a 1626-byte HTML package, wants to tune PI-Desktop interface motion and animation presets, or asks for frosted glass, Mica, translucency or a window material on the interface.
---

# PiOpt

PiOpt bundles four features in one plugin:

- **插件市场 (market)** — the download-and-verify half of a plugin update.
  Installing stays a user action in the Plugins page.
- **动效实验室 (motion)** — restrained interface motion presets.
- **窗口材质 (glass)** — an optional frosted-glass layer over the shell's own
  surfaces, carried by the same runtime theme as motion.
- **AI 网关 (gateway)** — status, restart and logs for the local AI gateway.

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

## Motion: when to use

- The user finds PI-Desktop animations too slow, too bouncy, too subtle, or
  wants them reduced.
- The user asks for a calmer or snappier interface, or wants motion stopped.

### Motion rules

1. There is no Agent tool for motion. Direct the user to the panel
   (**PiOpt → 动效实验室**) or the command `PiOpt: 打开动效实验室`.
2. Settings apply live: the panel writes on change, about one debounce frame
   after the last input. Do not tell the user to press an "apply" button.
3. Applying Motion Lab replaces the currently selected theme. PI-Desktop themes
   are mutually exclusive, so never promise that it stacks on another theme.
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
   (**PiOpt → 窗口材质**), the command `PiOpt: 打开窗口材质`, or `Alt+4`.
2. Never promise that the window shows the desktop. PI-Desktop builds its main
   window opaque on Windows 11 — `transparent: false` is what buys it native
   rounded corners, and `transparent` is a BrowserWindow construction flag that
   cannot be changed afterwards. A plugin makes glass *inside* the window, over
   a soft light field; the Mica backdrop the window already carries stays
   covered by the compositor. Say that plainly instead of calling it Windows
   Mica.
3. The layer rides the one `Motion Lab` runtime theme, so it only exists while
   PI-Desktop has that theme selected. Switching to another theme removes the
   glass; the stored on/off setting survives and comes back with the theme.
   The surfaces it covers are the left sidebar, the right work panel body, and
   three chrome bars that share one recipe: `.main-titlebar`,
   `.conversation-topbar` and `.work-panel-header`. That last one carries the
   work panel's tab list (浏览器 / 审阅 / 侧边聊天) — those tabs paint no fill of
   their own, so the header's material *is* the tab row's material. Keep all
   three on the same token and alpha; giving them merely similar values is what
   makes one of them look off. Blur is safe on all of them because the host
   portals every popup (context menu, submenus, notifications, usage popovers)
   to `document.body`, so none of them is a descendant whose `position: fixed`
   would re-anchor against the blurred panel.
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
   missing or moved file is dropped on load and on `glass.getState`, because a
   dead reference makes `themes.upsert` fail and takes the motion layer with it.
