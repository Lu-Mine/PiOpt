/*
 * 窗口入口的摆法（宿主窗口这一侧）。
 *
 * 宿主把「新建任务」「搜索」放在会话标题栏右上角（`.conversation-topbar .ct-actions`），
 * 把「收起侧边栏」放在侧边栏头部；侧边栏收起时那个按钮才换成标题栏里的「切换侧边栏」。
 * 这一层不碰宿主的组件，只做三件 DOM 上的事：
 *
 * 1. 把这两个入口搬进侧边栏头部，摆在「收起侧边栏」左边（顺序：新建任务、搜索、收起）；
 * 2. 侧边栏收起时改摆在「切换侧边栏」右边（顺序：切换、新建任务、搜索）；
 * 3. 原来那两个位置用属性标记后隐掉，所以是搬家而不是复制。
 *
 * 搬过去的是自己的按钮，点击转交给宿主原按钮 —— 新建任务仍走宿主自己的命令，搜索
 * 仍打开宿主自己的搜索框（原按钮不在这一页时退回宿主的 ⌘/Ctrl+K 快捷键）。
 *
 * 同一个开关还顺手处理右侧面板那个开关：它的图标在自己的方框里偏右下，这里按两个
 * 盒子的中心差把它平移到正中；宿主若本来就在正中，就什么都不设。
 */

const ENABLED_ATTR = "data-piopt-nav-entries";
const ACTION_ATTR = "data-piopt-nav-action";
const MOVED_ATTR = "data-piopt-nav-moved";
const ACTION_CLASS = "piopt-nav-action";
const SCAN_DELAY_MS = 90;
const ICON_SHIFT_X = "--piopt-panel-icon-shift-x";
const ICON_SHIFT_Y = "--piopt-panel-icon-shift-y";

const MENU_SELECTOR = ".conversation-topbar .ct-actions";
const NATIVE_NEW_TASK_SELECTOR = '[data-nav="new-task"]';
const NATIVE_TOGGLE_SELECTOR = '[data-nav="toggle-sidebar"]';
const LEAD_TOGGLE_SELECTOR = ".conversation-topbar .ct-lead .ct-icon-btn";
const SIDEBAR_HEADER_SELECTOR = ".sidebar-header";
const PANEL_TOGGLE_SELECTOR = ".app-work-panel-toggle";
const PANEL_ICON_SELECTOR = ".app-work-panel-toggle-icon";

// 宿主那两枚图标还拿不到时的兜底：同一套 lucide 线条（方框加笔 / 放大镜）。
const FALLBACK_ICONS = {
  "new-task":
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
};

export const NAV_ENTRIES_CSS = [
  // 搬过来的按钮：几何沿用宿主标题栏自己那一档（28px、--radius-md、hover 底色），
  // 所以摆进侧边栏头部与标题栏都不显突兀。
  `.${ACTION_CLASS}{
  width:var(--ds-control-size,28px);height:var(--ds-control-size,28px);flex:0 0 auto;
  display:inline-flex;align-items:center;justify-content:center;
  padding:0;border:0;border-radius:var(--radius-md);background:0 0;
  color:var(--ds-text-secondary);cursor:pointer;
  -webkit-app-region:no-drag;app-region:no-drag;
  transition:background var(--motion-duration-fast,.15s) var(--motion-ease-out,ease),color var(--motion-duration-fast,.15s) var(--motion-ease-out,ease)
}`,
  `.${ACTION_CLASS}:hover{background:var(--ds-bg-hover);color:var(--ds-text-primary)}`,
  `.${ACTION_CLASS}:focus-visible{outline:2px solid var(--ds-focus);outline-offset:1px}`,
  `.${ACTION_CLASS}>svg{display:block;width:15px;height:15px}`,
  // 原来那两个位置：留着节点，只是不再占地方（宿主重绘时也不会被当成外来户）。
  `[${ENABLED_ATTR}="true"] [${MOVED_ATTR}="true"]{display:none}`,
  // 右侧面板开关：内边距归零，图标按实测的中心差平移回正中。
  `[${ENABLED_ATTR}="true"] ${PANEL_TOGGLE_SELECTOR}{padding:0}`,
  `[${ENABLED_ATTR}="true"] ${PANEL_ICON_SELECTOR}{transform:translate(var(${ICON_SHIFT_X},0px),var(${ICON_SHIFT_Y},0px))}`,
].join("\n");

