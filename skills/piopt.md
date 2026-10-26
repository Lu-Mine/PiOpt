---
name: PiOpt control console
description: The user asks to update, reinstall or download a PI-Desktop plugin, hits a plugin install failure such as PLUGIN_INTEGRITY or a 1626-byte HTML package, or wants to tune PI-Desktop interface motion and animation presets.
---

# PiOpt

PiOpt bundles two features in one plugin:

- **插件市场 (market)** — the download-and-verify half of a plugin update.
  Installing stays a user action in the Plugins page.
- **动效实验室 (motion)** — restrained interface motion presets registered as
  two runtime themes.

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
