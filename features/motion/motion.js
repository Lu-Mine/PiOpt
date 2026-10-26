"use strict";

const THEME_IDS = Object.freeze({ light: "motion-light", dark: "motion-dark" });
const SETTINGS_KEY = "motionLab";
const CSS_LIMIT_BYTES = 256 * 1024;

const PRESETS = Object.freeze({
  agile: Object.freeze({ durationScale: 0.78, motionScale: 0.8, continuous: true }),
  balanced: Object.freeze({ durationScale: 1, motionScale: 1, continuous: true }),
  gentle: Object.freeze({ durationScale: 1.18, motionScale: 1, continuous: true }),
  reduced: Object.freeze({ durationScale: 0.48, motionScale: 0, continuous: false }),
});

const DEFAULT_CONFIG = Object.freeze({
  preset: "balanced",
  intensity: 1,
  speed: 1,
  followReducedMotion: true,
  mode: "auto",
});

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeConfig(input = {}) {
  const preset = Object.prototype.hasOwnProperty.call(PRESETS, input.preset)
    ? input.preset
    : DEFAULT_CONFIG.preset;
  const mode = ["auto", "light", "dark"].includes(input.mode)
    ? input.mode
    : DEFAULT_CONFIG.mode;

  return {
    preset,
    intensity: Math.round(clamp(finiteNumber(input.intensity, 1), 0.5, 1.25) * 100) / 100,
    speed: Math.round(clamp(finiteNumber(input.speed, 1), 0.65, 1.4) * 100) / 100,
    followReducedMotion: input.followReducedMotion !== false,
    mode,
  };
}

function motionTokens(input = {}) {
  const config = normalizeConfig(input);
  const preset = PRESETS[config.preset];
  const durationFactor = preset.durationScale / config.speed;
  const distanceFactor = preset.motionScale * config.intensity;
  const reduced = config.preset === "reduced";

  return {
    instant: Math.round((reduced ? 70 : 80) * durationFactor),
    fast: Math.round((reduced ? 80 : 130) * durationFactor),
    base: Math.round((reduced ? 90 : 190) * durationFactor),
    slow: Math.round((reduced ? 90 : 260) * durationFactor),
    distanceSm: Math.round(3 * distanceFactor * 100) / 100,
    distanceMd: Math.round(7 * distanceFactor * 100) / 100,
    distancePanel: Math.round(8 * distanceFactor * 100) / 100,
    scaleFrom: reduced ? 1 : Math.round((1 - 0.015 * distanceFactor) * 10000) / 10000,
    // Length of the cross-fade when the app swaps its light and dark palette.
    // It is its own token because a whole-window recolour reads better slightly
    // slower than a panel entrance, and because the user's speed setting has to
    // reach this one too.
    themeSwitch: Math.round((reduced ? 90 : 160) * durationFactor),
    exitRatio: 0.72,
    continuous: preset.continuous,
    easeOut: config.preset === "gentle"
      ? "cubic-bezier(.18,.86,.24,1)"
      : "cubic-bezier(.16,1,.3,1)",
    easeStandard: "cubic-bezier(.2,0,0,1)",
    easeIn: "cubic-bezier(.4,0,1,1)",
  };
}

function tokenDeclarations(tokens) {
  return [
    `--pm-instant:${tokens.instant}ms`,
    `--pm-fast:${tokens.fast}ms`,
    `--pm-base:${tokens.base}ms`,
    `--pm-slow:${tokens.slow}ms`,
    `--pm-exit-ratio:${tokens.exitRatio}`,
    `--pm-distance-sm:${tokens.distanceSm}px`,
    `--pm-distance-md:${tokens.distanceMd}px`,
    `--pm-distance-panel:${tokens.distancePanel}px`,
    `--pm-switch:${tokens.themeSwitch}ms`,
    `--pm-scale-from:${tokens.scaleFrom}`,
    `--pm-ease-out:${tokens.easeOut}`,
    `--pm-ease-standard:${tokens.easeStandard}`,
    `--pm-ease-in:${tokens.easeIn}`,
  ].join(";");
}

