"use strict";

/**
 * 窗口入口的摆法：把宿主的「新建任务」「搜索」搬进侧边栏，并顺手把右侧面板那个
 * 开关的图标摆正。
 *
 * 与 model-picker 一样，主进程只管这份设置，真正的 DOM 改写发生在宿主窗口里
 * （renderer/nav-entries.mjs）；两边都从这里取默认值与校验，所以形状只有一处。
 */

const SETTINGS_KEY = "navEntries";

const DEFAULT_CONFIG = Object.freeze({
  // 关掉时窗口保持宿主原样：入口在会话标题栏右上角，面板开关的图标按宿主的画法。
  enabled: false,
});

function normalizeConfig(input) {
  const source = input && typeof input === "object" ? input : {};
  return { enabled: source.enabled === true };
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_CONFIG,
  normalizeConfig,
};
