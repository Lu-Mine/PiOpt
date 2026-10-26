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

const FEATURES = { market, motion };
const PANEL_COMMAND = "piopt.open";

function featureFor(channel) {
  if (typeof channel !== "string") return null;
  if (channel.startsWith("market.")) return FEATURES.market;
  if (channel.startsWith("motion.")) return FEATURES.motion;
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

async function onLoad() {
  await market.onLoad();
  await motion.onLoad();
  await pi.commands.register({
    id: PANEL_COMMAND,
    title: "PiOpt: 打开控制台",
    keywords: ["piopt", "market", "motion", "控制台", "市场", "动效"],
    run: () => openPanel("market"),
  });
}

async function onUnload() {
  try {
    await pi.commands.unregister(PANEL_COMMAND);
  } catch {
    /* already gone */
  }
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
  openPanel,
  _features: FEATURES,
  _featureFor: featureFor,
};