let host = null;
let enabled = false;
let observer = null;
let scanTimer = null;
let attentionBound = false;
// 两个注入按钮一直留着，位置随侧边栏状态换：重建节点会让宿主的重绘踩空。
const actions = { "new-task": null, search: null };

// -------------------------------------------------------------------- 宿主的点

function menuElement() {
  return document.querySelector(MENU_SELECTOR);
}

/** 宿主那两个原按钮：会话标题栏里的一对，没有就退回标题栏里的「新建任务」。 */
function sourceButtons() {
  const menu = menuElement();
  const buttons = menu ? Array.from(menu.querySelectorAll("button")) : [];
  return {
    menu,
    "new-task": buttons[0] || document.querySelector(NATIVE_NEW_TASK_SELECTOR),
    search: buttons[1] || null,
  };
}

/** 「收起侧边栏」与「切换侧边栏」是同一枚按钮的两个位置，看它现在挂在哪。 */
function toggleButton() {
  return (
    document.querySelector(`${SIDEBAR_HEADER_SELECTOR} ${NATIVE_TOGGLE_SELECTOR}`) ||
    document.querySelector(NATIVE_TOGGLE_SELECTOR) ||
    document.querySelector(LEAD_TOGGLE_SELECTOR)
  );
}

function isElement(value) {
  return !!value && typeof value === "object" && value.nodeType === 1;
}

// ------------------------------------------------------------------ 注入的按钮

function buildAction(kind, source) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = ACTION_CLASS;
  button.setAttribute(ACTION_ATTR, kind);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    activate(kind);
  });
  syncAction(button, kind, source);
  return button;
}

/** 文案与图标都照抄宿主那一枚：宿主改语言、换图标时这里跟着变。 */
function syncAction(button, kind, source) {
  const label =
    (source && (source.getAttribute("aria-label") || source.getAttribute("title"))) ||
    (kind === "new-task" ? "新建任务" : "搜索");
  if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
  if (button.title !== label) button.title = label;
  const svg = source ? source.querySelector("svg") : null;
  const icon = svg ? svg.outerHTML : FALLBACK_ICONS[kind];
  if (button.innerHTML !== icon) button.innerHTML = icon;
}

function ensureActions() {
  const sources = sourceButtons();
  for (const kind of ["new-task", "search"]) {
    const source = sources[kind];
    if (!actions[kind]) actions[kind] = buildAction(kind, source);
    syncAction(actions[kind], kind, source);
  }
  return sources;
}

/** 点注入按钮 = 点宿主那枚按钮；搜索没有原按钮时退回宿主自己的快捷键。 */
function activate(kind) {
  const source = sourceButtons()[kind];
  if (isElement(source) && typeof source.click === "function") {
    source.click();
    return;
  }
  if (kind !== "search") return;
  const mac = document.documentElement.getAttribute("data-platform") === "darwin";
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      bubbles: true,
      cancelable: true,
      ...(mac ? { metaKey: true } : { ctrlKey: true }),
    })
  );
}

// ---------------------------------------------------------------------- 摆放

function placeActions(toggle) {
  const newTask = actions["new-task"];
  const search = actions.search;
  if (!toggle || !newTask || !search) return;
  const inSidebar = !!toggle.closest(SIDEBAR_HEADER_SELECTOR);
  if (inSidebar) {
    // 侧边栏展开：新建任务、搜索都是「收起侧边栏」左边的邻居。
    if (toggle.previousElementSibling !== search) toggle.before(search);
    if (search.previousElementSibling !== newTask) search.before(newTask);
    return;
  }
  // 侧边栏收起：两个入口跟着「切换侧边栏」往右排。
  if (toggle.nextElementSibling !== newTask) toggle.after(newTask);
  if (newTask.nextElementSibling !== search) newTask.after(search);
}

function detachActions() {
  for (const kind of ["new-task", "search"]) {
    const button = actions[kind];
    if (button && button.parentElement) button.remove();
  }
}

// 原来那两个位置：标记后由样式隐藏。宿主重绘会换掉节点，所以每次扫都重新标。
function markMoved(active) {
  for (const element of document.querySelectorAll(`[${MOVED_ATTR}="true"]`)) {
    if (!active) element.removeAttribute(MOVED_ATTR);
  }
  if (!active) return;
  const menu = menuElement();
  if (menu) menu.setAttribute(MOVED_ATTR, "true");
  for (const element of document.querySelectorAll(NATIVE_NEW_TASK_SELECTOR)) {
    element.setAttribute(MOVED_ATTR, "true");
  }
}

