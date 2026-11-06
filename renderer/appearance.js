(function () {
  "use strict";

/*
 * PiOpt 外观视图：界面动效与窗口材质共用一条设置流。
 *
 * 每个控件都实时生效（共用的防抖队列），没有提交按钮。预览模式（没有
 * pluginBridge）下用与主进程同一套默认值，保证脱离宿主也能看出效果。
 */

// --------------------------------------------------------------- motion model

const DEFAULT_CONFIG = {
  override: true,
  disabled: false,
  preset: "balanced",
  intensity: 1,
  speed: 1,
  followReducedMotion: true,
  mode: "auto",
};
const MOTION_LIMITS = { intensity: [0.5, 1.5], speed: [0.4, 2] };
// ---------------------------------------------------------------- glass model

const ENGINE_KINDS = ["video"];
const DEFAULT_ENGINE = { id: "", title: "", kind: "", file: "" };
const DEFAULT_GLASS = {
  enabled: false,
  preset: "standard",
  intensity: 1,
  wallpaper: "",
  fit: "fill",
  recent: [],
  engine: DEFAULT_ENGINE,
};
const GLASS_LIMITS = { intensity: [0.6, 1.6] };
const FITS = ["fill", "contain", "cover", "none"];
const FIT_COPY = {
  fill: "拉伸铺满整个窗口",
  contain: "等比完整显示整张图片",
  cover: "等比铺满窗口，超出部分裁切",
  none: "保持图片原始尺寸",
};
const WALLPAPER_MAX_BYTES = 4 * 1024 * 1024;
const WALLPAPER_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "avif", "svg"];

// ------------------------------------------------------------------- channels

const MOTION = "appearance.motion";
const GLASS = "appearance.glass";

const state = {
  config: { ...DEFAULT_CONFIG },
  glass: { ...DEFAULT_GLASS },
  recent: [],
  // Wallpaper Engine 扫描结果与已画好的缩略图（id → data URL）；null 表示还没扫过。
  engineList: null,
  engineThumbs: new Map(),
  // 背景的两个来源共用一个入口：tab 决定看哪一面，展开只影响 Wallpaper Engine 列表。
  backdropTab: "image",
  backdropTabSettled: false,
  engineExpanded: false,
  // 上一次算出的三行容量（列数 × 3）；宽度变化时用它决定要不要重渲染。
  engineCapacity: 0,
  appearance: { base: "dark", theme: "dark", pluginTheme: null },
  preference: "system",
  appliedBase: "dark",
  busy: false,
  syncVersion: 0,
  syncTimer: null,
  syncPromise: null,
  systemBase: null,
};

const elements = {};
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
  return { prefersLight: lightQuery.matches };
}

function basename(path) {
  const parts = String(path ?? "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function normalizeRecent(input) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const path = typeof entry === "string" ? entry : entry && entry.path;
    if (!path) continue;
    const key = String(path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      path: String(path),
      name: (entry && typeof entry === "object" && entry.name) || basename(path),
      // 主进程画好的 1:1 缩略图；没有（svg、读不到）时卡片只剩文件名。
      thumb: (entry && typeof entry === "object" && typeof entry.thumb === "string") ? entry.thumb : "",
      missing: Boolean(entry && typeof entry === "object" && entry.missing),
    });
  }
  return out;
}
function normalizeMotion(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    override: source.override !== false,
    disabled: source.disabled === true,
    preset: typeof source.preset === "string" ? source.preset : DEFAULT_CONFIG.preset,
    intensity:
      Math.round(
        clamp(finiteNumber(source.intensity, 1), MOTION_LIMITS.intensity[0], MOTION_LIMITS.intensity[1]) * 100
      ) / 100,
    speed:
      Math.round(
        clamp(finiteNumber(source.speed, 1), MOTION_LIMITS.speed[0], MOTION_LIMITS.speed[1]) * 100
      ) / 100,
    followReducedMotion: source.followReducedMotion !== false,
    mode: ["auto", "light", "dark"].includes(source.mode) ? source.mode : DEFAULT_CONFIG.mode,
  };
}

function normalizeEngine(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const id = /^\d{1,20}$/.test(String(source.id ?? "").trim()) ? String(source.id).trim() : "";
  const kind = ENGINE_KINDS.includes(source.kind) ? source.kind : "";
  if (!id || kind !== "video") return { ...DEFAULT_ENGINE };
  const title = typeof source.title === "string" ? source.title.trim() : "";
  const file = typeof source.file === "string" ? source.file : "";
  if (!file) return { ...DEFAULT_ENGINE };
  return { id, title, kind, file };
}

function normalizeGlass(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    enabled: source.enabled === true,
    preset: typeof source.preset === "string" ? source.preset : DEFAULT_GLASS.preset,
    intensity:
      Math.round(
        clamp(finiteNumber(source.intensity, 1), GLASS_LIMITS.intensity[0], GLASS_LIMITS.intensity[1]) * 100
      ) / 100,
    wallpaper: typeof source.wallpaper === "string" ? source.wallpaper : "",
    fit: FITS.includes(source.fit) ? source.fit : "fill",
    recent: Array.isArray(source.recent) ? source.recent : state.glass.recent,
    engine: normalizeEngine(source.engine),
  };
}

