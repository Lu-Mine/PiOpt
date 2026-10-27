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
 * The wallpaper upload is the one place where bytes travel: a renderer cannot
 * hand over a filesystem path (Electron removed `File.path`), so the image is
 * read here and posted as base64. The plugin process stores it in its own data
 * folder and the theme references that absolute path.
 *
 * Mirrors features/glass/glass.js so the readings render before the process
 * answers, which is also what makes the standalone preview mode usable.
 */

const PRESETS = {
  light: { blur: 16, saturate: 1.35, sidebar: 34, chrome: 58, overlay: 76, glow: 16, canvas: 90, scrim: 0.12 },
  standard: { blur: 28, saturate: 1.65, sidebar: 44, chrome: 66, overlay: 82, glow: 22, canvas: 84, scrim: 0.2 },
  deep: { blur: 44, saturate: 2, sidebar: 54, chrome: 74, overlay: 88, glow: 28, canvas: 78, scrim: 0.28 },
};
const DEFAULT_CONFIG = { enabled: false, preset: "standard", intensity: 1, wallpaper: "", fit: "fill" };
const LIMITS = { intensity: [0.6, 1.6] };
const FITS = ["fill", "contain", "cover", "none", "scale-down"];
const FIT_COPY = {
  fill: "拉伸铺满整个窗口，比例会变形",
  contain: "等比缩放，整张图完整显示",
  cover: "等比缩放铺满窗口，超出部分裁切",
  none: "保持图片原始像素尺寸，超出部分裁切",
  "scale-down": "等比缩放，但不会超过图片原始尺寸",
};
const WALLPAPER_MAX_BYTES = 4 * 1024 * 1024;
const WALLPAPER_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "avif", "svg"];

const PRESET_COPY = {
  light: "轻薄：柔和分层，几乎不动对比度",
  standard: "标准：明确的玻璃分层与弹层模糊",
  deep: "厚重：更厚的底色与更强的模糊",
};
const OFF_COPY = "已关闭：界面保持原来的实心表面";

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
    wallpaper: typeof source.wallpaper === "string" ? source.wallpaper : "",
    fit: FITS.includes(source.fit) ? source.fit : "fill",
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
    glow: Math.round(clamp(preset.glow * scale, 8, 46)),
    canvas: config.wallpaper ? firmUp(preset.canvas) : 100,
    scrim: Math.round(clamp(preset.scrim * (0.85 + 0.15 * scale), 0.04, 0.55) * 100) / 100,
  };
}

function basename(path) {
  const parts = String(path ?? "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function previewState(patch = {}) {
  return {
    config: { ...state.config, ...patch },
    presets: Object.keys(PRESETS),
    fits: ["fill", "scale-down"],
    limits: LIMITS,
  };
}

async function invoke(channel, payload = {}) {
  if (window.pluginBridge && typeof window.pluginBridge.invoke === "function") {
    return window.pluginBridge.invoke(channel, payload);
  }
  if (channel === "glass.getState") return previewState();
  if (channel === "glass.tokens") {
    const config = normalizeConfig(payload.config);
    return { config, tokens: localTokens(config) };
  }
  if (channel === "glass.saveWallpaper") {
    return { ok: false, reason: "preview", message: "独立预览模式不会保存背景图", ...previewState(), applied: false };
  }
  if (channel === "glass.clearWallpaper") {
    state.config = { ...state.config, wallpaper: "" };
    return { ok: true, ...previewState({ wallpaper: "" }), applied: false };
  }
  if (channel === "glass.apply" || channel === "glass.reset") {
    const config = channel === "glass.reset" ? { ...DEFAULT_CONFIG } : normalizeConfig(payload.config);
    return { ok: true, config, applied: false, ...previewState(config) };
  }
  throw new Error(`Unknown preview channel: ${channel}`);
}

function setBusy(busy) {
  state.busy = busy;
  elements.resetButton.disabled = busy;
  elements.pickButton.disabled = busy;
  elements.clearButton.disabled = busy || !state.config.wallpaper;
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
  if (elements.tokenCanvas) elements.tokenCanvas.textContent = `${tokens.canvas}%`;
}

function renderConfig() {
  const config = state.config;
  elements.view.dataset.enabled = String(config.enabled);
  elements.toggle.checked = config.enabled;
  document.querySelectorAll("[data-glass-preset]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.glassPreset === config.preset));
  });
  document.querySelectorAll("[data-glass-fit]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.glassFit === config.fit));
  });
  elements.intensity.value = String(Math.round(config.intensity * 100));
  elements.intensityValue.textContent = `${Math.round(config.intensity * 100)}%`;
  paintRange(elements.intensity);
  // With a photo behind it, "off" means "not frosted" rather than "nothing shown".
  elements.summary.textContent = config.enabled
    ? (PRESET_COPY[config.preset] || PRESET_COPY.standard)
    : config.wallpaper
      ? "已关闭磨砂：背景图仍然显示，表面保持清晰"
      : OFF_COPY;
  elements.fitHint.textContent = FIT_COPY[config.fit] || FIT_COPY.fill;

  const name = basename(config.wallpaper);
  elements.wallpaperName.textContent = name || "未选择：玻璃背后是柔光场";
  elements.wallpaperName.dataset.empty = String(!name);
  elements.wallpaperName.title = config.wallpaper || "";
  elements.clearButton.disabled = state.busy || !name;
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

