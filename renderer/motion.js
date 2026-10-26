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
  followTimer: null,
  messageCount: 0,
  followInFlight: false,
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

function localTokens(config) {
  const presets = {
    agile: { durationScale: 0.78, motionScale: 0.8 },
    balanced: { durationScale: 1, motionScale: 1 },
    gentle: { durationScale: 1.18, motionScale: 1 },
    reduced: { durationScale: 0.48, motionScale: 0 },
  };
  const preset = presets[config.preset] || presets.balanced;
  const reduced = config.preset === "reduced" || (config.followReducedMotion && reducedQuery.matches);
  const durationFactor = (reduced ? 0.48 : preset.durationScale) / clamp(config.speed, 0.65, 1.4);
  const distanceFactor = reduced ? 0 : preset.motionScale * clamp(config.intensity, 0.5, 1.25);
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


function previewCss(tokens) {
  return `#motion-preview{--pm-instant:${tokens.instant}ms;--pm-fast:${tokens.fast}ms;--pm-base:${tokens.base}ms;--pm-slow:${tokens.slow}ms;--pm-distance-sm:${tokens.distanceSm}px;--pm-distance-md:${tokens.distanceMd}px;--pm-distance-panel:${Math.round(tokens.distanceMd * 1.14 * 100) / 100}px;--pm-scale-from:${tokens.scaleFrom};--pm-ease-out:${tokens.easeOut};--pm-ease-standard:${tokens.easeStandard};--pm-ease-in:${tokens.easeIn}}`;
}

async function invoke(channel, payload = {}) {
  if (window.pluginBridge && typeof window.pluginBridge.invoke === "function") {
    return window.pluginBridge.invoke(channel, payload);
  }
  if (channel === "motion.getState") {
    return { config: { ...DEFAULT_CONFIG }, appearance: state.appearance, resolvedBase: "dark", themes: [] };
  }
  if (channel === "motion.previewCss") {
    const tokens = localTokens(payload.config || state.config);
    return { config: payload.config, tokens, css: previewCss(tokens) };
  }
  if (channel === "motion.reset") return { ok: true, config: { ...DEFAULT_CONFIG } };
  if (channel === "motion.save" || channel === "motion.apply") {
    return { ok: true, config: payload.config, appliedTheme: "preview" };
  }
  throw new Error(`Unknown preview channel: ${channel}`);
}
function resolvedBase() {
  if (state.config.mode === "light" || state.config.mode === "dark") return state.config.mode;
  if (state.preference === "light" || state.preference === "dark") return state.preference;
  if (lightQuery.matches) return "light";
  return "dark";
}

function applyAppearance(appearance) {
  if (appearance && typeof appearance === "object") state.appearance = appearance;
  if (typeof state.appearance.locale === "string" && state.appearance.locale) {
    document.documentElement.lang = state.appearance.locale;
  }
  renderMode();
  scheduleFollow();
}

// One place that takes the process's answer. `preference` and `resolvedBase` come
// from the process, so the page and the process cannot disagree about what "auto"
// means — that disagreement is what used to re-apply on every appearance event
// and flip the theme back and forth several times a second.
function applyResult(result) {
  if (!result || typeof result !== "object") return;
  if (result.config) state.config = { ...DEFAULT_CONFIG, ...result.config };
  if (typeof result.preference === "string") state.preference = result.preference;
  if (result.appearance) state.appearance = result.appearance;
  if (typeof result.resolvedBase === "string") state.appliedBase = result.resolvedBase;
  document.documentElement.dataset.base = state.appliedBase;
  renderConfig();
}

// "auto" keeps up with the appearance; an explicit light or dark choice follows
// nothing. When the resolved base already matches what is on screen nothing is
// sent, so a single appearance change settles in a single call.
function scheduleFollow() {
  if (state.config.mode !== "auto") return;
  if (resolvedBase() === state.appliedBase) return;
  window.clearTimeout(state.followTimer);
  state.followTimer = window.setTimeout(() => { void followAppearance(); }, 200);
}

async function followAppearance() {
  if (state.config.mode !== "auto" || state.followInFlight) return;
  if (resolvedBase() === state.appliedBase) return;
  state.followInFlight = true;
  try {
    applyResult(await invoke("motion.apply", { config: state.config, hints: hints() }));
  } catch {
    /* keep what is applied; the next appearance change tries again */
  } finally {
    state.followInFlight = false;
  }
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
  const labels = {
    ready: ["实时应用已就绪", "参数调整会实时应用到 PI-Desktop"],
    pending: ["正在同步到 PI-Desktop", "正在将最新参数同步到 PI-Desktop"],
    error: ["实时同步失败", "同步失败，参数保留在本地；调整任一选项可重试"],
  };
  const [title, footer] = labels[status] || labels.ready;
  elements.syncDot.dataset.state = status;
  elements.syncDot.title = detail || title;
  elements.titleStatus.textContent = detail || title;
  elements.footerNote.textContent = footer;
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
  const base = resolvedBase();
  elements.preview.dataset.base = base;
  elements.previewMode.textContent = `${base === "light" ? "Light" : "Dark"} base`;
}

function renderConfig() {
  renderPressed("[data-preset]", "preset", state.config.preset);
  elements.presetSummary.textContent = PRESET_COPY[state.config.preset] || PRESET_COPY.balanced;
  elements.intensity.value = String(Math.round(state.config.intensity * 100));
  elements.speed.value = String(Math.round(state.config.speed * 100));
  elements.intensityValue.textContent = `${Math.round(state.config.intensity * 100)}%`;
  elements.speedValue.textContent = `${state.config.speed.toFixed(2)}×`;
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
  const indicator = clamp(tokens.slow / 360, 0, 1) * 100;
  elements.rulerIndicator.style.left = `${indicator}%`;
}

let previewRequest = 0;
async function updatePreview() {
  const request = ++previewRequest;
  const effective = state.config.followReducedMotion && reducedQuery.matches
    ? { ...state.config, preset: "reduced" }
    : state.config;
  try {
    const result = await invoke("motion.previewCss", { config: effective });
    if (request !== previewRequest) return;
    const tokens = result.tokens || localTokens(effective);
    elements.previewTokenStyle.textContent = result.css || previewCss(tokens);
    renderTokens(tokens);
  } catch (error) {
    if (request !== previewRequest) return;
    const tokens = localTokens(effective);
    elements.previewTokenStyle.textContent = previewCss(tokens);
    renderTokens(tokens);
    toast(error.message || "预览参数更新失败", true);
  }
}

function replayClass(className) {
  elements.preview.classList.remove(className);
  void elements.preview.offsetWidth;
  elements.preview.classList.add(className);
  window.setTimeout(() => elements.preview.classList.remove(className), (state.tokens?.slow || 260) + 80);
}

function demoNavigate() {
  setMenu(false);
  setDialog(false);
  const items = [...document.querySelectorAll(".stage-nav")];
  const current = items.findIndex((item) => item.classList.contains("active"));
  items[current].classList.remove("active");
  items[(current + 1) % items.length].classList.add("active");
  replayClass("demo-navigate");
}

function demoMessage() {
  setMenu(false);
  setDialog(false);
  state.messageCount += 1;
  const article = document.createElement("article");
  article.className = "stage-message assistant-message is-new";
  article.innerHTML = `<div class="message-role">Pi</div><p>动效采样 ${state.messageCount}：响应保持迅速，归位保持稳定。</p>`;
  elements.stageThread.appendChild(article);
  while (elements.stageThread.children.length > 3) elements.stageThread.firstElementChild.remove();
  window.setTimeout(() => article.classList.remove("is-new"), (state.tokens?.base || 190) + 80);
}

function setMenu(open) {
  if (open) elements.stageDialogLayer.hidden = true;
  elements.stageMenu.hidden = !open;
  const button = document.querySelector('[data-demo="menu"]');
  button.setAttribute("aria-expanded", String(open));
}

function setDialog(open) {
  if (open) setMenu(false);
  elements.stageDialogLayer.hidden = !open;
  if (open) elements.stageDialogLayer.querySelector(".stage-dialog").focus?.();
}

function setConfig(patch, debounceMs = 80) {
  state.config = { ...state.config, ...patch };
  renderConfig();
  updatePreview();
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
      const result = await invoke("motion.apply", { config, hints: hints() });
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
    button.addEventListener("click", () => setConfig({ mode: button.dataset.mode }, 0));
  });
  elements.intensity.addEventListener("input", () => setConfig({ intensity: Number(elements.intensity.value) / 100 }));
  elements.speed.addEventListener("input", () => setConfig({ speed: Number(elements.speed.value) / 100 }));
  elements.followReduced.addEventListener("change", () => setConfig({ followReducedMotion: elements.followReduced.checked }, 0));
  elements.resetButton.addEventListener("click", resetConfig);
  elements.stopButton.addEventListener("click", stopMotion);
  document.querySelectorAll("[data-demo]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.demo === "navigate") demoNavigate();
      if (button.dataset.demo === "message") demoMessage();
      if (button.dataset.demo === "menu") setMenu(elements.stageMenu.hidden);
      if (button.dataset.demo === "dialog") setDialog(true);
    });
  });
  document.querySelector("[data-menu-anchor]").addEventListener("click", () => setMenu(elements.stageMenu.hidden));
  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => setDialog(false)));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setMenu(false);
      setDialog(false);
    }
  });
  const onReducedChange = () => {
    if (state.config.followReducedMotion) updatePreview();
  };
  if (typeof reducedQuery.addEventListener === "function") reducedQuery.addEventListener("change", onReducedChange);
  else reducedQuery.addListener(onReducedChange);
  window.pluginBridge?.on?.("appearance:changed", applyAppearance);
}

