"use strict";

/**
 * The appearance feature: interface motion and the window material, in one place.
 *
 * Both halves are one layer in the end — a single runtime theme that carries the
 * motion rules and, when the glass switch is on, the frosted surfaces — so they
 * are merged rather than wired together: the stylesheet is built here, from both
 * settings stores, and applied the same way whichever half changed.
 *
 * Two panel sections still ask separately (motion is `appearance.motion.*`, the
 * material is `appearance.glass.*`), but one channel table answers both here. The
 * pre-merge `motion.*` and `glass.*` names are accepted too: a panel window that
 * survived a reload can still be holding the old ones.
 */

const { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");

const motion = require("./motion.js");
const glass = require("./glass.js");
// Wallpaper Engine 的壁纸库：只有 video 类型能在这里真的播放，其余退回预览图。
const engine = require("./engine.js");

// One command per half: they open the same view on a different section, which is
// what the old two-view panel did with its motion and material tabs.
const COMMAND_IDS = Object.freeze({
  motion: "pi-modify.open",
  glass: "piopt.glass",
});
const PREFERENCE_KEY = "motion.hostPreference";
const THEME_LABEL = "PiOpt Appearance";

// The wallpaper the panel uploaded lives in the plugin's data folder. Two
// reasons it travels as bytes rather than a path: Electron removed `File.path`,
// and asking this windowless process for a native dialog blocks forever. The
// theme then references the absolute path, which the host rewrites to a
// `plugin-asset:` URL — the only way a runtime theme may carry an image.
const DATA_PREFIX = "wallpaper.";

let motionConfig = { ...motion.DEFAULT_CONFIG };
let glassConfig = { ...glass.DEFAULT_CONFIG };

// ------------------------------------------------------------------ appearance

async function getAppearance() {
  try {
    return await pi.app.getAppearance();
  } catch {
    return { base: "dark", theme: "dark", pluginTheme: null };
  }
}

async function readMotionConfig() {
  const settings = await pi.plugin.getSettings();
  return motion.normalizeConfig(settings && settings[motion.SETTINGS_KEY]);
}

async function readGlassConfig() {
  const settings = await pi.plugin.getSettings();
  return glass.normalizeGlassConfig(settings && settings[glass.SETTINGS_KEY]);
}

// What the user had picked in PI-Desktop before this theme took the selection:
// "system", "light" or "dark". Only a fallback — "auto" prefers the system
// reading the page reports, because this record just says what was picked once.
async function readPreference() {
  try {
    const settings = await pi.plugin.getSettings();
    return motion.preferenceFrom(settings && settings[PREFERENCE_KEY]) ?? "system";
  } catch {
    return "system";
  }
}

async function savePreference(preference) {
  try {
    await pi.plugin.setSettings({ [PREFERENCE_KEY]: preference });
  } catch {
    /* the next apply records it again */
  }
}

function activeThemeId(appearance) {
  if (typeof appearance.pluginTheme === "string") return appearance.pluginTheme;
  if (appearance.pluginTheme && typeof appearance.pluginTheme.id === "string") {
    return appearance.pluginTheme.id;
  }
  return "";
}

// The host namespaces plugin themes as `plugin:<plugin id>:<theme id>`, so the id
// is asked for rather than rebuilt. Hard-coding the pre-merge `local.pi-modify`
// namespace is what once produced `unknown theme id`.
async function registeredThemeId() {
  const pluginId = pi.plugin.getId();
  const fullId = `plugin:${pluginId}:${motion.THEME_ID}`;
  let entries = [];
  try {
    if (pi.themes && typeof pi.themes.list === "function") entries = await pi.themes.list();
  } catch {
    entries = [];
  }
  const list = Array.isArray(entries) ? entries : [];
  if (list.some((entry) => entry && entry.id === fullId)) return fullId;
  const byThemeId = list.find((entry) => entry && entry.themeId === motion.THEME_ID);
  return byThemeId && typeof byThemeId.id === "string" ? byThemeId.id : fullId;
}

// ------------------------------------------------------------------ stylesheet

function buildGlassLayer(config) {
  try {
    return glass.buildGlassCss(config);
  } catch {
    // An unreadable wallpaper must not cost the motion layer.
    return "";
  }
}

// One theme whose base follows the setting. Upserting the same id with a new base
// is what makes "auto" work: the host re-broadcasts the appearance, so the shell
// recolours without the user switching themes.
//
// Upsert is not free: the host rebuilds the theme and re-broadcasts the
// appearance, which repaints every window. Opening the panel applies the same
// config that is already in effect, so identical CSS is skipped; onLoad clears
// the cache so a plugin reload always re-registers.
let lastRegistered = null;

function resetThemeCache() {
  lastRegistered = null;
}

async function registerTheme(motionLayer, glassLayer, base) {
  if (!pi.themes || typeof pi.themes.upsert !== "function") {
    throw new Error("当前 PI-Desktop 版本不支持运行时主题 API，请升级后重试。");
  }
  // Motion rules and the glass layer are one stylesheet: PI-Desktop injects a
  // runtime theme into the host window, and that is the only channel a plugin
  // has into the shell's own document.
  const css = `${motion.buildThemeCss(motionLayer, base)}${glassLayer}`;
  if (Buffer.byteLength(css, "utf8") > motion.CSS_LIMIT_BYTES) {
    throw new RangeError("Generated theme CSS exceeds the PI-Desktop 256 KB limit.");
  }
  if (!lastRegistered || lastRegistered.base !== base || lastRegistered.css !== css) {
    await pi.themes.upsert({
      id: motion.THEME_ID,
      label: THEME_LABEL,
      base,
      css,
    });
    lastRegistered = { base, css };
  }
  // The old light/dark pair must not linger in the host's theme list.
  for (const legacy of motion.LEGACY_THEME_IDS) {
    try {
      await pi.themes.remove(legacy);
    } catch {
      /* never registered, or already gone */
    }
  }
}

function resolveNow(config, appearance, preference, hints) {
  return motion.resolveBase(config.mode, appearance, {
    preference,
    prefersLight: hints.prefersLight,
  });
}

/**
 * Writes the one theme from both halves and takes the host's selection over.
 *
 * Every appearance change goes through here, whichever half asked: the
 * stylesheet always carries both layers, so a change can never drop the other.
 */
async function applyTheme({ hints = {}, force = false } = {}) {
  const appearance = await getAppearance();
  const preference = motion.preferenceFrom(appearance.theme) ?? await readPreference();
  const base = resolveNow(motionConfig, appearance, preference, hints);
  if (force) resetThemeCache();
  await registerTheme(motionConfig, buildGlassLayer(glassConfig), base);
  const themeId = await registeredThemeId();
  if (activeThemeId(appearance) !== themeId) await pi.app.setTheme(themeId);
  return { appliedTheme: themeId, resolvedBase: base, preference };
}

// --------------------------------------------------------------------- motion

async function statePayload(hints = {}) {
  const appearance = await getAppearance();
  const themes = pi.themes && typeof pi.themes.list === "function"
    ? await pi.themes.list()
    : [];
  const preference = motion.preferenceFrom(appearance.theme) ?? await readPreference();
  return {
    config: motionConfig,
    limits: motion.LIMITS,
    appearance,
    themes,
    preference,
    resolvedBase: resolveNow(motionConfig, appearance, preference, hints),
  };
}

async function applyMotion(input, hints = {}) {
  const config = motion.normalizeConfig(input);
  const appearance = await getAppearance();
  const hostPreference = motion.preferenceFrom(appearance.theme);
  const recorded = await readPreference();
  // The user's own pick wins while the host still holds it; otherwise the value
  // recorded before this theme took over is the only truth left.
  const preference = hostPreference ?? recorded;
  if (hostPreference && hostPreference !== recorded) await savePreference(hostPreference);

  motionConfig = config;
  const applied = await applyTheme({ hints });
  await pi.plugin.setSettings({ [motion.SETTINGS_KEY]: config });

  return {
    ...(await statePayload({ preference, prefersLight: hints.prefersLight })),
    ...applied,
  };
}

// Reading the OS preference in the plugin process is what keeps "auto" cheap.
// The renderer used to hand the theme selection back to the host for ~150ms just
// to see a real prefers-color-scheme, which flashed the whole window on every
// panel open; a registry/plist/gsettings read costs a few milliseconds and does
// not touch the active theme at all.
function readSystemBase() {
  const run = (file, args) => {
    const { execFileSync } = require("node:child_process");
    return execFileSync(file, args, { encoding: "utf8", timeout: 2000, windowsHide: true });
  };
  try {
    if (process.platform === "win32") {
      const out = run("reg", [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
        "/v",
        "AppsUseLightTheme",
      ]);
      const match = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
      if (!match) return null;
      return Number.parseInt(match[1], 16) === 1 ? "light" : "dark";
    }
    if (process.platform === "darwin") {
      try {
        return /dark/i.test(run("defaults", ["read", "-g", "AppleInterfaceStyle"])) ? "dark" : "light";
      } catch {
        // The key only exists on a dark system.
        return "light";
      }
    }
    const out = run("gsettings", ["get", "org.gnome.desktop.interface", "color-scheme"]);
    if (/dark/i.test(out)) return "dark";
    if (/light|default/i.test(out)) return "light";
    return null;
  } catch {
    // No shell, no registry, an unknown desktop: let the renderer fall back.
    return null;
  }
}

// ------------------------------------------------------------ wallpaper thumbs

/*
 * 缩略图不在这里画。插件主入口跑在独立的 Node 进程里，不是 Electron 主进程，
 * 所以 `require("electron").nativeImage` 不存在——早先那版缩略图在真实宿主里
 * 一片空白就是这个原因。面板是 Chromium，能解码图片也能用 canvas 缩图，但它
 * 读不到数据目录（宿主的 fs 范围只覆盖工作区）。
 *
 * 于是缩略图由面板画好，随条目存在 recent 里（saveWallpaper / saveThumb）；存量
 * 图片则由面板逐张取原图字节（wallpaperBytes）现画一次再存回来。
 */
const IMAGE_MIME = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
});