// --------------------------------------------------------------- bridge access

function glassPreviewState(patch = {}) {
  return {
    config: { ...state.glass, ...patch },
    recent: state.recent,
    fits: [...FITS],
    limits: GLASS_LIMITS,
  };
}

async function invoke(channel, payload = {}) {
  if (window.pluginBridge && typeof window.pluginBridge.invoke === "function") {
    return window.pluginBridge.invoke(channel, payload);
  }
  if (channel === `${MOTION}.getState`) {
    return { config: { ...DEFAULT_CONFIG }, appearance: state.appearance, resolvedBase: "dark", themes: [], preference: state.preference };
  }
  if (channel === `${MOTION}.systemBase`) return { base: lightQuery.matches ? "light" : "dark", platform: "preview" };
  if (channel === `${MOTION}.reset`) return { ok: true, config: { ...DEFAULT_CONFIG } };
  if (channel === `${MOTION}.save` || channel === `${MOTION}.apply`) {
    const mode = payload.config && payload.config.mode;
    const resolved = mode === "light" || mode === "dark" ? mode : (lightQuery.matches ? "light" : "dark");
    return { ok: true, config: payload.config, appliedTheme: "preview", resolvedBase: resolved };
  }
  if (channel === `${MOTION}.release`) return { ok: true };
  if (channel === `${GLASS}.getState`) return glassPreviewState();
  if (channel === `${GLASS}.saveWallpaper` || channel === `${GLASS}.setWallpaper`) {
    return { ok: false, reason: "preview", message: "预览模式无法保存背景图", ...glassPreviewState(), applied: false };
  }
  if (channel === `${GLASS}.forgetWallpaper`) {
    state.recent = state.recent.filter((entry) => entry.path !== payload.path);
    return { ok: true, ...glassPreviewState() };
  }
  if (channel === `${GLASS}.wallpaperBytes`) return { ok: false, reason: "preview" };
  if (channel === `${GLASS}.saveThumb`) return { ok: false, ...glassPreviewState() };
  if (channel === `${GLASS}.engineScan`) {
    return { ok: false, reason: "preview", message: "预览模式读不到本机壁纸库", items: [] };
  }
  if (channel === `${GLASS}.enginePreview`) return { ok: false, reason: "preview" };
  if (channel === `${GLASS}.engineApply`) {
    return { ok: false, reason: "preview", message: "预览模式无法保存壁纸", ...glassPreviewState(), applied: false };
  }
  if (channel === `${GLASS}.engineClear`) {
    state.glass = { ...state.glass, wallpaper: "", engine: { ...DEFAULT_ENGINE } };
    return { ok: true, ...glassPreviewState({ wallpaper: "", engine: { ...DEFAULT_ENGINE } }), applied: false };
  }
  if (channel === `${GLASS}.clearWallpaper`) {
    state.glass = { ...state.glass, wallpaper: "", engine: { ...DEFAULT_ENGINE } };
    return { ok: true, ...glassPreviewState({ wallpaper: "", engine: { ...DEFAULT_ENGINE } }), applied: false };
  }
  if (channel === `${GLASS}.apply` || channel === `${GLASS}.reset`) {
    const config = channel === `${GLASS}.reset`
      ? { ...DEFAULT_GLASS, wallpaper: state.glass.wallpaper, recent: state.glass.recent }
      : normalizeGlass(payload.config);
    return { ok: true, config, applied: false, ...glassPreviewState(config) };
  }
  throw new Error(`Unknown preview channel: ${channel}`);
}

// ------------------------------------------------------------------ appearance

function resolvedBase() {
  if (state.config.mode === "light" || state.config.mode === "dark") return state.config.mode;
  return state.appliedBase;
}

function syncDocumentBase(base) {
  document.documentElement.dataset.base = base;
  document.documentElement.dataset.theme = base;
}

function applyAppearance(appearance) {
  if (appearance && typeof appearance === "object") state.appearance = appearance;
  if (typeof state.appearance.locale === "string" && state.appearance.locale) {
    document.documentElement.lang = state.appearance.locale;
  }
  renderMode();
}

function applyResult(result) {
  if (!result || typeof result !== "object") return;
  if (result.config) state.config = normalizeMotion({ ...DEFAULT_CONFIG, ...result.config });
  if (typeof result.preference === "string") state.preference = result.preference;
  if (result.appearance) state.appearance = result.appearance;
  if (typeof result.resolvedBase === "string") state.appliedBase = result.resolvedBase;
  syncDocumentBase(state.appliedBase);
  renderMotion();
}

async function measureSystemBase() {
  try {
    const result = await invoke(`${MOTION}.systemBase`);
    if (result && (result.base === "light" || result.base === "dark")) return result.base;
  } catch {
    /* fall through */
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

async function autoHints() {
  return { prefersLight: (await ensureSystemBase()) === "light" };
}

// ----------------------------------------------------------------- sync status

function setBusy(busy) {
  state.busy = busy;
  elements.pickButton.disabled = busy;
}

let toastTimer;
function toast(message, error = false) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 3000);
}

