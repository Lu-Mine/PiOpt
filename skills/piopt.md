---
name: PiOpt control console
description: The user asks to update, reinstall or download a PI-Desktop plugin, hits a plugin install failure such as PLUGIN_INTEGRITY or a 1626-byte HTML package, wants to tune PI-Desktop interface motion and animation presets, or asks for frosted glass, Mica, translucency or a window material on the interface, or wants to drive PI-Desktop from a phone, tablet or another computer on the same Wi-Fi.
---

# PiOpt

PiOpt bundles four rows in one plugin, in this order: 外观 / 行为 /
插件市场 / 远程 (rail rows, `Alt+1` to `Alt+4`). Only 远程 has Agent tools
(`remote_status`, `remote_control`); the other rows are panel settings.

- **外观 (appearance)** — how the window looks, in one view with two sections:
  **界面动效** (a master switch, a kill-all-animations switch, and strength /
  speed sliders) and **窗口材质** (an optional frosted-glass layer, a wallpaper
  with a recent list). They are one feature because they write one runtime
  theme; the view is one page, the sections are not separate panels. Each
  section has a 重置 button with a confirm step.
- **行为 (behavior)** — the chat composer's model popup. It always lists every
  model (the host's height limits are untouched); a bar right under the search
  field switches between the host's own order (默认), grouping by provider,
  grouping by model vendor, and a flat list sorted by name. The three
  rearrangements sort groups and the rows inside them A–Z (Latin first, then
  Chinese). Default is one flat list in the order configured in Settings — nothing
  is re-sorted and nothing is grouped, so there is no 「最近使用」 section at all;
  the host pulls those rows out of their provider groups and puts them on top, so
  the module asks the host for the full list (searching each provider name shows
  the whole group in its configured order, and search never hides the
  recently-used rows) and puts them back where they belong, caching the whole
  order in localStorage. Every row in that list also gets a faint source line
  (without group headings nobody else names the provider). Provider grouping puts
  recently used models back under their provider and drops the group label's
  background; vendor grouping labels groups by brand (Anthropic, OpenAI,
  Tencent…); name sorting adds a faint source line under each option. Every row
  also carries a 14px colored brand mark picked by model name first and provider
  name second, with a colored initial as fallback for brands not in the table
  (icons are lobe-icons, bundled, no network).
  Recently used rows show the same reasoning/vision badges and context reading as
  the provider groups: the same hidden probe fetches them with the host's own
  search and caches the markup in localStorage. The
  bar lives in the host window (`renderer/model-picker.mjs`) and writes the
  plugin's `modelPicker` key; the panel's 行为 view only reports the current
  value, so do not tell the user to change it there.
- **插件市场 (market)** — the download-and-verify half of a plugin update.
  Installing stays a user action in the Plugins page.
- **远程 (remote)** — a LAN gateway for a device on the same Wi-Fi (phone,
  tablet, or another computer's browser): one switch, one address, one
  six-digit pairing code. A paired device reads sessions, sends a prompt and
  stops a running turn; approvals stay on the desktop. Above 900px the page
  becomes two columns, with the session list staying on the left.

## Remote: when to use

- The user wants to reach this PI-Desktop from a phone, tablet or another computer on the same Wi-Fi, or
  asks whether that is possible at all.
- The gateway is on but the device cannot open the address or cannot pair.

### Remote rules

1. The switch starts it: **PiOpt → 远程 → 开启远程访问** (or the `remote_control`
   Agent tool with `start` / `stop` / `rotate-code`). Never offer to open the port
   by hand or start a second server; turning it on means the LAN can drive the
   machine, so say that when you offer it.
2. Pairing uses the six-digit code shown in the panel, not a password the user
   invents; the device reaches the page by scanning the QR the panel draws (or by
   typing the address the panel prints). Rotating the code invalidates only that code; devices already in
   已配对设备 keep working until they are removed there.
3. The device can also start a session: the ＋ in the session list offers a chat
   with no project (临时聊天) or one of the host's project folders. Projects are
   folders, not ids — a new session is just `session/create` with or without a
   `projectPath`, and mode, model and permission mode come from the host default.
   Long-pressing one of the user's own messages offers 从这里重新问: it forks the
   session through the message before it (`session/fork` keeps everything up to
   and including the cut, and the message ids are regenerated), then puts that
   message's text back in the composer. The original session is untouched. The
   host refuses to fork a session with an active turn — the page says so instead
   of retrying.
   It can list sessions, read one transcript, send a prompt and abort a turn. The transcript renders like the host window: the user's message is the
   only bubble, the agent's text fills the page as Markdown, thinking folds into
   a 思考 row and every tool call folds into one row (name, target, duration,
   expandable args and result). Every agent reply ends with its local timestamp
   (time only for today, a date once older); tool rows show duration instead.
   A long transcript still opens with the first
   question: the reader starts at byte 0, keeps the head message and the recent
   tail, and states how many messages it skipped. It also shows what a session is waiting for — `agent/pendingInteractive`
   and `plans/pending` are `read`, so the list marks 等你回答 and the transcript
   view prints the question. It cannot answer any of it: `tool/resolvePermission`,
   `agent/askTool/resolve` and `plans/resolve` are `dangerous` and come back to a
   confirmation on the desktop. Do not promise remote approval.
4. A device that keeps asking to pair, or one that pairs and then shows nothing, is
   a data problem: devices must survive a plugin restart
   (`<data>/remote-devices.json`), and the session list comes from the desktop
   channel because the plugin session API only sees sessions the plugin created.
5. If the device cannot reach the address, that is the Windows firewall or the
   access point's client isolation — the plugin cannot fix either. Check that the
   address is a LAN one (`127.0.0.1` there means no usable interface was found).
6. Changing the port restarts the gateway once; paired devices keep their tokens,
   they only need the new address.

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

The view is **PiOpt → 外观** (the first rail row, `Alt+1`). Two commands open it on a
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
4. The four presets are 敏捷 / 平衡 / 柔和 / 减弱, paired with strength (50–150%)
   and response speed (0.40–2.00×). Reversible interactions (expand/collapse,
   pop/dismiss, panel slide in/out) are symmetric and interruptible mid-flight.
   减弱 removes spatial movement and stops continuous animation; do not describe
   it as "slower motion".
5. Never claim motion is applied to other plugin panels, the terminal or browser
   views: those are separate documents that theme CSS cannot reach.

## Glass: when to use

- The user asks for Windows 11 Mica / acrylic / frosted glass, a translucent
  window, or for the interface to show what is behind it.
- The user wants the glass layer turned on or off, or wants it lighter or
  heavier.

### Glass rules

1. There is no Agent tool for glass. Direct the user to the panel
   (**PiOpt → 外观 → 窗口材质**) or the command `PiOpt: 打开窗口材质` (it
   scrolls to that section), or `Alt+1` then scroll.
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
   The surfaces it covers are the left sidebar, the right work panel body, the
   chrome bars, every popup (context menus, the model picker, the composer's
   own button popups) and the chat composer itself. Four chrome surfaces share
   one recipe via the `chromeFill` string, emitted into a single selector rule:
   `.main-titlebar`, `.conversation-topbar`, `.window-controls` and
   `.work-panel-header`. Not copies — a copy is how they drift apart.
   `.window-controls` is the minimise / maximise / close strip: the host gives
   it a `position: fixed` solid block and even swaps it to
   `--ds-bg-dock-raised` whenever a work panel is open, which is exactly why
   that corner used to read as a different material from the bar beside it.
   chromeFill is only half of the material; what it sits ON is the other half.
   The top bar is a child of the main pane, so its blur samples the photo
   through the pane's canvas tint. The panel's `.work-panel::before` therefore
   paints a two-stop gradient — the canvas tint for the top
   `--ds-toolbar-height`, the panel's dock glass below it — so the header's
   blur sees the same underlay and the two bands match (measured
   rgb(235,243,255) header against rgb(234,242,254) top bar). Giving the band
   the dock colour instead stacked a second layer there and read as a doubled,
   muddier strip; giving it nothing made the header look transparent, because
   its blur fell straight onto the raw photo.
   That layer lives on the pseudo element, never on `.work-panel` itself: an
   element with a backdrop-filter is a Backdrop Root, so a descendant's blur
   would see only what is painted inside it instead of the photo.
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
   Blur is safe on the frame because the host renders every popup inside its
   own component rather than portalling it — the popups are not descendants of
   the sidebar or the title bars. It is never safe on a menu that may open a
   submenu: the host nests that submenu inside the parent menu
   (`sidebar-submenu` lives inside `sidebar-floating-menu`) and positions both
   from `getBoundingClientRect` / `innerWidth` / `innerHeight`, i.e. viewport
   coordinates. A blur — like a transform — makes the parent the containing
   block for that fixed child, so the submenu resolves those numbers against
   the parent and appears trapped inside the menu that opened it.
   The frosting therefore has two applications. A leaf popup
   (`.composer-model-menu`, `.composer-autocomplete`, `.sidebar-submenu`, the
   usage bubbles, the settings pickers) takes it on the element, which is also
   what keeps the frosting over its own scrollbar. A menu that may open a
   submenu, and the composer (whose own popups are descendants), takes it on
   `::before` — a pseudo element is nobody's ancestor, so a child keeps the
   viewport as its frame. Both read `--pg-overlay-alpha` for the fill; popups
   take `--pg-blur-strong`, the composer the frame's own `--pg-blur` because it
   is the one large surface. They still read as one material.
   One limitation is deliberate: on a menu whose own list scrolls, the pseudo
   element scrolls with the content, so the frosting stays over the first
   screenful and the rest falls back to the translucent fill. Those menus hold
   a handful of items; the long ones are the submenus and the model picker,
   and both carry the filter on the element.
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