function buildThemeCss(input = {}, base = "dark") {
  const config = normalizeConfig(input);
  const tokens = motionTokens(config);
  const spinRule = tokens.continuous
    ? ".spinner,[data-loading=true] .loading-spinner{animation:pm-spin 900ms linear infinite}"
    : ".spinner,[data-loading=true] .loading-spinner{animation:none}";
  const pulseRule = tokens.continuous
    ? ".streaming-indicator,.generating-indicator{animation:pm-breathe 1600ms ease-in-out infinite}"
    : ".streaming-indicator,.generating-indicator{animation:none;opacity:.72}";

  const css = `/* Pi Modify Motion Lab: ${base} motion layer. No color tokens are changed. */
:root{${tokenDeclarations(tokens)}}
/* A palette swap is a colour change on surfaces that do not otherwise animate,
   so it needs its own transition: without this the app cuts over in one frame
   and no duration setting can be felt.

   Cheap on purpose. Only background-color is animated: text colour and borders
   are spread over thousands of elements, and transitioning them re-paints text
   on every frame. The root and the body stay out as well — recolouring them
   dirties the whole document. This keeps the cross-fade on a handful of solid
   surfaces, which is what the eye actually reads as the theme changing. */
:is(.app-shell,.main-pane,.chat-surface,.sidebar-surface,.topbar,.settings-content){transition:background-color var(--pm-switch) var(--pm-ease-standard)}
:is(.sidebar-item,.project-item,.session-item,[role=option],[role=tab])[aria-selected=true]::before{animation:pm-indicator-in var(--pm-base) var(--pm-ease-out) both;transform-origin:center}
:is(.message-row,.message-item,.assistant-message,.user-message):last-child{animation:pm-message-in var(--pm-base) var(--pm-ease-out) both}
.app-shell{animation:pm-surface-in var(--pm-base) var(--pm-ease-out) both}
:is(.main-pane,.chat-surface,.settings-content,[role=tabpanel]){animation:pm-content-in var(--pm-base) var(--pm-ease-out) both}
:is(.sidebar-item,.project-item,.session-item,[role=option],[role=tab]){transition:background-color var(--pm-fast) var(--pm-ease-standard),border-color var(--pm-fast) var(--pm-ease-standard),color var(--pm-fast) var(--pm-ease-standard),opacity var(--pm-fast) var(--pm-ease-standard)}
:is(.tool-result,.thinking-content,[data-state=open]>.collapsible-content){animation:pm-fade-in var(--pm-fast) var(--pm-ease-out) both}
:is(button,[role=button],input,textarea,select){transition:background-color var(--pm-fast) var(--pm-ease-standard),border-color var(--pm-fast) var(--pm-ease-standard),box-shadow var(--pm-fast) var(--pm-ease-standard),color var(--pm-fast) var(--pm-ease-standard),opacity var(--pm-fast) var(--pm-ease-standard),transform var(--pm-instant) var(--pm-ease-out)}
:is(button,[role=button]):active:not(:disabled){transform:translateY(1px)}
:is(input,textarea,select):focus-visible{transition-duration:var(--pm-fast)}
:is([role=tooltip],.tooltip-content){animation:pm-tooltip-in var(--pm-fast) var(--pm-ease-out) both}
:is([role=menu],.popover-content,.dropdown-content,[data-radix-popper-content-wrapper]>div){animation:pm-popover-in var(--pm-base) var(--pm-ease-out) both;transform-origin:var(--radix-popover-content-transform-origin,top center)}
:is([role=dialog],.dialog-content,.modal-content){animation:pm-dialog-in var(--pm-slow) var(--pm-ease-out) both}
:is(.dialog-overlay,.modal-overlay,[data-overlay]){animation:pm-fade-in var(--pm-base) var(--pm-ease-standard) both}
:is(.work-panel,.drawer-content,[data-side=right]){animation:pm-panel-right-in var(--pm-slow) var(--pm-ease-out) both}
:is([data-side=left],.drawer-left){animation:pm-panel-left-in var(--pm-slow) var(--pm-ease-out) both}
:is(.error-message,[role=alert][data-severity=error]){animation:pm-error-nudge var(--pm-fast) var(--pm-ease-out) both}
${spinRule}
${pulseRule}
.skeleton::after{animation:${tokens.continuous ? "pm-shimmer 1600ms ease-in-out infinite" : "none"}}
@keyframes pm-surface-in{from{opacity:0;transform:translateY(var(--pm-distance-sm))}to{opacity:1;transform:translateY(0)}}
@keyframes pm-content-in{from{opacity:0;transform:translateX(var(--pm-distance-md))}to{opacity:1;transform:translateX(0)}}
@keyframes pm-message-in{from{opacity:0;transform:translateY(var(--pm-distance-md))}to{opacity:1;transform:translateY(0)}}
@keyframes pm-fade-in{from{opacity:0}to{opacity:1}}
@keyframes pm-indicator-in{from{opacity:0;transform:scaleY(.45)}to{opacity:1;transform:scaleY(1)}}
@keyframes pm-tooltip-in{from{opacity:0;transform:translateY(calc(var(--pm-distance-sm) * .66))}to{opacity:1;transform:translateY(0)}}
@keyframes pm-popover-in{from{opacity:0;transform:translateY(var(--pm-distance-sm)) scale(var(--pm-scale-from))}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes pm-dialog-in{from{opacity:0;transform:translateY(var(--pm-distance-md)) scale(var(--pm-scale-from))}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes pm-panel-right-in{from{opacity:0;transform:translateX(var(--pm-distance-panel))}to{opacity:1;transform:translateX(0)}}
@keyframes pm-panel-left-in{from{opacity:0;transform:translateX(calc(var(--pm-distance-panel) * -1))}to{opacity:1;transform:translateX(0)}}
@keyframes pm-error-nudge{0%{transform:translateX(0)}45%{transform:translateX(2px)}100%{transform:translateX(0)}}
@keyframes pm-spin{to{transform:rotate(1turn)}}
@keyframes pm-breathe{0%,100%{opacity:.48}50%{opacity:1}}
@keyframes pm-shimmer{from{transform:translateX(-110%)}to{transform:translateX(110%)}}
@media(prefers-reduced-motion:reduce){
:root{--pm-instant:70ms;--pm-fast:80ms;--pm-base:90ms;--pm-slow:90ms;--pm-switch:90ms;--pm-distance-sm:0px;--pm-distance-md:0px;--pm-distance-panel:0px;--pm-scale-from:1}
:is(.app-shell,.main-pane,.chat-surface,.settings-content,[role=tabpanel],.message-row,.message-item,.assistant-message,.user-message,.tool-result,.thinking-content,[role=tooltip],.tooltip-content,[role=menu],.popover-content,.dropdown-content,[role=dialog],.dialog-content,.modal-content,.dialog-overlay,.modal-overlay,.work-panel,.drawer-content,.error-message){animation-name:pm-fade-in;animation-duration:80ms}
:is(.spinner,[data-loading=true] .loading-spinner,.streaming-indicator,.generating-indicator){animation:none}
.skeleton::after{animation:none}
}`;

  if (Buffer.byteLength(css, "utf8") > CSS_LIMIT_BYTES) {
    throw new RangeError("Generated theme CSS exceeds the PI-Desktop 256 KB limit.");
  }
  return css;
}

