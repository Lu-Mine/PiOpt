/*
 * 行为视图：聊天框模型浮窗的展开与排列。
 *
 * 这一屏只写一个值——浮窗的排列方式。真正改写浮窗的代码活在宿主窗口里
 * （renderer/model-picker.mjs）：它每次打开浮窗时经 plugin.call 读同一个设置，
 * 所以这里存下去就是全部，不需要通知谁。预览模式（没有 pluginBridge）下用和
 * 主进程同一套默认值，保证脱离宿主也能点。
 */
(function () {
  "use strict";

  const CHANNEL = "behavior.modelPicker";
  const GROUPINGS = ["provider", "name"];
  const DEFAULT_CONFIG = { grouping: "provider" };

  const state = { config: { ...DEFAULT_CONFIG }, busy: false, error: "" };
  const elements = {};

  function byId(id) {
    return document.getElementById(id);
  }

  async function invoke(channel, payload = {}) {
    if (window.pluginBridge && typeof window.pluginBridge.invoke === "function") {
      return window.pluginBridge.invoke(channel, payload);
    }
    if (channel === `${CHANNEL}.getState`) {
      return { config: { ...state.config }, groupings: [...GROUPINGS] };
    }
    if (channel === `${CHANNEL}.setGrouping`) {
      return { ok: true, config: { grouping: payload.grouping }, groupings: [...GROUPINGS] };
    }
    throw new Error(`Unknown preview channel: ${channel}`);
  }

  function render() {
    for (const button of document.querySelectorAll("[data-model-grouping]")) {
      button.setAttribute("aria-pressed", String(button.dataset.modelGrouping === state.config.grouping));
    }
    if (!elements.status) return;
    elements.status.textContent = state.error;
    elements.status.hidden = !state.error;
  }

  async function setGrouping(value) {
    if (state.busy || !GROUPINGS.includes(value) || value === state.config.grouping) return;
    const previous = state.config.grouping;
    state.config = { ...state.config, grouping: value };
    state.error = "";
    state.busy = true;
    render();
    try {
      const result = await invoke(`${CHANNEL}.setGrouping`, { grouping: value });
      if (result && result.config) state.config = { ...DEFAULT_CONFIG, ...result.config };
    } catch (error) {
      // 写不进去就退回上一次的选择：界面不该留着一个没保存的值。
      state.config = { ...state.config, grouping: previous };
      state.error = (error && error.message) || "设置没能保存。";
    } finally {
      state.busy = false;
      render();
    }
  }

  function bind() {
    for (const button of document.querySelectorAll("[data-model-grouping]")) {
      button.addEventListener("click", () => void setGrouping(button.dataset.modelGrouping));
    }
  }

  async function boot() {
    Object.assign(elements, { status: byId("behavior-status") });
    bind();
    render();
    try {
      const result = await invoke(`${CHANNEL}.getState`);
      if (result && result.config) state.config = { ...DEFAULT_CONFIG, ...result.config };
    } catch (error) {
      state.error = (error && error.message) || "读取设置失败。";
    }
    render();
  }

  window.PiOptBehavior = { boot };
})();