function imageMimeOf(name) {
  return IMAGE_MIME[extensionOf(name)] || "application/octet-stream";
}

// ---------------------------------------------------------------------- glass

function glassStatePayload() {
  const recent = glassConfig.recent.map((entry) => {
    const problem = wallpaperProblem(entry.path);
    return {
      path: entry.path,
      name: entry.name,
      // 读不到或已不可用的图不生成缩略图：卡片只剩文件名，比空白方块更清楚。
      thumb: problem ? "" : entry.thumb || "",
      // 只有 missing 才是「文件没了」；其它问题在选中的时候才会被拦下。
      missing: problem === "missing" || problem === "unsupported",
    };
  });
  return {
    config: glassConfig,
    recent,
    presets: Object.keys(glass.PRESETS),
    fits: [...glass.FITS],
    limits: glass.LIMITS,
    wallpaperExtensions: [...glass.WALLPAPER_EXTENSIONS],
    wallpaperMaxBytes: glass.WALLPAPER_MAX_BYTES,
  };
}

/**
 * Why a path cannot be used as a wallpaper, or null when it can.
 *
 * The host enforces the same two rules when it rewrites `url(…)` to a
 * `plugin-asset:` URL — a 4 MB ceiling and its own extension list. Checking
 * here turns a rejected `themes.upsert` into a sentence the user can act on.
 */
