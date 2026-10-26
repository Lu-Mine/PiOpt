(function () {
  "use strict";
"use strict";

const DEFAULT_CONFIG = {
  preset: "balanced",
  intensity: 1,
  speed: 1,
  followReducedMotion: true,
  mode: "auto",
};

const PRESET_COPY = {
  agile: "更短时长，保留必要方向感",
  balanced: "平衡的响应速度与空间感",
  gentle: "柔和归位，不增加运动距离",
  reduced: "仅保留短促的透明度反馈",
};

const state = {
  config: { ...DEFAULT_CONFIG },
  appearance: { base: "dark", theme: "dark", pluginTheme: null },
  // The user's own choice in PI-Desktop ("system" / "light" / "dark"), reported
  // by the plugin process: once a Motion Lab theme owns the selection the host
  // reports that theme's base instead, so "auto" has to lean on this.
  preference: "system",
  // The base that is currently on screen, used to notice that "auto" has to
  // follow a changed appearance.
  appliedBase: "dark",
  tokens: null,
  dirty: false,
  busy: false,
  syncVersion: 0,
  syncTimer: null,
  syncPromise: null,
  // The measured system base for "auto", or null when it still has to be read.
  systemBase: null,
};

const elements = {};
const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const lightQuery = window.matchMedia("(prefers-color-scheme: light)");

function hints() {
  // Only what the page can tell the process: which way the system leans.
  return { prefersLight: lightQuery.matches };
}

function byId(id) {
  return document.getElementById(id);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* Mirrors features/motion/motion.js so the panel can show token values before
   the process answers. */
const PRESETS = {
  agile: { durationScale: 0.78, motionScale: 0.8 },
  balanced: { durationScale: 1, motionScale: 1 },
  gentle: { durationScale: 1.18, motionScale: 1 },
  reduced: { durationScale: 0.48, motionScale: 0 },
};
// The slowest and fastest the speed slider reaches; keep in step with the
// min/max on #speed in index.html.
const SPEED_MIN = 0.6;
const SPEED_MAX = 1.6;
const INTENSITY_MIN = 0.5;
const INTENSITY_MAX = 1.5;

function localTokens(config) {
  const preset = PRESETS[config.preset] || PRESETS.balanced;
  const reduced = config.preset === "reduced" || (config.followReducedMotion && reducedQuery.matches);
  const durationFactor = (reduced ? 0.48 : preset.durationScale) / clamp(config.speed, SPEED_MIN, SPEED_MAX);
  const distanceFactor = reduced ? 0 : preset.motionScale * clamp(config.intensity, INTENSITY_MIN, INTENSITY_MAX);
  return {
    instant: Math.round((reduced ? 70 : 80) * durationFactor),
    fast: Math.round((reduced ? 80 : 130) * durationFactor),
    base: Math.round((reduced ? 90 : 190) * durationFactor),
    slow: Math.round((reduced ? 90 : 260) * durationFactor),
    distanceSm: Math.round(3 * distanceFactor * 100) / 100,
    distanceMd: Math.round(7 * distanceFactor * 100) / 100,
    scaleFrom: reduced ? 1 : Math.round((1 - 0.015 * distanceFactor) * 10000) / 10000,
    easeOut: config.preset === "gentle" ? "cubic-bezier(.18,.86,.24,1)" : "cubic-bezier(.16,1,.3,1)",
    easeStandard: "cubic-bezier(.2,0,0,1)",
    easeIn: "cubic-bezier(.4,0,1,1)",
  };
}


async function invoke(channel, payload = {}) {
  if (window.pluginBridge && typeof window.pluginBridge.invoke === "function") {
    return window.pluginBridge.invoke(channel, payload);
  }
  if (channel === "motion.getState") {
    return { config: { ...DEFAULT_CONFIG }, appearance: state.appearance, resolvedBase: "dark", themes: [] };
  }
  if (channel === "motion.tokens") {
    return { config: payload.config, tokens: localTokens(payload.config || state.config) };
  }
  if (channel === "motion.reset") return { ok: true, config: { ...DEFAULT_CONFIG } };
  if (channel === "motion.save" || channel === "motion.apply") {
    return { ok: true, config: payload.config, appliedTheme: "preview" };
  }
  throw new Error(`Unknown preview channel: ${channel}`);
}
function resolvedBase() {
  if (state.config.mode === "light" || state.config.mode === "dark") return state.config.mode;
  // "Auto" shows what the process last resolved, not this page's media query:
  // the host pins that query to our own base while our theme is applied.
  return state.appliedBase;
}

function applyAppearance(appearance) {
  if (appearance && typeof appearance === "object") state.appearance = appearance;
  if (typeof state.appearance.locale === "string" && state.appearance.locale) {
    document.documentElement.lang = state.appearance.locale;
  }
  renderMode();
}

// One place that takes the process's answer. `preference` and `resolvedBase` come
// from the process, so the page and the process cannot disagree about what "auto"
// means — that disagreement is what once flipped the theme several times a second.
function applyResult(result) {
  if (!result || typeof result !== "object") return;
  if (result.config) state.config = { ...DEFAULT_CONFIG, ...result.config };
  if (typeof result.preference === "string") state.preference = result.preference;
  if (result.appearance) state.appearance = result.appearance;
  if (typeof result.resolvedBase === "string") state.appliedBase = result.resolvedBase;
  document.documentElement.dataset.base = state.appliedBase;
  renderConfig();
}

// The host pins `nativeTheme.themeSource` to our theme's base, so this page's
// `prefers-color-scheme` reports our own base back at us — reading it while the
// theme is applied can only confirm what we already applied, which is why "auto"
// appeared to do nothing on a dark system. Asking the plugin process is free: it
// reads the OS preference (registry / plist / gsettings) without touching the
// active theme. Handing the selection back to the host is only the fallback,
// because that hand-back recolours the whole window for ~150ms.
async function measureSystemBase() {
  try {
    const result = await invoke("motion.systemBase");
    if (result && (result.base === "light" || result.base === "dark")) return result.base;
  } catch {
    /* the process could not read the OS; fall through */
  }
  await invoke("motion.release");
  await new Promise((resolve) => setTimeout(resolve, 150));
  return lightQuery.matches ? "light" : "dark";
}

async function ensureSystemBase() {
  if (state.systemBase === "light" || state.systemBase === "dark") return state.systemBase;
  state.systemBase = await measureSystemBase();
  return state.systemBase;
}

// What the page contributes to "auto": the measured system base, never the
// locked-down media query.
async function autoHints() {
  return { prefersLight: (await ensureSystemBase()) === "light" };
}

function setBusy(busy) {
  state.busy = busy;
  elements.resetButton.disabled = busy;
  elements.stopButton.disabled = busy;
}

let toastTimer;
function toast(message, error = false) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 3200);
}

function setSyncState(status, detail = "") {
  const titles = {
    ready: "实时应用已就绪",
    pending: "正在同步到 PI-Desktop",
    error: "实时同步失败",
  };
  const title = titles[status] || titles.ready;
  elements.syncDot.dataset.state = status;
  elements.syncDot.title = detail || title;
  elements.titleStatus.textContent = detail || title;
}

function markDirty(dirty = true) {
  state.dirty = dirty;
  if (dirty) setSyncState("pending");
  else setSyncState("ready");
}

function renderPressed(selector, attribute, value) {
  document.querySelectorAll(selector).forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset[attribute] === value));
  });
}