function paintRange(input) {
  if (!input) return;
  const min = Number(input.min) || 0;
  const span = (Number(input.max) || 100) - min || 1;
  const ratio = Math.max(0, Math.min(1, (Number(input.value) - min) / span));
  input.style.setProperty("--fill", `${Math.round(ratio * 1000) / 10}%`);
}

function renderPressed(selector, attribute, value) {
  document.querySelectorAll(selector).forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset[attribute] === value));
  });
}

// ---------------------------------------------------------------- 二级内容

/*
 * 二级内容是父选项的从属：父项关掉就整块收起，同时设成 inert，让 Tab 顺序
 * 与读屏都跳过看不见的控件（CSS 只负责高度与透明度的过渡）。aria-expanded
 * 挂在父项的开关上，读屏能从父项直接知道下面有没有展开的内容。
 */
function setSub(sub, expanded) {
  if (!sub) return;
  sub.dataset.collapsed = String(!expanded);
  sub.inert = !expanded;
  // 只有本来就会报「下面有没有内容」的开关才挂 aria-expanded；背景图那一行是
  // 没有 role 的容器，不去给它加一个读屏用不上的状态。
  const trigger = sub.dataset.trigger ? byId(sub.dataset.trigger) : null;
  if (trigger && trigger.hasAttribute("aria-controls")) {
    trigger.setAttribute("aria-expanded", String(expanded));
  }
}

// -------------------------------------------------------------------- motion

function renderMode() {
  renderPressed("[data-mode]", "mode", state.config.mode);
}
function syncPanelMotion(config) {
  const style = document.documentElement.style;
  if (config.disabled) {
    style.setProperty("--motion-duration-fast", "1ms");
    style.setProperty("--motion-duration-normal", "1ms");
    return;
  }
  if (!config.override) {
    style.removeProperty("--motion-duration-fast");
    style.removeProperty("--motion-duration-normal");
    return;
  }
  const speed = clamp(finiteNumber(config.speed, 1), MOTION_LIMITS.speed[0], MOTION_LIMITS.speed[1]);
  style.setProperty("--motion-duration-fast", `${Math.max(20, Math.round(135 / speed))}ms`);
  style.setProperty("--motion-duration-normal", `${Math.max(24, Math.round(195 / speed))}ms`);
}

function renderMotion() {
  const config = normalizeMotion(state.config);
  state.config = config;
  syncPanelMotion(config);
  elements.motionOverride.checked = config.override;
  elements.motionDisabled.checked = config.disabled;

  // 强度、速度与「跟随系统减弱」只改这一层写出去的动效规则，所以它们是「动画
  // 优化」的二级内容：父项关掉就收起。「完全禁用动画」是同级开关，它开着时这
  // 一层整体不可用——动画优化连同三个二级项一起禁用，样式按控件的 disabled
  // 状态自己变灰，不再额外写一句说明。
  setSub(elements.motionOverrideSub, config.override);
  elements.motionOverride.disabled = config.disabled;
  for (const input of [elements.intensity, elements.speed, elements.followReduced]) {
    input.disabled = !config.override || config.disabled;
  }

  elements.intensity.value = String(Math.round(config.intensity * 100));
  elements.speed.value = String(Math.round(config.speed * 100));
  elements.intensityValue.textContent = `${Math.round(config.intensity * 100)}%`;
  elements.speedValue.textContent = `${config.speed.toFixed(2)}×`;
  paintRange(elements.intensity);
  paintRange(elements.speed);
  elements.followReduced.checked = config.followReducedMotion;
  renderMode();
}

function setMotionConfig(patch, debounceMs = 80) {
  state.config = normalizeMotion({ ...state.config, ...patch });
  renderMotion();
  scheduleSync(debounceMs);
}

// --------------------------------------------------------------------- glass

function renderGlass() {
  const config = state.glass;
  elements.glassToggle.checked = config.enabled;

  // 模糊强度属于磨砂玻璃开关。背景图那一段不再收起：没有图时它仍然要能点
  // 「不使用」和最近使用。
  setSub(elements.glassEnabledSub, config.enabled);
  elements.glassIntensity.disabled = !config.enabled;
  // 没有可作用的对象时填充方式没有意义：视频壁纸和图片都算「有对象」。
  const hasBackdrop = Boolean(config.wallpaper) || Boolean(config.engine.id);
  elements.glassFitRow.dataset.empty = String(!hasBackdrop);
  for (const button of elements.glassFitButtons) button.disabled = !hasBackdrop;

  renderPressed("[data-glass-fit]", "glassFit", config.fit);
  elements.glassIntensity.value = String(Math.round(config.intensity * 100));
  elements.glassIntensityValue.textContent = `${Math.round(config.intensity * 100)}%`;
  paintRange(elements.glassIntensity);
  elements.glassFitHint.textContent = FIT_COPY[config.fit] || FIT_COPY.fill;

  const current = state.recent.find((entry) => entry.path === config.wallpaper);
  const name = (current && current.name) || basename(config.wallpaper);
  elements.wallpaperName.textContent = name || "未选择图片";
  elements.wallpaperName.dataset.empty = String(!name);

  // 一个入口两个来源：主行只报「现在生效的是哪一个」。
  const engineName = config.engine.id ? config.engine.title || config.engine.id : "";
  const backdropName = engineName ? `${engineName} · 动态` : name || "";
  elements.backdropName.textContent = backdropName || "未选择背景";
  elements.backdropName.dataset.empty = String(!backdropName);

  renderBackdropTabs();
  renderRecent();
  renderEngineGrid();
  void fillMissingThumbs();
}

