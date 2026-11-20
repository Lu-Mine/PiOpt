"use strict";

/**
 * The footer entry lives in the host window, so these tests stand in for the
 * host: a tiny DOM with the real selector the module targets, and the one host
 * API it calls. They pin the two things that would otherwise rot silently — the
 * button's position (second of four) and the single plugin.call it makes.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("manifest.json"));

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
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.textContent = "";
    this.innerHTML = "";
    this.title = "";
    this.type = "";
    // Real elements always carry a style object; the module writes two custom
    // properties on documentElement when it straightens the panel toggle.
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

  appendChild(node) {
    node.remove();
    node.parentElement = this;
    this.children.push(node);
    return node;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  after(...nodes) {
    const parent = this.parentElement;
    assert.ok(parent, "after() needs a parent");
    const index = parent.children.indexOf(this);
    for (const node of [...nodes].reverse()) {
      node.remove();
      node.parentElement = parent;
      parent.children.splice(index + 1, 0, node);
    }
  }

  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] ?? null;
  }

  get previousElementSibling() {
    const parent = this.parentElement;
    if (!parent) return null;
    const index = parent.children.indexOf(this);
    return index > 0 ? parent.children[index - 1] : null;
  }

  descendants() {
    const out = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }

  querySelector(selector) {
    return this.descendants().find((element) => matchesSelector(element, selector)) ?? null;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((element) => matchesSelector(element, selector));
  }
}

function buildHostDocument(legacy = false) {
  const documentElement = new FakeElement("div");
  const head = new FakeElement("head");
  const body = new FakeElement("body");
  documentElement.append(head, body);

  const sidebar = new FakeElement("div");
  sidebar.className = "sidebar-footer";
  const makeNav = (nav, className = "") => {
    const button = new FakeElement("button");
    button.className = className;
    button.setAttribute("data-nav", nav);
    return button;
  };
  let actions;
  let settings;
  let plugins = null;
  if (legacy) {
    actions = new FakeElement("div");
    actions.className = "footer-actions";
    settings = makeNav("settings");
    plugins = makeNav("plugins");
    actions.append(settings, plugins, makeNav("scheduled"), new FakeElement("button"));
    sidebar.append(actions);
  } else {
    actions = sidebar;
    settings = makeNav("settings", "footer-settings");
    sidebar.append(settings, makeNav("build", "footer-build"));
  }
  body.append(sidebar);

  const doc = {
    head,
    body,
    documentElement,
    createElement: (tagName) => new FakeElement(tagName),
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    addEventListener() {},
    removeEventListener() {},
  };
  return { doc, sidebar, actions, settings, plugins, legacy };
}
test("manifest declares the renderer entry, panel and exact host whitelists", () => {
  assert.equal(manifest.renderer, "renderer/entry.mjs");
  assert.ok(fs.existsSync(path.join(root, manifest.renderer)));
  assert.ok(manifest.permissions.includes("renderer.extension"));
  assert.ok(manifest.permissions.includes("ui.panel"));
  assert.deepEqual(manifest.rendererActions, ["plugin.call", "composer.insertText"]);
  assert.deepEqual(manifest.rendererCallMethods, [
    "openConsole",
    "openSessionOutput",
    "modelPickerState",
    "setModelPickerGrouping",
    "engineWallpaperState",
    "enginePkg",
    "reportEngineStatus",
    "reportEngineStats",
  ]);
  assert.deepEqual(manifest.contributes.launcherTriggers.map(({ id, pattern }) => ({ id, pattern })), [
    { id: "open-console", pattern: "^(?:piopt|PiOpt 控制台)$" },
  ]);
});

test("PI-Desktop 0.23 entry sits after footer settings without joining primary navigation", async () => {
  const { doc, sidebar, settings } = buildHostDocument();
  const previousDocument = global.document;
  global.document = doc;
  const calls = [];
  const host = { dispatch: async (action, payload) => { calls.push({ action, payload }); return { opened: true }; } };
  const entry = await import("../renderer/entry.mjs");
  try {
    await entry.onLoad(host);
    const button = sidebar.querySelector("[data-piopt-entry]");
    assert.ok(button);
    assert.equal(button.previousElementSibling, settings);
    assert.equal(button.className, "footer-settings piopt-entry");
    assert.equal(button.getAttribute("data-nav"), "piopt");
    assert.equal(button.getAttribute("aria-label"), "PiOpt 控制台");
    assert.equal((button.innerHTML.match(/<i><\/i>/g) ?? []).length, 3);
    assert.equal(sidebar.querySelector('[data-nav="plugins"]'), null);
    assert.ok(calls.some((call) => call.payload.method === "modelPickerState"));
    calls.length = 0;
    button.emit("click", { preventDefault() {}, stopPropagation() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, [{ action: "plugin.call", payload: { method: "openConsole", args: {} } }]);
    await entry.onUnload();
    assert.equal(sidebar.querySelector("[data-piopt-entry]"), null);
  } finally {
    await entry.onUnload();
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
});

test("legacy footer actions keep PiOpt next to the plugin button", async () => {
  const { doc, actions, plugins } = buildHostDocument(true);
  const previousDocument = global.document;
  global.document = doc;
  const entry = await import("../renderer/entry.mjs");
  try {
    await entry.onLoad({ dispatch: async () => ({}) });
    const button = actions.querySelector("[data-piopt-entry]");
    assert.ok(button);
    assert.equal(button.previousElementSibling, plugins);
    assert.ok(button.className.includes("footer-action"));
    assert.equal((button.innerHTML.match(/<i><\/i>/g) ?? []).length, 3);
  } finally {
    await entry.onUnload();
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
});

test("the main process answers openConsole without forcing a view", async () => {
  const opened = [];
  const previousPi = global.pi;
  global.pi = { ui: { openPanel: async (options) => opened.push(options) } };
  const main = require("../main.js");
  try {
    assert.deepEqual(await main.onRendererCall("openConsole", {}), { opened: true });
    assert.deepEqual(opened, [{ title: "PiOpt" }]);
    await assert.rejects(() => main.onRendererCall("openSettings", {}), /Unsupported renderer method/);
  } finally {
    if (previousPi === undefined) delete global.pi;
    else global.pi = previousPi;
  }
});

test("the footer entry uses a stable host-sized mark", () => {
  const source = read("renderer/entry.mjs");
  assert.match(source, /\.piopt-mark\{width:13px;height:13px;display:grid;grid-template-columns:repeat\(3,3px\);align-items:end;gap:2px\}/);
  assert.match(source, /\.sidebar-footer > \[\$\{ENTRY_ATTR\}\]\{width:32px;min-width:32px;flex:0 0 32px;padding:0!important;justify-content:center\}/);
});
