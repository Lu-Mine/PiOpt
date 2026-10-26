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
async function registerTheme(config, base) {
  if (!pi.themes || typeof pi.themes.upsert !== "function") {
    throw new Error("当前 PI-Desktop 版本不支持运行时主题 API，请升级后重试。");
  }
  await pi.themes.upsert({
    id: motion.THEME_ID,
    label: "Motion Lab",
    base,
    css: motion.buildThemeCss(config, base),
  });
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
    // see the real system. Handing the selection back to the host for a moment is
    // the only way to read it.
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

module.exports = { onLoad, onUnload, onPanelInvoke };
