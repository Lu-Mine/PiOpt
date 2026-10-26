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

// What the user had picked in PI-Desktop before a Motion Lab theme took the
// selection: "system", "light" or "dark". Once our own theme is selected the host
// reports that theme's base instead of this preference, so it has to be kept.
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

async function registerThemes(config) {
  if (!pi.themes || typeof pi.themes.upsert !== "function") {
    throw new Error("当前 PI-Desktop 版本不支持运行时主题 API，请升级后重试。");
  }

  await Promise.all([
    pi.themes.upsert({
      id: motion.THEME_IDS.light,
      label: "Motion Lab · Light",
      base: "light",
      css: motion.buildThemeCss(config, "light"),
    }),
    pi.themes.upsert({
      id: motion.THEME_IDS.dark,
      label: "Motion Lab · Dark",
      base: "dark",
      css: motion.buildThemeCss(config, "dark"),
    }),
  ]);
}

async function saveConfig(input) {
  const config = motion.normalizeConfig(input);
  await registerThemes(config);
  await pi.plugin.setSettings({ [motion.SETTINGS_KEY]: config });
  currentConfig = config;
  return config;
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
    resolvedBase: motion.resolveBase(currentConfig.mode, appearance, {
      preference,
      prefersLight: hints.prefersLight,
    }),
  };
}

// The host namespaces every plugin theme as `plugin:<plugin id>:<theme id>`.
// This used to be hard-coded to the pre-merge `local.pi-modify`, so once the two
// plugins became `local.piopt` the id it applied no longer existed and the host
// answered `unknown theme id`. Ask the theme list what was actually registered
// instead of rebuilding the host's naming rule.
async function themeIdForBase(base, pluginId) {
  const themeId = motion.THEME_IDS[base];
  const fullId = `plugin:${pluginId}:${themeId}`;
  let registered = [];
  try {
    if (pi.themes && typeof pi.themes.list === "function") registered = await pi.themes.list();
  } catch {
    registered = [];
  }
  const entries = Array.isArray(registered) ? registered : [];
  const byId = entries.find((entry) => entry && entry.id === fullId);
  if (byId) return fullId;
  const byThemeId = entries.find((entry) => entry && entry.themeId === themeId && entry.pluginId === pluginId);
  if (byThemeId && typeof byThemeId.id === "string") return byThemeId.id;
  return fullId;
}

// `hints` carries what only the renderer can know: whether the system currently
// prefers light. "auto" needs it because, once a Motion Lab theme owns the
// selection, appearance.base is that theme's base rather than the user's choice.
async function applyConfig(input, hints = {}) {
  const config = await saveConfig(input);
  const appearance = await getAppearance();
  const hostPreference = motion.preferenceFrom(appearance.theme);
  const recorded = await readPreference();
  const preference = hostPreference ?? recorded;
  if (hostPreference && hostPreference !== recorded) await savePreference(hostPreference);

  const base = motion.resolveBase(config.mode, appearance, {
    preference,
    prefersLight: hints.prefersLight,
  });
  const themeId = await themeIdForBase(base, pi.plugin.getId());
  const activeTheme = typeof appearance.pluginTheme === "string"
    ? appearance.pluginTheme
    : appearance.pluginTheme && typeof appearance.pluginTheme.id === "string"
      ? appearance.pluginTheme.id
      : "";
  if (activeTheme !== themeId) await pi.app.setTheme(themeId);
  return {
    ...(await statePayload({ preference, prefersLight: hints.prefersLight })),
    appliedTheme: themeId,
    resolvedBase: base,
    preference,
  };
}

async function onLoad() {
  currentConfig = await readConfig();
  await registerThemes(currentConfig);
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
      return { ok: true, config: await saveConfig(payload.config) };
    case "motion.apply":
      return { ok: true, ...(await applyConfig(payload.config, payload.hints ?? {})) };
    case "motion.reset":
      return { ok: true, config: await saveConfig(motion.DEFAULT_CONFIG) };
    default:
      throw new Error(`Unsupported panel action: ${channel}`);
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
