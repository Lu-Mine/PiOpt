// PiOpt — the chat composer's model popup, rewritten inside the host window.
//
// PI-Desktop's popup lists the three most recent models first and folds every
// other model behind an 「其他模型」 toggle (`ComposerPermissionPicker` in the
// host bundle). This module changes exactly that: 全部模型始终展开（限高仍是宿主
// 自己的 max-height，这里不碰），并且可以按供应商分组，或按模型名称平铺排序。
//
// 做法只有两条：
//   1. 点一次宿主自己的「其他模型」入口，把其余分组放出来，然后把入口藏掉；
//   2. 「按名称」时把原生分组隐藏，用克隆出来的按钮铺一份排序好的平铺列表 ——
//      点击克隆按钮只是转交给原生按钮（display:none 不影响 .click()），所以选中
//      模型走的仍是宿主自己的逻辑，React 的节点树一个都没被搬动。
//
// 之所以不重排 React 的节点：宿主在搜索、方向键高亮、模型异步加载时都会重新
// 渲染这棵子树，搬动别人的节点会让它下一次 insertBefore 找不到参照。

const MENU_SELECTOR = ".composer-model-menu";
const LIST_SELECTOR = ".composer-model-list";
const GROUP_SELECTOR = ".composer-model-group";
const GROUP_LABEL_SELECTOR = ".composer-model-group-label";
const OPTION_SELECTOR = ".composer-model-option";
const LABEL_SELECTOR = ".composer-model-label";
const SEARCH_INPUT_SELECTOR = ".composer-model-search input";
const COLLAPSE_CLASS = "composer-menu-entry";
const FLAT_CLASS = "piopt-mp-flat";
const MODE_ATTR = "data-piopt-mp-mode";
const SEARCH_ATTR = "data-piopt-mp-searching";
const EXPANDED_ATTR = "data-piopt-mp-expanded";
const GROUPINGS = ["provider", "name"];
const DEFAULT_GROUPING = "provider";
const SYNC_DELAY_MS = 40;

// Injected with the entry stylesheet: both rules only apply to menus this module
// has already touched, so an unmodified popup keeps the host's own look.
export const MODEL_PICKER_CSS = [
  `.composer-model-menu[${EXPANDED_ATTR}] .composer-model-list > .${COLLAPSE_CLASS}{display:none}`,
  /* 平铺时原生分组整组让位，搜索时再把它们放回来（搜索结果由宿主自己筛）。 */
  `.composer-model-menu[${MODE_ATTR}="name"]:not([${SEARCH_ATTR}="true"]) .composer-model-list > *:not(.${FLAT_CLASS}){display:none}`,
  `.composer-model-menu[${MODE_ATTR}="name"][${SEARCH_ATTR}="true"] .${FLAT_CLASS}{display:none}`,
].join("\n");

let host = null;
let grouping = DEFAULT_GROUPING;
let menu = null;
let bodyObserver = null;
let listObserver = null;
let syncTimer = null;
let building = false;

// The collator is the only locale-aware piece: 模型名多是英文，但排序要和界面的
// 中文语境一致，所以让平台自己决定语言，数字按数而不是按字符比较（`gpt-4` 在
// `gpt-10` 前面）。
const collator = typeof Intl === "object" && typeof Intl.Collator === "function"
  ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
  : null;

// ------------------------------------------------------------------- helpers

function textOf(element) {
  return element && typeof element.textContent === "string" ? element.textContent.trim() : "";
}

function isElement(node) {
  return Boolean(node) && node.nodeType === 1;
}

function childByClass(parent, className) {
  if (!parent) return null;
  for (const child of parent.children) {
    if (child.classList && child.classList.contains(className)) return child;
  }
  return null;
}

/**
 * 一行原生按钮的模型身份。
 *
 * 最近使用那一组的 title 是「供应商 · 模型 id」，供应商要自己拆出来；供应商分组
 * 里的 title 只有模型 id，供应商就是分组标题。身份用来去重（同一个模型只在平铺
 * 列表里出现一次）和稳定排序的兜底键。
 */
function identityOf(option, groupLabel) {
  const title = String(option.getAttribute("title") || "");
  const at = title.indexOf(" · ");
  const provider = at > 0 ? title.slice(0, at) : groupLabel;
  const modelId = at > 0 ? title.slice(at + 3) : title;
  // 分隔符用 US（单元分隔符）而不是 NUL：NUL 在属性值里会被序列化替换掉，
  // 这个键要先写进 `data-piopt-mp-item` 再读回来比对。
  return { provider, modelId, key: `${provider}\u001f${modelId.toLowerCase()}` };
}

