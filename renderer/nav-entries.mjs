/*
 * 窗口入口的摆法（宿主窗口这一侧）。
 *
 * 宿主把「新建任务」「搜索」放在会话标题栏右上角（`.conversation-topbar .ct-actions`），
 * 把「收起侧边栏」放在侧边栏头部；侧边栏收起时那个按钮才换成标题栏里的「切换侧边栏」。
 * 这一层不碰宿主的组件，只做三件 DOM 上的事：
 *
 * 1. 把这两个入口搬进侧边栏头部，摆在「收起侧边栏」左边（顺序：新建任务、搜索、收起）；
 * 2. 侧边栏收起时改摆在「切换侧边栏」右边（顺序：切换、新建任务、搜索）；
 * 3. 原来那两个位置隐掉（是搬家不是复制），并让会话标题向右让出这两个按钮的宽度。
 *
 * 搬过去的是自己的按钮，点击转交给宿主原按钮 —— 新建任务仍走宿主自己的命令，搜索
 * 仍打开宿主自己的搜索框（原按钮不在这一页时退回宿主的 ⌘/Ctrl+K 快捷键）。
 *
 * 两个与宿主渲染有关的硬约束：
 * - 隐藏原按钮用**内联** `display:none !important`。属性 + 样式表会被宿主重绘打断：
 *   React 换掉节点时属性跟着没了，按钮就在藏与露之间闪。内联样式留在节点自己身上，
 *   节点不换就一直藏着；真被换掉，观察者会在同一帧里再藏一次。
 * - 宿主重绘可能把我们的按钮一起带走，所以观察者是**同步**复位的（一批 mutation 一次
 *   microtask），不留几十毫秒的真空期。apply 本身幂等：位置已对就一个字节都不写。
 *
 * 同一个开关还顺手处理右侧面板那个开关：它的图标在自己的方框里偏右下，这里按两个
 * 盒子的中心差把它平移到正中；宿主若本来就在正中，就什么都不设。
 */

const ENABLED_ATTR = "data-piopt-nav-entries";
const ACTION_ATTR = "data-piopt-nav-action";
const MOVED_ATTR = "data-piopt-nav-moved";
const ACTION_CLASS = "piopt-nav-action";
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
  collapse:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>',
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
  // 展开时「收起侧边栏」摆到侧边栏头部最左边，与右边那几个入口之间拉开距离。
  `.sidebar-header > .${ACTION_CLASS}{margin-right:8px}`,
  // 收起侧边栏时这一排贴在会话标题上，两个按钮之间留一道与宿主标题栏相同的缝。
  `.conversation-topbar .ct-lead > .${ACTION_CLASS}{margin-left:4px}`,
  // 会话标题的让位：宿主只给一个 28px 的「切换侧边栏」留了 36px（28 + 8 的缝）。
  // 多出来的两个入口各占 28px 加 4px 的缝，一并算进 padding，标题就不会被压住。
  `[${ENABLED_ATTR}="true"] .conversation-topbar.ct-collapsed{padding-left:calc(var(--ct-lead-inset,12px) + 36px + 2 * 32px)}`,
  // 右侧面板开关：内边距归零，图标按实测的中心差平移回正中。
  `[${ENABLED_ATTR}="true"] ${PANEL_TOGGLE_SELECTOR}{padding:0}`,
  `[${ENABLED_ATTR}="true"] ${PANEL_ICON_SELECTOR}{transform:translate(var(${ICON_SHIFT_X},0px),var(${ICON_SHIFT_Y},0px))}`,
].join("\n");

let host = null;
let enabled = false;
let observer = null;
const rootObservers = new Map();
const OBSERVED_ROOT_SELECTORS = [
  ".sidebar-footer",
  ".conversation-topbar",
  ".sidebar-header",
  ".app-work-panel-toggle",
];

function observeRelevantRoots() {
  if (typeof MutationObserver !== "function" || !document.documentElement) return;
  const roots = new Set();
  for (const selector of OBSERVED_ROOT_SELECTORS) {
    const root = document.querySelector(selector);
    if (root) roots.add(root);
  }
  for (const [root, current] of rootObservers) {
    if (roots.has(root)) continue;
    current.disconnect();
    rootObservers.delete(root);
  }
  for (const root of roots) {
    if (rootObservers.has(root)) continue;
    const current = new MutationObserver(scheduleScan);
    current.observe(root, { childList: true, subtree: true });
    rootObservers.set(root, current);
  }
}

