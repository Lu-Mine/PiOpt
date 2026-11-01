"use strict";

// One theme, not two. Its base is whatever the user chose (or the system, for
// "auto"), so the host lists a single "PiOpt Appearance" entry instead of a
// light and a dark one that the user has to pick between.
const THEME_ID = "motion";
// The pre-merge pair; registered by older versions and removed on sight.
const LEGACY_THEME_IDS = Object.freeze(["motion-light", "motion-dark"]);
const SETTINGS_KEY = "motionLab";
const CSS_LIMIT_BYTES = 256 * 1024;

const LIMITS = Object.freeze({
  intensity: Object.freeze([0.5, 1.5]),
  speed: Object.freeze([0.4, 2]),
});

const PRESETS = Object.freeze({
  agile: Object.freeze({ durationScale: 0.78, motionScale: 0.8, continuous: true }),
  balanced: Object.freeze({ durationScale: 1, motionScale: 1, continuous: true }),
  gentle: Object.freeze({ durationScale: 1.18, motionScale: 1, continuous: true }),
  reduced: Object.freeze({ durationScale: 0.48, motionScale: 0, continuous: false }),
});

const DEFAULT_CONFIG = Object.freeze({
  // 总开关：关掉后不再向宿主写任何动效规则，完全交给 PI-Desktop 自己。
  override: true,
  // 彻底停用：所有过渡与动画压到 1ms。不用 none——宿主靠 animationend 卸载
  // 进场节点，none 会让这些事件永远不来，浮层就留在树上了。
  disabled: false,
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

function round(value, digits = 100) {
  return Math.round(value * digits) / digits;
}

function normalizeConfig(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const preset = Object.prototype.hasOwnProperty.call(PRESETS, source.preset)
    ? source.preset
    : DEFAULT_CONFIG.preset;
  const mode = ["auto", "light", "dark"].includes(source.mode)
    ? source.mode
    : DEFAULT_CONFIG.mode;

  return {
    override: source.override !== false,
    disabled: source.disabled === true,
    preset,
    intensity: round(clamp(finiteNumber(source.intensity, 1), LIMITS.intensity[0], LIMITS.intensity[1])),
    speed: round(clamp(finiteNumber(source.speed, 1), LIMITS.speed[0], LIMITS.speed[1])),
    followReducedMotion: source.followReducedMotion !== false,
    mode,
  };
}

/**
 * Unified motion language tokens.
 *
 * Five duration tiers (instant / fast / base / slow + system themeSwitch),
 * five spatial amplitude tiers (xs / sm / md / panel / sheet + scale pairs),
 * and one symmetric deceleration curve shared by both halves of every
 * reversible interaction (expand <-> collapse, pop <-> dismiss, slide <-> return).
 * `exitRatio` is 1 so round-trip transitions stay symmetric and interruptible.
 */
function motionTokens(input = {}) {
  const config = normalizeConfig(input);
  const preset = PRESETS[config.preset];
  const durationFactor = preset.durationScale / config.speed;
  const distanceFactor = preset.motionScale * config.intensity;
  const reduced = config.preset === "reduced";
  const easeSymmetric = config.preset === "gentle"
    ? "cubic-bezier(.2,.88,.28,1)"
    : "cubic-bezier(.22,1,.36,1)";

  return {
    instant: Math.max(16, Math.round((reduced ? 60 : 85) * durationFactor)),
    fast: Math.max(20, Math.round((reduced ? 75 : 135) * durationFactor)),
    base: Math.max(24, Math.round((reduced ? 90 : 195) * durationFactor)),
    slow: Math.max(30, Math.round((reduced ? 95 : 260) * durationFactor)),
    pressY: reduced ? 0 : 1,
    distanceXs: round(2 * distanceFactor),
    distanceSm: round(4 * distanceFactor),
    distanceMd: round(7 * distanceFactor),
    distancePanel: round(10 * distanceFactor),
    distanceSheet: round(16 * distanceFactor),
    scaleSubtle: reduced ? 1 : round(1 - 0.012 * distanceFactor, 10000),
    scaleFrom: reduced ? 1 : round(1 - 0.018 * distanceFactor, 10000),
    // Fixed on purpose: the palette cross-fade is not part of the speed/preset
    // tuning. A theme swap is a system-level change rather than part of the
    // motion design, and scaling it made the whole window feel sluggish at slow
    // settings. The reduced preset (and prefers-reduced-motion, in the generated
    // CSS) still shortens it, because that is an accessibility guarantee.
    themeSwitch: reduced ? 90 : 160,
    exitRatio: 1,
    continuous: preset.continuous,
    easeSymmetric,
    easeOut: easeSymmetric,
    easeStandard: "cubic-bezier(.2,0,0,1)",
    easeIn: "cubic-bezier(.4,0,1,1)",
  };
}

function tokenDeclarations(tokens) {
  return [
    "--pm-active:1",
    `--pm-instant:${tokens.instant}ms`,
    `--pm-fast:${tokens.fast}ms`,
    `--pm-base:${tokens.base}ms`,
    `--pm-slow:${tokens.slow}ms`,
    `--pm-exit-ratio:${tokens.exitRatio}`,
    `--pm-press-y:${tokens.pressY}px`,
    `--pm-distance-xs:${tokens.distanceXs}px`,
    `--pm-distance-sm:${tokens.distanceSm}px`,
    `--pm-distance-md:${tokens.distanceMd}px`,
    `--pm-distance-panel:${tokens.distancePanel}px`,
    `--pm-distance-sheet:${tokens.distanceSheet}px`,
    `--pm-switch:${tokens.themeSwitch}ms`,
    `--pm-scale-subtle:${tokens.scaleSubtle}`,
    `--pm-scale-from:${tokens.scaleFrom}`,
    `--pm-ease-symmetric:${tokens.easeSymmetric}`,
    `--pm-ease-out:${tokens.easeOut}`,
    `--pm-ease-standard:${tokens.easeStandard}`,
    `--pm-ease-in:${tokens.easeIn}`,
    // Bridge PI-Desktop's own motion custom properties so every native
    // transition in the host shell speaks the exact same language and scales
    // with the user's 0.4–2.0x speed slider.
    "--default-transition-duration:var(--pm-fast)",
    "--default-transition-timing-function:var(--pm-ease-standard)",
    "--motion-duration-fast:var(--pm-fast)",
    "--motion-duration-normal:var(--pm-base)",
    "--motion-duration-slow:var(--pm-slow)",
    "--motion-ease-out:var(--pm-ease-out)",
    "--motion-ease-in:var(--pm-ease-symmetric)",
    "--motion-ease-standard:var(--pm-ease-standard)",
  ].join(";");
}

const HOST_CHROME_EXIT_CSS = `
/* Glass must not depend on the motion switch. When motion is off, the host's
   own work-panel-in uses both and retains an opacity effect after it finishes.
   That effect is a Backdrop Root, so the header and panel blur lose the photo
   permanently, not just while an animation is running. Glass suppresses the
   entry here; an enabled motion layer replaces it with its own slide below.
   The exit keeps the work-panel-out prefix for the host's onAnimationEnd. */
.work-panel{animation:none!important}
.work-panel.is-exiting{animation:work-panel-out-glass 1ms linear both!important;overflow:hidden}
@keyframes work-panel-out-glass{from{flex-basis:var(--work-panel-width);width:var(--work-panel-width)}to{flex-basis:0;width:0}}
`;

const DISABLED_CSS = `/* PiOpt motion: disabled. Every transition and animation is flattened to 1ms
   rather than "none": the host unmounts entering nodes on animationend, and
   "none" would mean those events never fire. */
:root{--pm-active:0}
*,*::before,*::after{animation-duration:1ms!important;animation-delay:0ms!important;animation-iteration-count:1!important;transition-duration:1ms!important;transition-delay:0ms!important;scroll-behavior:auto!important}
${HOST_CHROME_EXIT_CSS}`;

// Interactive rows, tabs, segments, cards and options across every PI-Desktop surface.
const INTERACTIVE_SURFACES = [
  ".sidebar-item",
  ".project-item",
  ".session-item",
  ".thread-item",
  ".sidebar-session-group-header",
  ".sidebar-session-group-title",
  ".nav-item",
  ".settings-nav-item",
  ".file-tree-row",
  ".work-panel-tab",
  ".work-panel-launcher-row",
  ".plugins-row",
  ".plugins-card",
  ".plugins-filter",
  ".plugins-segment-btn",
  ".plugins-template",
  ".plugins-version",
  ".settings-segment-item",
  ".settings-row",
  ".settings-remote-host-card",
  ".dock-tab",
  ".todo-dock-row",
  ".task-row",
  ".notification-filter",
  ".notification-item",
  ".scope-seg",
  ".scope-chip",
  ".scope-option",
  ".scope-compact-option",
  ".mcpm-chip",
  ".mcpm-page-btn",
  ".mcpm-card",
  ".sklm-chip",
  ".sklm-page-btn",
  ".sklm-card",
  ".projects-row-block",
  ".projects-tag",
  ".projects-detail-task",
  ".scheduled-task",
  ".scheduled-run",
  ".scheduled-run-main",
  ".service-chooser-tile",
  ".ext-row",
  ".ext-transport-card",
  ".ext-preset-chip",
  ".provider-models-row",
  ".provider-model-card",
  ".composer-model-option",
  ".composer-ac-item",
  ".composer-plus-item",
  ".context-menu-item",
  ".home-project-switcher-item",
  ".provider-service-option",
  ".settings-font-item",
  ".settings-language-option",
  ".settings-theme-option",
  ".settings-menu-select-option",
  ".asktool-options>*",
  ".oauth-option",
  ".search-message-hit",
  "[role=option]",
  "[role=tab]",
].join(",");

// Carets and chevrons that rotate on expand/collapse across the entire app.
const DISCLOSURE_ICONS = [
  ".tool-row-caret",
  ".tool-activity-caret",
  ".review-change-card-caret",
  ".sidebar-disclosure-icon",
  ".file-tree-caret",
  ".projects-row-disclosure",
  ".import-group-chevron",
  ".provider-model-card-chevron",
  ".provider-model-multi-trigger>svg",
  ".provider-service-trigger-chevron",
  ".model-default-trigger-chevron",
  ".scope-compact-chevron",
  ".composer-mode-chip-caret",
  ".composer-model-thinking-chevron",
  ".scheduled-run-chevron",
  ".message-error-toggle svg",
  ".ext-sheet-advanced-toggle svg",
  ".settings-disclosure>summary svg",
  ".plugins-row-details-toggle svg",
  ".live-voice-work-disclosure svg:last-child",
].join(",");

// Menus that may host position:fixed submenus (or carry role=menu): opacity only,
// never transform, so nested fixed children stay anchored to the viewport.
const STATEFUL_MENUS = [
  ".context-menu",
  ".composer-permission-menu",
  ".composer-mode-menu",
  ".plan-approval-menu",
  ".agent-capability-menu",
  ".projects-menu",
  ".plugins-menu",
  ".scope-compact-menu",
].join(",");

// Standalone popovers and pickers that toggle `.is-open`: symmetric opacity + subtle lift/scale,
// resting at `transform: none` so no containing block remains once open.
const STATEFUL_POPOVERS = [
  ".settings-font-menu",
  ".settings-language-menu",
  ".settings-theme-menu",
  ".settings-menu-select-menu",
  ".provider-model-menu",
  ".provider-model-multi-menu",
  ".provider-service-menu",
  ".model-default-menu",
  ".home-project-switcher-menu",
  ".composer-autocomplete",
  ".scope-popover",
  ".turn-usage-popover",
  ".context-inspector-popover",
  ".live-voice-popup",
].join(",");

const SPINNERS = [
  ".spinner",
  "[data-loading=true] .loading-spinner",
  ".voice-spinner",
  ".route-pending-indicator",
  ".tool-spinner",
  ".provider-model-spinner",
  ".provider-models-reload.is-loading svg",
].join(",");

const PULSES = [
  ".streaming-indicator",
  ".generating-indicator",
  ".voice-mic-active",
  ".voice-recording-dot",
  ".dock-live-dot",
  ".task-row[data-state=running] .task-state",
  ".project-run-badge-dot",
  ".working-indicator-mark>span",
  ".activity-marker",
  ".tool-row-state.is-running .tool-row-state-dot",
  ".subagent-topology-node.outcome-creating .subagent-topology-status-icon",
  ".agent-capability-badge.is-connecting .agent-capability-status-dot",
  ".scheduled-task-live",
].join(",");

const SKELETON_LINES = [
  ".transcript-skeleton-line",
  ".plugins-skeleton-line",
  ".agent-capability-skeleton-glyph",
  ".agent-capability-skeleton-line",
  ".mermaid-loading>span",
].join(",");

// Even with motion override off, glass needs these two host-animation guards.
function buildThemeCss(input = {}, base = "dark") {
  const config = normalizeConfig(input);
  // 完全禁用优先于总开关：这是用户对「还要不要动效」的直接回答。
  if (config.disabled) return DISABLED_CSS;
  // 总开关关掉时不写动效，只保留材质所必需的宿主进出场保护。
  if (!config.override) return `:root{--pm-active:0}\n${HOST_CHROME_EXIT_CSS}`;

  const tokens = motionTokens(config);
  const spinRule = tokens.continuous
    ? `.spinner,[data-loading=true] .loading-spinner{animation:pm-spin 900ms linear infinite}\n:is(${SPINNERS}){animation:pm-spin 900ms linear infinite}`
    : `.spinner,[data-loading=true] .loading-spinner{animation:none}\n:is(${SPINNERS}){animation:none}`;
  const pulseRule = tokens.continuous
    ? `.streaming-indicator,.generating-indicator{animation:pm-breathe 1600ms ease-in-out infinite}\n:is(${PULSES}){animation:pm-breathe 1600ms ease-in-out infinite}`
    : `.streaming-indicator,.generating-indicator{animation:none;opacity:.72}\n:is(${PULSES}){animation:none;opacity:.72}`;
  const skeletonRule = tokens.continuous
    ? `.skeleton::after{animation:pm-shimmer 1600ms ease-in-out infinite}\n:is(${SKELETON_LINES}){animation:pm-breathe 1400ms ease-in-out infinite}`
    : `.skeleton::after{animation:none}\n:is(${SKELETON_LINES}){animation:none;opacity:.68}`;

  // 推理强度滑杆：档位是一格一格的，滑钮落到哪一格就「吸」到哪一格 —— 用一条带过冲
  // 的曲线替掉宿主的等时过渡，滑钮与进度条先越过一点再回落，点亮的那一格同时弹一下。
  // 拖动中宿主自己要求无过渡（指针到哪到哪），那条规则特异性更高，不会被这里盖掉；
  // reduced 预设不做过冲，系统「减弱动态」时连过渡都不留。
  // 选择器都带上 .composer-thinking-slider：上面那条通用 :is(…) 列表里混着
  // `.update-notice-progress>span` 这种「类 + 类型」的项，:is() 取其中最具体的那一个
  // （0,1,1），只写一个类（0,1,0）压不过它，过冲曲线就永远用不上。
  const thinkingSnap = tokens.continuous
    ? `.composer-thinking-slider .composer-thinking-thumb{transition:left var(--pm-base) cubic-bezier(.34,1.44,.64,1),transform var(--pm-fast) var(--pm-ease-symmetric)}
.composer-thinking-slider .composer-thinking-rail::after{transition:left var(--pm-base) cubic-bezier(.34,1.44,.64,1),width var(--pm-base) cubic-bezier(.34,1.44,.64,1),background-color var(--pm-fast) var(--pm-ease-standard)}
.composer-thinking-slider .composer-thinking-dot.active{animation:pm-thinking-snap var(--pm-base) var(--pm-ease-out) backwards}
/* 拖动中也要「吸」：宿主在拖动态把过渡关成 none，这里用更具体的选择器把它压回来。
   reduced 预设只留普通过渡，没有过冲。 */
.composer-thinking-slider[data-dragging].composer-thinking-slider .composer-thinking-rail>.composer-thinking-thumb{transition:left var(--pm-fast) cubic-bezier(.34,1.44,.64,1),transform var(--pm-fast) var(--pm-ease-symmetric)}
.composer-thinking-slider[data-dragging].composer-thinking-slider .composer-thinking-rail::after{transition:left var(--pm-fast) cubic-bezier(.34,1.44,.64,1),width var(--pm-fast) cubic-bezier(.34,1.44,.64,1)}
@keyframes pm-thinking-snap{0%{transform:scale(.55)}55%{transform:scale(1.45)}100%{transform:scale(1)}}`
    : `.composer-thinking-slider .composer-thinking-thumb{transition:left var(--pm-fast) var(--pm-ease-symmetric)}
.composer-thinking-slider .composer-thinking-rail::after{transition:width var(--pm-fast) var(--pm-ease-symmetric)}
.composer-thinking-slider[data-dragging].composer-thinking-slider .composer-thinking-rail>.composer-thinking-thumb{transition:left var(--pm-fast) var(--pm-ease-symmetric)}
.composer-thinking-slider[data-dragging].composer-thinking-slider .composer-thinking-rail::after{transition:width var(--pm-fast) var(--pm-ease-symmetric)}`;

  const reducedMedia = config.followReducedMotion
    ? `@media(prefers-reduced-motion:reduce){
:root{--pm-active:0;--pm-instant:60ms;--pm-fast:75ms;--pm-base:85ms;--pm-slow:90ms;--pm-switch:90ms;--pm-press-y:0px;--pm-distance-xs:0px;--pm-distance-sm:0px;--pm-distance-md:0px;--pm-distance-panel:0px;--pm-distance-sheet:0px;--pm-scale-subtle:1;--pm-scale-from:1}
:is(.chat-surface,.route-page,.route-surface,.settings-content,.settings-content-enter,.plugins-page,.scheduled-frame,.mcpm,.sklm,[role=tabpanel],.scheduled-detail,.message-row,.message-item,.assistant-message,.user-message,.asktool-card,.permission-card,.plan-approval-bar,.turn-outcome-card,.planning-state-indicator,.composer-queued-prompt,.composer-directory-drop,.message-edit,.composer-chip,.message-attachment,.tool-result,.thinking-content,.tool-row-body,.review-change-card-body,.task-output,.message-error-details,.projects-inspector,.provider-model-card-details,.provider-chosen-row-body,.ext-sheet-advanced-body,[role=tooltip],.tooltip-content,.ui-tooltip,.sidebar-session-hover-card,.minimap-popover,.image-hover-card,[role=menu],.popover-content,.dropdown-content,.sidebar-row-menu,.sidebar-popover,[role=dialog],.dialog,.p-dialog,.dialog-content,.modal-content,.plugins-modal,.search-dialog,.plugins-sheet,.plugins-reviews,.mcpm-sheet,.sklm-sheet,.overlay,.search-overlay,.dialog-overlay,.modal-overlay,.plugins-modal-backdrop,.plugins-sheet-scrim,.plugins-reviews-scrim,.mcpm-overlay,.sklm-overlay,.drawer-content,.toast,.update-notice,.chat-error-notice,.backend-banner,.p-notice,.jump-latest-btn,.error-message){animation-name:pm-fade-in;animation-duration:80ms}
:is(button,[role=button]):active:not(:disabled):not([role=menuitem]){transform:none}
.work-panel,.work-panel.is-exiting,.sidebar.is-entering,.sidebar.is-exiting,:root[data-platform=win32] .sidebar.is-exiting{animation-duration:80ms}
details::details-content{transition-duration:80ms}
:is(${SPINNERS},${PULSES},${SKELETON_LINES}){animation:none}
.skeleton::after{animation:none}
.composer-thinking-slider .composer-thinking-thumb{transition:none}
.composer-thinking-slider .composer-thinking-rail::after{transition:none}
.composer-thinking-slider .composer-thinking-dot.active{animation:none}
}`
    : "";

  const css = `/* Pi Modify Motion Lab: ${base} motion layer. No color tokens are changed. */
:root{${tokenDeclarations(tokens)}}
details{interpolate-size:allow-keywords}
/* System palette cross-fade: cheap single-property transition on primary solid surfaces. */
:is(.app-shell,.main-pane,.chat-surface,.sidebar-surface,.topbar,.settings-content){transition:background-color var(--pm-switch) var(--pm-ease-standard)}
/* Layer 1: Controls, switches, inputs, tabs, segments and interactive rows (symmetric & interruptible). */
:is(button,[role=button],.btn,.icon-btn,.title-nav-btn,.send-btn,.stop-btn,.copy-btn,input,textarea,select,.field-input,.field-textarea){transition:background-color var(--pm-fast) var(--pm-ease-standard),border-color var(--pm-fast) var(--pm-ease-standard),box-shadow var(--pm-fast) var(--pm-ease-standard),color var(--pm-fast) var(--pm-ease-standard),opacity var(--pm-fast) var(--pm-ease-standard),transform var(--pm-instant) var(--pm-ease-symmetric)}
/* Menu items are excluded: nudging one by a pixel while a submenu is open from it moves the trigger out from under the pointer. */
:is(button,[role=button]):active:not(:disabled):not([role=menuitem]){transform:translateY(1px)}
:is(input,textarea,select,.field-input,.field-textarea):focus-visible{transition-duration:var(--pm-fast)}
.composer-shell{transition:background-color var(--pm-fast) var(--pm-ease-standard),border-color var(--pm-fast) var(--pm-ease-standard),box-shadow var(--pm-base) var(--pm-ease-symmetric),transform var(--pm-base) var(--pm-ease-symmetric)}
:is(.settings-search-wrap,.plugins-search-wrap,.provider-models-search-wrap,.provider-chosen-search-wrap,.agent-capability-search-wrap,.projects-search-wrap){transition:background-color var(--pm-fast) var(--pm-ease-standard),border-color var(--pm-fast) var(--pm-ease-standard),box-shadow var(--pm-fast) var(--pm-ease-standard)}
.settings-toggle{transition:background-color var(--pm-fast) var(--pm-ease-symmetric),box-shadow var(--pm-fast) var(--pm-ease-standard)}
.settings-toggle-thumb{transition:transform var(--pm-fast) var(--pm-ease-symmetric),background-color var(--pm-fast) var(--pm-ease-standard)}
:is(.composer-thinking-thumb,.composer-thinking-dot,.composer-thinking-tick,.update-notice-progress>span,.plugins-install-bar-fill,.plugins-reviews-dist-fill,.settings-config-sync-progress-bar-fill,.voice-volume-fill){transition:transform var(--pm-fast) var(--pm-ease-symmetric),width var(--pm-base) var(--pm-ease-symmetric),background-color var(--pm-fast) var(--pm-ease-standard),opacity var(--pm-fast) var(--pm-ease-standard)}
${thinkingSnap}
:is(${INTERACTIVE_SURFACES}){transition:background-color var(--pm-fast) var(--pm-ease-standard),border-color var(--pm-fast) var(--pm-ease-standard),box-shadow var(--pm-fast) var(--pm-ease-standard),color var(--pm-fast) var(--pm-ease-standard),opacity var(--pm-fast) var(--pm-ease-standard)}
:is(.sidebar-item,.project-item,.session-item,[role=option],[role=tab])[aria-selected=true]::before{animation:pm-indicator-in var(--pm-base) var(--pm-ease-out) backwards;transform-origin:center}
:is(.thread-item-more,.thread-item-last-reply,.sidebar-session-group-add,.tool-row-head-copy,.tool-row-copy,.message-actions,.work-panel-tab-close,.plugins-search-clear,.agent-capability-search-clear,.ext-row-actions,.sidebar-resize-handle::after,.chat-width-handle::before){transition:opacity var(--pm-fast) var(--pm-ease-symmetric),background-color var(--pm-fast) var(--pm-ease-standard),color var(--pm-fast) var(--pm-ease-standard)}
:is(${DISCLOSURE_ICONS}){transition:transform var(--pm-fast) var(--pm-ease-symmetric),color var(--pm-fast) var(--pm-ease-standard),opacity var(--pm-fast) var(--pm-ease-standard)}
.plugins-row-details[open]>.plugins-row-details-toggle svg{transform:rotate(90deg)}
/* Layer 2: Symmetric & interruptible expand/collapse (Grid disclosures, <details>, chrome width & topbar sync). */
.sidebar-session-group-body.project{transition:grid-template-rows var(--pm-base) var(--pm-ease-symmetric)}
.sidebar-session-group-body.project>.sidebar-session-group-clip{opacity:1;transition:opacity var(--pm-base) var(--pm-ease-symmetric)}
.sidebar-session-group-body.project.collapsed>.sidebar-session-group-clip{opacity:0}
:is(.todo-dock-content,.dock-content){transition:grid-template-rows var(--pm-base) var(--pm-ease-symmetric),opacity var(--pm-base) var(--pm-ease-symmetric),transform var(--pm-base) var(--pm-ease-symmetric)}
.tool-activity-collapse{transition:grid-template-rows var(--pm-base) var(--pm-ease-symmetric),opacity var(--pm-base) var(--pm-ease-symmetric)}
.tool-activity-collapse-inner{min-height:0;overflow:hidden}
details::details-content{overflow:hidden;block-size:0;opacity:0;transition:block-size var(--pm-base) var(--pm-ease-symmetric),opacity var(--pm-base) var(--pm-ease-symmetric),content-visibility var(--pm-base) allow-discrete}
details[open]::details-content{block-size:auto;opacity:1}
.conversation-topbar,.conversation-topbar.ct-collapsed{transition:padding-left var(--pm-base) var(--pm-ease-symmetric)}
.conversation-topbar .ct-lead,.conversation-topbar.ct-collapsed .ct-lead{transition:left var(--pm-base) var(--pm-ease-symmetric),opacity var(--pm-base) var(--pm-ease-symmetric)}
.main-pane,.app-shell.sidebar-collapsed .main-pane{--chat-width-transition:var(--pm-base) var(--pm-ease-symmetric)}
.transcript-settle-veil{transition:opacity var(--pm-fast) var(--pm-ease-symmetric)}
/* Layer 3: Symmetric & interruptible popovers, menus, tooltips, dialogs and sheets.
   Every entrance keyframe uses backwards (never both) so no resting transform re-anchors fixed children.
   Menus never animate transform at all because nested submenus resolve viewport coordinates. */
:is([role=tooltip],.tooltip-content,.ui-tooltip,.sidebar-session-hover-card,.minimap-popover,.image-hover-card){animation:pm-fade-in var(--pm-fast) var(--pm-ease-out) backwards}
:is([role=menu],.popover-content,.dropdown-content,[data-radix-popper-content-wrapper]>div,.sidebar-row-menu,.sidebar-popover){animation:pm-fade-in var(--pm-base) var(--pm-ease-out) backwards}
.composer-model-thinking-menu:not(.is-open){opacity:0;visibility:hidden;pointer-events:none}
.composer-model-thinking-menu.is-open{opacity:1;visibility:visible;pointer-events:auto;animation:none}
:is(${STATEFUL_MENUS},.composer-model-thinking-menu){animation:none;transition:opacity var(--pm-fast) var(--pm-ease-symmetric),visibility 0s linear var(--pm-fast)}
:is(${STATEFUL_MENUS},.composer-model-thinking-menu).is-open{animation:none;transition:opacity var(--pm-fast) var(--pm-ease-symmetric),visibility 0s linear 0s}
/* Composer menus share the model selector's WAAPI pop/retract language. */
:is(.composer-mode-menu,.composer-permission-menu){transform-origin:0 100%;transition:none!important}
:is(${STATEFUL_POPOVERS}){animation:none;transform:translateY(var(--pm-distance-xs)) scale(var(--pm-scale-subtle));transition:opacity var(--pm-fast) var(--pm-ease-symmetric),transform var(--pm-fast) var(--pm-ease-symmetric),visibility 0s linear var(--pm-fast)}
:is(${STATEFUL_POPOVERS}).is-open{animation:none;transform:none;transition:opacity var(--pm-fast) var(--pm-ease-symmetric),transform var(--pm-fast) var(--pm-ease-symmetric),visibility 0s linear 0s}
:is(.overlay,.search-overlay,.dialog-overlay,.modal-overlay,.plugins-modal-backdrop,.plugins-sheet-scrim,.plugins-reviews-scrim,.mcpm-overlay,.sklm-overlay,[data-overlay]){animation:pm-fade-in var(--pm-base) var(--pm-ease-symmetric) backwards}
:is([role=dialog]:not(.plugins-sheet):not(.plugins-reviews):not(.turn-usage-popover):not(.context-inspector-popover):not(.scope-popover):not(.settings-menu-select-menu),.dialog,.p-dialog,.dialog-content,.modal-content,.plugins-modal){animation:pm-dialog-in var(--pm-slow) var(--pm-ease-out) backwards}
.search-dialog{animation:pm-dialog-top-in var(--pm-slow) var(--pm-ease-out) backwards}
:is(.plugins-sheet,.plugins-reviews,.mcpm-sheet,.sklm-sheet){animation:pm-sheet-right-in var(--pm-slow) var(--pm-ease-out) backwards}
:is(.composer-image-preview,.generated-image-viewer)[open]{animation:pm-dialog-in var(--pm-base) var(--pm-ease-out) backwards}
/* Layer 4: Frosted-safe panels & sidebars (no opacity keyframes on ancestors of backdrop-filter). */
:is(.drawer-content,[data-side=right]){animation:pm-panel-right-in var(--pm-slow) var(--pm-ease-out) backwards}
.work-panel{animation:none!important}
.work-panel[data-pm-wp-phase=in]{animation:work-panel-in-pm var(--pm-slow) var(--pm-ease-symmetric) backwards!important}
.work-panel.work-panel[data-pm-wp-phase=out]{animation:work-panel-out-pm var(--pm-slow) var(--pm-ease-symmetric) both!important;overflow:hidden}
/* The flex allocation changes once per frame, but the sheet's content stays rigid.
   Its left edge moves toward the viewport edge, carrying unchanged text with it. */
.work-panel:not(.is-maximized):not([data-resizing=true])>.work-panel-main{flex:0 0 var(--work-panel-width);width:var(--work-panel-width);min-width:var(--work-panel-width)}
.app-chat-shell:has(.work-panel) :is(.thread-content,.composer-stack,.home-stack-inner){transition:none!important}
/* app-chat-shell is display:contents in the host, so it cannot clip overflow.
   Clip at the real flex shell: a fixed-width incoming panel otherwise lets
   tab scrollIntoView/focus scroll #root and pull even the project list left. */
.app-shell:has(.work-panel){overflow:clip}
/* Keep the Todo panel measurable while the enclosing grid collapses. The host
   hides this panel immediately, otherwise its intrinsic height becomes zero. */
.dock:not(.is-expanded) .dock-panel[hidden]:has(.todo-dock-list){display:block!important;pointer-events:none}
.dock:not(.is-expanded) .dock-content{pointer-events:none}
.dock-panel:not([hidden]){animation:pm-fade-in var(--pm-fast) var(--pm-ease-symmetric) backwards}
/* Dock height is owned by one runtime animation, including the settled frame. */
:is(.dock-content,.todo-dock-content){transition:none!important;transform:none!important}
:is(.dock-content,.todo-dock-content)[data-pm-dock-motion]{grid-template-rows:minmax(0,1fr)!important;overflow:hidden}
:is(.dock-content,.todo-dock-content)[data-pm-dock-motion] .dock-panel{animation:none!important}
@starting-style{.context-menu.is-open{opacity:0}}
.sidebar.is-entering{animation:sidebar-in-pm var(--pm-base) var(--pm-ease-symmetric) backwards}
.sidebar.is-exiting,:root[data-platform=win32] .sidebar.is-exiting{animation:sidebar-out-pm var(--pm-base) var(--pm-ease-symmetric) both}
:is([data-side=left],.drawer-left){animation:pm-panel-left-in var(--pm-slow) var(--pm-ease-out) backwards}
/* Layer 5: Route surfaces, tab views, chat stream, inline disclosures, chips and notifications. */
:is(.chat-surface,.route-page,.settings-content){animation:pm-content-in var(--pm-base) var(--pm-ease-out) backwards}
:is(.route-surface,.settings-content-enter,.plugins-page,.scheduled-frame,.mcpm,.sklm){animation:pm-content-in var(--pm-base) var(--pm-ease-out) backwards}
:is(.work-panel-tabpane,.work-panel-launcher,.scheduled-detail){animation:pm-view-in var(--pm-fast) var(--pm-ease-out) backwards}
:is(.message-row,.message-item,.assistant-message,.user-message):last-child{animation:pm-message-in var(--pm-base) var(--pm-ease-out) backwards}
:is(.asktool-card,.permission-card,.plan-approval-bar,.turn-outcome-card,.planning-state-indicator,.composer-queued-prompt,.composer-directory-drop,.message-edit){animation:pm-card-in var(--pm-base) var(--pm-ease-out) backwards}
:is(.composer-chip,.message-attachment,.composer-mode-chip-face,.plugins-card-review-text,.project-memory-card){animation:pm-subtle-in var(--pm-fast) var(--pm-ease-out) backwards}
.composer-placeholder:not(.composer-placeholder-suggestion){animation:pm-placeholder-in var(--pm-fast) var(--pm-ease-out) backwards}
:is(.tool-result,.thinking-content,[data-state=open]>.collapsible-content,.tool-row-body,.review-change-card-body,.task-output,.message-error-details,.projects-inspector,.provider-model-card-details,.provider-chosen-row-body,.ext-sheet-advanced-body,.scheduled-instruction.is-open){animation:pm-fade-in var(--pm-fast) var(--pm-ease-out) backwards}
.jump-latest-btn{animation:pm-pop-in var(--pm-base) var(--pm-ease-out) backwards}
:is(.toast,.update-notice,.chat-error-notice,.backend-banner,.p-notice){animation:pm-toast-in var(--pm-base) var(--pm-ease-out) backwards}
.toast.closing{animation:toast-out-pm var(--pm-base) var(--pm-ease-symmetric) forwards}
:is(.error-message,[role=alert][data-severity=error]){animation:pm-error-nudge var(--pm-fast) var(--pm-ease-out) backwards}
/* Settings containers are reused across category changes; the runtime owns the fade. */
.settings-content,.settings-content-enter{animation:none}
${spinRule}
${pulseRule}
${skeletonRule}
@keyframes pm-content-in{from{opacity:0;transform:translateX(var(--pm-distance-md))}to{opacity:1;transform:translateX(0)}}
@keyframes pm-view-in{from{opacity:0;transform:translateY(var(--pm-distance-xs))}to{opacity:1;transform:translateY(0)}}
@keyframes pm-message-in{from{opacity:0;transform:translateY(var(--pm-distance-md))}to{opacity:1;transform:translateY(0)}}
@keyframes pm-card-in{from{opacity:0;transform:translateY(var(--pm-distance-sm)) scale(var(--pm-scale-subtle))}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes pm-subtle-in{from{opacity:0;transform:translateY(var(--pm-distance-xs))}to{opacity:1;transform:translateY(0)}}
@keyframes pm-placeholder-in{from{opacity:0}to{opacity:.72}}
@keyframes pm-fade-in{from{opacity:0}to{opacity:1}}
@keyframes pm-pop-in{from{opacity:0;scale:var(--pm-scale-from)}to{opacity:1;scale:1}}
@keyframes pm-indicator-in{from{opacity:0;transform:scaleY(.45)}to{opacity:1;transform:scaleY(1)}}
@keyframes pm-dialog-in{from{opacity:0;transform:translateY(var(--pm-distance-md)) scale(var(--pm-scale-from))}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes pm-dialog-top-in{from{opacity:0;transform:translateY(calc(var(--pm-distance-md) * -1)) scale(var(--pm-scale-from))}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes pm-sheet-right-in{from{opacity:0;transform:translateX(var(--pm-distance-sheet))}to{opacity:1;transform:translateX(0)}}
@keyframes pm-toast-in{from{opacity:0;transform:translateY(calc(var(--pm-distance-sm) * -1)) scale(var(--pm-scale-subtle))}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes toast-out-pm{from{opacity:1;transform:translateY(0) scale(1)}to{opacity:0;transform:translateY(calc(var(--pm-distance-sm) * -1)) scale(var(--pm-scale-subtle))}}
@keyframes pm-panel-right-in{from{transform:translateX(var(--pm-distance-panel))}to{transform:translateX(0)}}
@keyframes work-panel-in-pm{from{flex-basis:var(--pm-wp-from,0px);width:var(--pm-wp-from,0px)}to{flex-basis:var(--work-panel-width);width:var(--work-panel-width)}}
@keyframes work-panel-out-pm{from{flex-basis:var(--pm-wp-from,var(--work-panel-width));width:var(--pm-wp-from,var(--work-panel-width))}to{flex-basis:0;width:0}}
@keyframes sidebar-in-pm{from{flex-basis:var(--pm-sb-from,0px);width:var(--pm-sb-from,0px);transform:translateX(var(--pm-sb-shift,calc(var(--pm-distance-panel) * -1)))}to{flex-basis:var(--ds-sidebar-width);width:var(--ds-sidebar-width);transform:translateX(0)}}
@keyframes sidebar-out-pm{from{flex-basis:var(--pm-sb-from,var(--ds-sidebar-width));width:var(--pm-sb-from,var(--ds-sidebar-width));transform:translateX(var(--pm-sb-shift,0px))}to{flex-basis:0;width:0;transform:translateX(calc(var(--pm-distance-panel) * -1))}}
@keyframes pm-panel-left-in{from{transform:translateX(calc(var(--pm-distance-panel) * -1))}to{transform:translateX(0)}}
@keyframes pm-error-nudge{0%{transform:translateX(0)}45%{transform:translateX(2px)}100%{transform:translateX(0)}}
@keyframes pm-spin{to{transform:rotate(1turn)}}
@keyframes pm-breathe{0%,100%{opacity:.48}50%{opacity:1}}
@keyframes pm-shimmer{from{transform:translateX(-110%)}to{transform:translateX(110%)}}
${reducedMedia}`;

  if (Buffer.byteLength(css, "utf8") > CSS_LIMIT_BYTES) {
    throw new RangeError("Generated theme CSS exceeds the PI-Desktop 256 KB limit.");
  }
  return css;
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

// "Auto" means the system, full stop. A preference recorded earlier only says
// what the user picked in the host back then — following it would make "auto"
// copy whichever colour they last switched to, which is exactly what it must not
// do. The system reading is therefore checked first; the recorded preference and
// then the host's own base are only fallbacks for when the page cannot report it.
function resolveBase(mode, appearance = {}, hints = {}) {
  if (mode === "light" || mode === "dark") return mode;
  if (typeof hints.prefersLight === "boolean") return hints.prefersLight ? "light" : "dark";
  const preference = preferenceFrom(hints.preference);
  if (preference === "light" || preference === "dark") return preference;
  if (appearance.base === "light" || appearance.theme === "light") return "light";
  return "dark";
}

module.exports = {
  CSS_LIMIT_BYTES,
  DEFAULT_CONFIG,
  DISABLED_CSS,
  LEGACY_THEME_IDS,
  LIMITS,
  PRESETS,
  SETTINGS_KEY,
  THEME_ID,
  buildThemeCss,
  motionTokens,
  normalizeConfig,
  preferenceFrom,
  resolveBase,
};
