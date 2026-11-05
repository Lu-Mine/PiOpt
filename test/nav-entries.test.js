"use strict";

/**
 * 窗口入口的摆法：两个入口从会话标题栏搬进侧边栏，收起侧边栏后跟着「切换侧边栏」
 * 排，右侧面板开关的图标按实测偏差摆正。
 *
 * 这一层活在宿主窗口里，所以测试里给它一个小 DOM，替宿主出那两种布局：侧边栏展开
 * 与收起。搬家的顺序、原来那两个位置的隐去、关掉之后的还原，都是会悄悄退化的地方。
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// ------------------------------------------------------------------- fake DOM

function tokenMatches(element, token) {
  if (token.startsWith(".")) return (element.className || "").split(/\s+/).includes(token.slice(1));
  if (token.startsWith("[")) {
    const match = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(token);
    if (!match) return false;
    const value = element.getAttribute(match[1]);
    return match[2] === undefined ? value !== null : value === match[2];
  }
  return element.tagName === token.toUpperCase();
}

function matchesSelector(element, selector) {
  const tokens = selector.trim().split(/\s+/);
  if (!tokenMatches(element, tokens[tokens.length - 1])) return false;
  let index = tokens.length - 2;
  let cursor = element.parentElement;
  while (index >= 0) {
    let found = false;
    while (cursor) {
      if (tokenMatches(cursor, tokens[index])) {
        found = true;
        cursor = cursor.parentElement;
        break;
      }
      cursor = cursor.parentElement;
    }
    if (!found) return false;
    index -= 1;
  }
  return true;
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.textContent = "";
    this.innerHTML = "";
    this.title = "";
    this.type = "";
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.offsetLeft = 0;
    this.offsetTop = 0;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    const properties = new Map();
    this.style = {
      setProperty: (name, value) => properties.set(name, String(value)),
      removeProperty: (name) => properties.delete(name),
      getPropertyValue: (name) => properties.get(name) ?? "",
    };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  click() {
    this.emit("click", { preventDefault() {}, stopPropagation() {} });
  }

  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }

  prepend(...nodes) {
    for (const node of [...nodes].reverse()) {
      node.remove();
      node.parentElement = this;
      this.children.unshift(node);
    }
  }

  before(...nodes) {
    const parent = this.parentElement;
    assert.ok(parent, "before() needs a parent");
    const index = parent.children.indexOf(this);
    for (const node of nodes) {
      node.remove();
      node.parentElement = parent;
      parent.children.splice(index, 0, node);
    }
  }

  after(...nodes) {
    const parent = this.parentElement;
    assert.ok(parent, "after() needs a parent");
    let index = parent.children.indexOf(this);
    for (const node of nodes) {
      node.remove();
      node.parentElement = parent;
      index += 1;
      parent.children.splice(index, 0, node);
    }
  }

  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }

  get previousElementSibling() {
    const parent = this.parentElement;
    if (!parent) return null;
    const index = parent.children.indexOf(this);
    return index > 0 ? parent.children[index - 1] : null;
  }

  get nextElementSibling() {
    const parent = this.parentElement;
    if (!parent) return null;
    const index = parent.children.indexOf(this);
    return index >= 0 && index + 1 < parent.children.length ? parent.children[index + 1] : null;
  }

  closest(selector) {
    let cursor = this;
    while (cursor) {
      if (matchesSelector(cursor, selector)) return cursor;
      cursor = cursor.parentElement;
    }
    return null;
  }

  descendants() {
    const out = [];
    for (const child of this.children) out.push(child, ...child.descendants());
    return out;
  }

  querySelector(selector) {
    return this.descendants().find((element) => matchesSelector(element, selector)) ?? null;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((element) => matchesSelector(element, selector));
  }
}

const el = (tagName, className = "") => {
  const element = new FakeElement(tagName);
  element.className = className;
  return element;
};

/** 宿主的会话标题栏：右上角那一对入口，以及左侧那枚「切换侧边栏」。 */
function chatTopbar() {
  const topbar = el("div", "conversation-topbar");
  const left = el("div", "ct-left");
  const lead = el("div", "ct-lead");
  const toggle = el("button", "ct-icon-btn");
  toggle.setAttribute("aria-label", "切换侧边栏");
  lead.append(toggle);
  left.append(lead);

  const right = el("div", "ct-right");
  const actions = el("div", "ct-actions");
  const newTask = el("button", "ct-icon-btn");
  newTask.setAttribute("aria-label", "新建任务");
  const search = el("button", "ct-icon-btn");
  search.setAttribute("aria-label", "搜索");
  actions.append(newTask, search);
  right.append(actions);

  topbar.append(left, right);
  return { topbar, lead, toggle, actions, newTask, search };
}