function buildPreviewCss(input = {}) {
  const tokens = motionTokens(input);
  return `#motion-preview{${tokenDeclarations(tokens)}}`;
}

// `theme` is the user's own choice in the host: "system", "light", "dark", or one
// of our own theme ids. Once a plugin theme is selected the host reports that
// theme's base as `appearance.base`, so "auto" cannot read the user's intent
// from it any more — the caller passes what it knows instead: the preference it
// recorded before taking over, and whether the system currently prefers light.
function preferenceFrom(theme) {
  if (theme === "system" || theme === "light" || theme === "dark") return theme;
  return null;
}

function resolveBase(mode, appearance = {}, hints = {}) {
  if (mode === "light" || mode === "dark") return mode;
  const preference = preferenceFrom(hints.preference);
  if (preference === "light" || preference === "dark") return preference;
  if (typeof hints.prefersLight === "boolean") return hints.prefersLight ? "light" : "dark";
  if (appearance.base === "light" || appearance.theme === "light") return "light";
  return "dark";
}

module.exports = {
  CSS_LIMIT_BYTES,
  DEFAULT_CONFIG,
  PRESETS,
  SETTINGS_KEY,
  THEME_IDS,
  preferenceFrom,
  buildPreviewCss,
  buildThemeCss,
  motionTokens,
  normalizeConfig,
  resolveBase,
};
