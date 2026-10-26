"use strict";

/**
 * The glass layer is a stylesheet, so these tests are about what it may and may
 * not contain. Two of them guard accidents that already happened once in this
 * codebase: a `transform` left on an element re-anchors the host's `position:
 * fixed` popups, and `backdrop-filter` creates the same containing block — so
 * neither may appear on a shell container that owns menus.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const glass = require("../features/glass/glass.js");

// ------------------------------------------------------------------ fake host

function makePi(settings = {}) {
  const store = { ...settings };
  const calls = [];
  return {
    store,
    calls,
    pi: {
      plugin: {
        getId: () => "local.piopt",
        getManifest: () => ({}),
        getSettings: async () => ({ ...store }),
        setSettings: async (patch) => {
          Object.assign(store, patch);
          calls.push({ api: "setSettings", patch });
        },
      },
      commands: {
        register: async (command) => calls.push({ api: "register", id: command.id }),
        unregister: async (id) => calls.push({ api: "unregister", id }),
      },
      ui: { openPanel: async (options) => calls.push({ api: "openPanel", options }) },
      themes: { upsert: async () => {}, remove: async () => {}, list: async () => [] },
      app: { getAppearance: async () => ({ base: "dark", theme: "dark", pluginTheme: null }) },
    },
  };
}

function loadFeature() {
  delete require.cache[require.resolve("../features/glass/index.js")];
  return require("../features/glass/index.js");
}

// -------------------------------------------------------------------- config

test("glass is off by default, so nothing is injected until it is asked for", () => {
  const config = glass.normalizeGlassConfig(undefined);
  assert.deepEqual(config, { enabled: false, preset: "standard", intensity: 1 });
  assert.equal(glass.buildGlassCss(config), "");
  assert.equal(glass.buildGlassCss(undefined), "");
});

test("only a real boolean turns glass on", () => {
  for (const value of ["true", 1, "yes", {}]) {
    assert.equal(glass.normalizeGlassConfig({ enabled: value }).enabled, false, String(value));
  }
  assert.equal(glass.normalizeGlassConfig({ enabled: true }).enabled, true);
});

test("normalizes unknown presets and clamps the strength", () => {
  assert.equal(glass.normalizeGlassConfig({ preset: "nope" }).preset, "standard");
  assert.equal(glass.normalizeGlassConfig({}).preset, "standard");
  const [min, max] = glass.LIMITS.intensity;
  assert.equal(glass.normalizeGlassConfig({ intensity: 0 }).intensity, min);
  assert.equal(glass.normalizeGlassConfig({ intensity: 99 }).intensity, max);
  assert.equal(glass.normalizeGlassConfig({ intensity: "1.25" }).intensity, 1.25);
  assert.equal(glass.normalizeGlassConfig({ intensity: Number.NaN }).intensity, 1);
});

test("the three presets get thicker in one direction", () => {
  const light = glass.glassTokens({ preset: "light" });
  const standard = glass.glassTokens({ preset: "standard" });
  const deep = glass.glassTokens({ preset: "deep" });
  for (const key of ["blur", "blurStrong", "sidebar", "chrome", "overlay", "glow"]) {
    assert.ok(light[key] < standard[key], `light ${key}`);
    assert.ok(standard[key] < deep[key], `standard ${key}`);
  }
  assert.ok(light.saturate <= standard.saturate && standard.saturate <= deep.saturate);
});

test("strength moves the blur and firms the fills up, never the reverse", () => {
  const weak = glass.glassTokens({ preset: "standard", intensity: 0.6 });
  const strong = glass.glassTokens({ preset: "standard", intensity: 1.6 });
  assert.ok(weak.blur < strong.blur);
  assert.ok(weak.glow < strong.glow);
  // A thinner fill at high blur is what makes small text unreadable, so the
  // fill has to grow with the strength instead of shrinking.
  assert.ok(weak.sidebar <= strong.sidebar);
  assert.ok(weak.chrome <= strong.chrome);
  assert.ok(weak.overlay <= strong.overlay);
  for (const tokens of [weak, strong]) {
    assert.ok(tokens.sidebar >= 12 && tokens.sidebar <= 92);
    assert.ok(tokens.chrome >= 12 && tokens.chrome <= 92);
    assert.ok(tokens.overlay >= 12 && tokens.overlay <= 92);
  }
});

// ----------------------------------------------------------------------- css

test("the stylesheet carries its marker and the three material surfaces", () => {
  const css = glass.buildGlassCss({ enabled: true, preset: "standard", intensity: 1 });
  assert.ok(css.startsWith(glass.CSS_MARKER));
  assert.match(css, /--pg-blur:28px/);
  assert.match(css, /--pg-saturate:1\.65/);
  assert.match(css, /--pg-sidebar-alpha:44%/);
  assert.match(css, /\.app-shell::before\{/);
  assert.match(css, /:is\(\.sidebar-surface,\.sidebar-rail\)\{/);
  assert.match(css, /\.main-titlebar\{/);
  assert.match(css, /backdrop-filter:blur\(var\(--pg-blur\)\)/);
  assert.match(css, /@supports not \(\(backdrop-filter/);
});

test("glass never uses a transform", () => {
  // A transform — even one that finishes — becomes the containing block for
  // `position: fixed` descendants, which is what moved the host's context menu
  // the last time a theme layer added one.
  const css = glass.buildGlassCss({ enabled: true, preset: "deep", intensity: 1.6 });
  assert.doesNotMatch(css, /transform/);
});

test("no blur lands on a container that owns the host's popups", () => {
  // `backdrop-filter` has the same containing-block side effect as `transform`.
  // The shell and the main pane hold menus, dialogs and the composer, so they
  // may only be painted through the ::before layer.
  const css = glass.buildGlassCss({ enabled: true, preset: "deep", intensity: 1.6 });
  assert.doesNotMatch(css, /\.app-shell(?!::before)[^{}]*\{[^}]*backdrop-filter/);
  assert.doesNotMatch(css, /\.main-pane[^{}]*\{[^}]*backdrop-filter/);
  assert.doesNotMatch(css, /\.sidebar\b(?!-)[^{}]*\{[^}]*backdrop-filter/);
});

test("the glass layer defines no color tokens of its own", () => {
  const css = glass.buildGlassCss({ enabled: true });
  // It may read --ds-* tokens and add --pg-* ones; redefining a host token would
  // fight the theme it is riding on.
  const declared = [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]);
  for (const name of new Set(declared)) assert.ok(name.startsWith("--pg-"), name);
});

test("the stylesheet stays inside the host's 256 KB theme limit", () => {
  const css = glass.buildGlassCss({ enabled: true, preset: "deep", intensity: 1.6 });
  assert.ok(Buffer.byteLength(css, "utf8") < glass.CSS_LIMIT_BYTES);
  assert.ok(Buffer.byteLength(css, "utf8") < 8 * 1024, "the glass layer must stay small");
});

// -------------------------------------------------------------------- feature

test("the feature registers one command and removes it on unload", async () => {
  const host = makePi();
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    await feature.onLoad();
    assert.equal(host.calls.filter((call) => call.api === "register").length, 1);
    assert.equal(host.calls.find((call) => call.api === "register").id, "piopt.glass");
    await feature.onUnload();
    assert.equal(host.calls.find((call) => call.api === "unregister").id, "piopt.glass");
  } finally {
    delete global.pi;
  }
});

test("apply writes the setting and asks the theme to re-register", async () => {
  const host = makePi();
  global.pi = host.pi;
  const feature = loadFeature();
  let refreshed = 0;
  feature.bindTheme(async () => { refreshed += 1; });
  try {
    const result = await feature.onPanelInvoke("glass.apply", {
      config: { enabled: true, preset: "deep", intensity: 1.4 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.deepEqual(host.store[glass.SETTINGS_KEY], { enabled: true, preset: "deep", intensity: 1.4 });
    assert.equal(refreshed, 1);
    assert.deepEqual(result.config, { enabled: true, preset: "deep", intensity: 1.4 });
  } finally {
    delete global.pi;
  }
});

test("apply still persists when no theme is wired in yet", async () => {
  const host = makePi();
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    const result = await feature.onPanelInvoke("glass.apply", { config: { enabled: true } });
    assert.equal(result.applied, false);
    assert.equal(host.store[glass.SETTINGS_KEY].enabled, true);
  } finally {
    delete global.pi;
  }
});

test("reads the stored setting instead of trusting the panel", async () => {
  const host = makePi({ [glass.SETTINGS_KEY]: { enabled: true, preset: "light", intensity: 0.8 } });
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    const state = await feature.onPanelInvoke("glass.getState", {});
    assert.deepEqual(state.config, { enabled: true, preset: "light", intensity: 0.8 });
    assert.deepEqual(state.presets, ["light", "standard", "deep"]);
  } finally {
    delete global.pi;
  }
});

test("reset returns to the shipped default, which is off", async () => {
  const host = makePi({ [glass.SETTINGS_KEY]: { enabled: true, preset: "deep", intensity: 1.6 } });
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    const result = await feature.onPanelInvoke("glass.reset", {});
    assert.deepEqual(result.config, { enabled: false, preset: "standard", intensity: 1 });
    assert.equal(host.store[glass.SETTINGS_KEY].enabled, false);
  } finally {
    delete global.pi;
  }
});

test("glass.tokens answers without writing anything", async () => {
  const host = makePi();
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    const result = await feature.onPanelInvoke("glass.tokens", { config: { preset: "deep" } });
    assert.equal(result.tokens.blur, 44);
    assert.equal(host.calls.length, 0);
  } finally {
    delete global.pi;
  }
});

test("an unknown channel is refused", async () => {
  const host = makePi();
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    await assert.rejects(() => feature.onPanelInvoke("glass.nope", {}), /Unsupported panel action/);
  } finally {
    delete global.pi;
  }
});

// ----------------------------------------------------------------- integration

test("the motion theme is the only way the glass layer reaches the host", () => {
  const motion = read("features/motion/index.js");
  // Built from the motion stylesheet plus the glass layer, in that order.
  assert.match(motion, /`\$\{motion\.buildThemeCss\(config, base\)\}\$\{await readGlassCss\(\)\}`/);
  assert.match(motion, /glass\.buildGlassCss\(settings && settings\[glass\.SETTINGS_KEY\]\)/);
  // and a failed settings read must not cost the motion layer
  assert.match(motion, /An unreadable setting must not cost the motion layer/);
});

test("the panel mirrors the process model so preview mode is honest", () => {
  const panel = read("renderer/glass.js");
  const feature = read("features/glass/glass.js");
  // Both sides must agree on the presets, or the readings would lie.
  for (const preset of ["light", "standard", "deep"]) {
    assert.ok(panel.includes(`${preset}: { blur:`), preset);
    assert.ok(feature.includes(`${preset}: Object.freeze({ blur:`), preset);
  }
  assert.match(panel, /const DEFAULT_CONFIG = \{ enabled: false, preset: "standard", intensity: 1 \};/);
  assert.match(feature, /enabled: false,\n  preset: "standard",\n  intensity: 1,/);
});

test("the glass view stylesheet targets the classes its own markup uses", () => {
  const html = read("renderer/index.html");
  const start = html.indexOf('id="view-glass"');
  const end = html.indexOf('id="view-gateway"');
  assert.ok(start > 0 && end > start, "the glass view must sit between the market view and the gateway view");
  const markup = html.slice(start, end);
  const css = read("renderer/glass.css");

  const classes = new Set(
    [...markup.matchAll(/class="([^"]+)"/g)]
      .flatMap((match) => match[1].split(/\s+/))
      .filter((name) => name.startsWith("glass-"))
  );
  assert.ok(classes.size >= 10, `expected the glass view to use its own classes, saw ${classes.size}`);

  for (const name of classes) {
    // The rule has to target the element itself. `.glass-metrics dl` looked
    // right but styled a descendant that does not exist — the dl already
    // carries the class — so the readings card silently lost its grid, its
    // border and its row separation.
    assert.match(
      css,
      new RegExp(`\\.${name}\\s*(?:,[^{}]*)?\\{`),
      `renderer/glass.css must style .${name}`
    );
  }
});