// ------------------------------------------------------- 右侧面板开关的图标

/**
 * 图标在自己的方框里偏了一点：按两个盒子的中心差平移回去。用 offset 系列而不是
 * 视口矩形 —— 平移已经生效后，视口矩形会把这份平移算进去，越量越偏。
 */
function alignPanelToggle() {
  const root = document.documentElement;
  const button = document.querySelector(PANEL_TOGGLE_SELECTOR);
  const icon = button ? button.querySelector(PANEL_ICON_SELECTOR) : null;
  if (!button || !icon || !button.clientWidth || !icon.offsetWidth) {
    root.style.removeProperty(ICON_SHIFT_X);
    root.style.removeProperty(ICON_SHIFT_Y);
    return;
  }
  const dx = button.clientWidth / 2 - (icon.offsetLeft + icon.offsetWidth / 2);
  const dy = button.clientHeight / 2 - (icon.offsetTop + icon.offsetHeight / 2);
  // 一像素以内不动：亚像素取整带来的偏差肉眼看不见，而 transform 反而会让图标发虚。
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
    root.style.removeProperty(ICON_SHIFT_X);
    root.style.removeProperty(ICON_SHIFT_Y);
    return;
  }
  root.style.setProperty(ICON_SHIFT_X, `${dx.toFixed(2)}px`);
  root.style.setProperty(ICON_SHIFT_Y, `${dy.toFixed(2)}px`);
}

// ------------------------------------------------------------------ 一轮同步

function apply() {
  const root = document.documentElement;
  if (!enabled) {
    root.removeAttribute(ENABLED_ATTR);
    root.style.removeProperty(ICON_SHIFT_X);
    root.style.removeProperty(ICON_SHIFT_Y);
    markMoved(false);
    detachActions();
    return;
  }
  root.setAttribute(ENABLED_ATTR, "true");
  markMoved(true);
  ensureActions();
  const toggle = toggleButton();
  if (toggle) placeActions(toggle);
  else detachActions();
  alignPanelToggle();
}

function scan() {
  scanTimer = null;
  apply();
}

function scheduleScan() {
  if (scanTimer !== null) return;
  scanTimer = setTimeout(scan, SCAN_DELAY_MS);
}

// ------------------------------------------------------------------ 设置与生命周期

async function refresh() {
  if (!host || typeof host.dispatch !== "function") return;
  try {
    const state = await host.dispatch("plugin.call", { method: "modelPickerState", args: {} });
    const config = (state && state.config) || state || {};
    enabled = config.entryActions === true;
  } catch {
    // 读不到就沿用上一次的用法：窗口照常可用。
    return;
  }
  apply();
}

function onAttention() {
  void refresh();
}

function onDocumentKeydown() {
  // 宿主重绘后自己的按钮可能换掉，扫描会在下一帧把它找回来。
  scheduleScan();
}

export function mountNavEntries(bridge) {
  host = bridge;
  if (typeof MutationObserver === "function" && document.documentElement) {
    if (!observer) {
      observer = new MutationObserver(scheduleScan);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }
  if (!attentionBound) {
    attentionBound = true;
    document.addEventListener("visibilitychange", onAttention);
    document.addEventListener("keydown", onDocumentKeydown, true);
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("focus", onAttention);
      window.addEventListener("resize", scheduleScan);
    }
  }
  return refresh();
}

export function unmountNavEntries() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (scanTimer !== null) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
  if (attentionBound) {
    attentionBound = false;
    document.removeEventListener("visibilitychange", onAttention);
    document.removeEventListener("keydown", onDocumentKeydown, true);
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("focus", onAttention);
      window.removeEventListener("resize", scheduleScan);
    }
  }
  enabled = false;
  apply();
  for (const kind of ["new-task", "search"]) {
    if (actions[kind]) actions[kind].remove();
    actions[kind] = null;
  }
  host = null;
}

// Exposed for the test that keeps the host selectors honest.
export const __internals = {
  ENABLED_ATTR,
  ACTION_ATTR,
  MOVED_ATTR,
  ACTION_CLASS,
  ICON_SHIFT_X,
  ICON_SHIFT_Y,
  MENU_SELECTOR,
  NATIVE_NEW_TASK_SELECTOR,
  NATIVE_TOGGLE_SELECTOR,
  LEAD_TOGGLE_SELECTOR,
  SIDEBAR_HEADER_SELECTOR,
  PANEL_TOGGLE_SELECTOR,
  PANEL_ICON_SELECTOR,
};