async function initialize() {
  Object.assign(elements, {
    titleStatus: byId("title-status"), syncDot: byId("sync-dot"), presetSummary: byId("preset-summary"),
    intensity: byId("intensity"), speed: byId("speed"), intensityValue: byId("intensity-value"), speedValue: byId("speed-value"),
    followReduced: byId("follow-reduced"), tokenInstant: byId("token-instant"), tokenFast: byId("token-fast"),
    tokenBase: byId("token-base"), tokenSlow: byId("token-slow"), tokenDistance: byId("token-distance"), tokenScale: byId("token-scale"),
    resetButton: byId("reset-button"), stopButton: byId("stop-button"),
    preview: byId("motion-preview"), previewMode: byId("preview-mode"), previewTokenStyle: byId("preview-token-style"),
    stageThread: byId("stage-thread"), stageMenu: byId("stage-menu"), stageDialogLayer: byId("stage-dialog-layer"),
    rulerIndicator: byId("ruler-indicator"), footerNote: byId("footer-note"), toast: byId("toast"),
  });
  bindEvents();
  renderConfig();
  setBusy(true);
  try {
    const result = await invoke("motion.getState", { hints: hints() });
    applyResult({ ...result, config: result.config || state.config });
    renderConfig();
    await updatePreview();
    markDirty(false);
  } catch (error) {
    applyAppearance(state.appearance);
    state.appliedBase = resolvedBase();
    document.documentElement.dataset.base = state.appliedBase;
    await updatePreview();
    markDirty(false);
    elements.titleStatus.textContent = "独立预览模式";
    toast(error.message || "无法读取插件状态，已进入预览模式", true);
  } finally {
    setBusy(false);
  }
}

window.PiOptMotion = { boot: initialize };
})();