function wallpaperProblem(candidate) {
  const target = String(candidate ?? "").trim();
  if (!target) return "empty";
  if (!glass.isSupportedWallpaper(target)) return "unsupported";
  let stats;
  try {
    stats = statSync(target);
  } catch {
    return "missing";
  }
  if (!stats.isFile()) return "missing";
  if (stats.size > glass.WALLPAPER_MAX_BYTES) return "too-large";
  return null;
}

const WALLPAPER_ERRORS = {
  empty: "没有选择图片。",
  unreadable: "图片内容读不出来，换一张试试。",
  unsupported: `只支持 ${glass.WALLPAPER_EXTENSIONS.join(" / ")} 图片。`,
  missing: "找不到这个文件，或者它不是普通文件。",
  "too-large": `图片不能超过 ${Math.round(glass.WALLPAPER_MAX_BYTES / 1024 / 1024)} MB。`,
};

async function notify(message) {
  try {
    await pi.ui.showToast(message, "error");
  } catch {
    /* a toast is best effort */
  }
}

async function persistGlass(config, { apply = true } = {}) {
  glassConfig = glass.normalizeGlassConfig(config);
  await pi.plugin.setSettings({ [glass.SETTINGS_KEY]: glassConfig });
  if (apply) await applyTheme();
  return { ...glassStatePayload(), applied: apply };
}

