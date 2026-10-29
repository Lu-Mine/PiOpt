"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  CSS_LIMIT_BYTES,
  DEFAULT_CONFIG,
  LIMITS,
  PRESETS,
  buildThemeCss,
  motionTokens,
  normalizeConfig,
  resolveBase,
} = require("../features/appearance/motion.js");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("exposes the four approved presets and 0.4–2.0x speed range", () => {
  assert.deepEqual(Object.keys(PRESETS), ["agile", "balanced", "gentle", "reduced"]);
  assert.deepEqual(LIMITS.speed, [0.4, 2]);
  assert.deepEqual(LIMITS.intensity, [0.5, 1.5]);
});

test("normalizes invalid values and clamps speed to 0.4–2.0x", () => {
  assert.deepEqual(normalizeConfig({ preset: "unknown", mode: "neon", intensity: 9, speed: 0 }), {
    ...DEFAULT_CONFIG,
    intensity: 1.5,
    speed: 0.4,
  });
  assert.equal(normalizeConfig({ speed: 9 }).speed, 2);
  assert.equal(normalizeConfig({ speed: "0.4" }).speed, 0.4);
  assert.equal(normalizeConfig({ speed: "2.0" }).speed, 2);
  assert.equal(normalizeConfig({ intensity: "0.51", speed: "1.85", followReducedMotion: false }).intensity, 0.51);
  assert.equal(normalizeConfig({ intensity: "0.51", speed: "1.85" }).speed, 1.85);
  assert.equal(normalizeConfig({ followReducedMotion: false }).followReducedMotion, false);
});

test("panel slider and renderer model match the 0.4–2.0x speed range", () => {
  const html = read("renderer/index.html");
  assert.match(html, /<input id="speed" type="range" min="40" max="200" step="5" value="100" \/>/);
  const panelJs = read("renderer/appearance.js");
  assert.match(panelJs, /const MOTION_LIMITS = \{ intensity: \[0\.5, 1\.5\], speed: \[0\.4, 2\] \};/);
});

test("speed changes durations across 0.4–2.0x without changing distance or scale", () => {
  const slowest = motionTokens({ preset: "balanced", speed: 0.4, intensity: 1 });
  const base = motionTokens({ preset: "balanced", speed: 1, intensity: 1 });
  const fastest = motionTokens({ preset: "balanced", speed: 2, intensity: 1 });
  assert.ok(slowest.base > base.base && base.base > fastest.base);
  assert.ok(slowest.slow > base.slow && base.slow > fastest.slow);
  assert.equal(slowest.distanceMd, fastest.distanceMd);
  assert.equal(slowest.scaleFrom, fastest.scaleFrom);
});

test("intensity changes distance and scale without changing durations", () => {
  const restrained = motionTokens({ preset: "balanced", speed: 1, intensity: 0.5 });
  const clear = motionTokens({ preset: "balanced", speed: 1, intensity: 1.25 });
  assert.equal(restrained.base, clear.base);
  assert.equal(restrained.slow, clear.slow);
  assert.ok(restrained.distanceMd < clear.distanceMd);
  assert.ok(restrained.scaleFrom > clear.scaleFrom);
});

