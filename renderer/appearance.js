(function () {
  "use strict";

/*
 * PiOpt appearance view: interface motion and the window material, one section
 * each, in one file.
 *
 * The panel only decides *what* the appearance should be. Both halves end in the
 * same place — one runtime theme, built in the plugin process from one motion
 * setting and one material setting — so there is one sync strip here instead of
 * one per view: a change to either section is written back with the same
 * debounce, and the strip reports the write, not the section.
 *
 * The material's wallpaper upload is the one place where bytes travel: a
 * renderer cannot hand over a filesystem path (Electron removed `File.path`), so
 * the image is read here and posted as base64. The plugin process stores it in
 * its own data folder and the theme references that absolute path.
 *
 * The copies of the presets below mirror features/appearance/motion.js and
 * features/appearance/glass.js, so the readings render before the process
 * answers — which is also what makes the standalone preview mode usable.
 */

// --------------------------------------------------------------- motion model

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

// ---------------------------------------------------------------- glass model

const GLASS_PRESETS = {
  light: { blur: 16, saturate: 1.35, sidebar: 72, chrome: 58, overlay: 76, glow: 16, canvas: 62, scrim: 0.12 },
  standard: { blur: 28, saturate: 1.65, sidebar: 82, chrome: 66, overlay: 82, glow: 22, canvas: 74, scrim: 0.2 },
  deep: { blur: 44, saturate: 2, sidebar: 90, chrome: 74, overlay: 88, glow: 28, canvas: 86, scrim: 0.28 },
};
const DEFAULT_GLASS = { enabled: false, preset: "standard", intensity: 1, wallpaper: "", fit: "fill" };
const GLASS_LIMITS = { intensity: [0.6, 1.6] };
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

const GLASS_PRESET_COPY = {
  light: "轻薄：柔和分层，几乎不动对比度",
  standard: "标准：明确的玻璃分层与弹层模糊",
  deep: "厚重：更厚的底色与更强的模糊",
};
const GLASS_OFF_COPY = "已关闭：界面保持原来的实心表面";

// ------------------------------------------------------------------- channels

// The two halves are one feature now, so every channel is namespaced under it.
const MOTION = "appearance.motion";
const GLASS = "appearance.glass";

const state = {
  config: { ...DEFAULT_CONFIG },
  glass: { ...DEFAULT_GLASS },
  appearance: { base: "dark", theme: "dark", pluginTheme: null },
  // The user's own choice in PI-Desktop ("system" / "light" / "dark"), reported
  // by the plugin process: once the theme owns the selection the host reports
  // that theme's base instead, so "auto" has to lean on this.
  preference: "system",
  // The base that is currently on screen, used to notice that "auto" has to
  // follow a changed appearance.
  appliedBase: "dark",
  tokens: null,
  glassTokens: null,
  busy: false,
  dirty: false,
  syncVersion: 0,
  syncTimer: null,
  syncPromise: null,
  // The measured system base for "auto", or null when it still has to be read.
  systemBase: null,
};

const elements = {};
const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const lightQuery = window.matchMedia("(prefers-color-scheme: light)");

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

function hints() {
  // Only what the page can tell the process: which way the system leans.
  return { prefersLight: lightQuery.matches };
}

function normalizeGlass(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const preset = Object.prototype.hasOwnProperty.call(GLASS_PRESETS, source.preset) ? source.preset : DEFAULT_GLASS.preset;
  return {
    enabled: source.enabled === true,
    preset,
    intensity: Math.round(clamp(finiteNumber(source.intensity, 1), GLASS_LIMITS.intensity[0], GLASS_LIMITS.intensity[1]) * 100) / 100,
    wallpaper: typeof source.wallpaper === "string" ? source.wallpaper : "",
    fit: FITS.includes(source.fit) ? source.fit : "fill",
  };
}

function localMotionTokens(config) {
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

function localGlassTokens(input) {
  const config = normalizeGlass(input);
  const preset = GLASS_PRESETS[config.preset];
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

// --------------------------------------------------------------- bridge access

function glassPreviewState(patch = {}) {
  return {
    config: { ...state.glass, ...patch },
    presets: Object.keys(GLASS_PRESETS),
    fits: [...FITS],
    limits: GLASS_LIMITS,
  };
}

async function invoke(channel, payload = {}) {
  if (window.pluginBridge && typeof window.pluginBridge.invoke === "function") {
    return window.pluginBridge.invoke(channel, payload);
  }
  // Standalone preview: the page opened without a host, so answer from the
  // copies above instead of failing every control.
  if (channel === `${MOTION}.getState`) {
    return { config: { ...DEFAULT_CONFIG }, appearance: state.appearance, resolvedBase: "dark", themes: [], preference: state.preference };
  }
  if (channel === `${MOTION}.tokens`) {
    return { config: payload.config, tokens: localMotionTokens(payload.config || state.config) };
  }
  if (channel === `${MOTION}.systemBase`) return { base: lightQuery.matches ? "light" : "dark", platform: "preview" };
  if (channel === `${MOTION}.reset`) return { ok: true, config: { ...DEFAULT_CONFIG } };
  if (channel === `${MOTION}.save` || channel === `${MOTION}.apply`) {
    return { ok: true, config: payload.config, appliedTheme: "preview", resolvedBase: state.appliedBase };
  }
  if (channel === `${MOTION}.release`) return { ok: true };
  if (channel === `${GLASS}.getState`) return glassPreviewState();
  if (channel === `${GLASS}.tokens`) {
    const config = normalizeGlass(payload.config);
    return { config, tokens: localGlassTokens(config) };
  }
  if (channel === `${GLASS}.saveWallpaper`) {
    return { ok: false, reason: "preview", message: "独立预览模式不会保存背景图", ...glassPreviewState(), applied: false };
  }
  if (channel === `${GLASS}.clearWallpaper`) {
    state.glass = { ...state.glass, wallpaper: "" };
    return { ok: true, ...glassPreviewState({ wallpaper: "" }), applied: false };
  }
  if (channel === `${GLASS}.apply` || channel === `${GLASS}.reset`) {
    const config = channel === `${GLASS}.reset`
      ? { ...DEFAULT_GLASS, wallpaper: state.glass.wallpaper }
      : normalizeGlass(payload.config);
    return { ok: true, config, applied: false, ...glassPreviewState(config) };
  }
  throw new Error(`Unknown preview channel: ${channel}`);
}

// ------------------------------------------------------------------ appearance

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
  renderMotionConfig();
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
    const result = await invoke(`${MOTION}.systemBase`);
    if (result && (result.base === "light" || result.base === "dark")) return result.base;
  } catch {
    /* the process could not read the OS; fall through */
  }
  await invoke(`${MOTION}.release`);
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

// ----------------------------------------------------------------- sync strip

function setBusy(busy) {
  state.busy = busy;
  elements.resetButton.disabled = busy;
  elements.stopButton.disabled = busy;
  elements.glassReset.disabled = busy;
  elements.pickButton.disabled = busy;
  elements.clearButton.disabled = busy || !state.glass.wallpaper;
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
  // Two dots, one strip: both sections write the same theme, so both report it.
  for (const dot of [elements.syncDot, elements.glassDot]) {
    dot.dataset.state = status;
    dot.title = title;
  }
}

function markDirty(dirty = true) {
  state.dirty = dirty;
  setSyncState(dirty ? "pending" : "ready");
}

/* Feeds the filled track in renderer/appearance.css with the current value ratio. */
function paintRange(input) {
  if (!input) return;
  const min = Number(input.min) || 0;
  const span = (Number(input.max) || 100) - min || 1;
  const ratio = Math.max(0, Math.min(1, (Number(input.value) - min) / span));
  input.style.setProperty("--fill", `${Math.round(ratio * 1000) / 10}%`);
}

// -------------------------------------------------------------------- motion

function renderPressed(selector, attribute, value) {
  document.querySelectorAll(selector).forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset[attribute] === value));
  });
}

