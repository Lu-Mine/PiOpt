"use strict";

/**
 * Window glass for PI-Desktop.
 *
 * A plugin cannot make the host window itself translucent. `transparent` is a
 * BrowserWindow construction flag, and once the window exists Electron ignores
 * the alpha channel of `setBackgroundColor` — the host also mixes that alpha
 * away on purpose (`toOpaqueElectronBackgroundColor`) so Windows 11 can keep
 * its native rounded corners. Measured on 0.21.0 / Windows 11 26H2: the window
 * already carries `DWMWA_SYSTEMBACKDROP_TYPE = DWMSA_MAINWINDOW` (Mica) and
 * `WS_EX_NOREDIRECTIONBITMAP`, yet painting the page transparent shows a flat
 * #121212 — the compositor's own opaque root, not the desktop.
 *
 * What a plugin *can* do is paint glass inside the window. The surfaces the
 * shell draws itself get a translucent fill over a soft light field, and the
 * popups that float above real content get a true backdrop blur. That is the
 * whole of this module: it turns a small config into a stylesheet.
 *
 * The stylesheet travels with the Motion Lab runtime theme
 * (`pi.themes.upsert`), which is the only channel a plugin has into the host
 * window's own document — see features/motion/index.js.
 */

const SETTINGS_KEY = "windowGlass";
const CSS_MARKER = "/* PiOpt window glass */";
const CSS_LIMIT_BYTES = 256 * 1024;

// One preset is one glass recipe. `sidebar`, `chrome` and `overlay` are fill
// opacities in percent: the higher the number, the more the surface hides what
// is behind it. Blur alone does not read as frosted glass on a dark surface —
// the fill is what keeps text legible while the blur carries the material.
const PRESETS = Object.freeze({
  light: Object.freeze({ blur: 16, saturate: 1.35, sidebar: 34, chrome: 58, overlay: 76, glow: 16 }),
  standard: Object.freeze({ blur: 28, saturate: 1.65, sidebar: 44, chrome: 66, overlay: 82, glow: 22 }),
  deep: Object.freeze({ blur: 44, saturate: 2, sidebar: 54, chrome: 74, overlay: 88, glow: 28 }),
});

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  preset: "standard",
  intensity: 1,
});

const LIMITS = Object.freeze({ intensity: Object.freeze([0.6, 1.6]) });

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeGlassConfig(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const preset = Object.prototype.hasOwnProperty.call(PRESETS, source.preset)
    ? source.preset
    : DEFAULT_CONFIG.preset;

  return {
    // Off by default: enabling glass changes every surface the user looks at,
    // so it has to be asked for.
    enabled: source.enabled === true,
    preset,
    intensity:
      Math.round(
        clamp(finiteNumber(source.intensity, DEFAULT_CONFIG.intensity), LIMITS.intensity[0], LIMITS.intensity[1]) * 100
      ) / 100,
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
  };
}

/**
 * The stylesheet, or an empty string when glass is off.
 *
 * Three rules exist for three different reasons:
 *
 * 1. `.app-shell::before` paints the light field. Without something behind them
 *    the translucent surfaces would just show one flat colour, and `backdrop-filter`
 *    would have nothing to blur. `z-index:-1` puts it under the shell's content
 *    but over its own background, so no layout or stacking changes elsewhere.
 *
 * 2. The surfaces the shell draws itself — the sidebar and the title bar — get
 *    the fill plus a blur. They are the frame around the content, and they are
 *    also the only two places where a blur is cheap enough to run at 144 Hz.
 *
 * 3. Menus, dialogs and popovers get a stronger blur. These are the one case
 *    where real friction-free glass is possible: they already float above live
 *    content, so the blur is doing actual work rather than decorating a colour.
 *
 * No rule uses `transform`. A transform — even one that finishes — leaves the
 * element as the containing block for `position: fixed` descendants, which is
 * what once moved the host's context menu. `backdrop-filter` has the same
 * containing-block side effect, so it is applied only to elements whose fixed
 * descendants are the popups themselves (see the note in README).
 */