test("unified motion language bridges host tokens and enforces symmetric round-trips", () => {
  const tokens = motionTokens({ preset: "balanced", speed: 1, intensity: 1 });
  assert.equal(tokens.exitRatio, 1, "reversible round-trips must keep symmetric 1:1 duration");
  assert.equal(tokens.easeOut, tokens.easeSymmetric);

  const css = buildThemeCss(DEFAULT_CONFIG, "dark");
  assert.match(css, /--pm-active:1\b/);
  assert.match(css, /--motion-duration-fast:var\(--pm-fast\)/);
  assert.match(css, /--motion-duration-normal:var\(--pm-base\)/);
  assert.match(css, /--motion-duration-slow:var\(--pm-slow\)/);
  assert.match(css, /--motion-ease-in:var\(--pm-ease-symmetric\)/);
  assert.match(css, /--default-transition-duration:var\(--pm-fast\)/);

  // Native <details>, Grid disclosures, stateful menus & popovers, topbar & panels all use symmetric curves.
  assert.match(css, /details\{interpolate-size:allow-keywords\}/);
  assert.match(css, /details::details-content\{[^}]*block-size var\(--pm-base\) var\(--pm-ease-symmetric\)/);
  assert.match(css, /\.sidebar\.is-entering\{animation:sidebar-in-pm var\(--pm-base\) var\(--pm-ease-symmetric\) backwards\}/);
  assert.match(css, /\.sidebar\.is-exiting,:root\[data-platform=win32\] \.sidebar\.is-exiting\{animation:sidebar-out-pm var\(--pm-base\) var\(--pm-ease-symmetric\) both\}/);
  assert.match(css, /\.work-panel:not\(\.work-panel-pending\):not\(\[data-resizing=true\]\)\{animation:work-panel-in-pm var\(--pm-slow\) var\(--pm-ease-symmetric\) backwards;overflow:hidden\}/);
  assert.match(css, /\.work-panel\.is-exiting\{animation:work-panel-out-pm calc\(var\(--pm-slow\) \* var\(--pm-exit-ratio\)\) var\(--pm-ease-symmetric\) both;overflow:hidden\}/);
});

test("reduced preset removes spatial movement and continuous motion", () => {
  const tokens = motionTokens({ preset: "reduced", intensity: 1.25, speed: 1 });
  assert.equal(tokens.distanceXs, 0);
  assert.equal(tokens.distanceSm, 0);
  assert.equal(tokens.distanceMd, 0);
  assert.equal(tokens.scaleSubtle, 1);
  assert.equal(tokens.scaleFrom, 1);
  assert.equal(tokens.continuous, false);
  const css = buildThemeCss({ preset: "reduced" }, "dark");
  assert.match(css, /\.spinner[^{}]*\{animation:none\}/);
  assert.match(css, /\.streaming-indicator[^{}]*\{animation:none/);
});

test("generates equivalent light and dark motion layers without color overrides", () => {
  const light = buildThemeCss(DEFAULT_CONFIG, "light");
  const dark = buildThemeCss(DEFAULT_CONFIG, "dark");
  assert.match(light, /Pi Modify Motion Lab: light motion layer/);
  assert.match(dark, /Pi Modify Motion Lab: dark motion layer/);
  assert.equal(light.replace("light motion layer", "dark motion layer"), dark);
  assert.doesNotMatch(light, /--ds-(?:bg|text|accent|border)/);
});

test("generated CSS respects followReducedMotion setting", () => {
  const css = buildThemeCss(DEFAULT_CONFIG, "dark");
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /--pm-distance-md:0px/);
  assert.match(css, /--pm-scale-from:1/);
  assert.match(css, /animation:none/);
  assert.match(css, /animation-duration:80ms/);

  const unfollowed = buildThemeCss({ ...DEFAULT_CONFIG, followReducedMotion: false }, "dark");
  assert.doesNotMatch(unfollowed, /@media\(prefers-reduced-motion:reduce\)/);
});