function refuse(reason) {
  const message = WALLPAPER_ERRORS[reason] || "这个文件不能用作背景图。";
  void notify(message);
  return { ok: false, reason, message, ...glassStatePayload() };
}

async function adoptWallpaper(target, name, thumb = "") {
  const problem = wallpaperProblem(target);
  if (problem) {
    // Drop a reference that stopped resolving instead of leaving the theme
    // pointing at an asset the host can no longer serve: `themes.upsert` would
    // then fail outright and take the motion layer down with it.
    if (problem === "missing" && glassConfig.wallpaper) {
      await persistGlass({ ...glassConfig, wallpaper: "" });
    }
    return refuse(problem);
  }

  // Turning glass on here would be a surprise: the switch is the user's.
  // The photo is its own layer and stays visible with the glass off, so picking
  // one must not silently flip the user's switch.
  await persistGlass({
    ...glassConfig,
    wallpaper: target,
    recent: glass.rememberWallpaper(glassConfig.recent, target, name, thumb),
    // 选一张普通图片就是「不再是 Wallpaper Engine 壁纸」：两套来源不能同时
    // 生效，否则视频层会压在图片上，谁也不是用户想要的那张。
    engine: { ...glass.EMPTY_ENGINE },
  });
  return { ok: true, ...glassStatePayload() };
}

function extensionOf(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name ?? ""));
  return match ? match[1].toLowerCase() : "";
}

/**
 * 把上传的字节写进插件数据目录，并采纳这个路径。
 *
 * 每次上传都写一个独立的文件（时间戳命名），因为「最近使用」要同时留住几张图；
 * 只在使用者从列表里删掉某一项时才删除对应文件。
 */
async function saveWallpaperBytes(name, base64, thumb = "") {
  const extension = extensionOf(name);
  if (!glass.WALLPAPER_EXTENSIONS.includes(extension)) return refuse("unsupported");

  let buffer;
  try {
    buffer = Buffer.from(String(base64 ?? ""), "base64");
  } catch {
    return refuse("unreadable");
  }
  if (!buffer.length) return refuse("unreadable");
  if (buffer.length > glass.WALLPAPER_MAX_BYTES) return refuse("too-large");

  let dataDir;
  try {
    dataDir = await pi.plugin.getDataPath();
  } catch {
    return refuse("unreadable");
  }

  const target = join(dataDir, `${DATA_PREFIX}${Date.now().toString(36)}.${extension}`);
  try {
    writeFileSync(target, buffer);
  } catch {
    return refuse("unreadable");
  }

  return adoptWallpaper(target, name, thumb);
}


// --------------------------------------------------------- wallpaper engine