function disconnectRelevantRoots() {
  for (const current of rootObservers.values()) current.disconnect();
  rootObservers.clear();
}
let scanQueued = false;
let applying = false;
let attentionBound = false;
// 三个注入按钮一直留着，位置随侧边栏状态换：重建节点会让宿主的重绘踩空。
// collapse 那枚是「收起侧边栏」：展开时摆到侧边栏头部最左边，收起时收起来。
const actions = { "new-task": null, search: null, collapse: null };
// 被我们藏起来的宿主节点：关闭时只还原这些，别人的样式一概不碰。
const hiddenNodes = new Set();
let alignedIcon = null;

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
    (kind === "new-task" ? "新建任务" : kind === "search" ? "搜索" : "收起侧边栏");
  if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
  if (button.title !== label) button.title = label;
  const svg = source ? source.querySelector("svg") : null;
  const icon = svg ? svg.outerHTML : FALLBACK_ICONS[kind];
  // Browsers expand self-closing SVG elements while serializing innerHTML.
  // Compare a canonical DOM serialization, not the original source string.
  const probe = document.createElement("span");
  probe.innerHTML = icon;
  if (button.innerHTML !== probe.innerHTML) button.innerHTML = icon;
}

function ensureActions() {
  const sources = sourceButtons();
  for (const kind of ["new-task", "search"]) {
    const source = sources[kind];
    if (!actions[kind]) actions[kind] = buildAction(kind, source);
    syncAction(actions[kind], kind, source);
  }
}

/** 点注入按钮 = 点宿主那枚按钮；搜索没有原按钮时退回宿主自己的快捷键。 */
function activate(kind) {
  const source = kind === "collapse" ? toggleButton() : sourceButtons()[kind];
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
  const collapse = actions.collapse;
  if (!toggle || !newTask || !search) return;
  const inSidebar = !!toggle.closest(SIDEBAR_HEADER_SELECTOR);
  if (inSidebar) {
    // 侧边栏展开：顺序就是 收起、新建任务、搜索，三个都在头部右侧那一组里。
    // 收起按钮排在新建任务左边（宿主原来那枚藏起来了，但节点还在，锚点不动）。
    if (toggle.previousElementSibling !== search) toggle.before(search);
    if (search.previousElementSibling !== newTask) search.before(newTask);
    if (collapse && newTask.previousElementSibling !== collapse) newTask.before(collapse);
    return;
    return;
  }
  // 侧边栏收起：那枚 collapse 收起来，两个入口跟着「切换侧边栏」往右排。
  if (collapse && collapse.parentElement) collapse.remove();
  if (toggle.nextElementSibling !== newTask) toggle.after(newTask);
  if (newTask.nextElementSibling !== search) newTask.after(search);
}

function detachActions() {
  for (const kind of ["new-task", "search", "collapse"]) {
    const button = actions[kind];
    if (button && button.parentElement) button.remove();
  }
}