/*
 * 背景的两个来源用 tab 切换，默认停在「图片」；当前生效的是 Wallpaper Engine
 * 壁纸时停在那一面。切换只是面板状态，不写设置——它不改变任何已生效的东西。
 */
function renderBackdropTabs() {
  const tab = state.backdropTab === "engine" ? "engine" : "image";
  for (const button of elements.tabButtons) {
    button.setAttribute("aria-selected", String(button.dataset.backdropTab === tab));
  }
  elements.panelImage.hidden = tab !== "image";
  elements.panelEngine.hidden = tab !== "engine";
}

async function selectBackdropTab(tab) {
  const next = tab === "engine" ? "engine" : "image";
  if (state.backdropTab === next) return;
  state.backdropTab = next;
  renderBackdropTabs();
  if (next === "engine") {
    // 第一次打开这一面才去扫：别的操作不该让它去碰 Steam 目录。
    if (state.engineList === null) await scanEngine();
    // 这一面现在可见了：按真实列数重算三行容量。
    else renderEngineGrid();
  }
}

/*
 * 面板宽度变了（拖窗口、拖面板）列数就变，三行的容量也跟着变。只有容量真的变了
 * 才重渲染——否则 ResizeObserver 的每一条通知都会重建一次 DOM。
 */
let engineGridObserver = null;

function watchEngineGrid() {
  if (engineGridObserver || typeof ResizeObserver !== "function" || !elements.engineGrid) return;
  engineGridObserver = new ResizeObserver(() => {
    if (!state.engineList || !state.engineList.length) return;
    const capacity = engineColumnCount() * ENGINE_ROWS;
    if (capacity === state.engineCapacity) return;
    renderEngineGrid();
    void fillEngineThumbs();
  });
  engineGridObserver.observe(elements.engineGrid);
}

/*
 * 最近使用是一张图一张卡片：1:1 的缩略图，文件名在图片下面，点卡片就用这张
 * 图；删除图标只在 hover 或键盘焦点进入时出现，点它先确认再删。
 */
function renderRecent() {
  const list = elements.recentList;
  // 第一张固定是「不使用」：这一段常开，即使没有背景图也能一键回到无图状态。
  // 视频壁纸也算「正在使用」，否则点了「不使用」而画面不变。
  const off = !state.glass.wallpaper && !state.glass.engine.id;
  const offCard = `
    <div class="wallpaper-card${off ? " is-current" : ""}">
      <button type="button" class="wallpaper-apply" data-wallpaper-off
        aria-pressed="${off}" aria-label="不使用背景图">
        <span class="wallpaper-thumb is-off"></span>
        <span class="wallpaper-name">不使用</span>
      </button>
    </div>`;
  list.innerHTML = offCard + state.recent.map((entry) => {
    const current = entry.path === state.glass.wallpaper;
    const thumb = entry.thumb ? `<img src="${escapeAttr(entry.thumb)}" alt="" />` : "";
    const label = escapeAttr(entry.name);
    return `
    <div class="wallpaper-card${current ? " is-current" : ""}">
      <button type="button" class="wallpaper-apply" data-recent-use="${escapeAttr(entry.path)}"
        aria-pressed="${current}" aria-label="使用 ${label}">
        <span class="wallpaper-thumb">${thumb}</span>
        <span class="wallpaper-name" title="${label}">${escapeHtml(entry.name)}</span>
      </button>
      <button type="button" class="wallpaper-remove" data-recent-forget="${escapeAttr(entry.path)}"
        aria-label="删除 ${label}" title="删除">
        <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>`;
  }).join("");
}

/*
 * 升级前上传的图片没有缩略图：逐张向主进程要一次原图字节，面板画好再存回去。
 * 一次只跑一张，保存后重新渲染，卡片会陆续补上预览。
 */
let thumbFilling = false;

