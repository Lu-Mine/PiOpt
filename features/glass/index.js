"use strict";

const glass = require("./glass.js");

const COMMAND_ID = "piopt.glass";
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
  return { config: currentConfig, presets: Object.keys(glass.PRESETS), limits: glass.LIMITS };
}

// Every write also re-registers the theme: an unchanged config re-upserts
// nothing (features/motion/index.js compares the CSS), so this stays cheap
// while the user drags the strength slider.
async function applyConfig(input) {
  currentConfig = glass.normalizeGlassConfig(input);
  await pi.plugin.setSettings({ [glass.SETTINGS_KEY]: currentConfig });
  let applied = false;
  if (applyTheme) {
    await applyTheme();
    applied = true;
  }
  return { ...statePayload(), applied };
}

async function onLoad() {
  currentConfig = await readConfig();
  await pi.commands.register({
    id: COMMAND_ID,
    title: "PiOpt: 打开窗口材质",
    keywords: ["piopt", "glass", "mica", "acrylic", "磨砂", "玻璃", "材质", "透明"],
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
      return statePayload();
    case "glass.tokens": {
      const config = glass.normalizeGlassConfig(payload.config);
      return { config, tokens: glass.glassTokens(config) };
    }
    case "glass.apply":
      return { ok: true, ...(await applyConfig(payload.config)) };
    case "glass.reset":
      return { ok: true, ...(await applyConfig(glass.DEFAULT_CONFIG)) };
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
};
