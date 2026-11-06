"use strict";

/**
 * Window glass for PI-Desktop.
 *
 * A plugin cannot make the host window itself translucent. `transparent` is a
 * BrowserWindow construction flag, and once the window exists Electron ignores
 * the alpha channel of `setBackgroundColor` — the host also mixes that alpha
 * away on purpose (`toOpaqueElectronBackgroundColor`) so Windows 11 can keep
 * its native rounded corners. Measured on 0.21.0 / Windows 11 26H2: the window
 * already carries `DWMWA_SYSTEMBACKDROP_TYPE = DWMWA_MAINWINDOW` (Mica) and
 * `WS_EX_NOREDIRECTIONBITMAP`, yet painting the page transparent shows a flat
 * #121212 — the compositor's own opaque root, not the desktop.
 *
 * What a plugin *can* do is paint glass inside the window: the surfaces the
 * shell draws itself get a translucent fill over something worth looking
 * through, and the popups that float above real content get a backdrop blur.
 *
 * That "something" is either a soft light field or a wallpaper the user picked.
 * A wallpaper is referenced by absolute path, never inlined: the host rewrites
 * `url("C:/…/photo.jpg")` to a `plugin-asset:` URL while sanitising the theme,
 * which keeps the 256 KB stylesheet budget free and raises the image ceiling to
 * the host's own 4 MB asset limit.
 *
 * The stylesheet travels with the Motion Lab runtime theme
 * (`pi.themes.upsert`), which is the only channel a plugin has into the host
 * window's own document — see features/motion/index.js.
 */

const SETTINGS_KEY = "windowGlass";
const CSS_MARKER = "/* PiOpt window glass */";
const CSS_LIMIT_BYTES = 256 * 1024;

// The host accepts a reference to an absolute path only when the extension is
// on its own image list (THEME_ASSET_EXTENSIONS minus fonts) and the file is at
// most 4 MB. Keeping the same list here turns a host refusal into a readable
// message in the panel.
const WALLPAPER_EXTENSIONS = Object.freeze(["png", "jpg", "jpeg", "webp", "avif", "svg"]);
const WALLPAPER_MAX_BYTES = 4 * 1024 * 1024;

// Wallpaper Engine 壁纸走另一条通道：video 类型由渲染模块注入一个原生
// `<video>`，因为宿主的主题资源只吃静态图片（4 MB、png/jpg/webp/avif/svg）。
// `engine` 记住这张壁纸的来源；只有 video 能在这里播放，其余类型属于
// Wallpaper Engine 自己，不进这个字段。
const ENGINE_KINDS = Object.freeze(["video"]);
const ENGINE_VIDEO_EXTENSIONS = Object.freeze(["mp4", "webm"]);
const EMPTY_ENGINE = Object.freeze({ id: "", title: "", kind: "", file: "" });

const FITS = Object.freeze(["fill", "contain", "cover", "none"]);

// One preset is one glass recipe. `sidebar`, `chrome`, `overlay` and `canvas`
// are fill opacities in percent: the higher the number, the more the surface
// hides what is behind it — and the deeper/darker it reads. All of them climb
// with the weight, so 轻薄 → 厚重 makes every surface progressively more solid.
//
// `sidebar` sits ABOVE `canvas` on purpose. The sidebar's own token is the
// darkest surface the host has (dark: --ds-bg-under = #000, against
// --ds-bg-primary = #181818 for the pane), and it only stays darker than the
// pane while it mostly hides the image behind it. A low alpha there let a light
// photo wash the sidebar out to roughly twice the pane's luminance — measured
// 63-65 against 34-35 — which read as "the sidebar is the light one".
// `canvas` still only drops below 100 when a wallpaper is set.
const PRESETS = Object.freeze({
  light: Object.freeze({ blur: 16, saturate: 1.35, sidebar: 72, chrome: 58, overlay: 76, glow: 16, canvas: 62, scrim: 0.12 }),
  standard: Object.freeze({ blur: 28, saturate: 1.65, sidebar: 82, chrome: 66, overlay: 82, glow: 22, canvas: 74, scrim: 0.2 }),
  deep: Object.freeze({ blur: 44, saturate: 2, sidebar: 90, chrome: 74, overlay: 88, glow: 28, canvas: 86, scrim: 0.28 }),
});

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  preset: "standard",
  intensity: 1,
  wallpaper: "",
  fit: "fill",
  // 最近用过的背景图，最新在前。路径是绝对路径：宿主按文件系统解析。
  recent: Object.freeze([]),
  engine: EMPTY_ENGINE,
});