function compareRows(left, right) {
  if (collator) {
    const byLabel = collator.compare(left.label, right.label);
    if (byLabel !== 0) return byLabel;
  } else if (left.label !== right.label) {
    return left.label < right.label ? -1 : 1;
  }
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/** 原生列表里出现的每一个模型，按身份去重后的平铺行。 */
function readRows(list) {
  const rows = [];
  const seen = new Set();
  for (const option of list.querySelectorAll(OPTION_SELECTOR)) {
    const group = typeof option.closest === "function" ? option.closest(GROUP_SELECTOR) : null;
    const groupLabel = textOf(group ? group.querySelector(GROUP_LABEL_SELECTOR) : null);
    const identity = identityOf(option, groupLabel);
    if (seen.has(identity.key)) continue;
    seen.add(identity.key);
    rows.push({
      option,
      key: identity.key,
      label: textOf(option.querySelector(LABEL_SELECTOR)) || identity.modelId,
    });
  }
  return rows;
}

// Our own DOM writes must not feed the observer back into another rebuild.
function dropRecords() {
  if (listObserver) listObserver.takeRecords();
}

// --------------------------------------------------------------------- build

function clearFlat(list) {
  const flat = childByClass(list, FLAT_CLASS);
  if (!flat) return;
  building = true;
  flat.remove();
  dropRecords();
  building = false;
}

function buildFlat(list) {
  building = true;
  let flat = childByClass(list, FLAT_CLASS);
  // 先清空再读：平铺按钮同样是 .composer-model-option，留着会被当成原生行。
  if (flat) flat.textContent = "";
  const rows = readRows(list);
  rows.sort(compareRows);
  if (!flat) {
    flat = document.createElement("div");
    flat.className = FLAT_CLASS;
    list.append(flat);
  }
  for (const row of rows) {
    const item = row.option.cloneNode(true);
    item.removeAttribute("data-model-index");
    if (item.classList) item.classList.remove("kb-active");
    item.setAttribute("data-piopt-mp-item", row.key);
    item.addEventListener("click", (event) => {
      event.preventDefault();
      // The clone only stands in for the host's own button: the real click goes
      // to the hidden original, so selection stays entirely React's business.
      if (typeof row.option.click === "function") row.option.click();
    });
    flat.append(item);
  }
  dropRecords();
  building = false;
  return rows.length;
}

// ---------------------------------------------------------------------- sync

function sync() {
  const target = menu;
  if (!target || target.isConnected === false) {
    unbindMenu();
    return;
  }
  const list = target.querySelector(LIST_SELECTOR);
  if (!list) return;

  target.setAttribute(EXPANDED_ATTR, "true");

  // 宿主的折叠入口：点一次把它全部展开，然后它在 CSS 里被藏掉，用户不能再收起。
  // 点击是异步生效的，所以这一轮先让原生列表照常显示，展开后的下一轮再平铺，
  // 免得浮窗先空一下。
  const collapse = childByClass(list, COLLAPSE_CLASS);
  if (collapse && collapse.getAttribute("aria-expanded") === "false") {
    target.removeAttribute(MODE_ATTR);
    if (typeof collapse.click === "function") collapse.click();
    return;
  }

  // 搜索时由宿主自己筛结果，平铺列表让开，不跟它的过滤结果打架。
  if (target.getAttribute(SEARCH_ATTR) === "true") return;

  if (grouping === "name") {
    target.setAttribute(MODE_ATTR, grouping);
    buildFlat(list);
  } else {
    target.removeAttribute(MODE_ATTR);
    clearFlat(list);
  }
}

function scheduleSync() {
  if (building || syncTimer !== null) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    sync();
  }, SYNC_DELAY_MS);
}

/**
 * 把宿主的键盘高亮（`.kb-active`）抄到平铺列表上。
 *
 * 方向键由宿主处理，它只会在原生按钮上换高亮；平铺列表里的按钮是克隆体，所以
 * 每次高亮变化都要跟着挪一下，否则按方向键时光标停在看不见的原生行上。
 */