function buildDocument() {
  const documentElement = el("div");
  const head = el("head");
  const body = el("body");
  documentElement.append(head, body);
  const doc = {
    head,
    body,
    documentElement,
    createElement: (tagName) => new FakeElement(tagName),
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };
  return { doc, body, documentElement };
}

function withSidebar(body) {
  const header = el("div", "sidebar-header");
  const actions = el("div", "sidebar-header-actions");
  const collapse = el("button", "icon-btn icon-btn-square");
  collapse.setAttribute("data-nav", "toggle-sidebar");
  collapse.setAttribute("aria-label", "收起侧边栏");
  actions.append(collapse);
  header.append(actions);
  body.append(header);
  return { header, actions, collapse };
}

const hostReturning = (entryActions) => ({
  dispatch: async () => ({ config: { entryActions } }),
});

async function withHost(build) {
  const mod = await import("../renderer/nav-entries.mjs");
  const { doc, body, documentElement } = buildDocument();
  const previousDocument = global.document;
  global.document = doc;
  try {
    await build({ mod, doc, body, documentElement });
  } finally {
    mod.unmountNavEntries();
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
}
}

const injected = (container) => container.querySelectorAll("[data-piopt-nav-action]");
const kindsOf = (container) => injected(container).map((node) => node.getAttribute("data-piopt-nav-action"));

// ----------------------------------------------------------------- 静态约束

