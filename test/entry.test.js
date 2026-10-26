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

function buildHostDocument() {
  const documentElement = new FakeElement("div");
  const head = new FakeElement("head");
  const body = new FakeElement("body");
  documentElement.append(head, body);

  const sidebar = new FakeElement("div");
  sidebar.className = "sidebar-footer";
  const actions = new FakeElement("div");
  actions.className = "footer-actions";
  sidebar.append(actions);
  body.append(sidebar);

  const makeNav = (nav) => {
    const button = new FakeElement("button");
    button.setAttribute("data-nav", nav);
    return button;
  };
  const settings = makeNav("settings");
  const plugins = makeNav("plugins");
  const scheduled = makeNav("scheduled");
  const account = new FakeElement("button");
  actions.append(settings, plugins, scheduled, account);

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
  return { doc, actions, plugins };
}

function navsOf(actions) {
  return actions.children.map((child) => child.getAttribute("data-nav"));
}

// ---------------------------------------------------------------------- tests

test("manifest declares the renderer entry and keeps the whitelists exact", () => {
  assert.equal(manifest.renderer, "renderer/entry.mjs");
  assert.ok(fs.existsSync(path.join(root, manifest.renderer)));
  assert.ok(manifest.permissions.includes("renderer.extension"));
  assert.deepEqual(manifest.rendererActions, ["plugin.call"]);
  assert.deepEqual(manifest.rendererCallMethods, ["openConsole"]);
});

test("the entry mounts right after the host's plugin button and leaves on unload", async () => {
  const { doc, actions, plugins } = buildHostDocument();
  const previousDocument = global.document;
  global.document = doc;

  const calls = [];
  const host = {
    dispatch: async (action, payload) => {
      calls.push({ action, payload });
      return { opened: true };
    },
  };

  const entry = await import("../renderer/entry.mjs");
  try {
    assert.deepEqual(entry.__internals.ANCHOR_SELECTOR, '[data-nav="plugins"]');

    await entry.onLoad(host);

    // Second button in, ahead of the two that were behind it.
    assert.deepEqual(navsOf(actions), ["settings", "plugins", "piopt", "scheduled", null]);
    const button = actions.querySelector("[data-piopt-entry]");
    assert.equal(button.previousElementSibling, plugins);
    assert.ok(button.className.includes("footer-action"));
    assert.equal(button.getAttribute("aria-label"), "PiOpt 控制台");
    // PiOpt's own mark: three bars, same as the panel's product bar.
    assert.equal((button.innerHTML.match(/<i><\/i>/g) ?? []).length, 3);
    assert.equal(button.innerHTML.includes("<svg"), false);
    // One style element, mounted next to the host's own styles.
    assert.equal(doc.head.querySelectorAll("[data-piopt-entry-style]").length, 1);

    const event = { preventDefault() {}, stopPropagation() {} };
    button.emit("click", event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, [{ action: "plugin.call", payload: { method: "openConsole", args: {} } }]);

    // A re-render that drops the button puts it back where it belongs.
    button.remove();
    await entry.onLoad(host);
    assert.deepEqual(navsOf(actions), ["settings", "plugins", "piopt", "scheduled", null]);

    await entry.onUnload();
    assert.deepEqual(navsOf(actions), ["settings", "plugins", "scheduled", null]);
    assert.equal(doc.head.querySelectorAll("[data-piopt-entry-style]").length, 0);
  } finally {
    await entry.onUnload();
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
});

test("the main process answers openConsole without forcing a view", async () => {
  const opened = [];
  const previousPi = global.pi;
  global.pi = {
    ui: { openPanel: async (options) => opened.push(options) },
  };
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

test("the entry mark is exactly as wide as its three bars", () => {
  // 3 bars of 3px with 2px gaps need 13px. A narrower box overflows itself and
  // the whole mark lands half the difference off centre in the host's button.
  const source = read("renderer/entry.mjs");
  const match = /\.piopt-mark\{width:(\d+)px;height:\d+px;display:grid;grid-template-columns:repeat\((\d+),(\d+)px\);align-items:end;gap:(\d+)px\}/.exec(
    source
  );
  assert.ok(match, "the mark rule must stay a single declaration");
  const width = Number(match[1]);
  const columns = Number(match[2]);
  const bar = Number(match[3]);
  const gap = Number(match[4]);
  assert.equal(width, columns * bar + (columns - 1) * gap, "box must fit its own grid");

  const base = read("renderer/base.css");
  assert.match(base, /\.opt-mark \{[^}]*width: 13px;/, "the panel mark keeps the same geometry");
});