// ---------------------------------------------------------------- wallpaper

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

async function uploadWallpaper(file) {
  if (state.busy) return;
  const extension = (/\.([A-Za-z0-9]+)$/.exec(file.name)?.[1] ?? "").toLowerCase();
  if (!WALLPAPER_EXTENSIONS.includes(extension)) {
    toast(`只支持 ${WALLPAPER_EXTENSIONS.join(" / ")} 图片`, true);
    return;
  }
  if (file.size > WALLPAPER_MAX_BYTES) {
    toast(`图片超过 ${Math.round(WALLPAPER_MAX_BYTES / 1024 / 1024)} MB`, true);
    return;
  }

  setBusy(true);
  setSyncState("pending", "正在导入背景图");
  try {
    const data = await readAsBase64(file);
    const result = await invoke("glass.saveWallpaper", { name: file.name, data });
    if (result && result.config) state.config = normalizeConfig(result.config);
    renderConfig();
    await refreshTokens();
    if (result && result.ok === false) {
      setSyncState("error");
      toast(result.message || "这个文件不能用作背景图", true);
      return;
    }
    markDirty(false);
    toast(`已应用背景图：${file.name}`);
  } catch (error) {
    setSyncState("error");
    toast(error.message || "无法导入背景图", true);
  } finally {
    setBusy(false);
  }
}

function pickWallpaper() {
  if (state.busy) return;
  elements.fileInput.value = "";
  elements.fileInput.click();
}

async function clearWallpaper() {
  if (state.busy || !state.config.wallpaper) return;
  setBusy(true);
  try {
    const result = await invoke("glass.clearWallpaper");
    if (result && result.config) state.config = normalizeConfig(result.config);
    renderConfig();
    await refreshTokens();
    markDirty(false);
    toast("已清除背景图");
  } catch (error) {
    setSyncState("error");
    toast(error.message || "无法清除背景图", true);
  } finally {
    setBusy(false);
  }
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
  document.querySelectorAll("[data-glass-fit]").forEach((button) => {
    button.addEventListener("click", () => setConfig({ fit: button.dataset.glassFit }, 0));
  });
  elements.intensity.addEventListener("input", () => {
    paintRange(elements.intensity);
    setConfig({ intensity: Number(elements.intensity.value) / 100 });
  });
  elements.pickButton.addEventListener("click", pickWallpaper);
  elements.fileInput.addEventListener("change", () => {
    const file = elements.fileInput.files && elements.fileInput.files[0];
    if (file) void uploadWallpaper(file);
  });
  elements.clearButton.addEventListener("click", clearWallpaper);
  elements.resetButton.addEventListener("click", resetConfig);
  // Kept for symmetry with the motion view: no token depends on the OS motion
  // preference, but a listener keeps the two panels consistent.
  const onReducedChange = () => { /* nothing to recompute */ };
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
    wallpaperName: byId("glass-wallpaper-name"),
    pickButton: byId("glass-wallpaper-pick"),
    clearButton: byId("glass-wallpaper-clear"),
    fitHint: byId("glass-fit-hint"),
    fileInput: byId("glass-wallpaper-file"),
    tokenBlur: byId("glass-token-blur"),
    tokenStrong: byId("glass-token-strong"),
    tokenSidebar: byId("glass-token-sidebar"),
    tokenChrome: byId("glass-token-chrome"),
    tokenOverlay: byId("glass-token-overlay"),
    tokenGlow: byId("glass-token-glow"),
    tokenCanvas: byId("glass-token-canvas"),
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
