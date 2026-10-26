"use strict";

/**
 * PiOpt host entry: one plugin, two features.
 *
 * Each feature under features/ keeps its own lifecycle, commands, agent tools
 * and panel channels; this file only composes them and routes panel traffic by
 * channel prefix, so the two features never call each other directly.
 */

const market = require("./features/market/index.js");
const motion = require("./features/motion/index.js");
const glass = require("./features/glass/index.js");
const gateway = require("./features/gateway/index.js");

const FEATURES = { market, motion, glass, gateway };
const PANEL_COMMAND = "piopt.open";

function featureFor(channel) {
  if (typeof channel !== "string") return null;
  if (channel.startsWith("market.")) return FEATURES.market;
  if (channel.startsWith("motion.")) return FEATURES.motion;
  if (channel.startsWith("gateway.")) return FEATURES.gateway;
  if (channel.startsWith("glass.")) return FEATURES.glass;
  return null;
}

async function openPanel(feature) {
  const target = FEATURES[feature] ? feature : "market";
  try {
    await pi.plugin.setSettings({ panelFeature: target });
  } catch {
    /* the panel falls back to its remembered view */
  }
  await pi.ui.openPanel({ title: "PiOpt" });
}

// The footer entry in the host window (renderer/entry.mjs) opens the console
// without naming a view, so it lands on whatever the panel showed last; the
// command above stays the way to ask for a named view.
async function openConsole() {
  await pi.ui.openPanel({ title: "PiOpt" });
  return { opened: true };
}

const RENDERER_METHODS = Object.freeze({ openConsole });

async function onRendererCall(method, args = {}) {
  if (!Object.prototype.hasOwnProperty.call(RENDERER_METHODS, method)) {
    throw new Error(`Unsupported renderer method: ${method}`);
  }
  return RENDERER_METHODS[method](args);
}

async function onLoad() {
  await market.onLoad();
  await motion.onLoad();
  await glass.onLoad();
  // The glass layer rides the Motion Lab theme, so the two features are wired
  // here instead of importing each other.
  glass.bindTheme(() => motion.refreshTheme());
  await gateway.onLoad();
  await pi.commands.register({
    id: PANEL_COMMAND,
    title: "PiOpt: 打开控制台",
    keywords: ["piopt", "market", "motion", "控制台", "市场", "动效"],
    run: () => openPanel("market"),
  });
  await pi.commands.register({
    id: "gateway.open",
    title: "网关: 打开 AI 网关面板",
    keywords: ["gateway", "网关", "模型", "积分"],
    run: () => openPanel("gateway"),
  });
}

async function onUnload() {
  try {
    await pi.commands.unregister(PANEL_COMMAND);
  } catch {
    /* already gone */
  }
  try {
    await pi.commands.unregister("gateway.open");
  } catch {
    /* already gone */
  }
  await glass.onUnload();
  await gateway.onUnload();
  await motion.onUnload();
  await market.onUnload();
}

async function onPanelInvoke(channel, payload = {}) {
  const feature = featureFor(channel);
  if (!feature || typeof feature.onPanelInvoke !== "function") {
    throw new Error(`Unsupported panel action: ${channel}`);
  }
  return feature.onPanelInvoke(channel, payload);
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  onRendererCall,
  openPanel,
  _features: FEATURES,
  _featureFor: featureFor,
};