const RECENT_MAX = 8;

// 缩略图是面板用 canvas 画好、随条目一起存下来的 data URL。插件进程没有图像
// 解码器（nativeImage 只在 Electron 主进程里），面板也读不到数据目录，所以这
// 一份小图是唯一能让「最近使用」显示预览的东西。只认 data:image/ 前缀，其它
// 一律当作没有。
const THUMB_PREFIX = "data:image/";

function thumbValue(value) {
  const thumb = typeof value === "string" ? value.trim() : "";
  return thumb.startsWith(THUMB_PREFIX) ? thumb : "";
}

function recentEntry(value) {
  if (typeof value === "string") {
    const path = value.trim();
    if (!isSupportedWallpaper(path)) return null;
    return { path, name: path.split(/[\\/]/).pop() || path, thumb: "" };
  }
  if (!value || typeof value !== "object") return null;
  const path = String(value.path ?? "").trim();
  if (!isSupportedWallpaper(path)) return null;
  const name = typeof value.name === "string" && value.name.trim()
    ? value.name.trim()
    : path.split(/[\\/]/).pop() || path;
  return { path, name, thumb: thumbValue(value.thumb) };
}

function normalizeRecent(input) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const item = recentEntry(entry);
    if (!item) continue;
    const key = item.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= RECENT_MAX) break;
  }
  return out;
}

/** 把一个路径提到最近使用的最前面（去重、截断）。 */
function rememberWallpaper(current, target, name, thumb = "") {
  const list = normalizeRecent(current);
  const previous = list.find((entry) => entry.path.toLowerCase() === String(target).toLowerCase());
  return normalizeRecent([
    // 换图时传进来的缩略图优先；只是从列表里切回旧图时，保留它原来那份。
    { path: target, name, thumb: thumbValue(thumb) || (previous ? previous.thumb : "") },
    ...list.filter((entry) => entry.path.toLowerCase() !== String(target).toLowerCase()),
  ]);
}

const LIMITS = Object.freeze({ intensity: Object.freeze([0.6, 1.6]) });

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isSupportedWallpaper(value) {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path) return false;
  // Absolute only: the host resolves the reference against the filesystem, so a
  // relative path would silently fall back to "no image".
  if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(path)) return false;
  if (path.includes("\0")) return false;
  // The host rejects a reference whose segments contain "." or "..", so a path
  // that would be refused at upsert time is refused here instead.
  if (path.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) return false;
  const extension = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? "").toLowerCase();
  return WALLPAPER_EXTENSIONS.includes(extension);
}

function isSupportedEngineVideo(value) {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path) return false;
  if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(path)) return false;
  if (path.includes("\0")) return false;
  if (path.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) return false;
  const extension = (/\.[a-z0-9]+$/i.exec(path)?.[0].slice(1) ?? "").toLowerCase();
  return ENGINE_VIDEO_EXTENSIONS.includes(extension);
}

/**
 * The Wallpaper Engine source behind the current backdrop.
 *
 * Only `kind: "video"` survives: it carries the clip the renderer module plays.
 * Every other type belongs to Wallpaper Engine's own renderer, so it never
 * reaches here; an entry that lost its clip collapses to empty rather than
 * leaving a dangling reference for `themes.upsert` to choke on.
 */
function normalizeEngine(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const id = /^\d{1,20}$/.test(String(source.id ?? "").trim()) ? String(source.id).trim() : "";
  const kind = ENGINE_KINDS.includes(source.kind) ? source.kind : "";
  if (!id || kind !== "video") return { ...EMPTY_ENGINE };

  const file = isSupportedEngineVideo(source.file) ? String(source.file).trim() : "";
  if (!file) return { ...EMPTY_ENGINE };
  const title = typeof source.title === "string" ? source.title.trim().slice(0, 120) : "";
  return { id, title, kind, file };
}

/** Whether the backdrop is a clip the renderer module has to play. */
function hasEngineVideo(config) {
  const engine = config && config.engine ? config.engine : EMPTY_ENGINE;
  return engine.kind === "video" && Boolean(engine.file);
}