function buildGlassCss(input = {}) {
  const config = normalizeGlassConfig(input);
  if (!config.enabled) return "";

  const tokens = glassTokens(config);
  const css = `${CSS_MARKER}
:root{--pg-blur:${tokens.blur}px;--pg-blur-strong:${tokens.blurStrong}px;--pg-saturate:${tokens.saturate};--pg-sidebar-alpha:${tokens.sidebar}%;--pg-chrome-alpha:${tokens.chrome}%;--pg-overlay-alpha:${tokens.overlay}%;--pg-glow:${tokens.glow}%}
.app-shell::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(150% 120% at 0% -30%,color-mix(in oklab,var(--ds-accent) var(--pg-glow),transparent),transparent 62%),radial-gradient(110% 90% at 105% 8%,color-mix(in oklab,var(--ds-bg-tertiary) 85%,transparent),transparent 66%),radial-gradient(130% 110% at 42% 122%,color-mix(in oklab,var(--ds-accent) calc(var(--pg-glow) * .8),transparent),transparent 64%)}
:is(.sidebar-surface,.sidebar-rail){background-color:color-mix(in oklab,var(--ds-bg-sidebar) var(--pg-sidebar-alpha),transparent)!important;background-image:linear-gradient(180deg,var(--ds-sidebar-glass-sheen-top),transparent 220px),linear-gradient(0deg,var(--ds-sidebar-glass-sheen-bottom),transparent 160px)!important;background-repeat:no-repeat!important;box-shadow:inset -1px 0 0 color-mix(in oklab,var(--ds-text-primary) 9%,transparent);-webkit-backdrop-filter:blur(var(--pg-blur)) saturate(var(--pg-saturate));backdrop-filter:blur(var(--pg-blur)) saturate(var(--pg-saturate))}
.main-titlebar{background-color:color-mix(in oklab,var(--ds-bg-primary) var(--pg-chrome-alpha),transparent)!important;box-shadow:inset 0 -1px 0 color-mix(in oklab,var(--ds-text-primary) 8%,transparent);-webkit-backdrop-filter:blur(var(--pg-blur)) saturate(var(--pg-saturate));backdrop-filter:blur(var(--pg-blur)) saturate(var(--pg-saturate))}
:is(.sidebar-footer,.footer-actions){background-color:transparent!important}
:is([role=dialog],.dialog-content,.modal-content,[role=menu],.popover-content,.dropdown-content,.sidebar-section-menu,.project-menu,.composer-model-menu,.agent-capability-menu){background-color:color-mix(in oklab,var(--ds-bg-elevated-opaque) var(--pg-overlay-alpha),transparent)!important;border-color:color-mix(in oklab,var(--ds-text-primary) 12%,transparent);-webkit-backdrop-filter:blur(var(--pg-blur-strong)) saturate(var(--pg-saturate));backdrop-filter:blur(var(--pg-blur-strong)) saturate(var(--pg-saturate))}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
:is(.sidebar-surface,.sidebar-rail){background-color:color-mix(in oklab,var(--ds-bg-sidebar) 90%,transparent)!important}
.main-titlebar{background-color:color-mix(in oklab,var(--ds-bg-primary) 94%,transparent)!important}
:is([role=dialog],.dialog-content,.modal-content,[role=menu],.popover-content,.dropdown-content){background-color:var(--ds-bg-elevated-opaque)!important}
}`;

  if (Buffer.byteLength(css, "utf8") > CSS_LIMIT_BYTES) {
    throw new RangeError("Generated glass CSS exceeds the PI-Desktop 256 KB theme limit.");
  }
  return css;
}

module.exports = {
  CSS_LIMIT_BYTES,
  CSS_MARKER,
  DEFAULT_CONFIG,
  LIMITS,
  PRESETS,
  SETTINGS_KEY,
  buildGlassCss,
  glassTokens,
  normalizeGlassConfig,
};