// 原来那两个位置：内联 display 藏掉，节点仍归宿主。宿主重绘会换掉节点，所以每轮都
// 重新藏一遍；被换掉的旧节点如果还留在文档里，也不会再冒出来。
function hideNativeSources(hide) {
  if (!hide) {
    for (const element of hiddenNodes) {
      element.style.removeProperty("display");
      element.removeAttribute(MOVED_ATTR);
    }
    hiddenNodes.clear();
    return;
  }
  const targets = new Set(document.querySelectorAll(NATIVE_NEW_TASK_SELECTOR));
  const menu = menuElement();
  if (menu) {
    targets.add(menu);
    // ct-actions 里那一对按钮也各藏一次：有的宿主版本只给整组挂外壳，按钮自己仍占格子。
    for (const button of menu.querySelectorAll("button")) targets.add(button);
  }
  // 侧边栏展开时那枚「收起侧边栏」挪到头部最左边的是注入按钮，原按钮藏起来。
  const nativeToggle = document.querySelector(`${SIDEBAR_HEADER_SELECTOR} ${NATIVE_TOGGLE_SELECTOR}`);
  if (nativeToggle) targets.add(nativeToggle);
  for (const element of targets) {
    if (element.style.getPropertyValue("display") !== "none") {
      element.style.setProperty("display", "none", "important");
    }
    element.setAttribute(MOVED_ATTR, "true");
    hiddenNodes.add(element);
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
  // 同一个图标量过一次就够了，窗口尺寸变化时再量（resize 会触发一轮 apply）。
  if (icon && icon === alignedIcon) return;
  alignedIcon = icon || null;
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
  if (applying) return;
  applying = true;
  try {
    const root = document.documentElement;
    if (!enabled) {
      root.removeAttribute(ENABLED_ATTR);
      root.style.removeProperty(ICON_SHIFT_X);
      root.style.removeProperty(ICON_SHIFT_Y);
      alignedIcon = null;
      hideNativeSources(false);
      detachActions();
      return;
    }
    root.setAttribute(ENABLED_ATTR, "true");
    ensureActions();
    const toggle = toggleButton();
    // 展开时那枚「收起侧边栏」也注入一枚：摆到头部最左边，图标文案照抄宿主。
    const inSidebar = !!(toggle && toggle.closest(SIDEBAR_HEADER_SELECTOR));
    if (inSidebar && !actions.collapse) actions.collapse = buildAction("collapse", toggle);
    if (actions.collapse) syncAction(actions.collapse, "collapse", inSidebar ? toggle : null);
    if (toggle) placeActions(toggle);
    else detachActions();
    hideNativeSources(true);
    alignPanelToggle();
  } finally {
    applying = false;
  }
}

/**
 * 宿主一改 DOM 就同步复位：一批 mutation 只跑一次，且在下一帧绘制之前完成。
 * 不用几十毫秒的去抖 —— 那正是注入按钮被宿主带走后「闪一下才回来」的窗口期。
 */
function scheduleScan() {
  if (scanQueued || applying) return;
  scanQueued = true;
  queueMicrotask(() => {
    scanQueued = false;
    apply();
  });
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
  // 只在功能开着时看键盘：宿主重绘后自己的按钮可能被换掉，扫描会在下一帧找回来。
  if (!enabled) return;
  scheduleScan();
}

/** 控制台里可以直接读：__pioptNavEntries.inspect()。不改任何东西。 */
function inspect() {
  const toggle = toggleButton();
  return {
    enabled,
    anchor: toggle
      ? toggle.closest(SIDEBAR_HEADER_SELECTOR)
        ? "sidebar-header"
        : toggle.closest(".ct-lead")
          ? "ct-lead"
          : "titlebar"
      : "none",
    actions: ["new-task", "search", "collapse"].map((kind) => {
      const button = actions[kind];
      return {
        kind,
        parent: button && button.parentElement ? button.parentElement.className : null,
        inDocument: !!(button && button.parentElement),
        label: button ? button.getAttribute("aria-label") : null,
      };
    }),
    hiddenSources: hiddenNodes.size,
    shiftX: document.documentElement.style.getPropertyValue(ICON_SHIFT_X),
    shiftY: document.documentElement.style.getPropertyValue(ICON_SHIFT_Y),
  };
}

export function mountNavEntries(bridge) {
  host = bridge;
  observeRelevantRoots();
  if (typeof MutationObserver === "function" && document.body && !observer) {
    observer = new MutationObserver(() => {
      observeRelevantRoots();
      scheduleScan();
    });
    observer.observe(document.body, { childList: true });
  }
  if (!attentionBound) {
    attentionBound = true;
    document.addEventListener("visibilitychange", onAttention);
    document.addEventListener("keydown", onDocumentKeydown, true);
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("focus", onAttention);
      window.addEventListener("resize", scheduleScan);
      window.__pioptNavEntries = { inspect, apply: () => apply() };
    }
  }
  return refresh();
}

export function unmountNavEntries() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  disconnectRelevantRoots();
  scanQueued = false;
  if (attentionBound) {
    attentionBound = false;
    document.removeEventListener("visibilitychange", onAttention);
    document.removeEventListener("keydown", onDocumentKeydown, true);
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("focus", onAttention);
      window.removeEventListener("resize", scheduleScan);
      if (window.__pioptNavEntries) delete window.__pioptNavEntries;
    }
  }
  enabled = false;
  apply();
  for (const kind of ["new-task", "search", "collapse"]) {
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