/**
 * The reference as CSS can spell it, or "" when there is none.
 *
 * A Windows path cannot be written verbatim: `url("C:\Users\…")` reads `\U` as
 * a CSS escape. The host normalises either separator, so forward slashes are
 * both correct and unambiguous.
 */
function wallpaperCssUrl(value) {
  if (!isSupportedWallpaper(value)) return "";
  return String(value)
    .trim()
    .replace(/\\/g, "/")
    .replace(/"/g, "%22");
}

function normalizeGlassConfig(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const preset = Object.prototype.hasOwnProperty.call(PRESETS, source.preset)
    ? source.preset
    : DEFAULT_CONFIG.preset;
  const fit = FITS.includes(source.fit) ? source.fit : DEFAULT_CONFIG.fit;
  const wallpaper = isSupportedWallpaper(source.wallpaper) ? String(source.wallpaper).trim() : "";

  return {
    // Off by default: enabling glass changes every surface the user looks at,
    // so it has to be asked for.
    enabled: source.enabled === true,
    preset,
    intensity:
      Math.round(
        clamp(finiteNumber(source.intensity, DEFAULT_CONFIG.intensity), LIMITS.intensity[0], LIMITS.intensity[1]) * 100
      ) / 100,
    wallpaper,
    fit,
    recent: normalizeRecent(source.recent),
    engine: normalizeEngine(source.engine),
  };
}

// Blur and glow scale with the strength slider; the fills only firm up a
// little, because a thinner fill at high blur is what makes small text lose its
// background and become hard to read.
function glassTokens(input = {}) {
  const config = normalizeGlassConfig(input);
  const preset = PRESETS[config.preset];
  const scale = config.intensity;
  const blur = Math.round(clamp(preset.blur * scale, 6, 80));
  const firmUp = (value) => Math.round(clamp(value * (0.86 + 0.14 * scale), 12, 92));

  return {
    blur,
    blurStrong: Math.round(clamp(blur * 1.35, 8, 96)),
    saturate: Math.round(preset.saturate * 100) / 100,
    sidebar: firmUp(preset.sidebar),
    chrome: firmUp(preset.chrome),
    overlay: firmUp(preset.overlay),
    glow: Math.round(clamp(preset.glow * scale, 8, 46)),
    // The dimming rides on the backdrop layer instead of the surface fills.
    // A surface's `background-color` and its `backdrop-filter` composite in an
    // order that is not stable across tiles: sampling a real window showed a
    // sidebar section drawn with the fill and the one below it without. Painting
    // the scrim into the image layer makes every reveal the same brightness.
    scrim: Math.round(clamp(preset.scrim * (0.85 + 0.15 * scale), 0.04, 0.55) * 100) / 100,
    // 100% keeps the pane exactly as the host paints it, so a user who never
    // picks a wallpaper sees no change at all.
    // 视频壁纸同样算“有东西在背后”，否则主画布会盖住它。
    canvas: config.wallpaper || hasEngineVideo(config) ? firmUp(preset.canvas) : 100,
  };
}

const LIGHT_FIELD =
  "radial-gradient(150% 120% at 0% -30%,color-mix(in oklab,var(--ds-accent) var(--pg-glow),transparent),transparent 62%)," +
  "radial-gradient(110% 90% at 105% 8%,color-mix(in oklab,var(--ds-bg-tertiary) 85%,transparent),transparent 66%)," +
  "radial-gradient(130% 110% at 42% 122%,color-mix(in oklab,var(--ds-accent) calc(var(--pg-glow) * .8),transparent),transparent 64%)";


/**
 * The `background-size` declarations for one fit mode.
 *
 * `scale-down` is the only mode CSS cannot express directly: `background-size`
 * has no access to an image's natural size, so the pseudo element is clamped to
 * `min(100%, natural)` and centred with `inset` + `margin: auto` (never
 * `transform`), then `contain` fills that box — which is exactly
 * `object-fit: scale-down`. Without a known size it degrades to plain `contain`.
 */
function fitDeclarations(fit) {
  switch (fit) {
    case "contain":
      return "background-size:contain;background-position:center;background-repeat:no-repeat;";
    case "cover":
      return "background-size:cover;background-position:center;background-repeat:no-repeat;";
    case "none":
      return "background-size:auto;background-position:center;background-repeat:no-repeat;";
    case "fill":
    default:
      return "background-size:100% 100%;background-repeat:no-repeat;";
  }
}
// The popups and the composer are frosted too, and that needs two different
// applications for one reason: a `backdrop-filter` makes the element the
// containing block for every `position: fixed` descendant, exactly like a
// `transform`. The host nests a submenu inside the menu that opens it
// (`.sidebar-submenu` is a child of `.sidebar-row-menu`) and writes both levels'
// `top`/`left` from `getBoundingClientRect` — viewport numbers. Blurring that
// parent resolved them against the menu instead, which is how the second level
// stayed trapped inside the first one.
//
// So the layer that may open a submenu carries the frosting on its `::before`: a
// pseudo element is nobody's ancestor, so the child keeps the viewport as its
// frame. A popup that never opens anything (a plain list, its own scrollbar) gets
// the filter on the element, which is also the only way the frosting follows a
// scrolling list instead of staying pinned to the first screenful.
const FROSTED_POPUPS = Object.freeze([
  // The model picker: the host itself frosts this one in its dark theme with a
  // fixed 40px blur, so this is the one case where the recipe is replacing a
  // material the shell already had.
  ".composer-model-menu",
  ".composer-autocomplete",
  ".sidebar-submenu",
  ".scope-popover",
  ".provider-model-menu",
  ".provider-model-multi-menu",
  ".provider-service-menu",
  ".model-default-menu",
  ".settings-font-menu",
  ".settings-language-menu",
  ".settings-theme-menu",
  ".settings-menu-select-menu",
  ".home-project-switcher-menu",
  ".turn-usage-popover",
  ".context-inspector-popover",
  ".live-voice-popup",
]);

// Menus that may host a fixed submenu of their own — the same set the motion
// layer refuses to transform, and for the same reason.
const FROSTED_FRAMES = Object.freeze([
  ".context-menu",
  ".sidebar-row-menu",
  ".sidebar-floating-menu",
  ".composer-permission-menu",
  ".composer-mode-menu",
  ".agent-capability-menu",
  ".plan-approval-menu",
  ".projects-menu",
  ".plugins-menu",
  ".scope-compact-menu",
]);

// The chat composer owns the composer's own popups (model, mode, permission,
// autocomplete) as descendants, so its frosting goes on the pseudo element as
// well; a filter here would re-anchor all of them.
const FROSTED_SHELL = ".composer-shell";

// The surfaces that take the translucent fill but not the element-level
// frosting: the menus that may open a submenu (their layer is a pseudo element)
// plus the dialogs and dropdowns that were already translucent. `[role=menu]`
// covers most of the host's menus; the named ones are there because their role
// is not a menu.
//
// The leaf popups are deliberately absent: their own rule below writes the same
// fill next to the filter, so that selector list is not paid for twice.
const POPUP_FILL = Object.freeze([
  "[role=dialog]",
  ".dialog-content",
  ".modal-content",
  "[role=menu]",
  ".popover-content",
  ".dropdown-content",
  ".sidebar-section-menu",
  ".project-menu",
  ...FROSTED_FRAMES,
]);
/**
 * The stylesheet, or an empty string when glass is off.
 *
 * Four rules exist for four different reasons:
 *
 * 1. `.app-shell::before` paints what sits behind the glass — the wallpaper, or
 *    a soft light field when there is none. Without it the translucent surfaces
 *    would show one flat colour and `backdrop-filter` would have nothing to
 *    blur. `z-index:-1` puts it under the shell's content but over its own
 *    background, so no layout or stacking changes elsewhere.
 *
 * 2. The surfaces the shell draws itself — the sidebar and the title bar — get
 *    the fill plus a blur. They are the frame around the content, and they are
 *    also the only two places where a blur is cheap enough to run at 144 Hz.
 *
 * 3. The main pane drops to a near-opaque fill so the wallpaper is visible
 *    through it. Only `background-color` changes: a `backdrop-filter` here would
 *    make the pane the containing block for the composer's fixed layers.
 *
 * 4. Menus, popups and the chat composer get a stronger blur (see the note
 *    above FROSTED_POPUPS for why half of them take it on a pseudo element).
 *    These float above live content, so the blur does actual work there rather
 *    than decorating a colour.
 *
 * No rule uses `transform`. A transform — even one that finishes — leaves the
 * element as the containing block for `position: fixed` descendants, which is
 * what once moved the host's context menu. `backdrop-filter` has the same
 * containing-block side effect, so it lands on an element only when that
 * element's own fixed descendants are not positioned by the shell (a leaf
 * popup), and on a `::before` layer everywhere else.
 */
function buildGlassCss(input = {}, options = {}) {
  const config = normalizeGlassConfig(input);
  const surfaces = config.enabled;
  const engineVideo = hasEngineVideo(config);
  // Nothing to paint when the user wants solid surfaces and no backdrop: an
  // engine clip counts as a backdrop even though the image layer stays empty,
  // because the variables (--pg-*) still have to exist for the video layer.
  if (!surfaces && !config.wallpaper && !engineVideo) return "";

  const tokens = glassTokens(config);
  // The switch only decides whether the surfaces are frosted. A photo must survive
  // it going off, so the blur is what it adds — not the whole stylesheet.
  const blur = surfaces
    ? "-webkit-backdrop-filter:blur(var(--pg-blur)) saturate(var(--pg-saturate));backdrop-filter:blur(var(--pg-blur)) saturate(var(--pg-saturate))"
    : "";
  // The popups and the composer take a slightly stronger blur than the frame:
  // they already float over live content, so the blur does real work there.
  const blurStrong = surfaces
    ? "-webkit-backdrop-filter:blur(var(--pg-blur-strong)) saturate(var(--pg-saturate))!important;backdrop-filter:blur(var(--pg-blur-strong)) saturate(var(--pg-saturate))!important"
    : "";
  // One recipe, two applications — see FROSTED_POPUPS / FROSTED_FRAMES above.
  // A leaf popup carries both the fill and the filter on itself (the fill is what
  // gives the blur a floor to work against); the menus that may open a submenu
  // and the composer only get the layer, because their fill is already set by the
  // POPUP_FILL rule or by the host.
  //
  // The composer's fill stays on the shell rather than moving into the layer: the
  // layer is painted above that fill, and a uniform colour is exactly what makes
  // the two orders equivalent (blur of a·fill plus the backdrop equals a·fill
  // over the blurred backdrop).
  const popupFill =
    "background-color:color-mix(in oklab,var(--ds-bg-elevated-opaque) var(--pg-overlay-alpha),transparent)!important;" +
    "border-color:color-mix(in oklab,var(--ds-text-primary) 12%,transparent);";
  // The composer is the one large surface: it takes the frame's own radius, not
  // the popup one. A 46px blur over a 768px-wide box is a lot of pixels for no
  // extra legibility, and at that size the softer radius reads better.
  const shellBlur = surfaces
    ? "-webkit-backdrop-filter:blur(var(--pg-blur)) saturate(var(--pg-saturate))!important;backdrop-filter:blur(var(--pg-blur)) saturate(var(--pg-saturate))!important"
    : "";
  const frostLayer = "content:\"\";position:absolute;inset:0;z-index:-1;pointer-events:none;border-radius:inherit;";
  const frosted = surfaces
    ? [
        `:is(${FROSTED_POPUPS.join(",")}){${popupFill}${blurStrong}}`,
        `:is(${FROSTED_FRAMES.join(",")})::before{${frostLayer}${blurStrong}}`,
        `${FROSTED_SHELL}::before{${frostLayer}${shellBlur}}`,
        `${FROSTED_SHELL}{background-color:color-mix(in oklab,var(--ds-bg-composer) var(--pg-overlay-alpha),transparent)!important;background-image:none!important}`,
      ].join("\n")
    : "";
  const wallpaper = wallpaperCssUrl(config.wallpaper);
  // A photo already carries the detail the light field was standing in for, and
  // leaving it out keeps one fewer full-window gradient to recomposite.
  // The scrim is the first layer so every surface that reveals the photo sees the
  // same dimmed version of it, whatever the compositor decides about the fills.
  const scrim = "linear-gradient(rgba(0,0,0,var(--pg-scrim)),rgba(0,0,0,var(--pg-scrim)))";
  // A Wallpaper Engine clip is painted by the renderer module on a layer above
  // this pseudo element, and it carries its own scrim — so the image layer here
  // paints nothing at all. Without that, the light field would only add a second
  // full-window gradient nobody can see.
  const backdrop = engineVideo ? "none" : wallpaper ? `${scrim},url("${wallpaper}")` : LIGHT_FIELD;

  // Every "chrome" surface — the window title bar, the conversation top bar, the
  // work panel's tab header and the window controls — paints this exact string.
  // One variable, not four copies: the point is that they are the same material,
  // and a copy is how they drift apart.
  const chromeFill =
    `background-color:color-mix(in oklab,var(--ds-bg-primary) var(--pg-chrome-alpha),transparent)!important;` +
    `box-shadow:inset 0 -1px 0 color-mix(in oklab,var(--ds-text-primary) 8%,transparent);${blur}`;

  // Only a frosted surface needs a no-blur fallback; with the switch off these
  // rules would just make the frame more opaque and hide the photo.
  const noBlurFallback = surfaces
    ? [
        "@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){",
        ":is(.sidebar-surface,.sidebar-rail){background-color:color-mix(in oklab,var(--ds-bg-sidebar) 90%,transparent)!important}",
        ".main-titlebar,:is(.conversation-topbar,[data-slot=topbar]),.window-controls,.work-panel-header{background-color:color-mix(in oklab,var(--ds-bg-primary) 94%,transparent)!important}",
        ".work-panel::before{background-image:linear-gradient(to bottom,color-mix(in oklab,var(--ds-bg-primary) 94%,transparent) 0 var(--ds-toolbar-height),color-mix(in oklab,var(--ds-bg-dock) 90%,transparent) var(--ds-toolbar-height))!important}",
        ":is(" + POPUP_FILL.join(",") + "){background-color:var(--ds-bg-elevated-opaque)!important}",
        // The composer's fill is the one surface that changed on its own element,
        // so a compositor without backdrop blur gets the host's own colour back.
        `${FROSTED_SHELL}{background-color:var(--ds-bg-composer)!important}`,
        "}",
      ].join("\n")
    : "";
  const sizing = wallpaper && !engineVideo ? fitDeclarations(config.fit) : "";

  const css = `${CSS_MARKER}
:root{--pg-blur:${tokens.blur}px;--pg-blur-strong:${tokens.blurStrong}px;--pg-saturate:${tokens.saturate};--pg-sidebar-alpha:${tokens.sidebar}%;--pg-chrome-alpha:${tokens.chrome}%;--pg-overlay-alpha:${tokens.overlay}%;--pg-canvas-alpha:${tokens.canvas}%;--pg-glow:${tokens.glow}%;--pg-scrim:${tokens.scrim}}
.app-shell::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background-image:${backdrop};${sizing}}
:is(.sidebar-surface,.sidebar-rail){background-color:color-mix(in oklab,var(--ds-bg-under) var(--pg-sidebar-alpha),transparent)!important;background-image:linear-gradient(180deg,var(--ds-sidebar-glass-sheen-top),transparent 220px),linear-gradient(0deg,var(--ds-sidebar-glass-sheen-bottom),transparent 160px)!important;background-repeat:no-repeat!important;box-shadow:inset -1px 0 0 color-mix(in oklab,var(--ds-text-primary) 9%,transparent);${blur}}
/* Every chrome surface paints the identical chromeFill string: the window title
   bar, the conversation top bar, the window controls (the 120px minimise /
   maximise / close strip, position: fixed, which the host otherwise paints a
   solid --ds-bg-primary or --ds-bg-dock-raised) and the work panel header.

   chromeFill is only half of that material — what the fill sits ON decides how
   it reads. The conversation top bar is a child of the main pane, so its blur
   samples the photo *through* the pane's canvas tint. The work panel header
   gets the same underlay from its panel's pseudo element (see below), which is
   what makes the two bands come out the same instead of one being see-through. */
.main-titlebar,:is(.conversation-topbar,[data-slot=topbar]),.window-controls,.work-panel-header{${chromeFill}}
.main-pane{background-color:color-mix(in oklab,var(--ds-bg-primary) var(--pg-canvas-alpha),transparent)!important}
/* The work panel's glass lives on its ::before, not on .work-panel.

   An element with a backdrop filter is a Backdrop Root: a descendant's own
   blur can only see what is painted inside that ancestor, never the
   photo behind it. With the blur on .work-panel, the header's blur sampled the
   panel's still-transparent box, so the header's fill landed on nothing and
   read as a flat grey bar — measured on 0.21.0 over a solid #2060c0 backdrop:
   header rgb(27,30,34), window controls rgb(22,36,56). The window controls are
   a sibling of the panel, not a child, so they always saw the real backdrop.
   Dropping the header's fill instead (the previous workaround) just showed the
   panel glass at a different density from the bar beside it.

   A pseudo element is a sibling of the header in paint order, so it is not a
   Backdrop Root for it: the header and the window controls now sample the same
   stack and come out identical — rgb(22,36,57) for both, same as the top bar.
   .work-panel is already a stacking context (position: relative + z-index 20),
   so z-index:-1 keeps the layer above the panel's box and below its content. */
.work-panel{background-color:transparent!important;animation:none!important}
.work-panel.is-exiting{animation:work-panel-out-glass 1ms linear both!important;overflow:hidden}
/* No transform here: it would re-anchor the host's fixed popups. */
@keyframes work-panel-out-glass{from{flex-basis:var(--work-panel-width);width:var(--work-panel-width)}to{flex-basis:0;width:0}}
/* One layer, two stops. The band at the top is what the conversation top bar
   sits on — the pane's canvas tint — and below --ds-toolbar-height it becomes
   the panel's own, denser dock glass. The header then paints chromeFill over
   the band, so its blur samples the photo through the same tint the top bar
   sees and the two bands measure the same colour. Painting the dock colour in
   the band as well would stack a second translucent layer there, which read as
   a muddier, doubled strip against the bar beside it. Without the gradient the
   header's blur fell straight onto the raw photo: still blurred, but darker and
   more saturated than the bar, which read as "transparent, no frosting". */
.work-panel::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background-image:linear-gradient(to bottom,color-mix(in oklab,var(--ds-bg-primary) var(--pg-canvas-alpha),transparent) 0 var(--ds-toolbar-height),color-mix(in oklab,var(--ds-bg-dock) var(--pg-sidebar-alpha),transparent) var(--ds-toolbar-height));${blur}}
:is(.sidebar-footer,.footer-actions){background-color:transparent!important}
/* Popups and the composer are frosted too, but the layer is applied in two
   different places — the reason is spelled out above FROSTED_POPUPS.

   A backdrop blur makes an element the containing block for its position:fixed
   descendants — the same trap as a transform. The host nests its context
   submenu inside the parent menu (sidebar-submenu lives inside sidebar-row-menu)
   and positions BOTH from getBoundingClientRect, innerWidth and innerHeight, i.e.
   in viewport coordinates. Blurring the parent made the child resolve those
   numbers against the parent instead of the viewport, so the submenu stayed
   pinned inside the menu that opened it and could not float out.

   So the menus that may open a submenu carry the frosting on their ::before —
   a pseudo element is nobody's ancestor, and it paints between the fill and the
   content — while a leaf popup carries it on the element, which is also what
   keeps the frosting in place while a long list scrolls under it.

   (No backticks in this block: it lives inside a template literal.) */
:is(${POPUP_FILL.join(",")}){background-color:color-mix(in oklab,var(--ds-bg-elevated-opaque) var(--pg-overlay-alpha),transparent)!important;border-color:color-mix(in oklab,var(--ds-text-primary) 12%,transparent)}
${frosted}
${noBlurFallback}`;

  if (Buffer.byteLength(css, "utf8") > CSS_LIMIT_BYTES) {
    throw new RangeError("Generated glass CSS exceeds the PI-Desktop 256 KB theme limit.");
  }
  return css;
}

module.exports = {
  CSS_LIMIT_BYTES,
  CSS_MARKER,
  DEFAULT_CONFIG,
  ENGINE_KINDS,
  ENGINE_VIDEO_EXTENSIONS,
  EMPTY_ENGINE,
  FITS,
  FROSTED_FRAMES,
  FROSTED_POPUPS,
  FROSTED_SHELL,
  LIMITS,
  POPUP_FILL,
  PRESETS,
  RECENT_MAX,
  SETTINGS_KEY,
  WALLPAPER_EXTENSIONS,
  WALLPAPER_MAX_BYTES,
  buildGlassCss,
  fitDeclarations,
  glassTokens,
  hasEngineVideo,
  isSupportedEngineVideo,
  isSupportedWallpaper,
  normalizeEngine,
  normalizeGlassConfig,
  normalizeRecent,
  recentEntry,
  rememberWallpaper,
  wallpaperCssUrl,
};
