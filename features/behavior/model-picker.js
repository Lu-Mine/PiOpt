"use strict";

/**
 * 聊天框模型浮窗：始终展开，按宿主顺序原样排列，或按供应商 / 厂商分组、按名称平铺。
 *
 * 宿主的浮窗默认只列出最近使用的三个模型，其余收在「其他模型」后面；这里只
 * 改这一件事。真正的 DOM 改写发生在宿主窗口里（renderer/model-picker.mjs），
 * 本文件只负责这份设置的形状，主进程与面板都从这里读，所以默认值和校验只有
 * 一处。
 */

const SETTINGS_KEY = "modelPicker";

// `default` 原样沿用宿主自己的顺序（分组、组内、最近使用那一组的位置都不动）；
// `provider` 按供应商分组（宿主里的服务），`vendor` 按模型厂商分组（Anthropic、
// OpenAI、智谱…），`name` 把全部模型平铺成一份按显示名称排序的列表。后三种模式
// 的分组与组内顺序都按 A–Z。
const GROUPINGS = Object.freeze(["default", "provider", "vendor", "name"]);
// frameSelected：选中项的标记由宿主那枚对勾换成一圈圆角矩形边框；
// translateThinking：推理强度滑杆上的 off / minimal / low … 换成中文。
const DEFAULT_CONFIG = Object.freeze({ grouping: "provider", frameSelected: false, translateThinking: false });

function normalizeGrouping(value) {
  return GROUPINGS.includes(value) ? value : DEFAULT_CONFIG.grouping;
}

function normalizeConfig(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    grouping: normalizeGrouping(source.grouping),
    frameSelected: source.frameSelected === true,
    translateThinking: source.translateThinking === true,
  };
}

module.exports = {
  SETTINGS_KEY,
  GROUPINGS,
  DEFAULT_CONFIG,
  normalizeConfig,
  normalizeGrouping,
};
