"use strict";

/**
 * PiOpt host entry: one plugin, five views.
 *
 * Each feature under features/ keeps its own lifecycle, commands, agent tools
 * and panel channels; this file only composes them and routes panel traffic by
 * channel prefix, so no feature calls another directly. Interface motion and the
 * window material are one feature (`appearance`) because they are one theme;
 * `behavior` owns the chat composer's model popup — its setting here, the DOM
 * rewrite in the host window (renderer/model-picker.mjs).
 */

const market = require("./features/market/index.js");
const appearance = require("./features/appearance/index.js");
const behavior = require("./features/behavior/index.js");
const gateway = require("./features/gateway/index.js");
const remote = require("./features/remote/index.js");

const FEATURES = { market, appearance, behavior, gateway, remote };
const PANEL_COMMAND = "piopt.open";

function featureFor(channel) {
  if (typeof channel !== "string") return null;
  if (channel.startsWith("market.")) return FEATURES.market;
  if (channel.startsWith("behavior.")) return FEATURES.behavior;
  if (channel.startsWith("gateway.")) return FEATURES.gateway;
  if (channel.startsWith("remote.")) return FEATURES.remote;
  // `motion.*` and `glass.*` are the pre-merge names of the two halves; the
  // feature answers them so a panel window that outlived the reload still works.
  if (/^(appearance|motion|glass)\./.test(channel)) return FEATURES.appearance;
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

// The host window asks two questions about the model popup: what the grouping is
// (once per open) and what the user just picked there. Both are answered by the
// behavior feature so the setting has a single owner.
const RENDERER_METHODS = Object.freeze({
  openConsole,
  modelPickerState: () => FEATURES.behavior.getState(),
  setModelPickerGrouping: (args = {}) => FEATURES.behavior.setGrouping(args.grouping),
});

async function onRendererCall(method, args = {}) {
  if (!Object.prototype.hasOwnProperty.call(RENDERER_METHODS, method)) {
    throw new Error(`Unsupported renderer method: ${method}`);
  }
  return RENDERER_METHODS[method](args);
}

async function onLoad() {
  await appearance.onLoad();
  await behavior.onLoad();
  await gateway.onLoad();
  await remote.onLoad();
  await market.onLoad();
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
  await pi.commands.register({
    id: "remote.open",
    title: "PiOpt: 打开手机控制",
    keywords: ["remote", "phone", "mobile", "手机", "局域网", "配对"],
    run: () => openPanel("remote"),
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
  try {
    await pi.commands.unregister("remote.open");
  } catch {
    /* already gone */
  }
  await behavior.onUnload();
  await appearance.onUnload();
  await gateway.onUnload();
  await remote.onUnload();
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