/*
 * Wallpaper Engine 的壁纸只有一种能在这里画出来：
 *
 * - video（mp4 / webm）：真的播放。文件留在创意工坊目录里，渲染模块用
 *   `file:` URL 播它；设置里只记 id、标题与路径。
 * - scene / web / application / preset：由 Wallpaper Engine 自己的渲染器绘制，
 *   插件复刻不了，一律不可选。项目自带的 `preview.gif` / `preview.jpg` 是创意
 *   工坊列表用的**方形封面**（本机 42 张全是 1:1、192–1024 px），只够当列表
 *   卡片的缩略图——拿它铺窗口会是一张被裁切的方图，所以没有“静帧兜底”。
 */
const ENGINE_ERRORS = Object.freeze({
  "no-workshop": "没找到 Wallpaper Engine 的创意工坊目录：Steam 里装过至少一张壁纸才会出现。",
  "engine-only": "这类壁纸要由 Wallpaper Engine 本机渲染，这里只能播放 video 类。",
  "video-unplayable": "这个视频不是 mp4 / webm，或者文件已经不在了。",
  "unknown-project": "这个壁纸已经不在了，重新扫一次试试。",
});

// 不缓存扫描结果：几十个目录的一次 stat 是毫秒级，缓存只会让「刚装好的壁纸
// 不出现」，而这正是用户打开这个列表时最想看到的东西。
function engineItems() {
  return engine.scanAll(engine.discoverWorkshopRoots());
}

function engineItemById(id) {
  const target = String(id ?? "").trim();
  if (!target) return null;
  return engineItems().find((item) => item.id === target) || null;
}

function engineRefuse(reason) {
  const message = ENGINE_ERRORS[reason] || "这个壁纸用不了。";
  void notify(message);
  return { ok: false, reason, message, ...glassStatePayload() };
}

function engineScanPayload() {
  const roots = engine.discoverWorkshopRoots();
  const items = engine.scanAll(roots);
  return {
    ok: roots.length > 0,
    reason: roots.length ? "" : "no-workshop",
    message: roots.length ? "" : ENGINE_ERRORS["no-workshop"],
    libraryCount: roots.length,
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      // type 是 Wallpaper Engine 自己的分类（scene / video / web / …）；
      // 只有 video 能播，其余在这里一律不可选。
      type: item.type,
      kind: item.kind,
      supported: item.supported,
      reason: item.reason,
      // 方形封面只用来画列表缩略图。
      hasPreview: Boolean(item.preview),
    })),
  };
}

function enginePreviewPayload(id) {
  const item = engineItemById(id);
  if (!item) return { ok: false, reason: "unknown-project" };
  const preview = engine.previewOf(item);
  if (!preview) return { ok: false, reason: "no-preview" };
  return { ok: true, mime: preview.mime, data: preview.data };
}

async function applyEngineWallpaper(payload = {}) {
  const item = engineItemById(payload.id);
  if (!item) return engineRefuse("unknown-project");
  if (item.kind !== "video") return engineRefuse("engine-only");
  if (!item.supported) return engineRefuse(item.reason || "video-unplayable");

  const next = {
    ...glassConfig,
    // 视频层自己铺满窗口，图片层必须让位，否则会在它下面留一张旧图。
    wallpaper: "",
    engine: { id: item.id, title: item.title, kind: "video", file: item.file },
  };
  return { ok: true, ...(await persistGlass(next)) };
}

/** 两种背景只能有一个生效，所以「不使用」把图片与视频一起撤掉。 */
async function clearEngineWallpaper() {
  const next = { ...glassConfig, wallpaper: "", engine: { ...glass.EMPTY_ENGINE } };
  return { ok: true, ...(await persistGlass(next)) };
}

/**
 * 旧版本曾把 scene 壁纸的方形封面当成静帧背景写进数据目录
 * （`wallpaper.engine-<id>.jpg`）。那不是壁纸画面，升级时清掉它，免得窗口上
 * 一直挂着一张被裁切的方图。
 */
