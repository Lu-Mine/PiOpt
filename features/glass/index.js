"use strict";

const { readdirSync, statSync, unlinkSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");

const glass = require("./glass.js");

const COMMAND_ID = "piopt.glass";

// The panel reads the image and hands over its bytes. Two reasons, both learned
// the hard way:
//
// - A renderer cannot expose a filesystem path any more: Electron removed
//   `File.path`, so `<input type="file">` yields a `File` and nothing else.
// - Asking this windowless utility process to spawn a WinForms dialog does not
//   work: the dialog is never created, so `ShowDialog` just blocks.
//
// The bytes land in the plugin's own data folder, and the theme references that
// absolute path — the host rewrites it to a `plugin-asset:` URL, which is how a
// runtime theme is meant to carry an image.
const DATA_PREFIX = "wallpaper.";

let currentConfig = { ...glass.DEFAULT_CONFIG };

// The glass layer is a runtime theme, and Motion Lab owns the one theme this
// plugin registers. Rather than import-cycle the two features, main.js hands
// the refresh in here once both are loaded.
let applyTheme = null;

function bindTheme(apply) {
  applyTheme = typeof apply === "function" ? apply : null;
}

async function readConfig() {
  const settings = await pi.plugin.getSettings();
  return glass.normalizeGlassConfig(settings && settings[glass.SETTINGS_KEY]);
}

function statePayload() {
  return {
    config: currentConfig,
    presets: Object.keys(glass.PRESETS),
    fits: [...glass.FITS],
    limits: glass.LIMITS,
  };
}

// ------------------------------------------------------------------ wallpaper

/**
 * Why a path cannot be used as a wallpaper, or null when it can.
 *
 * The host enforces the same two rules when it rewrites `url(…)` to a
 * `plugin-asset:` URL — a 4 MB ceiling and its own extension list. Checking
 * here turns a rejected `themes.upsert` into a sentence the user can act on.
 */
function wallpaperProblem(candidate) {
  const path = String(candidate ?? "").trim();
  if (!path) return "empty";
  if (!glass.isSupportedWallpaper(path)) return "unsupported";
  let stats;
  try {
    stats = statSync(path);
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
  "too-large": `图片超过 ${Math.round(glass.WALLPAPER_MAX_BYTES / 1024 / 1024)} MB，宿主会拒绝这个主题资源。`,
};

async function notify(message) {
  try {
    await pi.ui.showToast(message, "error");
  } catch {
    /* a toast is best effort */
  }
}

async function persist(config) {
  currentConfig = glass.normalizeGlassConfig(config);
  await pi.plugin.setSettings({ [glass.SETTINGS_KEY]: currentConfig });
  const applied = Boolean(applyTheme);
  if (applyTheme) await applyTheme();
  return { ...statePayload(), applied };
}

function refuse(reason) {
  const message = WALLPAPER_ERRORS[reason] || "这个文件不能用作背景图。";
  void notify(message);
  return { ok: false, reason, message, ...statePayload() };
}

async function adoptWallpaper(path) {
  const problem = wallpaperProblem(path);
  if (problem) {
    // Drop a reference that stopped resolving instead of leaving the theme
    // pointing at an asset the host can no longer serve: `themes.upsert` would
    // then fail outright and take the motion layer down with it.
    if (problem === "missing" && currentConfig.wallpaper) {
      await persist({ ...currentConfig, wallpaper: "" });
    }
    return refuse(problem);
  }

  // A wallpaper is invisible behind opaque surfaces, so turning glass on here is
  // what makes the pick show a result instead of nothing.
  await persist({ ...currentConfig, wallpaper: path, enabled: true });
  return { ok: true, ...statePayload() };
}

function extensionOf(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name ?? ""));
  return match ? match[1].toLowerCase() : "";
}

/**
 * Stores the uploaded bytes in the plugin's data folder and adopts the path.
 *
 * One wallpaper at a time: a leftover of another format would keep a stale image
 * on disk and could still be referenced by an old setting.
 */
async function saveWallpaperBytes(name, base64) {
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

  const target = join(dataDir, `${DATA_PREFIX}${extension}`);
  try {
    for (const entry of readdirSync(dataDir)) {
      if (!entry.startsWith(DATA_PREFIX) || entry === basename(target)) continue;
      try {
        unlinkSync(join(dataDir, entry));
      } catch {
        /* a file that cannot be removed is not worth failing the upload for */
      }
    }
    writeFileSync(target, buffer);
  } catch {
    return refuse("unreadable");
  }

  return adoptWallpaper(target);
}

// ------------------------------------------------------------------ lifecycle

async function onLoad() {
  currentConfig = await readConfig();
  // A wallpaper that moved or was deleted must not keep the theme pointing at a
  // path the host can no longer serve.
  if (currentConfig.wallpaper && wallpaperProblem(currentConfig.wallpaper)) {
    currentConfig = { ...currentConfig, wallpaper: "" };
    await pi.plugin.setSettings({ [glass.SETTINGS_KEY]: currentConfig });
  }
  await pi.commands.register({
    id: COMMAND_ID,
    title: "PiOpt: 打开窗口材质",
    keywords: ["piopt", "glass", "mica", "acrylic", "磨砂", "玻璃", "材质", "透明", "背景图"],
    run: async () => {
      await pi.plugin.setSettings({ panelFeature: "glass" });
      await pi.ui.openPanel({ title: "PiOpt" });
    },
  });
}

async function onUnload() {
  try {
    await pi.commands.unregister(COMMAND_ID);
  } catch {
    /* already gone */
  }
}

async function onPanelInvoke(channel, payload = {}) {
  switch (channel) {
    case "glass.getState":
      currentConfig = await readConfig();
      if (currentConfig.wallpaper && wallpaperProblem(currentConfig.wallpaper)) {
        await persist({ ...currentConfig, wallpaper: "" });
      }
      return statePayload();
    case "glass.tokens": {
      const config = glass.normalizeGlassConfig(payload.config);
      return { config, tokens: glass.glassTokens(config) };
    }
    case "glass.apply": {
      // The wallpaper is owned by save/clear: a whole-config write from the
      // panel must not drop an image the user just uploaded.
      const merged = { ...currentConfig, ...(payload.config ?? {}), wallpaper: currentConfig.wallpaper };
      return { ok: true, ...(await persist(merged)) };
    }
    case "glass.saveWallpaper":
      return saveWallpaperBytes(payload.name, payload.data);
    case "glass.setWallpaper":
      // For scripted use and tests; the panel uploads bytes instead.
      return adoptWallpaper(payload.path);
    case "glass.clearWallpaper":
      return { ok: true, ...(await persist({ ...currentConfig, wallpaper: "" })) };
    case "glass.reset":
      return { ok: true, ...(await persist(glass.DEFAULT_CONFIG)) };
    default:
      throw new Error(`Unsupported panel action: ${channel}`);
  }
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  bindTheme,
  // Read by features/motion/index.js when it builds the theme stylesheet.
  getConfig: () => currentConfig,
  _wallpaperProblem: wallpaperProblem,
};
