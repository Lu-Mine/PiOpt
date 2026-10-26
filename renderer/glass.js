(function () {
  "use strict";

/*
 * PiOpt window-material view.
 *
 * The panel only decides *what* the glass layer should be; the stylesheet is
 * generated in the plugin process (features/glass/glass.js) and reaches the
 * host window through the Motion Lab runtime theme. So this file never touches
 * the host document — it writes settings and reads back the token numbers it
 * asked for.
 *
 * Mirrors features/glass/glass.js so the readings render before the process
 * answers, which is also what makes the standalone preview mode usable.
 */

const PRESETS = {
  light: { blur: 16, saturate: 1.35, sidebar: 34, chrome: 58, overlay: 76, glow: 16 },
  standard: { blur: 28, saturate: 1.65, sidebar: 44, chrome: 66, overlay: 82, glow: 22 },
  deep: { blur: 44, saturate: 2, sidebar: 54, chrome: 74, overlay: 88, glow: 28 },
};
const DEFAULT_CONFIG = { enabled: false, preset: "standard", intensity: 1 };
const LIMITS = { intensity: [0.6, 1.6] };

const PRESET_COPY = {
  light: "轻薄：柔和分层，几乎不动对比度",
  standard: "标准：明确的玻璃分层与弹层模糊",
  deep: "厚重：更厚的底色与更强的模糊",
};
const OFF_COPY = "已关闭：宿主窗口保持原来的实心表面";

const state = {
  config: { ...DEFAULT_CONFIG },
  tokens: null,
  busy: false,
  dirty: false,
  syncVersion: 0,
  syncTimer: null,
  syncPromise: null,
};

const elements = {};
const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

function byId(id) {
  return document.getElementById(id);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeConfig(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const preset = Object.prototype.hasOwnProperty.call(PRESETS, source.preset) ? source.preset : DEFAULT_CONFIG.preset;
  return {
    enabled: source.enabled === true,
    preset,
    intensity: Math.round(clamp(finiteNumber(source.intensity, 1), LIMITS.intensity[0], LIMITS.intensity[1]) * 100) / 100,
  };
}

function localTokens(input) {
  const config = normalizeConfig(input);
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
    glow: Math.round(clamp(preset.glow * scale, 4, 34)),
  };
}

async function invoke(channel, payload = {}) {
  if (window.pluginBridge && typeof window.pluginBridge.invoke === "function") {
    return window.pluginBridge.invoke(channel, payload);
  }
  if (channel === "glass.getState") {
    return { config: { ...DEFAULT_CONFIG }, presets: Object.keys(PRESETS), limits: LIMITS };
  }
  if (channel === "glass.tokens") {
    const config = normalizeConfig(payload.config);
    return { config, tokens: localTokens(config) };
  }
  if (channel === "glass.apply" || channel === "glass.reset") {
    const config = channel === "glass.reset" ? { ...DEFAULT_CONFIG } : normalizeConfig(payload.config);
    return { ok: true, config, applied: false };
  }
  throw new Error(`Unknown preview channel: ${channel}`);
}

function setBusy(busy) {
  state.busy = busy;
  elements.resetButton.disabled = busy;
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
  const title = detail || titles[status] || titles.ready;
  elements.status.dataset.state = status;
  elements.status.title = title;
}

function markDirty(dirty = true) {
  state.dirty = dirty;
  setSyncState(dirty ? "pending" : "ready");
}

/* Feeds the filled track in renderer/glass.css with the current value ratio. */
function paintRange(input) {
  if (!input) return;
  const min = Number(input.min) || 0;
  const span = (Number(input.max) || 100) - min || 1;
  const ratio = Math.max(0, Math.min(1, (Number(input.value) - min) / span));
  input.style.setProperty("--fill", `${Math.round(ratio * 1000) / 10}%`);
}

function renderTokens(tokens) {
  state.tokens = tokens;
  elements.tokenBlur.textContent = `${tokens.blur} px`;
  elements.tokenStrong.textContent = `${tokens.blurStrong} px`;
  elements.tokenSidebar.textContent = `${tokens.sidebar}%`;
  elements.tokenChrome.textContent = `${tokens.chrome}%`;
  elements.tokenOverlay.textContent = `${tokens.overlay}%`;
  elements.tokenGlow.textContent = `${tokens.glow}%`;
}

function renderConfig() {
  const config = state.config;
  elements.view.dataset.enabled = String(config.enabled);
  elements.toggle.checked = config.enabled;
  document.querySelectorAll("[data-glass-preset]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.glassPreset === config.preset));
  });
  elements.intensity.value = String(Math.round(config.intensity * 100));
  elements.intensityValue.textContent = `${Math.round(config.intensity * 100)}%`;
  paintRange(elements.intensity);
  elements.summary.textContent = config.enabled ? (PRESET_COPY[config.preset] || PRESET_COPY.standard) : OFF_COPY;
}

// Last writer wins, exactly like the motion view: dragging the slider fires on
// every input event, and the process has the final say on the numbers.
let tokenRequest = 0;
async function refreshTokens() {
  const request = ++tokenRequest;
  const config = { ...state.config };
  try {
    const result = await invoke("glass.tokens", { config });
    if (request !== tokenRequest) return;
    renderTokens(result.tokens || localTokens(config));
  } catch {
    if (request !== tokenRequest) return;
    renderTokens(localTokens(config));
  }
}

function setConfig(patch, debounceMs = 80) {
  state.config = normalizeConfig({ ...state.config, ...patch });
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
      const result = await invoke("glass.apply", { config });
      if (requestedVersion === state.syncVersion) {
        if (result && result.config) state.config = normalizeConfig(result.config);
        renderConfig();
        markDirty(false);
      }
    } catch (error) {
      if (requestedVersion === state.syncVersion) {
        setSyncState("error");
        toast(`${error.message || "无法应用窗口材质"}；继续调整即可重试`, true);
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
  state.config = { ...DEFAULT_CONFIG };
  renderConfig();
  await refreshTokens();
  state.syncVersion += 1;
  markDirty(true);
  try {
    const result = await invoke("glass.reset", {});
    if (result && result.config) state.config = normalizeConfig(result.config);
    renderConfig();
    markDirty(false);
    toast("已恢复默认并实时应用");
  } catch (error) {
    setSyncState("error");
    toast(error.message || "无法恢复默认", true);
  }
}

function bindEvents() {
  elements.toggle.addEventListener("change", () => {
    setConfig({ enabled: elements.toggle.checked }, 0);
  });
  document.querySelectorAll("[data-glass-preset]").forEach((button) => {
    button.addEventListener("click", () => setConfig({ preset: button.dataset.glassPreset }, 0));
  });
  elements.intensity.addEventListener("input", () => {
    paintRange(elements.intensity);
    setConfig({ intensity: Number(elements.intensity.value) / 100 });
  });
  elements.resetButton.addEventListener("click", resetConfig);
  // Kept for symmetry with the motion view: the readings do not depend on the
  // OS motion preference, but a listener keeps the two panels consistent.
  const onReducedChange = () => { /* no token depends on reduced motion */ };
  if (typeof reducedQuery.addEventListener === "function") reducedQuery.addEventListener("change", onReducedChange);
  else if (typeof reducedQuery.addListener === "function") reducedQuery.addListener(onReducedChange);
}

async function initialize() {
  Object.assign(elements, {
    view: byId("view-glass"),
    summary: byId("glass-summary"),
    status: byId("glass-status"),
    toggle: byId("glass-toggle"),
    intensity: byId("glass-intensity"),
    intensityValue: byId("glass-intensity-value"),
    tokenBlur: byId("glass-token-blur"),
    tokenStrong: byId("glass-token-strong"),
    tokenSidebar: byId("glass-token-sidebar"),
    tokenChrome: byId("glass-token-chrome"),
    tokenOverlay: byId("glass-token-overlay"),
    tokenGlow: byId("glass-token-glow"),
    resetButton: byId("glass-reset"),
    toast: byId("glass-toast"),
  });
  bindEvents();
  renderConfig();
  setBusy(true);
  try {
    const result = await invoke("glass.getState");
    if (result && result.config) state.config = normalizeConfig(result.config);
    renderConfig();
    await refreshTokens();
    markDirty(false);
  } catch (error) {
    await refreshTokens();
    markDirty(false);
    toast(error.message || "无法读取窗口材质设置，已进入预览模式", true);
  } finally {
    setBusy(false);
  }
}

window.PiOptGlass = { boot: initialize };
})();