async function dropLegacyEngineStill() {
  const target = String(glassConfig.wallpaper ?? "");
  if (!/^wallpaper\.engine-\d{1,20}\.jpg$/i.test(basename(target))) return false;
  try {
    const dataDir = await pi.plugin.getDataPath();
    if (ownsWallpaper(dataDir, target)) unlinkSync(target);
  } catch {
    /* 删不掉文件不影响把它从设置里去掉 */
  }
  glassConfig = glass.normalizeGlassConfig({
    ...glassConfig,
    wallpaper: "",
    engine: { ...glass.EMPTY_ENGINE },
  });
  await pi.plugin.setSettings({ [glass.SETTINGS_KEY]: glassConfig });
  return true;
}

/** 渲染模块要的那一份：只有它能用的字段，不含面板用的元数据。 */
function getEngineWallpaperState() {
  const source = glassConfig.engine;
  return {
    engine: {
      id: source.id,
      title: source.title,
      kind: source.kind,
      file: source.kind === "video" ? source.file : "",
    },
    fit: glassConfig.fit,
    // 视频层是否停住画面：渲染模块不会自己读设置，只能从这里拿。
    performance: glassConfig.performance,
  };
}
// ------------------------------------------------------------------ lifecycle

async function openPanel(section) {
  try {
    await pi.plugin.setSettings({ panelFeature: "appearance", panelSection: section });
  } catch {
    /* the panel falls back to its remembered view */
  }
  await pi.ui.openPanel({ title: "PiOpt" });
}

async function onLoad() {
  // A reload means the host may have lost the registration; start from zero.
  resetThemeCache();
  motionConfig = await readMotionConfig();
  glassConfig = await readGlassConfig();
  // 旧版本把 scene 壁纸的方形封面写成了静帧背景：那不是画面，先清掉。
  await dropLegacyEngineStill();
  // A wallpaper that moved or was deleted must not keep the theme pointing at a
  // path the host can no longer serve; the same goes for a Wallpaper Engine clip
  // the renderer module would chase forever.
  if (glassConfig.wallpaper && wallpaperProblem(glassConfig.wallpaper)) {
    // No theme refresh here: the applyTheme below carries the cleaned config.
    await persistGlass({ ...glassConfig, wallpaper: "", engine: { ...glass.EMPTY_ENGINE } }, { apply: false });
  }
  if (glassConfig.engine.kind === "video") {
    let playable = false;
    try {
      playable = statSync(glassConfig.engine.file).isFile();
    } catch {
      playable = false;
    }
    if (!playable) await persistGlass({ ...glassConfig, engine: { ...glass.EMPTY_ENGINE } }, { apply: false });
  }

  await applyTheme({ force: true });
  // Removing the old light/dark pair would otherwise leave a user who had
  // selected one of them on the host's fallback theme; take the selection over
  // instead.
  const appearance = await getAppearance();
  const previous = activeThemeId(appearance);
  if (previous.startsWith(`plugin:${pi.plugin.getId()}:`)) {
    const themeId = await registeredThemeId();
    if (previous !== themeId) await pi.app.setTheme(themeId);
  }

  await pi.commands.register({
    id: COMMAND_IDS.motion,
    title: "PiOpt: 打开外观",
    keywords: ["piopt", "pi-modify", "appearance", "motion", "animation", "外观", "动效", "动画", "减弱动态"],
    run: () => openPanel("motion"),
  });
  await pi.commands.register({
    id: COMMAND_IDS.glass,
    title: "PiOpt: 打开窗口材质",
    keywords: ["piopt", "glass", "mica", "acrylic", "外观", "磨砂", "玻璃", "材质", "透明", "背景图"],
    run: () => openPanel("glass"),
  });
}

async function onUnload() {
  for (const id of Object.values(COMMAND_IDS)) {
    try {
      await pi.commands.unregister(id);
    } catch {
      /* already gone */
    }
  }
}