function renderMode() {
  renderPressed("[data-mode]", "mode", state.config.mode);
}

/* Feeds the filled track in renderer/motion.css with the current value ratio. */
function paintRange(input) {
  if (!input) return;
  const min = Number(input.min) || 0;
  const span = (Number(input.max) || 100) - min || 1;
  const ratio = Math.max(0, Math.min(1, (Number(input.value) - min) / span));
  input.style.setProperty("--fill", `${Math.round(ratio * 1000) / 10}%`);
}

function renderConfig() {
  renderPressed("[data-preset]", "preset", state.config.preset);
  elements.presetSummary.textContent = PRESET_COPY[state.config.preset] || PRESET_COPY.balanced;
  elements.intensity.value = String(Math.round(state.config.intensity * 100));
  elements.speed.value = String(Math.round(state.config.speed * 100));
  elements.intensityValue.textContent = `${Math.round(state.config.intensity * 100)}%`;
  elements.speedValue.textContent = `${state.config.speed.toFixed(2)}×`;
  paintRange(elements.intensity);
  paintRange(elements.speed);
  elements.followReduced.checked = state.config.followReducedMotion;
  renderMode();
}

function renderTokens(tokens) {
  state.tokens = tokens;
  elements.tokenInstant.textContent = `${tokens.instant} ms`;
  elements.tokenFast.textContent = `${tokens.fast} ms`;
  elements.tokenBase.textContent = `${tokens.base} ms`;
  elements.tokenSlow.textContent = `${tokens.slow} ms`;
  elements.tokenDistance.textContent = `${tokens.distanceMd} px`;
  elements.tokenScale.textContent = String(tokens.scaleFrom);
}

// Last writer wins: dragging a slider fires this on every input event, and the
// process also has the final say on the numbers (the panel copy is a fallback
// for when the bridge is unavailable).
let tokenRequest = 0;
async function refreshTokens() {
  const request = ++tokenRequest;
  const effective = state.config.followReducedMotion && reducedQuery.matches
    ? { ...state.config, preset: "reduced" }
    : state.config;
  try {
    const result = await invoke("motion.tokens", { config: effective });
    if (request !== tokenRequest) return;
    renderTokens(result.tokens || localTokens(effective));
  } catch {
    if (request !== tokenRequest) return;
    renderTokens(localTokens(effective));
  }
}