test("generated CSS stays within host safety and performance boundaries", () => {
  const css = buildThemeCss({ preset: "gentle", intensity: 1.25, speed: 0.4 }, "dark");
  assert.ok(Buffer.byteLength(css, "utf8") < CSS_LIMIT_BYTES);
  assert.doesNotMatch(css, /transition\s*:\s*all/i);
  assert.doesNotMatch(css, /@import|javascript\s*:|expression\s*\(/i);
  assert.doesNotMatch(css, /url\s*\(/i);
  assert.doesNotMatch(css, /animation[^;{}]*filter|@keyframes[^{}]*filter/i);
  assert.doesNotMatch(css, /will-change/i);
});

test("entrances hand the element back instead of pinning a transform", () => {
  const css = buildThemeCss(DEFAULT_CONFIG, "dark");
  const entrances = css
    .split("\n")
    .filter((line) => /animation:pm-/.test(line) && !/infinite/.test(line));
  assert.ok(entrances.length > 0, "expected entrance rules");
  for (const line of entrances) assert.match(line, / backwards\b/, line);

  // Floating menus fade only: a transform on their ancestor re-anchors fixed children.
  assert.match(css, /:is\(\[role=menu\][^{]*\)\{animation:pm-fade-in /);
  assert.doesNotMatch(css, /\[role=menu\][^}]*transform/);
  // A menu item must not shift under the pointer of the submenu it opens.
  assert.match(css, /:not\(\[role=menuitem\]\)\{transform:translateY\(1px\)\}/);
});

test("no ancestor of a frosted surface animates opacity", () => {
  const css = buildThemeCss(DEFAULT_CONFIG, "dark").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /\.app-shell[^{}]*\{[^}]*animation\b/);
  assert.doesNotMatch(css, /\.main-pane[^{}]*\{[^}]*animation\b/);
  assert.match(css, /:is\(\.chat-surface,\.route-page,\.settings-content\)\{animation:pm-content-in /);

  for (const name of [
    "pm-panel-right-in",
    "pm-panel-left-in",
    "work-panel-in-pm",
    "work-panel-out-pm",
    "sidebar-in-pm",
    "sidebar-out-pm",
  ]) {
    const block = css.match(new RegExp(`@keyframes ${name}\\{(?:[^{}]*\\{[^{}]*\\})+\\}`));
    assert.ok(block, `missing @keyframes ${name}`);
    assert.doesNotMatch(block[0], /opacity/, `${name} must not animate opacity`);
  }
  assert.doesNotMatch(css, /\.work-panel[^{}]*\{[^}]*pm-fade-in/);
});

test("motion switches never re-enable the host's opacity-filled panel animation and disable runtime flag", () => {
  for (const config of [
    { ...DEFAULT_CONFIG, override: false },
    { ...DEFAULT_CONFIG, disabled: true },
  ]) {
    const css = buildThemeCss(config, "dark");
    assert.match(css, /--pm-active:0\b/);
    assert.match(css, /\.work-panel\{animation:none!important\}/);
    assert.match(css, /\.work-panel\.is-exiting\{animation:work-panel-out-glass /);
    assert.doesNotMatch(css, /@keyframes work-panel-in\b/);
  }
});

test("resolves automatic base from host appearance", () => {
  assert.equal(resolveBase("light", { base: "dark" }), "light");
  assert.equal(resolveBase("auto", { base: "light" }), "light");
  assert.equal(resolveBase("auto", { theme: "dark" }), "dark");
  assert.equal(resolveBase("auto", {}), "dark");
});

// -------------------------------------------- reversible motion runtime tests

function makeRuntimeDom(vars = {}) {
  const tokenMap = {
    "--pm-active": "1",
    "--pm-fast": "140ms",
    "--pm-base": "200ms",
    "--pm-slow": "260ms",
    "--pm-distance-xs": "2px",
    "--pm-distance-sm": "4px",
    "--pm-distance-md": "7px",
    "--pm-distance-panel": "10px",
    "--pm-distance-sheet": "16px",
    "--pm-scale-subtle": "0.988",
    "--pm-scale-from": "0.982",
    "--pm-ease-symmetric": "cubic-bezier(.22,1,.36,1)",
    ...vars,
  };

  function singleSelectorMatches(el, sel) {
    const s = sel.trim();
    if (!s) return false;
    if (s.includes(">")) {
      const [parentSel, childSel] = s.split(">").map((part) => part.trim());
      return Boolean(el.parentElement) && singleSelectorMatches(el.parentElement, parentSel) && singleSelectorMatches(el, childSel);
    }
    const attrMatches = [...s.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
    for (const m of attrMatches) {
      const v = el.getAttribute(m[1]);
      if (m[2] === undefined ? v === null : v !== m[2]) return false;
    }
    const classMatches = [...s.replace(/\[[^\]]*\]/g, "").matchAll(/\.([a-zA-Z0-9_-]+)/g)];
    for (const m of classMatches) {
      if (!el.classList.contains(m[1])) return false;
    }
    const tagPart = s.replace(/\[[^\]]*\]/g, "").replace(/\.[a-zA-Z0-9_-]+/g, "").trim();
    if (tagPart && tagPart !== "*" && el.tagName !== tagPart.toUpperCase()) return false;
    return attrMatches.length > 0 || classMatches.length > 0 || Boolean(tagPart);
  }

  class MockNode {
    constructor(tagName = "div") {
      this.nodeType = 1;
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.parentNode = null;
      this.attributes = new Map();
      this.listeners = new Map();
      this.animations = [];
      this._rect = { top: 20, left: 40, width: 280, height: 160 };
      this.offsetHeight = 160;
      this.inert = false;
      const props = new Map();
      this.style = {
        position: "",
        top: "",
        left: "",
        width: "",
        overflow: "",
        opacity: "",
        visibility: "",
        boxSizing: "",
        animationDuration: "",
        setProperty: (k, v) => props.set(k, String(v)),
        getPropertyValue: (k) => props.get(k) || "",
        removeProperty: (k) => props.delete(k),
      };
      const self = this;
      this.classList = {
        _set: new Set(),
        add(...names) { for (const n of names) if (n) this._set.add(n); },
        remove(...names) { for (const n of names) this._set.delete(n); },
        contains(n) { return this._set.has(n); },
        toString() { return [...this._set].join(" "); },
      };
      Object.defineProperty(this, "className", {
        get() { return self.classList.toString(); },
        set(v) {
          self.classList._set = new Set(String(v || "").split(/\s+/).filter(Boolean));
        },
      });
    }

    get isConnected() {
      let cur = this;
      while (cur.parentElement) cur = cur.parentElement;
      return cur === documentElement;
    }

    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    hasAttribute(k) { return this.attributes.has(k); }
    removeAttribute(k) { this.attributes.delete(k); }

    addEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      this.listeners.set(type, list.filter((item) => item !== fn));
    }
    dispatchEvent(event) {
      for (const fn of this.listeners.get(event.type) || []) fn(event);
    }

    appendChild(child) {
      child.remove();
      child.parentElement = this;
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    prepend(child) {
      child.remove();
      child.parentElement = this;
      child.parentNode = this;
      this.children.unshift(child);
      return child;
    }
    insertBefore(child, ref) {
      child.remove();
      child.parentElement = this;
      child.parentNode = this;
      const idx = this.children.indexOf(ref);
      if (idx >= 0) this.children.splice(idx, 0, child);
      else this.children.push(child);
      return child;
    }
    remove() {
      if (!this.parentElement) return;
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
      this.parentNode = null;
    }

    cloneNode(deep = false) {
      const copy = new MockNode(this.tagName);
      copy.className = this.className;
      for (const [k, v] of this.attributes) copy.setAttribute(k, v);
      copy._rect = { ...this._rect };
      if (deep) {
        for (const c of this.children) copy.appendChild(c.cloneNode(true));
      }
      return copy;
    }

    getBoundingClientRect() {
      return { ...this._rect };
    }

    matches(selectorList) {
      return String(selectorList)
        .split(",")
        .some((sel) => singleSelectorMatches(this, sel));
    }

    closest(selectorList) {
      let cur = this;
      while (cur) {
        if (cur.matches(selectorList)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }

    descendants() {
      const out = [];
      for (const c of this.children) out.push(c, ...c.descendants());
      return out;
    }

    querySelector(selectorList) {
      return this.descendants().find((el) => el.matches(selectorList)) || null;
    }

    querySelectorAll(selectorList) {
      return this.descendants().filter((el) => el.matches(selectorList));
    }

    animate(keyframes, options) {
      const anim = {
        keyframes,
        options,
        cancelled: false,
        onfinish: null,
        oncancel: null,
        finish() { if (this.onfinish) this.onfinish(); },
        cancel() {
          this.cancelled = true;
          if (this.oncancel) this.oncancel();
        },
      };
      this.animations.push(anim);
      return anim;
    }
  }

  const documentElement = new MockNode("html");
  const body = new MockNode("body");
  documentElement.appendChild(body);
  const doc = {
    documentElement,
    body,
    createElement: (tag) => new MockNode(tag),
    querySelector: (s) => documentElement.querySelector(s),
    querySelectorAll: (s) => documentElement.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };
  const getComputedStyle = () => ({
    getPropertyValue: (name) => tokenMap[name] ?? "",
  });

  return { doc, body, MockNode, getComputedStyle, tokenMap };
}

test("motion-runtime animates reversible inline expand/collapse symmetrically and interrupts mid-flight", async () => {
  const runtime = await import("../renderer/motion-runtime.mjs");
  assert.equal(runtime.sampleCubicBezier([0.22, 1, 0.36, 1], 0), 0);
  assert.equal(runtime.sampleCubicBezier([0.22, 1, 0.36, 1], 1), 1);
  const mid = runtime.sampleCubicBezier([0.22, 1, 0.36, 1], 0.5);
  assert.ok(mid > 0.7 && mid < 1, `expected fast-out curve > 0.7 at t=0.5, got ${mid}`);

  const env = makeRuntimeDom();
  const prevDoc = global.document;
  const prevStyle = global.getComputedStyle;
  const prevPerf = global.performance;
  let fakeNow = 1000;
  global.document = env.doc;
  global.getComputedStyle = env.getComputedStyle;
  global.performance = { now: () => fakeNow };

  try {
    const toolRow = new env.MockNode("div");
    toolRow.className = "tool-row thinking open";
    env.body.appendChild(toolRow);

    // 1. Expand: append .tool-row-body into an already-mounted .tool-row
    const body1 = new env.MockNode("div");
    body1.className = "tool-row-body";
    body1._rect = { top: 40, left: 20, width: 500, height: 200 };
    toolRow.appendChild(body1);

    runtime.__internals.processMutations([
      { type: "childList", target: toolRow, addedNodes: [body1], removedNodes: [], nextSibling: null },
    ]);
    assert.equal(body1.animations.length, 1);
    assert.equal(body1.animations[0].keyframes[0].height, "0px");
    assert.equal(body1.animations[0].keyframes[1].height, "200px");
    assert.equal(body1.animations[0].options.duration, 200);

    // 2. Interrupt mid-expand at t = +60ms (30% of 200ms) -> collapse reverses from partial height!
    fakeNow = 1060;
    runtime.__internals.captureSnapshot();
    body1.remove();
    runtime.__internals.processMutations([
      { type: "childList", target: toolRow, addedNodes: [], removedNodes: [body1], nextSibling: null },
    ]);

    const ghosts = toolRow.querySelectorAll("[data-pm-ghost]");
    assert.equal(ghosts.length, 1, "expected a sanitized collapse ghost");
    const ghost = ghosts[0];
    assert.equal(ghost.inert, true);
    assert.equal(ghost.getAttribute("aria-hidden"), "true");
    const startH = Number.parseFloat(ghost.animations[0].keyframes[0].height);
    assert.ok(startH > 40 && startH < 195, `collapse should start from mid-flight height, got ${startH}`);
    assert.equal(ghost.animations[0].keyframes[1].height, "0px");
    assert.ok(ghost.animations[0].options.duration < 200, "interrupted collapse scales duration proportionally");

    // 3. Interrupt mid-collapse at t = +40ms -> re-opening resumes from remaining ghost height and cleans ghost!
    fakeNow += 40;
    const body2 = new env.MockNode("div");
    body2.className = "tool-row-body";
    body2._rect = { top: 40, left: 20, width: 500, height: 200 };
    toolRow.appendChild(body2);

    runtime.__internals.processMutations([
      { type: "childList", target: toolRow, addedNodes: [body2], removedNodes: [], nextSibling: null },
    ]);

    assert.equal(toolRow.querySelectorAll("[data-pm-ghost]").length, 0, "ghost must be removed immediately on reversal");
    const resumeH = Number.parseFloat(body2.animations[0].keyframes[0].height);
    assert.ok(resumeH > 5 && resumeH < startH, `re-expand must resume from current ghost height, got ${resumeH}`);
    assert.equal(body2.animations[0].keyframes[1].height, "200px");
  } finally {
    runtime.unmountMotionRuntime();
    global.document = prevDoc;
    global.getComputedStyle = prevStyle;
    global.performance = prevPerf;
  }
});

test("motion-runtime animates portal pop/dismiss symmetrically, interrupts mid-dismissal, and reverses work-panel mid-flight", async () => {
  const runtime = await import("../renderer/motion-runtime.mjs");
  const env = makeRuntimeDom();
  const prevDoc = global.document;
  const prevStyle = global.getComputedStyle;
  const prevPerf = global.performance;
  let fakeNow = 2000;
  global.document = env.doc;
  global.getComputedStyle = env.getComputedStyle;
  global.performance = { now: () => fakeNow };

  try {
    // A. Popover open -> dismiss -> mid-dismissal re-open
    const pop = new env.MockNode("div");
    pop.className = "scope-popover is-open";
    pop.setAttribute("id", "scope-1");
    pop.setAttribute("role", "dialog");
    pop._rect = { top: 100, left: 200, width: 304, height: 240 };
    env.body.appendChild(pop);

    runtime.__internals.processMutations([
      { type: "childList", target: env.body, addedNodes: [pop], removedNodes: [], nextSibling: null },
    ]);

    fakeNow = 2200; // fully open
    runtime.__internals.captureSnapshot();
    pop.remove();
    runtime.__internals.processMutations([
      { type: "childList", target: env.body, addedNodes: [], removedNodes: [pop], nextSibling: null },
    ]);

    const layer = env.body.querySelector("[data-piopt-motion-layer]");
    assert.ok(layer, "motion layer created for outgoing overlay");
    assert.equal(layer.children.length, 1);
    const popGhost = layer.children[0];
    assert.equal(popGhost.getAttribute("id"), null, "sanitized clone strips duplicate ids");
    assert.equal(popGhost.getAttribute("role"), null, "sanitized clone strips ARIA role so queries stay clean");
    assert.equal(popGhost.animations.length, 1);
    assert.equal(popGhost.animations[0].options.duration, 140);

    // Re-open 35ms into the 140ms dismissal -> reverses smoothly from mid-flight!
    fakeNow = 2235;
    const pop2 = new env.MockNode("div");
    pop2.className = "scope-popover is-open";
    pop2._rect = { top: 100, left: 200, width: 304, height: 240 };
    env.body.appendChild(pop2);
    runtime.__internals.processMutations([
      { type: "childList", target: env.body, addedNodes: [pop2], removedNodes: [], nextSibling: null },
    ]);
    assert.equal(layer.children.length, 0, "dismissal ghost destroyed immediately on re-open");
    assert.equal(pop2.animations.length, 1, "re-opened popover resumes smoothly from interrupted progress");
    assert.ok(pop2.animations[0].keyframes[0].opacity > 0.05 && pop2.animations[0].keyframes[0].opacity < 0.95);

    // B. WorkPanel mid-entry interruption sets exact instantaneous `--pm-wp-from` width
    const panel = new env.MockNode("aside");
    panel.className = "work-panel";
    panel.style.setProperty("--work-panel-width", "400px");
    panel._rect = { top: 0, left: 800, width: 400, height: 700 };
    env.body.appendChild(panel);

    runtime.__internals.processMutations([
      { type: "childList", target: env.body, addedNodes: [panel], removedNodes: [], nextSibling: null },
    ]);
    assert.equal(panel.style.getPropertyValue("--pm-wp-from"), "");

    // User clicks close 65ms into the 260ms open animation
    fakeNow += 65;
    panel.classList.add("is-exiting");
    runtime.__internals.processMutations([
      { type: "attributes", attributeName: "class", target: panel, addedNodes: [], removedNodes: [] },
    ]);
    const midWidth = Number.parseFloat(panel.style.getPropertyValue("--pm-wp-from"));
    assert.ok(midWidth > 80 && midWidth < 390, `expected mid-flight width on reversal, got ${midWidth}`);
    assert.ok(Number.parseFloat(panel.style.animationDuration) < 260);

    panel.dispatchEvent({ type: "animationend", target: panel });
    assert.equal(panel.style.getPropertyValue("--pm-wp-from"), "", "inline custom properties cleaned on animationend");

    // C. Turning motion optimization off (`--pm-active: 0`) makes the runtime completely inert
    env.tokenMap["--pm-active"] = "0";
    const pop3 = new env.MockNode("div");
    pop3.className = "scope-popover is-open";
    pop3._rect = { top: 100, left: 200, width: 304, height: 240 };
    env.body.appendChild(pop3);
    runtime.__internals.captureSnapshot();
    pop3.remove();
    runtime.__internals.processMutations([
      { type: "childList", target: env.body, addedNodes: [], removedNodes: [pop3], nextSibling: null },
    ]);
    assert.equal(layer.children.length, 0, "no ghost created when motion override is inactive");
  } finally {
    runtime.unmountMotionRuntime();
    global.document = prevDoc;
    global.getComputedStyle = prevStyle;
    global.performance = prevPerf;
  }
});

test("motion-runtime animates file-tree folder sibling groups symmetrically and interrupts mid-collapse", async () => {
  const runtime = await import("../renderer/motion-runtime.mjs");
  const env = makeRuntimeDom();
  const prevDoc = global.document;
  const prevStyle = global.getComputedStyle;
  const prevPerf = global.performance;
  let fakeNow = 3000;
  global.document = env.doc;
  global.getComputedStyle = env.getComputedStyle;
  global.performance = { now: () => fakeNow };

  try {
    const dirBox = new env.MockNode("div");
    const btn = new env.MockNode("button");
    btn.className = "file-tree-row";
    dirBox.appendChild(btn);
    env.body.appendChild(dirBox);

    const childA = new env.MockNode("div");
    childA._rect = { top: 0, left: 0, width: 200, height: 28 };
    const childB = new env.MockNode("div");
    childB._rect = { top: 28, left: 0, width: 200, height: 28 };
    dirBox.appendChild(childA);
    dirBox.appendChild(childB);

    runtime.__internals.processMutations([
      { type: "childList", target: dirBox, addedNodes: [childA, childB], removedNodes: [], nextSibling: null },
    ]);
    assert.equal(childA.animations.length, 1);
    assert.equal(childB.animations.length, 1);
    assert.equal(childA.animations[0].keyframes[0].height, "0px");
    assert.equal(childA.animations[0].keyframes[1].height, "28px");

    // Collapse after fully expanded -> wraps removed siblings in one collapse ghost
    fakeNow = 3300;
    runtime.__internals.captureSnapshot();
    childA.remove();
    childB.remove();
    runtime.__internals.processMutations([
      { type: "childList", target: dirBox, addedNodes: [], removedNodes: [childA, childB], nextSibling: null },
    ]);
    const ghosts = dirBox.querySelectorAll("[data-pm-ghost]");
    assert.equal(ghosts.length, 3, "wrapper ghost + 2 cloned rows");
    const wrapper = dirBox.children[1];
    assert.equal(wrapper.animations[0].keyframes[0].height, "56px");
    assert.equal(wrapper.animations[0].keyframes[1].height, "0px");

    // Re-expand 50ms into the 200ms collapse -> wrapper ghost removed immediately and rows resume mid-height!
    fakeNow = 3350;
    const childC = new env.MockNode("div");
    childC._rect = { top: 0, left: 0, width: 200, height: 28 };
    const childD = new env.MockNode("div");
    childD._rect = { top: 28, left: 0, width: 200, height: 28 };
    dirBox.appendChild(childC);
    dirBox.appendChild(childD);
    runtime.__internals.processMutations([
      { type: "childList", target: dirBox, addedNodes: [childC, childD], removedNodes: [], nextSibling: null },
    ]);
    assert.equal(dirBox.querySelectorAll("[data-pm-ghost]").length, 0);
    const resumed = Number.parseFloat(childC.animations[0].keyframes[0].height);
    assert.ok(resumed > 1 && resumed < 28, `expected mid-flight resumed row height, got ${resumed}`);
  } finally {
    runtime.unmountMotionRuntime();
    global.document = prevDoc;
    global.getComputedStyle = prevStyle;
    global.performance = prevPerf;
  }
});