test("the rewrite is one module with one stylesheet and one lifecycle", () => {
  const source = read("renderer/nav-entries.mjs");
  assert.match(source, /export const NAV_ENTRIES_CSS = \[/);
  assert.match(source, /export function mountNavEntries\(bridge\)/);
  assert.match(source, /export function unmountNavEntries\(\)/);
  // 宿主的四个落点，一个都不能凭猜：标题栏那对入口、两处侧边栏开关、面板开关。
  assert.match(source, /const MENU_SELECTOR = "\.conversation-topbar \.ct-actions";/);
  assert.match(source, /const NATIVE_TOGGLE_SELECTOR = '\[data-nav="toggle-sidebar"\]';/);
  assert.match(source, /const LEAD_TOGGLE_SELECTOR = "\.conversation-topbar \.ct-lead \.ct-icon-btn";/);
  assert.match(source, /const PANEL_TOGGLE_SELECTOR = "\.app-work-panel-toggle";/);
  assert.match(source, /const PANEL_ICON_SELECTOR = "\.app-work-panel-toggle-icon";/);
  // 搬家而不是复制：原位置用**内联** display 藏掉 —— 属性 + 样式表会在宿主重绘时
  // 跟着节点一起没了，那才是原按钮闪来闪去的根因。
  assert.match(source, /element\.style\.setProperty\("display", "none", "important"\);/);
  assert.match(source, /element\.style\.removeProperty\("display"\);/);
  // 收起侧边栏时标题要往右让出这两个入口的宽度（宿主只给一个按钮留了 36px）。
  assert.match(
    source,
    /`\[\$\{ENABLED_ATTR\}="true"\] \.conversation-topbar\.ct-collapsed\{padding-left:calc\(var\(--ct-lead-inset,12px\) \+ 36px \+ 2 \* 32px\)\}`/
  );
  // 宿主改 DOM 后同步复位：一批 mutation 一次 microtask，不留几十毫秒的闪烁窗口。
  assert.match(source, /observer = new MutationObserver\(scheduleScan\);/);
  assert.match(source, /queueMicrotask\(\(\) => \{/);
  // 图标按中心差平移，变量缺省就是零，宿主的原样不受影响。
  assert.match(
    source,
    /`\[\$\{ENABLED_ATTR\}="true"\] \$\{PANEL_ICON_SELECTOR\}\{transform:translate\(var\(\$\{ICON_SHIFT_X\},0px\),var\(\$\{ICON_SHIFT_Y\},0px\)\)\}`/
  );
  assert.match(source, /const dx = button\.clientWidth \/ 2 - \(icon\.offsetLeft \+ icon\.offsetWidth \/ 2\);/);
});

test("the setting itself is one boolean, off unless asked for", () => {
  const navEntries = require("../features/behavior/nav-entries.js");
  assert.equal(navEntries.SETTINGS_KEY, "navEntries");
  assert.deepEqual(navEntries.DEFAULT_CONFIG, { enabled: false });
  assert.deepEqual(navEntries.normalizeConfig({}), { enabled: false });
  assert.deepEqual(navEntries.normalizeConfig({ enabled: true }), { enabled: true });
  assert.deepEqual(navEntries.normalizeConfig({ enabled: "yes" }), { enabled: false });
});

// ------------------------------------------------------------------ 两种布局

test("sidebar open: the two entries sit to the left of the collapse button", async () => {
  await withHost(async ({ mod, body, documentElement }) => {
    const { header, actions, collapse } = withSidebar(body);
    const { topbar, actions: menu } = chatTopbar();
    body.append(topbar);

    await mod.mountNavEntries(hostReturning(true));

    // 头部最左边是那枚「收起侧边栏」（注入的），原按钮藏起来。
    assert.equal(header.firstElementChild.getAttribute("data-piopt-nav-action"), "collapse");
    assert.equal(collapse.style.getPropertyValue("display"), "none");
    // 原位置还是那一条：新建任务、搜索、收起（原按钮藏着，但仍占着锚点的位置）。
    assert.deepEqual(kindsOf(actions), ["new-task", "search"]);
    assert.equal(actions.children[0].getAttribute("data-piopt-nav-action"), "new-task");
    assert.equal(actions.children[1].getAttribute("data-piopt-nav-action"), "search");
    assert.equal(actions.children[2], collapse);
    assert.equal(actions.parentElement, header);
    // 文案与图标照着宿主那一枚来。
    assert.equal(actions.children[0].getAttribute("aria-label"), "新建任务");
    assert.equal(actions.children[1].getAttribute("aria-label"), "搜索");
    assert.ok(actions.children[0].innerHTML.includes("<svg"));
    // 会话标题栏那一份不再是入口：原位置只是被隐掉，节点还在。
    assert.equal(menu.getAttribute("data-piopt-nav-moved"), "true");
    assert.equal(menu.children.length, 2);
    assert.equal(documentElement.getAttribute("data-piopt-nav-entries"), "true");
  });
});

// 原位隐藏靠内联 display，不是属性 + 样式表：宿主换掉节点时属性会跟着没了。
test("hidden native sources stay hidden as inline styles, not as a class", async () => {
  await withHost(async ({ mod, body }) => {
    const { topbar, actions: menu, newTask, search } = chatTopbar();
    body.append(topbar);
    withSidebar(body);

    await mod.mountNavEntries(hostReturning(true));

    assert.equal(menu.style.getPropertyValue("display"), "none");
    assert.equal(newTask.style.getPropertyValue("display"), "none");
    assert.equal(search.style.getPropertyValue("display"), "none");
    // 关掉之后把内联样式收走，宿主原来的显示方式原样回来。
    mod.unmountNavEntries();
    assert.equal(menu.style.getPropertyValue("display"), "");
    assert.equal(newTask.style.getPropertyValue("display"), "");
  });
});

test("sidebar closed: the two entries follow the toggle button", async () => {
  await withHost(async ({ mod, body }) => {
    const { topbar, lead, toggle } = chatTopbar();
    body.append(topbar);

    await mod.mountNavEntries(hostReturning(true));

    // 收起时「切换侧边栏」左边那枚 ct-icon-btn 就是锚点，两个入口排在它右边。
    assert.deepEqual(kindsOf(lead), ["new-task", "search"]);
    assert.equal(lead.children[0], toggle);
    assert.equal(lead.children[1].getAttribute("data-piopt-nav-action"), "new-task");
    assert.equal(lead.children[2].getAttribute("data-piopt-nav-action"), "search");
  });
});

test("clicking an injected entry is clicking the host's own button", async () => {
  await withHost(async ({ mod, body }) => {
    const { actions } = withSidebar(body);

test("sidebar closed: the injected collapse button goes away with the sidebar", async () => {
  await withHost(async ({ mod, body }) => {
    const { topbar, lead } = chatTopbar();
    body.append(topbar);

    await mod.mountNavEntries(hostReturning(true));

    // 收起时「切换侧边栏」本就在最左，不需要再注入一枚收起按钮。
    assert.deepEqual(kindsOf(lead), ["new-task", "search"]);
    assert.equal(lead.querySelectorAll('[data-piopt-nav-action="collapse"]').length, 0);
  });
});
    const { topbar, newTask, search } = chatTopbar();
    body.append(topbar);

    await mod.mountNavEntries(hostReturning(true));

    let opened = 0;
    let searched = 0;
    newTask.addEventListener("click", () => {
      opened += 1;
    });
    search.addEventListener("click", () => {
      searched += 1;
    });
    actions.children[0].click();
    actions.children[1].click();
    assert.equal(opened, 1);
    assert.equal(searched, 1);
  });
});

test("switching the feature off puts the window back the way the host drew it", async () => {
  const mod = await import("../renderer/nav-entries.mjs");
  const { doc, body, documentElement } = buildDocument();
  const previousDocument = global.document;
  global.document = doc;
  try {
    const { actions } = withSidebar(body);
    const { topbar, actions: menu, lead } = chatTopbar();
    body.append(topbar);

    await mod.mountNavEntries(hostReturning(true));
    assert.deepEqual(kindsOf(actions), ["new-task", "search"]);

    // 关掉开关：注入的按钮离场，原来那两个位置重新露面，documentElement 也不再挂标记。
    const off = { dispatch: async () => ({ config: { entryActions: false } }) };
    mod.mountNavEntries(off);
    // mount 会重新读设置；等它的那一轮刷新结束。
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(kindsOf(actions), []);
    assert.equal(menu.getAttribute("data-piopt-nav-moved"), null);
    assert.equal(kindsOf(lead).length, 0);
    assert.equal(documentElement.getAttribute("data-piopt-nav-entries"), null);
  } finally {
    mod.unmountNavEntries();
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
});

// ------------------------------------------------------- 右侧面板开关的图标

test("the panel toggle's icon is nudged back to the centre of its own box", async () => {
  await withHost(async ({ mod, body, documentElement }) => {
    withSidebar(body);
    body.append(chatTopbar().topbar);

    const button = el("button", "app-work-panel-toggle no-drag");
    const icon = el("span", "app-work-panel-toggle-icon");
    button.append(icon);
    body.append(button);
    // 28×28 的方框里，15×15 的图标落在 (8,10)：偏右下 1.5 / 3.5 像素。
    button.clientWidth = 28;
    button.clientHeight = 28;
    icon.offsetWidth = 15;
    icon.offsetHeight = 15;
    icon.offsetLeft = 8;
    icon.offsetTop = 10;

    await mod.mountNavEntries(hostReturning(true));

    assert.equal(documentElement.style.getPropertyValue("--piopt-panel-icon-shift-x"), "-1.50px");
    assert.equal(documentElement.style.getPropertyValue("--piopt-panel-icon-shift-y"), "-3.50px");
  });
});

test("an icon the host already centred gets no correction at all", async () => {
  await withHost(async ({ mod, body, documentElement }) => {
    withSidebar(body);
    body.append(chatTopbar().topbar);

    const button = el("button", "app-work-panel-toggle");
    const icon = el("span", "app-work-panel-toggle-icon");
    button.append(icon);
    body.append(button);
    button.clientWidth = 28;
    button.clientHeight = 28;
    icon.offsetWidth = 15;
    icon.offsetHeight = 15;
    icon.offsetLeft = 6;
    icon.offsetTop = 6;

    await mod.mountNavEntries(hostReturning(true));

    assert.equal(documentElement.style.getPropertyValue("--piopt-panel-icon-shift-x"), "");
    assert.equal(documentElement.style.getPropertyValue("--piopt-panel-icon-shift-y"), "");
  });
});

// --------------------------------------------------------------- 主进程那一侧

test("the entry switch is stored on its own key, next to the popup settings", async () => {
  const feature = require("../features/behavior/index.js");
  const store = { modelPicker: { grouping: "name", frameSelected: true, translateThinking: true } };
  const writes = [];
  global.pi = {
    plugin: {
      getSettings: async () => ({ ...store }),
      setSettings: async (patch) => {
        writes.push(patch);
        Object.assign(store, patch);
      },
    },
  };
  try {
    await feature.onLoad();
    // 面板与窗口读到的仍是同一份扁平配置：浮窗三项加一个 entryActions。
    assert.deepEqual(feature.getState().config, {
      grouping: "name",
      frameSelected: true,
      translateThinking: true,
      entryActions: false,
    });

    const saved = await feature.setOptions({ entryActions: true });
    assert.equal(saved.config.entryActions, true);
    // 只写入口那一份设置，不顺手把浮窗那份再写一遍。
    assert.deepEqual(writes, [{ navEntries: { enabled: true } }]);
    assert.equal(store.modelPicker.entryActions, undefined);
    assert.deepEqual(store.navEntries, { enabled: true });

    // 关掉时同样只动自己那一份。
    writes.length = 0;
    const off = await feature.setOptions({ entryActions: false, grouping: "vendor" });
    assert.equal(off.config.entryActions, false);
    assert.equal(off.config.grouping, "vendor");
    assert.deepEqual(store.navEntries, { enabled: false });
    assert.equal(store.modelPicker.grouping, "vendor");
    // 浮窗那份里不夹带入口开关：它有自己的键。
    assert.equal(store.modelPicker.entryActions, undefined);
  } finally {
    delete global.pi;
  }
});