// ----------------------------------------------------------------- panel calls

async function onMotion(channel, payload) {
  switch (channel) {
    case "appearance.motion.getState":
      motionConfig = await readMotionConfig();
      return statePayload(payload.hints ?? {});
    case "appearance.motion.tokens": {
      const config = motion.normalizeConfig(payload.config);
      return { config, tokens: motion.motionTokens(config) };
    }
    case "appearance.motion.save":
      return { ok: true, config: await applyMotion(payload.config, payload.hints ?? {}) };
    // The host sets nativeTheme.themeSource to our theme's base, so the page's
    // prefers-color-scheme reports our own base back at us and "auto" can never
    // see the real system. The process reads the OS value instead.
    case "appearance.motion.systemBase":
      return { ok: true, base: readSystemBase(), platform: process.platform };
    // Kept as a fallback for when the OS read is unavailable: hand the selection
    // back to the host for a moment, which does flash, so it is the last resort.
    case "appearance.motion.release":
      await pi.app.setTheme("system");
      return { ok: true };
    case "appearance.motion.apply":
      return { ok: true, ...(await applyMotion(payload.config, payload.hints ?? {})) };
    case "appearance.motion.reset":
      return { ok: true, ...(await applyMotion(motion.DEFAULT_CONFIG, payload.hints ?? {})) };
    default:
      return null;
  }
}

async function onGlass(channel, payload) {
  switch (channel) {
    case "appearance.glass.getState":
      glassConfig = await readGlassConfig();
      await dropLegacyEngineStill();
      if (glassConfig.wallpaper && wallpaperProblem(glassConfig.wallpaper)) {
        await persistGlass({ ...glassConfig, wallpaper: "" });
      }
      return glassStatePayload();
    case "appearance.glass.tokens": {
      const config = glass.normalizeGlassConfig(payload.config);
      return { config, tokens: glass.glassTokens(config) };
    }
    case "appearance.glass.apply": {
      // The wallpaper is owned by save/clear: a whole-config write from the
      // panel must not drop an image the user just uploaded.
      const merged = { ...glassConfig, ...(payload.config ?? {}), wallpaper: glassConfig.wallpaper };
      return { ok: true, ...(await persistGlass(merged)) };
    }
    case "appearance.glass.saveWallpaper":
      return saveWallpaperBytes(payload.name, payload.data, payload.thumb);
    case "appearance.glass.setWallpaper":
      // For scripted use and tests; the panel uploads bytes instead.
      return adoptWallpaper(payload.path, basename(String(payload?.path ?? "")));
    case "appearance.glass.forgetWallpaper": {
      const target = String(payload?.path ?? "").trim();
      if (!target) return { ok: false, reason: "empty", ...glassStatePayload() };
      let dataDir = "";
      try {
        dataDir = await pi.plugin.getDataPath();
      } catch {
        /* 没有数据目录说明这张图不是我们存的 */
      }
      const owned = ownsWallpaper(dataDir, target);
      const next = {
        ...glassConfig,
        recent: glassConfig.recent.filter((entry) => entry.path !== target),
        wallpaper: glassConfig.wallpaper === target ? "" : glassConfig.wallpaper,
      };
      if (owned) {
        try {
          unlinkSync(target);
        } catch {
          /* 删不掉文件不影响把它从列表里去掉 */
        }
      }
      return { ok: true, ...(await persistGlass(next)) };
    }
    case "appearance.glass.wallpaperBytes": {
      // 存量图片没有缩略图：面板取一次原图字节，画好再存回来。
      const target = String(payload?.path ?? "").trim();
      if (!glassConfig.recent.some((entry) => entry.path === target)) {
        return { ok: false, reason: "missing" };
      }
      const problem = wallpaperProblem(target);
      if (problem) return { ok: false, reason: problem };
      try {
        return { ok: true, mime: imageMimeOf(target), data: readFileSync(target).toString("base64") };
      } catch {
        return { ok: false, reason: "unreadable" };
      }
    }
    case "appearance.glass.saveThumb": {
      const target = String(payload?.path ?? "").trim();
      const thumb = typeof payload?.thumb === "string" ? payload.thumb : "";
      if (!target || !thumb.startsWith("data:image/")) return { ok: false, ...glassStatePayload() };
      glassConfig = glass.normalizeGlassConfig({
        ...glassConfig,
        recent: glassConfig.recent.map((entry) => (entry.path === target ? { ...entry, thumb } : entry)),
      });
      await pi.plugin.setSettings({ [glass.SETTINGS_KEY]: glassConfig });
      return { ok: true, ...glassStatePayload() };
    }
    case "appearance.glass.engineScan":
      return engineScanPayload();
    case "appearance.glass.enginePreview":
      return enginePreviewPayload(payload?.id);
    case "appearance.glass.engineApply":
      return applyEngineWallpaper(payload);
    case "appearance.glass.engineClear":
      return clearEngineWallpaper();
    case "appearance.glass.clearWallpaper":
      // 「不使用」对两种来源是同一个意思：图片让位，Wallpaper Engine 的视频
      // 也一起撤掉（视频本体留在创意工坊目录，插件没有副本要删）。
      return clearEngineWallpaper();
    case "appearance.glass.reset": {
      // Reset keeps the backdrop: it is the user's own file (or their Wallpaper
      // Engine pick), not a recipe.
      const reset = {
        ...glass.DEFAULT_CONFIG,
        wallpaper: glassConfig.wallpaper,
        recent: glassConfig.recent,
        engine: glassConfig.engine,
      };
      return { ok: true, ...(await persistGlass(reset)) };
    }
    default:
      return null;
  }
}