async function fillMissingThumbs() {
  if (thumbFilling) return;
  thumbFilling = true;
  try {
    for (const entry of [...state.recent]) {
      if (entry.thumb || entry.missing) continue;
      if (!state.recent.some((item) => item.path === entry.path)) continue;
      try {
        const bytes = await invoke(`${GLASS}.wallpaperBytes`, { path: entry.path });
        if (!bytes || bytes.ok === false || !bytes.data) continue;
        const thumb = await makeThumb(`data:${bytes.mime};base64,${bytes.data}`);
        if (!thumb) continue;
        const result = await invoke(`${GLASS}.saveThumb`, { path: entry.path, thumb });
        if (result && result.ok !== false) adoptGlassState(result);
      } catch {
        /* 单张失败不影响其它图片 */
      }
    }
  } finally {
    thumbFilling = false;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function setGlassConfig(patch, debounceMs = 80) {
  state.glass = normalizeGlass({ ...state.glass, ...patch });
  renderGlass();
  scheduleSync(debounceMs);
}

function adoptGlassState(result) {
  if (!result) return;
  if (result.config) state.glass = normalizeGlass(result.config);
  if (Array.isArray(result.recent)) state.recent = normalizeRecent(result.recent);
  // 第一次拿到真实设置时决定停在哪一面：正在用 Wallpaper Engine 壁纸就停在那一面，
  // 之后由用户自己切，面板不再自作主张。
  if (!state.backdropTabSettled) {
    state.backdropTab = state.glass.engine.id ? "engine" : "image";
    state.backdropTabSettled = true;
  }
  renderGlass();
}

// ---------------------------------------------------------------------- sync

function scheduleSync(debounceMs = 80) {
  state.syncVersion += 1;
  window.clearTimeout(state.syncTimer);
  state.syncTimer = window.setTimeout(() => flushSync(state.syncVersion), debounceMs);
}

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
        if (glassResult) adoptGlassState(glassResult);
      }
    } catch (error) {
      if (requestedVersion === state.syncVersion) {
        toast(error.message || "无法应用外观设置", true);
      }
    } finally {
      state.syncPromise = null;
      if (requestedVersion !== state.syncVersion) await flushSync(state.syncVersion);
    }
  })();
  return state.syncPromise;
}

// ------------------------------------------------------------------- confirm

let confirmResolve = null;

function askConfirm(title, text, confirmLabel = "重置") {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    elements.confirmTitle.textContent = title;
    elements.confirmText.textContent = text;
    elements.confirmOk.textContent = confirmLabel;
    elements.confirm.hidden = false;
    elements.confirmOk.focus();
  });
}

function closeConfirm(answer) {
  elements.confirm.hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(answer);
}

// ------------------------------------------------------------------ commands

async function resetMotion() {
  if (state.busy) return;
  const ok = await askConfirm("重置界面动效", "这个分区里的所有选项都会回到默认值。");
  if (!ok) return;
  state.systemBase = null;
  setMotionConfig({ ...DEFAULT_CONFIG }, 0);
  toast("已重置界面动效");
}