function renderMode() {
  renderPressed("[data-mode]", "mode", state.config.mode);
}

function renderMotionConfig() {
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

function renderMotionTokens(tokens) {
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
let motionRequest = 0;
async function refreshMotionTokens() {
  const request = ++motionRequest;
  const effective = state.config.followReducedMotion && reducedQuery.matches
    ? { ...state.config, preset: "reduced" }
    : state.config;
  try {
    const result = await invoke(`${MOTION}.tokens`, { config: effective });
    if (request !== motionRequest) return;
    renderMotionTokens(result.tokens || localMotionTokens(effective));
  } catch {
    if (request !== motionRequest) return;
    renderMotionTokens(localMotionTokens(effective));
  }
}

function setMotionConfig(patch, debounceMs = 80) {
  state.config = { ...state.config, ...patch };
  renderMotionConfig();
  refreshMotionTokens();
  scheduleSync(debounceMs);
}

// --------------------------------------------------------------------- glass

function renderGlassConfig() {
  const config = state.glass;
  elements.glassView.dataset.enabled = String(config.enabled);
  elements.glassToggle.checked = config.enabled;
  renderPressed("[data-glass-preset]", "glassPreset", config.preset);
  renderPressed("[data-glass-fit]", "glassFit", config.fit);
  elements.glassIntensity.value = String(Math.round(config.intensity * 100));
  elements.glassIntensityValue.textContent = `${Math.round(config.intensity * 100)}%`;
  paintRange(elements.glassIntensity);
  // With a photo behind it, "off" means "not frosted" rather than "nothing shown".
  elements.glassSummary.textContent = config.enabled
    ? (GLASS_PRESET_COPY[config.preset] || GLASS_PRESET_COPY.standard)
    : config.wallpaper
      ? "已关闭磨砂：背景图仍然显示，表面保持清晰"
      : GLASS_OFF_COPY;
  elements.glassFitHint.textContent = FIT_COPY[config.fit] || FIT_COPY.fill;

  const name = basename(config.wallpaper);
  elements.wallpaperName.textContent = name || "未选择：玻璃背后是柔光场";
  elements.wallpaperName.dataset.empty = String(!name);
  elements.wallpaperName.title = config.wallpaper || "";
  elements.clearButton.disabled = state.busy || !name;
}

function renderGlassTokens(tokens) {
  state.glassTokens = tokens;
  elements.tokenBlur.textContent = `${tokens.blur} px`;
  elements.tokenStrong.textContent = `${tokens.blurStrong} px`;
  elements.tokenSidebar.textContent = `${tokens.sidebar}%`;
  elements.tokenChrome.textContent = `${tokens.chrome}%`;
  elements.tokenOverlay.textContent = `${tokens.overlay}%`;
  elements.tokenGlow.textContent = `${tokens.glow}%`;
  elements.tokenCanvas.textContent = `${tokens.canvas}%`;
}

let glassRequest = 0;
async function refreshGlassTokens() {
  const request = ++glassRequest;
  const config = { ...state.glass };
  try {
    const result = await invoke(`${GLASS}.tokens`, { config });
    if (request !== glassRequest) return;
    renderGlassTokens(result.tokens || localGlassTokens(config));
  } catch {
    if (request !== glassRequest) return;
    renderGlassTokens(localGlassTokens(config));
  }
}

function setGlassConfig(patch, debounceMs = 80) {
  state.glass = normalizeGlass({ ...state.glass, ...patch });
  renderGlassConfig();
  refreshGlassTokens();
  scheduleSync(debounceMs);
}

// ---------------------------------------------------------------------- sync

function scheduleSync(debounceMs = 80) {
  state.syncVersion += 1;
  markDirty(true);
  window.clearTimeout(state.syncTimer);
  state.syncTimer = window.setTimeout(() => flushSync(state.syncVersion), debounceMs);
}

// One queue for both sections: whichever last changed decides what is written,
// and a write in flight is followed by one that reflects the newest state. The
// two halves travel to the process as one call so they cannot interleave.
function flushSync(version) {
  if (state.syncPromise) return state.syncPromise;
  window.clearTimeout(state.syncTimer);
  state.syncTimer = null;
  const requestedVersion = typeof version === "number" ? version : state.syncVersion;
  const config = { ...state.config };
  const glassConfig = { ...state.glass };
  state.syncPromise = (async () => {
    try {
      const appliedHints = config.mode === "auto" ? await autoHints() : hints();
      const result = await invoke(`${MOTION}.apply`, { config, hints: appliedHints });
      const glassResult = await invoke(`${GLASS}.apply`, { config: glassConfig });
      if (requestedVersion === state.syncVersion) {
        applyResult(result);
        if (glassResult && glassResult.config) {
          state.glass = normalizeGlass(glassResult.config);
          renderGlassConfig();
        }
        markDirty(false);
      }
    } catch (error) {
      if (requestedVersion === state.syncVersion) {
        setSyncState("error");
        toast(`${error.message || "无法同步外观主题"}；继续调整即可重试`, true);
      }
    } finally {
      state.syncPromise = null;
      if (requestedVersion !== state.syncVersion) await flushSync(state.syncVersion);
    }
  })();
  return state.syncPromise;
}

// ------------------------------------------------------------------ commands

async function resetMotion() {
  if (state.busy) return;
  state.systemBase = null;
  setMotionConfig({ ...DEFAULT_CONFIG }, 0);
  toast("已恢复平衡并实时应用");
}

function stopMotion() {
  if (state.busy) return;
  setMotionConfig({ preset: "reduced", intensity: 0.5 }, 0);
  toast("已停止全部动画");
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
    const result = await invoke(`${GLASS}.saveWallpaper`, { name: file.name, data });
    if (result && result.config) state.glass = normalizeGlass(result.config);
    renderGlassConfig();
    await refreshGlassTokens();
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
  if (state.busy || !state.glass.wallpaper) return;
  setBusy(true);
  try {
    const result = await invoke(`${GLASS}.clearWallpaper`);
    if (result && result.config) state.glass = normalizeGlass(result.config);
    renderGlassConfig();
    await refreshGlassTokens();
    markDirty(false);
    toast("已清除背景图");
  } catch (error) {
    setSyncState("error");
    toast(error.message || "无法清除背景图", true);
  } finally {
    setBusy(false);
  }
}

async function resetGlass() {
  if (state.busy) return;
  setBusy(true);
  try {
    // The reset keeps the photo: it is the user's own file, not a recipe.
    const result = await invoke(`${GLASS}.reset`, {});
    if (result && result.config) state.glass = normalizeGlass(result.config);
    renderGlassConfig();
    await refreshGlassTokens();
    state.syncVersion += 1;
    markDirty(false);
    toast("已恢复默认材质，背景图保留");
  } catch (error) {
    setSyncState("error");
    toast(error.message || "无法恢复默认材质", true);
  } finally {
    setBusy(false);
  }
}

// ------------------------------------------------------------------- binding

function bindEvents() {
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => setMotionConfig({ preset: button.dataset.preset }, 0));
  });
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      // Picking "auto" re-reads the system; the other two need no measurement.
      if (button.dataset.mode === "auto") state.systemBase = null;
      setMotionConfig({ mode: button.dataset.mode }, 0);
    });
  });
  elements.intensity.addEventListener("input", () => {
    paintRange(elements.intensity);
    setMotionConfig({ intensity: Number(elements.intensity.value) / 100 });
  });
  elements.speed.addEventListener("input", () => {
    paintRange(elements.speed);
    setMotionConfig({ speed: Number(elements.speed.value) / 100 });
  });
  elements.followReduced.addEventListener("change", () => setMotionConfig({ followReducedMotion: elements.followReduced.checked }, 0));
  elements.resetButton.addEventListener("click", resetMotion);
  elements.stopButton.addEventListener("click", stopMotion);

  elements.glassToggle.addEventListener("change", () => setGlassConfig({ enabled: elements.glassToggle.checked }, 0));
  document.querySelectorAll("[data-glass-preset]").forEach((button) => {
    button.addEventListener("click", () => setGlassConfig({ preset: button.dataset.glassPreset }, 0));
  });
  document.querySelectorAll("[data-glass-fit]").forEach((button) => {
    button.addEventListener("click", () => setGlassConfig({ fit: button.dataset.glassFit }, 0));
  });
  elements.glassIntensity.addEventListener("input", () => {
    paintRange(elements.glassIntensity);
    setGlassConfig({ intensity: Number(elements.glassIntensity.value) / 100 });
  });
  elements.pickButton.addEventListener("click", pickWallpaper);
  elements.fileInput.addEventListener("change", () => {
    const file = elements.fileInput.files && elements.fileInput.files[0];
    if (file) void uploadWallpaper(file);
  });
  elements.clearButton.addEventListener("click", clearWallpaper);
  elements.glassReset.addEventListener("click", resetGlass);

  const onReducedChange = () => {
    if (state.config.followReducedMotion) refreshMotionTokens();
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
    view: byId("view-appearance"),
    syncDot: byId("sync-dot"),
    presetSummary: byId("preset-summary"),
    intensity: byId("intensity"), speed: byId("speed"),
    intensityValue: byId("intensity-value"), speedValue: byId("speed-value"),
    followReduced: byId("follow-reduced"),
    tokenInstant: byId("token-instant"), tokenFast: byId("token-fast"),
    tokenBase: byId("token-base"), tokenSlow: byId("token-slow"),
    tokenDistance: byId("token-distance"), tokenScale: byId("token-scale"),
    resetButton: byId("reset-button"), stopButton: byId("stop-button"),
    glassDot: byId("glass-status"),
    glassView: byId("glass-view"),
    glassSummary: byId("glass-summary"),
    glassToggle: byId("glass-toggle"),
    glassIntensity: byId("glass-intensity"),
    glassIntensityValue: byId("glass-intensity-value"),
    wallpaperName: byId("glass-wallpaper-name"),
    pickButton: byId("glass-wallpaper-pick"),
    clearButton: byId("glass-wallpaper-clear"),
    glassFitHint: byId("glass-fit-hint"),
    fileInput: byId("glass-wallpaper-file"),
    tokenBlur: byId("glass-token-blur"), tokenStrong: byId("glass-token-strong"),
    tokenSidebar: byId("glass-token-sidebar"), tokenChrome: byId("glass-token-chrome"),
    tokenOverlay: byId("glass-token-overlay"), tokenGlow: byId("glass-token-glow"),
    tokenCanvas: byId("glass-token-canvas"),
    glassReset: byId("glass-reset"),
    toast: byId("toast"),
  });
  bindEvents();
  renderMotionConfig();
  renderGlassConfig();
  setBusy(true);
  try {
    const [motionState, glassState] = await Promise.all([
      invoke(`${MOTION}.getState`),
      invoke(`${GLASS}.getState`).catch(() => null),
    ]);
    applyResult({ ...motionState, config: (motionState && motionState.config) || state.config });
    if (glassState && glassState.config) state.glass = normalizeGlass(glassState.config);
    renderMotionConfig();
    renderGlassConfig();
    await Promise.all([refreshMotionTokens(), refreshGlassTokens()]);
    // "Auto" has to read the real system, which costs a release, so it happens
    // once here rather than on every slider move.
    if (state.config.mode === "auto") await flushSync();
    markDirty(false);
  } catch (error) {
    applyAppearance(state.appearance);
    state.appliedBase = resolvedBase();
    document.documentElement.dataset.base = state.appliedBase;
    await Promise.all([refreshMotionTokens(), refreshGlassTokens()]);
    markDirty(false);
    toast(error.message || "无法读取插件状态，已进入预览模式", true);
  } finally {
    setBusy(false);
  }
}

window.PiOptAppearance = { boot: initialize };
})();
