"use strict";

const motion = require("./motion.js");

const COMMAND_ID = "pi-modify.open";
const PREFERENCE_KEY = "motion.hostPreference";
let currentConfig = { ...motion.DEFAULT_CONFIG };

async function getAppearance() {
  try {
    return await pi.app.getAppearance();
  } catch {
    return { base: "dark", theme: "dark", pluginTheme: null };
  }
}

async function readConfig() {
  const settings = await pi.plugin.getSettings();
  return motion.normalizeConfig(settings && settings[motion.SETTINGS_KEY]);
}

// What the user had picked in PI-Desktop before Motion Lab took the selection:
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

async function registerTheme(config, base) {
  if (!pi.themes || typeof pi.themes.upsert !== "function") {
    throw new Error("当前 PI-Desktop 版本不支持运行时主题 API，请升级后重试。");
  }
  const css = motion.buildThemeCss(config, base);
  if (!lastRegistered || lastRegistered.base !== base || lastRegistered.css !== css) {
    await pi.themes.upsert({
      id: motion.THEME_ID,
      label: "Motion Lab",
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

async function statePayload(hints = {}) {
  const appearance = await getAppearance();
  const themes = pi.themes && typeof pi.themes.list === "function"
    ? await pi.themes.list()
    : [];
  const preference = motion.preferenceFrom(appearance.theme) ?? await readPreference();
  return {
    config: currentConfig,
    appearance,
    themes,
    preference,
    resolvedBase: resolveNow(currentConfig, appearance, preference, hints),
  };
}

async function applyConfig(input, hints = {}) {
  const config = motion.normalizeConfig(input);
  const appearance = await getAppearance();
  const hostPreference = motion.preferenceFrom(appearance.theme);
  const recorded = await readPreference();
  // The user's own pick wins while the host still holds it; otherwise the value
  // recorded before Motion Lab took over is the only truth left.
  const preference = hostPreference ?? recorded;
  if (hostPreference && hostPreference !== recorded) await savePreference(hostPreference);

  const base = resolveNow(config, appearance, preference, hints);
  await registerTheme(config, base);
  await pi.plugin.setSettings({ [motion.SETTINGS_KEY]: config });
  currentConfig = config;

  const themeId = await registeredThemeId();
  if (activeThemeId(appearance) !== themeId) await pi.app.setTheme(themeId);

  return {
    ...(await statePayload({ preference, prefersLight: hints.prefersLight })),
    appliedTheme: themeId,
    resolvedBase: base,
    preference,
  };
}

async function onLoad() {
  // A reload means the host may have lost the registration; start from zero.
  resetThemeCache();
  currentConfig = await readConfig();
  const appearance = await getAppearance();
  const preference = motion.preferenceFrom(appearance.theme) ?? await readPreference();
  await registerTheme(currentConfig, resolveNow(currentConfig, appearance, preference, {}));
  // Removing the old pair would otherwise leave a user who had selected one of
  // them on the host's fallback theme; take the selection over instead.
  const previous = activeThemeId(appearance);
  if (previous.startsWith(`plugin:${pi.plugin.getId()}:`)) {
    const themeId = await registeredThemeId();
    if (previous !== themeId) await pi.app.setTheme(themeId);
  }
  await pi.commands.register({
    id: COMMAND_ID,
    title: "PiOpt: 打开动效实验室",
    keywords: ["piopt", "pi-modify", "motion", "animation", "动画", "动效", "减弱动态"],
    run: async () => {
      await pi.plugin.setSettings({ panelFeature: "motion" });
      await pi.ui.openPanel({ title: "PiOpt" });
    },
  });
}

async function onUnload() {
  await pi.commands.unregister(COMMAND_ID);
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

async function onPanelInvoke(channel, payload = {}) {
  switch (channel) {
    case "motion.getState":
      currentConfig = await readConfig();
      return statePayload(payload.hints ?? {});
    case "motion.previewCss": {
      const config = motion.normalizeConfig(payload.config);
      return { config, css: motion.buildPreviewCss(config), tokens: motion.motionTokens(config) };
    }
    case "motion.save":
      return { ok: true, config: await applyConfig(payload.config, payload.hints ?? {}) };
    // The host sets nativeTheme.themeSource to our theme's base, so the page's
    // prefers-color-scheme reports our own base back at us and "auto" can never
    // see the real system. The process reads the OS value instead.
    case "motion.systemBase":
      return { ok: true, base: readSystemBase(), platform: process.platform };
    // Kept as a fallback for when the OS read is unavailable: hand the selection
    // back to the host for a moment, which does flash, so it is the last resort.
    case "motion.release":
      await pi.app.setTheme("system");
      return { ok: true };
    case "motion.apply":
      return { ok: true, ...(await applyConfig(payload.config, payload.hints ?? {})) };
    case "motion.reset":
      return { ok: true, ...(await applyConfig(motion.DEFAULT_CONFIG, payload.hints ?? {})) };
    default:
      throw new Error(`Unsupported panel action: ${channel}`);
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke, readSystemBase, resetThemeCache };