function setConfig(patch, debounceMs = 80) {
  state.config = { ...state.config, ...patch };
  renderConfig();
  refreshTokens();
  scheduleSync(debounceMs);
}

function scheduleSync(debounceMs = 80) {
  state.syncVersion += 1;
  markDirty(true);
  window.clearTimeout(state.syncTimer);
  state.syncTimer = window.setTimeout(() => flushSync(state.syncVersion), debounceMs);
}

function flushSync(version) {
  if (state.syncPromise) return state.syncPromise;
  window.clearTimeout(state.syncTimer);
  state.syncTimer = null;
  const requestedVersion = typeof version === "number" ? version : state.syncVersion;
  const config = { ...state.config };
  state.syncPromise = (async () => {
    try {
      const appliedHints = config.mode === "auto" ? await autoHints() : hints();
      const result = await invoke("motion.apply", { config, hints: appliedHints });
      if (requestedVersion === state.syncVersion) {
        applyResult(result);
        markDirty(false);
      }
    } catch (error) {
      if (requestedVersion === state.syncVersion) {
        setSyncState("error");
        toast(`${error.message || "无法同步动画主题"}；继续调整即可重试`, true);
      }
    } finally {
      state.syncPromise = null;
      if (requestedVersion !== state.syncVersion) await flushSync(state.syncVersion);
    }
  })();
  return state.syncPromise;
}

async function resetConfig() {
  if (state.busy) return;
  setConfig({ ...DEFAULT_CONFIG }, 0);
  toast("已恢复平衡并实时应用");
}

function stopMotion() {
  if (state.busy) return;
  setConfig({ preset: "reduced", intensity: 0.5 }, 0);
  toast("已停止全部动画");
}

function bindEvents() {
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => setConfig({ preset: button.dataset.preset }, 0));
  });
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      // Picking "auto" re-reads the system; the other two need no measurement.
      if (button.dataset.mode === "auto") state.systemBase = null;
      setConfig({ mode: button.dataset.mode }, 0);
    });
  });
  elements.intensity.addEventListener("input", () => {
    paintRange(elements.intensity);
    setConfig({ intensity: Number(elements.intensity.value) / 100 });
  });
  elements.speed.addEventListener("input", () => {
    paintRange(elements.speed);
    setConfig({ speed: Number(elements.speed.value) / 100 });
  });
  elements.followReduced.addEventListener("change", () => setConfig({ followReducedMotion: elements.followReduced.checked }, 0));
  elements.resetButton.addEventListener("click", resetConfig);
  elements.stopButton.addEventListener("click", stopMotion);
  const onReducedChange = () => {
    if (state.config.followReducedMotion) refreshTokens();
  };
  if (typeof reducedQuery.addEventListener === "function") reducedQuery.addEventListener("change", onReducedChange);
  else reducedQuery.addListener(onReducedChange);
  // No media-query listener for colour scheme on purpose: while our theme is
  // applied the host pins that query to our own base, so a change there would
  // only echo our own writes back.
  window.pluginBridge?.on?.("appearance:changed", applyAppearance);
}

async function initialize() {
  Object.assign(elements, {
    titleStatus: byId("title-status"), syncDot: byId("sync-dot"), presetSummary: byId("preset-summary"),
    intensity: byId("intensity"), speed: byId("speed"), intensityValue: byId("intensity-value"), speedValue: byId("speed-value"),
    followReduced: byId("follow-reduced"), tokenInstant: byId("token-instant"), tokenFast: byId("token-fast"),
    tokenBase: byId("token-base"), tokenSlow: byId("token-slow"), tokenDistance: byId("token-distance"), tokenScale: byId("token-scale"),
    resetButton: byId("reset-button"), stopButton: byId("stop-button"),
    toast: byId("toast"),
  });
  bindEvents();
  renderConfig();
  setBusy(true);
  try {
    const result = await invoke("motion.getState");
    applyResult({ ...result, config: result.config || state.config });
    renderConfig();
    await refreshTokens();
    // "Auto" has to read the real system, which costs a release, so it happens
    // once here rather than on every slider move.
    if (state.config.mode === "auto") await flushSync();
    markDirty(false);
  } catch (error) {
    applyAppearance(state.appearance);
    state.appliedBase = resolvedBase();
    document.documentElement.dataset.base = state.appliedBase;
    await refreshTokens();
    markDirty(false);
    elements.titleStatus.textContent = "独立预览模式";
    toast(error.message || "无法读取插件状态，已进入预览模式", true);
  } finally {
    setBusy(false);
  }
}

window.PiOptMotion = { boot: initialize };
})();
