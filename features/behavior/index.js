"use strict";

/**
 * The behavior feature: how the host window's own controls behave.
 *
 * 两件事都改宿主窗口里的 DOM，主进程只保管设置：
 *
 * - 聊天框的模型浮窗默认只列最近使用的三个模型，这里让它始终列出全部，并按所选
 *   方式排列（renderer/model-picker.mjs）。
 * - 窗口入口的摆法：把「新建任务」「搜索」搬进侧边栏，并在侧边栏收起时放进标题栏
 *   「切换侧边栏」的右边（renderer/nav-entries.mjs）。
 *
 * 设置进了插件 settings，所以重开窗口、重载插件都还在。面板与两个渲染模块看到的是
 * 同一份扁平配置：浮窗的三项加一个 `entryActions`。
 */

const modelPicker = require("./model-picker.js");
const navEntries = require("./nav-entries.js");

let picker = { ...modelPicker.DEFAULT_CONFIG };
let entries = { ...navEntries.DEFAULT_CONFIG };

async function readSettings() {
  try {
    return (await pi.plugin.getSettings()) || {};
  } catch {
    return {};
  }
}

async function readConfig() {
  const settings = await readSettings();
  return {
    picker: modelPicker.normalizeConfig(settings[modelPicker.SETTINGS_KEY]),
    entries: navEntries.normalizeConfig(settings[navEntries.SETTINGS_KEY]),
  };
}

// 面板要的东西：当前设置，以及可以选哪些排列方式。
function statePayload() {
  return {
    config: { ...picker, entryActions: entries.enabled },
    groupings: [...modelPicker.GROUPINGS],
  };
}

// 面板与窗口里那颗排列按钮改的都是同一份设置：排列走 setGrouping，其余走 setOptions。
async function setGrouping(input) {
  picker = modelPicker.normalizeConfig({ ...picker, grouping: input });
  await pi.plugin.setSettings({ [modelPicker.SETTINGS_KEY]: picker });
  return statePayload();
}

// 一次改动可能同时落在两份设置上：入口开关自己一个键，其余归模型浮窗那份。
async function setOptions(patch = {}) {
  const source = patch && typeof patch === "object" ? patch : {};
  const writes = {};
  if (Object.prototype.hasOwnProperty.call(source, "entryActions")) {
    entries = navEntries.normalizeConfig({ enabled: source.entryActions === true });
    writes[navEntries.SETTINGS_KEY] = entries;
  }
  const pickerPatch = { ...source };
  delete pickerPatch.entryActions;
  if (Object.keys(pickerPatch).length > 0) {
    picker = modelPicker.normalizeConfig({ ...picker, ...pickerPatch });
    writes[modelPicker.SETTINGS_KEY] = picker;
  }
  if (Object.keys(writes).length > 0) await pi.plugin.setSettings(writes);
  return statePayload();
}

async function onLoad() {
  const loaded = await readConfig();
  picker = loaded.picker;
  entries = loaded.entries;
}

async function onUnload() {
  /* nothing to release: both rewrites live in the host window */
}

async function onPanelInvoke(channel, payload = {}) {
  switch (channel) {
    case "behavior.modelPicker.getState": {
      const loaded = await readConfig();
      picker = loaded.picker;
      entries = loaded.entries;
      return statePayload();
    }
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
  // Read by the host window's renderer modules on every refresh; the cached copy is
  // the one this process last wrote, so no settings round-trip per popup open.
  getState: statePayload,
  setGrouping,
  setOptions,
  _getConfig: () => ({ ...picker, entryActions: entries.enabled }),
  _getEntries: () => ({ ...entries }),
};