async function resetGlass() {
  if (state.busy) return;
  const ok = await askConfirm("重置窗口材质", "这个分区里的所有选项都会回到默认值。背景图与最近使用会保留。");
  if (!ok) return;
  setBusy(true);
  try {
    const result = await invoke(`${GLASS}.reset`, {});
    adoptGlassState(result);
    state.syncVersion += 1;
    toast("已重置窗口材质");
  } catch (error) {
    toast(error.message || "无法重置窗口材质", true);
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------- wallpaper

// 面板是唯一能解码图片的一侧（插件进程没有图像库，也没有 electron），所以缩略图
// 在这里画：中心方图裁切后缩到 96px，存进「最近使用」条目，卡片直接用。
const THUMB_EDGE = 96;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

async function makeThumb(dataUrl) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const edge = Math.min(width, height);
  if (!edge) return "";

  const canvas = document.createElement("canvas");
  canvas.width = THUMB_EDGE;
  canvas.height = THUMB_EDGE;
  const context = canvas.getContext("2d");
  context.drawImage(
    image,
    (width - edge) / 2,
    (height - edge) / 2,
    edge,
    edge,
    0,
    0,
    THUMB_EDGE,
    THUMB_EDGE
  );
  return canvas.toDataURL("image/png");
}

async function uploadWallpaper(file) {
  if (state.busy) return;
  const extension = (/\.([A-Za-z0-9]+)$/.exec(file.name)?.[1] ?? "").toLowerCase();
  if (!WALLPAPER_EXTENSIONS.includes(extension)) {
    toast(`只支持 ${WALLPAPER_EXTENSIONS.join(" / ")} 图片`, true);
    return;
  }
  if (file.size > WALLPAPER_MAX_BYTES) {
    toast(`图片不能超过 ${Math.round(WALLPAPER_MAX_BYTES / 1024 / 1024)} MB`, true);
    return;
  }

  setBusy(true);
  try {
    const dataUrl = await readAsDataUrl(file);
    const comma = dataUrl.indexOf(",");
    const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const thumb = await makeThumb(dataUrl).catch(() => "");
    const result = await invoke(`${GLASS}.saveWallpaper`, { name: file.name, data, thumb });
    adoptGlassState(result);
    if (result && result.ok === false) {
      toast(result.message || "无法使用该图片", true);
      return;
    }
    toast(`已应用背景图：${file.name}`);
  } catch (error) {
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
  if (state.busy || (!state.glass.wallpaper && !state.glass.engine.id)) return;
  setBusy(true);
  try {
    // 通道自己也清 Wallpaper Engine 的来源：两套背景只能有一个在生效。
    const result = await invoke(`${GLASS}.clearWallpaper`);
    adoptGlassState(result);
    toast("已清除背景");
  } catch (error) {
    toast(error.message || "无法清除背景", true);
  } finally {
    setBusy(false);
  }
}

// --------------------------------------------------------- wallpaper engine

const ENGINE_KIND_COPY = { video: "动态" };
const ENGINE_TYPE_COPY = { video: "视频", scene: "场景", web: "网页", application: "程序", preset: "预设" };
const ENGINE_REASON_COPY = {
  // 封面图是创意工坊列表用的方图，不是壁纸画面，所以没有"静帧预览"这条路。
  "engine-only": "需 Wallpaper Engine 渲染",
  "video-unplayable": "视频格式不支持",
  "unknown-project": "壁纸已不存在",
};

function engineMeta(item) {
  const kind = ENGINE_KIND_COPY[item.kind] || "";
  const type = ENGINE_TYPE_COPY[item.type] || item.type || "";
  return [type, kind].filter(Boolean).join(" · ");
}

function engineNote(item) {
  if (!item.supported) return ENGINE_REASON_COPY[item.reason] || "不可用";
  // 能选中的只有 video：它真的会动。
  return "动态播放";
}

/*
 * 一张卡片一张壁纸：缩略图来自项目自带的预览（GIF 由面板解码首帧），下面两行
 * 是标题与「它是什么」。不支持的卡片留在原位、按禁用处理，理由写在第二行——
 * 藏起来比置灰更糟。
 */
// 收起时最多给三行卡片。列数由网格自己的宽度决定（面板可以被拖宽），所以每次
// 渲染前读一次 grid-template-columns，而不是写死张数。
const ENGINE_ROWS = 3;
const ENGINE_COLUMN_GAP = 10;
const ENGINE_MIN_COLUMN = 76;

function engineColumnCount() {
  const grid = elements.engineGrid;
  if (!grid) return 1;
  const columns = getComputedStyle(grid).gridTemplateColumns;
  if (columns && columns !== "none") return Math.max(1, columns.trim().split(/\s+/).length);
  // 这一面还没显示时读不到轨道：按宽度估一个，切到这一面时再算一次。
  const width = grid.getBoundingClientRect().width || grid.parentElement?.getBoundingClientRect().width || 0;
  return Math.max(1, Math.floor((width + ENGINE_COLUMN_GAP) / (ENGINE_MIN_COLUMN + ENGINE_COLUMN_GAP)));
}

function renderEngineGrid() {
  const grid = elements.engineGrid;
  if (!grid) return;
  const items = state.engineList;
  const capacity = engineColumnCount() * ENGINE_ROWS;
  state.engineCapacity = capacity;

  // 「显示全部 / 收起」只在列表超过三行时出现。
  const moreButton = elements.engineMore;
  if (moreButton) {
    const overflow = Boolean(items) && items.length > capacity;
    moreButton.hidden = !overflow;
    if (overflow) {
      moreButton.textContent = state.engineExpanded ? "收起" : `显示全部（${items.length}）`;
      moreButton.setAttribute("aria-expanded", String(state.engineExpanded));
      moreButton.title = state.engineExpanded
        ? `收起后只留前 ${ENGINE_ROWS} 行`
        : `还有 ${items.length - capacity} 张`;
    }
  }

  if (!items) {
    grid.innerHTML = "";
    return;
  }
  if (!items.length) {
    elements.engineHead.textContent = "本机壁纸";
    grid.innerHTML = `<p class="wallpaper-engine-empty">${escapeHtml(state.engineListMessage || "没有找到 Wallpaper Engine 壁纸")}</p>`;
    return;
  }

  elements.engineHead.textContent = `本机壁纸 · ${items.length}`;
  const currentId = state.glass.engine.id;
  const visible = state.engineExpanded ? items : items.slice(0, capacity);
  grid.innerHTML = visible.map((item) => {
    const thumb = state.engineThumbs.get(item.id) || "";
    const current = item.id === currentId;
    const label = escapeAttr(item.title);
    const meta = escapeAttr(engineMeta(item));
    const note = escapeHtml(engineNote(item));
    const disabled = item.supported ? "" : " disabled";
    return `
    <div class="wallpaper-card${current ? " is-current" : ""}${item.supported ? "" : " is-unsupported"}" data-engine-card="${escapeAttr(item.id)}">
      <button type="button" class="wallpaper-apply" data-engine-use="${escapeAttr(item.id)}"
        aria-pressed="${current}" aria-label="${label}：${note}"${disabled}>
        <span class="wallpaper-thumb">${thumb ? `<img src="${escapeAttr(thumb)}" alt="" />` : ""}</span>
        <span class="wallpaper-name" title="${label}">${escapeHtml(item.title)}</span>
        <span class="wallpaper-meta" title="${meta}">${note}</span>
      </button>
    </div>`;
  }).join("");
}

function paintEngineThumb(id, thumb) {
  const slot = elements.engineGrid?.querySelector(
    `[data-engine-card="${CSS.escape(id)}"] .wallpaper-thumb`
  );
  if (!slot) return;
  slot.innerHTML = `<img src="${escapeAttr(thumb)}" alt="" />`;
}

let engineThumbFilling = false;

// 缩略图一次画一张：扫描结果可能几十条，全部并行解码会把面板卡住。
async function fillEngineThumbs() {
  if (engineThumbFilling) return;
  engineThumbFilling = true;
  try {
    for (const item of [...(state.engineList || [])]) {
      if (state.engineThumbs.has(item.id) || !item.hasPreview) continue;
      if (!state.engineList || !state.engineList.some((entry) => entry.id === item.id)) continue;
      try {
        const bytes = await invoke(`${GLASS}.enginePreview`, { id: item.id });
        if (!bytes || bytes.ok === false || !bytes.data) continue;
        const thumb = await makeThumb(`data:${bytes.mime};base64,${bytes.data}`);
        if (!thumb) continue;
        state.engineThumbs.set(item.id, thumb);
        paintEngineThumb(item.id, thumb);
      } catch {
        /* 单张失败不影响其它卡片 */
      }
    }
  } finally {
    engineThumbFilling = false;
  }
}

async function scanEngine() {
  elements.engineHead.textContent = "正在读取本机壁纸…";
  try {
    const result = await invoke(`${GLASS}.engineScan`);
    state.engineList = Array.isArray(result?.items) ? result.items : [];
    state.engineListMessage = result && result.ok === false ? result.message || "" : "";
  } catch (error) {
    state.engineList = [];
    state.engineListMessage = error.message || "读不到本机壁纸库";
  }
  renderEngineGrid();
  void fillEngineThumbs();
}

/** 收起时只留三行，超出部分用这个按钮在「全部 / 收起」之间切换。 */
function toggleEngineExpanded() {
  state.engineExpanded = !state.engineExpanded;
  renderEngineGrid();
  void fillEngineThumbs();
}

async function useEngineItem(id) {
  if (state.busy) return;
  const item = (state.engineList || []).find((entry) => entry.id === id);
  if (!item || !item.supported) return;

  setBusy(true);
  try {
    const result = await invoke(`${GLASS}.engineApply`, { id });
    adoptGlassState(result);
    if (result && result.ok === false) {
      toast(result.message || "无法使用这张壁纸", true);
      return;
    }
    toast(`已启用动态壁纸：${item.title}`);
  } catch (error) {
    toast(error.message || "无法使用这张壁纸", true);
  } finally {
    setBusy(false);
  }
}

async function useRecent(path) {
  if (state.busy) return;
  setBusy(true);
  try {
    const result = await invoke(`${GLASS}.setWallpaper`, { path });
    adoptGlassState(result);
    if (result && result.ok === false) {
      toast(result.message || "这张图已经不能用了", true);
      return;
    }
    toast("已切换到这张背景图");
  } catch (error) {
    toast(error.message || "无法使用这张图", true);
  } finally {
    setBusy(false);
  }
}

async function forgetRecent(path) {
  if (state.busy) return;
  const entry = state.recent.find((item) => item.path === path);
  const name = (entry && entry.name) || basename(path);
  const current = state.glass.wallpaper === path;
  const ok = await askConfirm(
    "删除这张背景图",
    current ? `「${name}」正在使用，删除后会回到没有背景图的状态。` : `「${name}」会从最近使用里移除。`,
    "删除"
  );
  if (!ok) return;

  setBusy(true);
  try {
    const result = await invoke(`${GLASS}.forgetWallpaper`, { path });
    adoptGlassState(result);
    toast("已删除背景图");
  } catch (error) {
    toast(error.message || "无法删除这张背景图", true);
  } finally {
    setBusy(false);
  }
}

// ------------------------------------------------------------------- binding

function bindEvents() {
  elements.motionOverride.addEventListener("change", () =>
    setMotionConfig({ override: elements.motionOverride.checked }, 0)
  );
  elements.motionDisabled.addEventListener("change", () =>
    setMotionConfig({ disabled: elements.motionDisabled.checked }, 0)
  );
  elements.intensity.addEventListener("input", () => {
    paintRange(elements.intensity);
    setMotionConfig({ intensity: Number(elements.intensity.value) / 100 });
  });
  elements.speed.addEventListener("input", () => {
    paintRange(elements.speed);
    setMotionConfig({ speed: Number(elements.speed.value) / 100 });
  });
  elements.followReduced.addEventListener("change", () =>
    setMotionConfig({ followReducedMotion: elements.followReduced.checked }, 0)
  );
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.mode === "auto") state.systemBase = null;
      setMotionConfig({ mode: button.dataset.mode }, 0);
    });
  });
  document.querySelectorAll("[data-reset]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.reset === "motion") void resetMotion();
      else void resetGlass();
    });
  });

  elements.glassToggle.addEventListener("change", () => setGlassConfig({ enabled: elements.glassToggle.checked }, 0));
  elements.glassIntensity.addEventListener("input", () => {
    paintRange(elements.glassIntensity);
    setGlassConfig({ intensity: Number(elements.glassIntensity.value) / 100 });
  });
  document.querySelectorAll("[data-glass-fit]").forEach((button) => {
    button.addEventListener("click", () => setGlassConfig({ fit: button.dataset.glassFit }, 0));
  });
  elements.pickButton.addEventListener("click", pickWallpaper);
  for (const button of elements.tabButtons) {
    button.addEventListener("click", () => void selectBackdropTab(button.dataset.backdropTab));
  }
  elements.engineMore.addEventListener("click", toggleEngineExpanded);
  elements.engineGrid.addEventListener("click", (event) => {
    const use = event.target.closest("[data-engine-use]");
    if (use) void useEngineItem(use.dataset.engineUse);
  });
  // 缩略图解码失败时只留标题，不留一个破图标。
  elements.engineGrid.addEventListener("error", (event) => {
    if (event.target instanceof HTMLImageElement) event.target.remove();
  }, true);
  elements.fileInput.addEventListener("change", () => {
    const file = elements.fileInput.files && elements.fileInput.files[0];
    if (file) void uploadWallpaper(file);
  });
  elements.recentList.addEventListener("click", (event) => {
    // 删除图标是卡片的兄弟节点而不是子节点，但先判删除更稳：卡片正被删除时
    // 不该顺手把这张图又应用一次。
    const forget = event.target.closest("[data-recent-forget]");
    if (forget) {
      void forgetRecent(forget.dataset.recentForget);
      return;
    }
    if (event.target.closest("[data-wallpaper-off]")) {
      void clearWallpaper();
      return;
    }
    const use = event.target.closest("[data-recent-use]");
    if (use) void useRecent(use.dataset.recentUse);
  });
  // 缩略图由面板画好存在条目里；某个格式解码失败时只留文件名。
  elements.recentList.addEventListener("error", (event) => {
    if (event.target instanceof HTMLImageElement) event.target.remove();
  }, true);

  elements.confirmCancel.addEventListener("click", () => closeConfirm(false));
  elements.confirmOk.addEventListener("click", () => closeConfirm(true));
  elements.confirm.addEventListener("click", (event) => {
    if (event.target === elements.confirm) closeConfirm(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.confirm.hidden) closeConfirm(false);
  });

  window.pluginBridge?.on?.("appearance:changed", applyAppearance);
}

