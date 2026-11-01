"use strict";

/**
 * The behavior feature: how the chat composer's model popup behaves.
 *
 * 宿主窗口里的模型浮窗默认只列最近使用的三个模型，其余收在「其他模型」后面。
 * 这个功能改的就是这一点：浮窗始终列出全部模型（限高仍由宿主决定），并且可以
 * 选择按供应商分组，还是把全部模型按名称平铺排序。
 *
 * 主进程只保管这份设置；把浮窗真正改写的模块活在宿主窗口里
 * （renderer/model-picker.mjs），它经 `plugin.call` 读同一个值。设置进了插件
 * settings，所以重开窗口、重载插件都还在。
 */

const modelPicker = require("./model-picker.js");

let config = { ...modelPicker.DEFAULT_CONFIG };

async function readConfig() {
  try {
    const settings = await pi.plugin.getSettings();
    return modelPicker.normalizeConfig(settings && settings[modelPicker.SETTINGS_KEY]);
  } catch {
    return { ...modelPicker.DEFAULT_CONFIG };
  }
}

// 面板要的东西：当前设置，以及可以选哪些排列方式。
function statePayload() {
  return {
    config,
    groupings: [...modelPicker.GROUPINGS],
  };
}

// 面板与浮窗改的都是同一份设置：宿主窗口里那颗排列按钮经 setGrouping 写，
// 面板里的分段控件写同一个字段，两个开关走 setOptions。
async function setGrouping(input) {
  config = modelPicker.normalizeConfig({ ...config, grouping: input });
  await pi.plugin.setSettings({ [modelPicker.SETTINGS_KEY]: config });
  return statePayload();
}

async function setOptions(patch = {}) {
  config = modelPicker.normalizeConfig({ ...config, ...patch });
  await pi.plugin.setSettings({ [modelPicker.SETTINGS_KEY]: config });
  return statePayload();
}

async function onLoad() {
  config = await readConfig();
}

async function onUnload() {
  /* nothing to release: the popup rewrite lives in the host window */
}

async function onPanelInvoke(channel, payload = {}) {
  switch (channel) {
    case "behavior.modelPicker.getState":
      config = await readConfig();
      return statePayload();
    case "behavior.modelPicker.setGrouping":
      return { ok: true, ...(await setGrouping(payload.grouping)) };
    case "behavior.modelPicker.setOptions":
      return { ok: true, ...(await setOptions(payload)) };
    default:
      throw new Error(`Unsupported panel action: ${channel}`);
  }
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  // Read by the host window's renderer module on every popup open; the cached
  // copy is the one this process last wrote, so no settings round-trip per open.
  getState: statePayload,
  setGrouping,
  setOptions,
  _getConfig: () => config,
};