function syncHighlight(list) {
  const flat = childByClass(list, FLAT_CLASS);
  if (!flat) return;
  let activeKey = null;
  for (const option of list.querySelectorAll(`${OPTION_SELECTOR}.kb-active`)) {
    // 平铺行也是 `.composer-model-option`，而且此刻正被同步；只看原生行，否则
    // 移除高亮时会被自己的克隆体说服「还有人高亮着」。
    if (typeof option.closest === "function" && option.closest(`.${FLAT_CLASS}`)) continue;
    const group = typeof option.closest === "function" ? option.closest(GROUP_SELECTOR) : null;
    const groupLabel = textOf(group ? group.querySelector(GROUP_LABEL_SELECTOR) : null);
    activeKey = identityOf(option, groupLabel).key;
    break;
  }
  for (const item of flat.children) {
    const active = activeKey !== null && item.getAttribute("data-piopt-mp-item") === activeKey;
    if (item.classList) item.classList.toggle("kb-active", active);
    if (active && typeof item.scrollIntoView === "function") item.scrollIntoView({ block: "nearest" });
  }
}

// -------------------------------------------------------------------- binding

function unbindMenu() {
  if (syncTimer !== null) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  if (listObserver) {
    listObserver.disconnect();
    listObserver = null;
  }
  if (menu) {
    const list = menu.querySelector(LIST_SELECTOR);
    if (list) clearFlat(list);
    menu.removeAttribute(MODE_ATTR);
    menu.removeAttribute(SEARCH_ATTR);
    menu.removeAttribute(EXPANDED_ATTR);
  }
  menu = null;
}

function bindMenu(element) {
  unbindMenu();
  menu = element;

  if (typeof MutationObserver === "function") {
    listObserver = new MutationObserver((records) => {
      if (building) return;
      for (const record of records) {
        const node = record.target;
        // 平铺列表是我们自己的节点，它的增删不该再触发一次重建。
        if (isElement(node) && typeof node.closest === "function" && node.closest(`.${FLAT_CLASS}`)) continue;
        // 只是键盘高亮换了一行：跟着挪一下，别整份重建。
        if (record.type === "attributes" && record.attributeName === "class") {
          syncHighlight(element.querySelector(LIST_SELECTOR));
          continue;
        }
        scheduleSync();
        return;
      }
    });
    listObserver.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-checked", "aria-expanded", "class"],
    });
  }

  sync();
  void refreshGrouping();
}

// ----------------------------------------------------------------- lifecycle

async function refreshGrouping() {
  if (!host || typeof host.dispatch !== "function") return;
  try {
    const state = await host.dispatch("plugin.call", { method: "modelPickerState", args: {} });
    const next = state && state.config ? state.config.grouping : state && state.grouping;
    if (GROUPINGS.includes(next) && next !== grouping) {
      grouping = next;
      if (menu) sync();
    }
  } catch {
    // 读不到就沿用上一次的排列方式，浮窗本身照常工作。
  }
}

function onDocumentInput(event) {
  const target = event ? event.target : null;
  if (!menu || !isElement(target) || typeof target.closest !== "function") return;
  if (!target.closest(SEARCH_INPUT_SELECTOR)) return;
  // 搜索由宿主自己筛：它一有查询就把平铺列表让开，把原生结果放回来。
  if (String(target.value || "").trim()) menu.setAttribute(SEARCH_ATTR, "true");
  else {
    menu.removeAttribute(SEARCH_ATTR);
    scheduleSync();
  }
}

/** Watches the body for the portal the host mounts each time the popup opens. */
function watchBody() {
  if (typeof MutationObserver !== "function" || !document.body) return;
  bodyObserver = new MutationObserver(() => {
    const found = document.querySelector(MENU_SELECTOR);
    if (!found) {
      if (menu) unbindMenu();
      return;
    }
    if (found !== menu) bindMenu(found);
  });
  // The portal is a direct child of <body>; watching that one level is enough and
  // costs nothing while the popup is closed.
  bodyObserver.observe(document.body, { childList: true });
}

export function mountModelPicker(bridge) {
  host = bridge;
  // 入口模块可能在同一个窗口里被重新挂载（插件重载）；监听器只挂一次。
  if (!bodyObserver) {
    document.addEventListener("input", onDocumentInput, true);
    watchBody();
  }
  const open = document.querySelector(MENU_SELECTOR);
  if (open && open !== menu) bindMenu(open);
  return refreshGrouping();
}

export function unmountModelPicker() {
  document.removeEventListener("input", onDocumentInput, true);
  if (bodyObserver) {
    bodyObserver.disconnect();
    bodyObserver = null;
  }
  unbindMenu();
  host = null;
  grouping = DEFAULT_GROUPING;
}

export const __internals = {
  MENU_SELECTOR,
  LIST_SELECTOR,
  FLAT_CLASS,
  MODE_ATTR,
  SEARCH_ATTR,
  EXPANDED_ATTR,
  DEFAULT_GROUPING,
  GROUPINGS,
};