async function initialize() {
  Object.assign(elements, {
    view: byId("view-appearance"),
    motionOverrideSub: byId("motion-override-sub"),
    motionOverride: byId("motion-override"),
    motionDisabled: byId("motion-disabled"),
    intensity: byId("intensity"),
    speed: byId("speed"),
    intensityValue: byId("intensity-value"),
    speedValue: byId("speed-value"),
    followReduced: byId("follow-reduced"),
    glassToggle: byId("glass-toggle"),
    glassEnabledSub: byId("glass-enabled-sub"),
    glassFitButtons: Array.from(document.querySelectorAll("[data-glass-fit]")),
    glassIntensity: byId("glass-intensity"),
    glassFitRow: byId("glass-fit-row"),
    glassIntensityValue: byId("glass-intensity-value"),
    backdropName: byId("glass-backdrop-name"),
    tabButtons: Array.from(document.querySelectorAll("[data-backdrop-tab]")),
    panelImage: byId("glass-panel-image"),
    panelEngine: byId("glass-panel-engine"),
    wallpaperName: byId("glass-wallpaper-name"),
    pickButton: byId("glass-wallpaper-pick"),
    glassFitHint: byId("glass-fit-hint"),
    fileInput: byId("glass-wallpaper-file"),
    recentList: byId("glass-recent-list"),
    engineHead: byId("glass-engine-head"),
    engineMore: byId("glass-engine-more"),
    engineGrid: byId("glass-engine-grid"),
    confirm: byId("confirm"),
    confirmTitle: byId("confirm-title"),
    confirmText: byId("confirm-text"),
    confirmCancel: byId("confirm-cancel"),
    confirmOk: byId("confirm-ok"),
    toast: byId("toast"),
  });
  bindEvents();
  watchEngineGrid();
  renderMotion();
  renderGlass();
  setBusy(true);
  try {
    const [motionState, glassState] = await Promise.all([
      invoke(`${MOTION}.getState`),
      invoke(`${GLASS}.getState`).catch(() => null),
    ]);
    applyResult({ ...motionState, config: (motionState && motionState.config) || state.config });
    if (glassState) adoptGlassState(glassState);
    if (state.config.mode === "auto") await flushSync();
  } catch (error) {
    applyAppearance(state.appearance);
    state.appliedBase = resolvedBase();
    syncDocumentBase(state.appliedBase);
    toast(error.message || "无法读取设置", true);
  } finally {
    setBusy(false);
  }
}

window.PiOptAppearance = { boot: initialize };
})();
