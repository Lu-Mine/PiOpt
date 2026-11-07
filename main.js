"use strict";

/**
 * PiOpt host entry: one plugin, four views.
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
const remote = require("./features/remote/index.js");

const FEATURES = { market, appearance, behavior, remote };
const PANEL_COMMAND = "piopt.open";

function featureFor(channel) {
  if (typeof channel !== "string") return null;
  if (channel.startsWith("market.")) return FEATURES.market;
  if (channel.startsWith("behavior.")) return FEATURES.behavior;
  if (channel.startsWith("remote.")) return FEATURES.remote;
  // `motion.*` and `glass.*` are the pre-merge names of the two halves; the
  // feature answers them so a panel window that outlived the reload still works.
  if (/^(appearance|motion|glass)\./.test(channel)) return FEATURES.appearance;
  return null;
}

async function openPanel(feature) {
  // 只有明确点名时才写「跳转意图」。不带参数的「打开控制台」不该重置面板的
  // 位置——这里写下的值会在面板启动时把用户上次待的地方覆盖掉。
  if (FEATURES[feature]) {
    try {
      await pi.plugin.setSettings({ panelJump: { feature, at: Date.now() } });
    } catch {
      /* 面板拿不到意图就用它自己记住的位置 */
    }
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
  // The video wallpaper layer in the host window: only the clip and the fit mode,
  // so the renderer module never sees the panel's file bookkeeping.
  engineWallpaperState: () => FEATURES.appearance.getEngineWallpaperState(),
  // A scene's container becomes one data file in the plugin's own data folder: the
  // renderer brings it in with `<script src>`, the only channel the host does not
  // cap at 64KB and 10 calls/s.
  enginePkg: (args = {}) => FEATURES.appearance.getEnginePkgFile(args),
  // The renderer reports how a scene mount went: its console never reaches the
  // host's logs, so this is the only way a failure can be seen at all.
  reportEngineStatus: (args = {}) => FEATURES.appearance.setEngineStatus(args),
  // The real frame rate, every 5s. "It feels slow" needs a number, and the engine's
  // own counter only exists inside the renderer.
  reportEngineStats: (args = {}) => FEATURES.appearance.setEngineStats(args),
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
  await remote.onLoad();
  await market.onLoad();
  await pi.commands.register({
    id: PANEL_COMMAND,
    title: "PiOpt: 打开控制台",
    keywords: ["piopt", "market", "motion", "控制台", "市场", "动效"],
    // 「打开控制台」是回到用户上次待的地方，不是把他送回市场首页。
    run: () => openPanel(),
  });
  await pi.commands.register({
    id: "remote.open",
    title: "PiOpt: 打开远程访问",
    keywords: ["remote", "phone", "mobile", "远程", "手机", "局域网", "配对"],
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
    await pi.commands.unregister("remote.open");
  } catch {
    /* already gone */
  }
  await behavior.onUnload();
  await appearance.onUnload();
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
