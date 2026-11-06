/*
 * 行为视图：聊天框模型浮窗的排列方式，以及三项改写（选中行的标记、推理强度文案、
 * 窗口入口的摆法）。
 *
 * 排列方式是四选一的分段控件，写的就是浮窗里那条切换读的同一个值；三个开关各管一种
 * 改写。每一下都即时保存，没有提交按钮 —— 与外观那一屏一致：控件本身就是状态。
 */
(function () {
  "use strict";

  const CHANNEL = "behavior.modelPicker";
  const DEFAULT_CONFIG = {
    grouping: "provider",
    frameSelected: false,
    translateThinking: false,
    entryActions: false,
    commandButton: false,
  };
  const GROUPINGS = ["default", "provider", "vendor", "name"];

  const state = { config: { ...DEFAULT_CONFIG }, error: "", busy: false };
  const elements = {};

  function byId(id) {
    return document.getElementById(id);
  }

  function normalizeConfig(input) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    return {
      grouping: GROUPINGS.includes(source.grouping) ? source.grouping : DEFAULT_CONFIG.grouping,
      frameSelected: source.frameSelected === true,
      translateThinking: source.translateThinking === true,
      entryActions: source.entryActions === true,
      commandButton: source.commandButton === true,
    };
  }

  async function invoke(channel, payload = {}) {
    if (window.pluginBridge && typeof window.pluginBridge.invoke === "function") {
      return window.pluginBridge.invoke(channel, payload);
    }
    // 脱离宿主的预览：没有主进程，就把这一次的选择留在内存里，界面照常点亮。
    if (channel === `${CHANNEL}.setGrouping`) {
      state.config = normalizeConfig({ ...state.config, grouping: payload.grouping });
    } else if (channel === `${CHANNEL}.setOptions`) {
      state.config = normalizeConfig({ ...state.config, ...payload });
    } else if (channel !== `${CHANNEL}.getState`) {
      throw new Error(`Unknown preview channel: ${channel}`);
    }
    return { ok: true, config: { ...state.config }, groupings: [...GROUPINGS] };
  }

  function render() {
    const config = state.config;
    for (const button of elements.groupingButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.grouping === config.grouping));
      button.disabled = state.busy;
    }
    elements.frame.checked = config.frameSelected;
    elements.thinking.checked = config.translateThinking;
    elements.entries.checked = config.entryActions;
    elements.command.checked = config.commandButton;
    elements.frame.disabled = state.busy;
    elements.thinking.disabled = state.busy;
    elements.entries.disabled = state.busy;
    elements.command.disabled = state.busy;
    elements.status.textContent = state.error;
    elements.status.hidden = !state.error;
  }

  function adopt(result) {
    if (result && result.config) state.config = normalizeConfig(result.config);
    state.error = "";
    render();
  }

  /**
   * 一次改动：先把选择画到界面上（点下去就该有反应），再交给主进程保存；
   * 存不进去就退回上一次的值，并在区块下面报一句。
   */
  async function save(channel, patch) {
    if (state.busy) return;
    const previous = { ...state.config };
    const isGrouping = channel === `${CHANNEL}.setGrouping`;
    state.busy = true;
    state.config = normalizeConfig({ ...state.config, ...patch });
    render();
    try {
      adopt(await invoke(channel, isGrouping ? { grouping: patch.grouping } : patch));
    } catch (error) {
      state.config = previous;
      state.error = (error && error.message) || "保存设置失败。";
    } finally {
      state.busy = false;
    }
    render();
  }

  function bindEvents() {
    for (const button of elements.groupingButtons) {
      button.addEventListener("click", () => {
        void save(`${CHANNEL}.setGrouping`, { grouping: button.dataset.grouping });
      });
    }
    elements.frame.addEventListener("change", () => {
      void save(`${CHANNEL}.setOptions`, { frameSelected: elements.frame.checked });
    });
    elements.thinking.addEventListener("change", () => {
      void save(`${CHANNEL}.setOptions`, { translateThinking: elements.thinking.checked });
    });
    elements.entries.addEventListener("change", () => {
      void save(`${CHANNEL}.setOptions`, { entryActions: elements.entries.checked });
    });
    elements.command.addEventListener("change", () => {
      void save(`${CHANNEL}.setOptions`, { commandButton: elements.command.checked });
    });
  }

  async function boot() {
    Object.assign(elements, {
      groupingButtons: Array.from(document.querySelectorAll("#behavior-grouping [data-grouping]")),
      frame: byId("behavior-frame"),
      thinking: byId("behavior-thinking-zh"),
      entries: byId("behavior-entry-actions"),
      command: byId("behavior-command-button"),
      status: byId("behavior-status"),
    });
    bindEvents();
    render();
    try {
      adopt(await invoke(`${CHANNEL}.getState`));
    } catch (error) {
      state.error = (error && error.message) || "读取设置失败。";
      render();
    }
  }

  window.PiOptBehavior = { boot };
})();
