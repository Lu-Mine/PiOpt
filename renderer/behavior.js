/*
 * 行为视图：聊天框模型浮窗的排列方式（只读）。
 *
 * 排列方式在浮窗里切换——搜索框右侧那颗按钮，点一下换一种。这里只把当前的值
 * 读出来给使用者看，不提供第二个入口：同一个设置有两处开关，迟早会不一致。
 */
(function () {
  "use strict";

  const CHANNEL = "behavior.modelPicker";
  const DEFAULT_CONFIG = { grouping: "provider" };
  const GROUPING_COPY = { provider: "按供应商", vendor: "按厂商", name: "按名称" };

  const state = { config: { ...DEFAULT_CONFIG }, error: "" };
  const elements = {};

  function byId(id) {
    return document.getElementById(id);
  }

  async function invoke(channel, payload = {}) {
    if (window.pluginBridge && typeof window.pluginBridge.invoke === "function") {
      return window.pluginBridge.invoke(channel, payload);
    }
    if (channel === `${CHANNEL}.getState`) {
      return { config: { ...state.config }, groupings: Object.keys(GROUPING_COPY) };
    }
    throw new Error(`Unknown preview channel: ${channel}`);
  }

  function render() {
    const grouping = state.config.grouping;
    if (elements.grouping) {
      elements.grouping.textContent = GROUPING_COPY[grouping] || GROUPING_COPY.provider;
    }
    if (!elements.status) return;
    elements.status.textContent = state.error;
    elements.status.hidden = !state.error;
  }

  async function boot() {
    Object.assign(elements, {
      grouping: byId("behavior-grouping"),
      status: byId("behavior-status"),
    });
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