/**
 * The pre-merge channel names.
 *
 * `motion.*` and `glass.*` were two features with a view each; they are one
 * feature now. A panel window that outlived the reload can still be on the old
 * names, so they are answered here instead of failing with an unsupported
 * action — the call is identical, only the prefix differs.
 */
function modernChannel(channel) {
  for (const [prefix, half] of [["motion.", "appearance.motion."], ["glass.", "appearance.glass."]]) {
    if (channel.startsWith(prefix)) return `${half}${channel.slice(prefix.length)}`;
  }
  return channel;
}

async function onPanelInvoke(channel, payload = {}) {
  const name = typeof channel === "string" ? modernChannel(channel) : "";
  const handled = name.startsWith("appearance.motion.")
    ? await onMotion(name, payload)
    : name.startsWith("appearance.glass.")
      ? await onGlass(name, payload)
      : null;
  if (handled !== null) return handled;
  throw new Error(`Unsupported panel action: ${channel}`);
}

// A wallpaper is ours only when it sits directly in the data dir with our prefix.
// path.relative rejects siblings such as "<dataDir>-evil/wallpaper.x".
function ownsWallpaper(dataDir, target) {
  if (!dataDir || !target) return false;
  const nodePath = require("node:path");
  const rel = nodePath.relative(nodePath.resolve(dataDir), nodePath.resolve(target));
  if (!rel || rel.startsWith("..") || nodePath.isAbsolute(rel) || /[\\/]/.test(rel)) return false;
  return rel.startsWith(DATA_PREFIX);
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  readSystemBase,
  resetThemeCache,
  // Re-registers the one theme from both halves. Every appearance write ends up
  // here, so the stylesheet can never carry only one of the two layers.
  refreshTheme: applyTheme,
  // Read by main.js for the renderer module: it needs the clip, not the panel's
  // bookkeeping.
  getEngineWallpaperState,
  _wallpaperProblem: wallpaperProblem,
  _ownsWallpaper: ownsWallpaper,
  _getMotionConfig: () => motionConfig,
  _getGlassConfig: () => glassConfig,
};
