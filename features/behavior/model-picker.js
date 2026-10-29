"use strict";

/**
 * 聊天框模型浮窗：始终展开，按供应商分组或按名称平铺。
 *
 * 宿主的浮窗默认只列出最近使用的三个模型，其余收在「其他模型」后面；这里只
 * 改这一件事。真正的 DOM 改写发生在宿主窗口里（renderer/model-picker.mjs），
 * 本文件只负责这份设置的形状，主进程与面板都从这里读，所以默认值和校验只有
 * 一处。
 */

const SETTINGS_KEY = "modelPicker";

// `provider` 保留宿主自己的分组（供应商标题 + 模型列表），`name` 把全部模型
// 平铺成一份按显示名称排序的列表。
const GROUPINGS = Object.freeze(["provider", "name"]);
const DEFAULT_CONFIG = Object.freeze({ grouping: "provider" });

function normalizeGrouping(value) {
  return GROUPINGS.includes(value) ? value : DEFAULT_CONFIG.grouping;
}

function normalizeConfig(input) {
  const source = input && typeof input === "object" ? input : {};
  return { grouping: normalizeGrouping(source.grouping) };
}

module.exports = {
  SETTINGS_KEY,
  GROUPINGS,
  DEFAULT_CONFIG,
  normalizeConfig,
  normalizeGrouping,
};
