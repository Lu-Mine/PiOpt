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

const FITS = Object.freeze(["fill", "contain", "cover", "none", "scale-down"]);

// One preset is one glass recipe. `sidebar`, `chrome`, `overlay` and `canvas`
// are fill opacities in percent: the higher the number, the more the surface
// hides what is behind it — and the deeper/darker it reads. All four climb with
// the weight, so 轻薄 → 厚重 makes every surface (sidebar, title bar, main pane)
// progressively more solid and darker. `canvas` still stays below 100 whenever a
// wallpaper is set, and only jumps to 100 (untouched) when there is no image, so
// a user who never picks a wallpaper sees no change.
const PRESETS = Object.freeze({
  light: Object.freeze({ blur: 16, saturate: 1.35, sidebar: 34, chrome: 58, overlay: 76, glow: 16, canvas: 62, scrim: 0.12 }),
  standard: Object.freeze({ blur: 28, saturate: 1.65, sidebar: 44, chrome: 66, overlay: 82, glow: 22, canvas: 74, scrim: 0.2 }),
  deep: Object.freeze({ blur: 44, saturate: 2, sidebar: 54, chrome: 74, overlay: 88, glow: 28, canvas: 86, scrim: 0.28 }),
});

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  preset: "standard",
  intensity: 1,
  wallpaper: "",
  fit: "fill",
});

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
    canvas: config.wallpaper ? firmUp(preset.canvas) : 100,
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
function fitDeclarations(fit, size) {
  switch (fit) {
    case "contain":
      return "background-size:contain;background-position:center;background-repeat:no-repeat;";
    case "cover":
      return "background-size:cover;background-position:center;background-repeat:no-repeat;";
    case "none":
      return "background-size:auto;background-position:center;background-repeat:no-repeat;";
    case "scale-down": {
      const width = Number(size && size.width);
      const height = Number(size && size.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return "background-size:contain;background-position:center;background-repeat:no-repeat;";
      }
      const boxWidth = Math.round(width);
      const boxHeight = Math.round(height);
      return `inset:0;margin:auto;width:min(100%,${boxWidth}px);height:min(100%,${boxHeight}px);background-size:contain;background-position:center;background-repeat:no-repeat;`;
    }
    case "fill":
    default:
      return "background-size:100% 100%;background-repeat:no-repeat;";
  }
}
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
 * 4. Menus, dialogs and popovers get a stronger blur. These are the one case
 *    where real friction-free glass is possible: they already float above live
 *    content, so the blur is doing actual work rather than decorating a colour.
 *
 * No rule uses `transform`. A transform — even one that finishes — leaves the
 * element as the containing block for `position: fixed` descendants, which is
 * what once moved the host's context menu. `backdrop-filter` has the same
 * containing-block side effect, so it is applied only to elements whose fixed
 * descendants are the popups themselves (see the note in README).
 */
function buildGlassCss(input = {}, options = {}) {
  const config = normalizeGlassConfig(input);
  const surfaces = config.enabled;
  // Nothing to paint when the user wants solid surfaces and has no photo behind.
  if (!surfaces && !config.wallpaper) return "";

  const tokens = glassTokens(config);
  // The switch only decides whether the surfaces are frosted. A photo must survive
  // it going off, so the blur is what it adds — not the whole stylesheet.
  const blur = surfaces
    ? "-webkit-backdrop-filter:blur(var(--pg-blur)) saturate(var(--pg-saturate));backdrop-filter:blur(var(--pg-blur)) saturate(var(--pg-saturate))"
    : "";
  const blurStrong = surfaces
    ? "-webkit-backdrop-filter:blur(var(--pg-blur-strong)) saturate(var(--pg-saturate));backdrop-filter:blur(var(--pg-blur-strong)) saturate(var(--pg-saturate))"
    : "";
  const wallpaper = wallpaperCssUrl(config.wallpaper);
  // A photo already carries the detail the light field was standing in for, and
  // leaving it out keeps one fewer full-window gradient to recomposite.
  // The scrim is the first layer so every surface that reveals the photo sees the
  // same dimmed version of it, whatever the compositor decides about the fills.
  const scrim = "linear-gradient(rgba(0,0,0,var(--pg-scrim)),rgba(0,0,0,var(--pg-scrim)))";
  const backdrop = wallpaper ? `${scrim},url("${wallpaper}")` : LIGHT_FIELD;

  // Only a frosted surface needs a no-blur fallback; with the switch off these
  // rules would just make the frame more opaque and hide the photo.
  const noBlurFallback = surfaces
    ? [
        "@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){",
        ":is(.sidebar-surface,.sidebar-rail){background-color:color-mix(in oklab,var(--ds-bg-sidebar) 90%,transparent)!important}",
        ".main-titlebar{background-color:color-mix(in oklab,var(--ds-bg-primary) 94%,transparent)!important}",
        ":is([role=dialog],.dialog-content,.modal-content,[role=menu],.popover-content,.dropdown-content){background-color:var(--ds-bg-elevated-opaque)!important}",
        "}",
      ].join("\n")
    : "";
  const sizing = wallpaper ? fitDeclarations(config.fit, options.size) : "";

  const css = `${CSS_MARKER}
:root{--pg-blur:${tokens.blur}px;--pg-blur-strong:${tokens.blurStrong}px;--pg-saturate:${tokens.saturate};--pg-sidebar-alpha:${tokens.sidebar}%;--pg-chrome-alpha:${tokens.chrome}%;--pg-overlay-alpha:${tokens.overlay}%;--pg-canvas-alpha:${tokens.canvas}%;--pg-glow:${tokens.glow}%;--pg-scrim:${tokens.scrim}}
.app-shell::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background-image:${backdrop};${sizing}}
:is(.sidebar-surface,.sidebar-rail){background-color:color-mix(in oklab,var(--ds-bg-sidebar) var(--pg-sidebar-alpha),transparent)!important;background-image:linear-gradient(180deg,var(--ds-sidebar-glass-sheen-top),transparent 220px),linear-gradient(0deg,var(--ds-sidebar-glass-sheen-bottom),transparent 160px)!important;background-repeat:no-repeat!important;box-shadow:inset -1px 0 0 color-mix(in oklab,var(--ds-text-primary) 9%,transparent);${blur}}
.main-titlebar{background-color:color-mix(in oklab,var(--ds-bg-primary) var(--pg-chrome-alpha),transparent)!important;box-shadow:inset 0 -1px 0 color-mix(in oklab,var(--ds-text-primary) 8%,transparent);${blur}}
.main-pane{background-color:color-mix(in oklab,var(--ds-bg-primary) var(--pg-canvas-alpha),transparent)!important}
:is(.sidebar-footer,.footer-actions){background-color:transparent!important}
:is([role=dialog],.dialog-content,.modal-content,[role=menu],.popover-content,.dropdown-content,.sidebar-section-menu,.project-menu,.composer-model-menu,.agent-capability-menu){background-color:color-mix(in oklab,var(--ds-bg-elevated-opaque) var(--pg-overlay-alpha),transparent)!important;border-color:color-mix(in oklab,var(--ds-text-primary) 12%,transparent);${blurStrong}}
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
  FITS,
  LIMITS,
  PRESETS,
  SETTINGS_KEY,
  WALLPAPER_EXTENSIONS,
  WALLPAPER_MAX_BYTES,
  buildGlassCss,
  glassTokens,
  fitDeclarations,
  isSupportedWallpaper,
  normalizeGlassConfig,
  wallpaperCssUrl,
};
