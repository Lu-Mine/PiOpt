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
const os = require("node:os");

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
  assert.deepEqual(config, { enabled: false, preset: "standard", intensity: 1, wallpaper: "", fit: "fill" });
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
  assert.match(css, /--pg-sidebar-alpha:82%/);
  assert.match(css, /\.app-shell::before\{/);
  assert.match(css, /:is\(\.sidebar-surface,\.sidebar-rail\)\{/);
  // The window title bar, conversation top bar, window controls and work panel
  // header share one selector rule, so they cannot drift apart.
  assert.match(
    css,
    /\.main-titlebar,:is\(\.conversation-topbar,\[data-slot=topbar\]\),\.window-controls,\.work-panel-header\{background-color:color-mix\(in oklab,var\(--ds-bg-primary\) var\(--pg-chrome-alpha\)/
  );
  assert.doesNotMatch(css, /\.work-panel-header\{background-color:transparent!important/);
  // The right work panel body is a surface too, on the sidebar's density.
  assert.match(css, /\.work-panel\{background-color:color-mix\(in oklab,var\(--ds-bg-dock\)/);
  assert.match(css, /backdrop-filter:blur\(var\(--pg-blur\)\)/);
  assert.match(css, /@supports not \(\(backdrop-filter/);
});

test("glass never uses a transform", () => {
  // A transform — even one that finishes — becomes the containing block for
  // `position: fixed` descendants, which is what moved the host's context menu
  // the last time a theme layer added one.
  //
  // Only property declarations are checked: the word is allowed in comments,
  // which is where most of this file's warnings about it live. Strip the
  // comments first so prose cannot fail a rule about behaviour.
  const css = glass.buildGlassCss({ enabled: true, preset: "deep", intensity: 1.6 });
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(declarations, /(^|[;{])\s*(?:-webkit-)?transform\s*:/);
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
    assert.deepEqual(host.store[glass.SETTINGS_KEY], { enabled: true, preset: "deep", intensity: 1.4, wallpaper: "", fit: "fill" });
    assert.equal(refreshed, 1);
    assert.deepEqual(result.config, { enabled: true, preset: "deep", intensity: 1.4, wallpaper: "", fit: "fill" });
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
    assert.deepEqual(state.config, { enabled: true, preset: "light", intensity: 0.8, wallpaper: "", fit: "fill" });
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
    assert.deepEqual(result.config, { enabled: false, preset: "standard", intensity: 1, wallpaper: "", fit: "fill" });
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
  assert.match(motion, /glass\.buildGlassCss\(config, \{ size \}\)/);
  assert.match(motion, /readImageSize\(config\.wallpaper\)/);
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
  assert.match(panel, /const DEFAULT_CONFIG = \{ enabled: false, preset: "standard", intensity: 1, wallpaper: "", fit: "fill" \};/);
  assert.match(feature, /enabled: false,\n  preset: "standard",\n  intensity: 1,\n  wallpaper: "",\n  fit: "fill",/);
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

// ----------------------------------------------------------------- wallpaper

/** A real file, because the feature stats it: a fake path would only test the
 *  string parser twice. */
function tempWallpaper(name = "wall.png") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piopt-glass-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  process.on("exit", () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the temp folder is disposable either way */
    }
  });
  return file;
}

test("a wallpaper must be an absolute path with an allowed extension", () => {
  assert.equal(glass.isSupportedWallpaper("C:/x/y.png"), true);
  assert.equal(glass.isSupportedWallpaper("/home/a/b.webp"), true);
  assert.equal(glass.isSupportedWallpaper("/home/a/b.SVG"), true);
  assert.equal(glass.isSupportedWallpaper("relative.png"), false);
  assert.equal(glass.isSupportedWallpaper("C:/x/y.gif"), false);
  assert.equal(glass.isSupportedWallpaper("C:/x/y"), false);
  assert.equal(glass.isSupportedWallpaper("C:/x/../y.png"), false);
  assert.equal(glass.isSupportedWallpaper(""), false);
  assert.equal(glass.isSupportedWallpaper(null), false);
});

test("the css reference uses forward slashes, because a backslash escapes", () => {
  const bs = String.fromCharCode(92);
  assert.equal(glass.wallpaperCssUrl(`C:${bs}Pictures${bs}a b.png`), "C:/Pictures/a b.png");
  assert.equal(glass.wallpaperCssUrl("C:/x/y.png"), "C:/x/y.png");
  assert.equal(glass.wallpaperCssUrl("nope.png"), "");
});

test("a wallpaper replaces the light field and thins the content pane", () => {
  const plain = glass.buildGlassCss({ enabled: true });
  const photo = glass.buildGlassCss({ enabled: true, wallpaper: "/pictures/shot.png" });

  assert.ok(plain.includes("radial-gradient("), "no wallpaper keeps the light field");
  assert.equal(photo.includes("radial-gradient("), false, "a photo carries its own detail");
  // The photo rides under a scrim layer, so every reveal of it is equally dim.
  assert.ok(photo.includes('url("/pictures/shot.png")'));
  assert.ok(photo.includes("background-image:linear-gradient(rgba(0,0,0,var(--pg-scrim)),rgba(0,0,0,var(--pg-scrim))),url("));
  assert.match(photo, /--pg-scrim:0\.2\b/);
  assert.equal(plain.includes("background-image:url("), false, "the light field needs no scrim");
  assert.match(plain, /--pg-canvas-alpha:100%/);
  assert.match(photo, /--pg-canvas-alpha:74%/);
  assert.ok(plain.includes(".main-pane{background-color:color-mix(in oklab,var(--ds-bg-primary) var(--pg-canvas-alpha),transparent)!important}"));
});

test("every surface gets more solid as the weight climbs", () => {
  // 轻薄 → 厚重 must read as "more solid and darker" on all four surfaces —
  // the main pane included. It used to fall the other way, which made the
  // content area look lighter as the sidebar got heavier.
  const canvas = ["light", "standard", "deep"].map(
    (preset) => glass.glassTokens({ enabled: true, preset, wallpaper: "/a.png" }).canvas
  );
  const sidebar = ["light", "standard", "deep"].map(
    (preset) => glass.glassTokens({ enabled: true, preset, wallpaper: "/a.png" }).sidebar
  );
  const increasing = (values) => values.every((value, i) => i === 0 || value > values[i - 1]);
  assert.ok(increasing(canvas), `canvas should rise with weight, got ${canvas.join(" < ")}`);
  assert.ok(increasing(sidebar), `sidebar should rise with weight, got ${sidebar.join(" < ")}`);
});

test("the sidebar stays denser than the pane so it reads darker", () => {
  // The sidebar's own token is the darkest surface in the host (dark:
  // --ds-bg-under #000 vs --ds-bg-primary #181818). It only stays darker than
  // the pane while it mostly hides the photo behind it: at a low alpha a light
  // image washed the sidebar out to twice the pane's luminance.
  for (const preset of ["light", "standard", "deep"]) {
    const tokens = glass.glassTokens({ enabled: true, preset, wallpaper: "/a.png" });
    assert.ok(
      tokens.sidebar > tokens.canvas,
      `${preset}: sidebar ${tokens.sidebar}% must exceed canvas ${tokens.canvas}%`
    );
  }
  const css = glass.buildGlassCss({ enabled: true, wallpaper: "/a.png" });
  // The pane's own token would let a photo lift the rail above the pane.
  assert.ok(css.includes("var(--ds-bg-under) var(--pg-sidebar-alpha)"));
});

test("every fill mode maps to its own sizing declaration", () => {
  const css = (fit, size) => glass.buildGlassCss({ enabled: true, wallpaper: "/a.png", fit }, { size });

  const fill = css("fill");
  assert.ok(fill.includes("background-size:100% 100%"));
  assert.equal(fill.includes("background-position:center"), false);

  for (const mode of ["contain", "cover"]) {
    const layer = css(mode);
    assert.ok(layer.includes(`background-size:${mode}`), mode);
    assert.ok(layer.includes("background-position:center"), mode);
    assert.ok(layer.includes("background-repeat:no-repeat"), mode);
  }

  const none = css("none");
  assert.ok(none.includes("background-size:auto"));
  assert.ok(none.includes("background-position:center"));

  // An unknown value falls back to fill instead of dropping the layer.
  assert.ok(css("stretch").includes("background-size:100% 100%"));
});

test("scale-down never enlarges, which needs the image's natural size", () => {
  const sized = (size) => glass.buildGlassCss({ enabled: true, wallpaper: "/a.png", fit: "scale-down" }, { size });

  // With a known size the layer is clamped to the photo's own box and centred
  // without a transform, so a small image stays small.
  const small = sized({ width: 400, height: 300 });
  assert.ok(small.includes("width:min(100%,400px)"));
  assert.ok(small.includes("height:min(100%,300px)"));
  assert.ok(small.includes("margin:auto"));
  assert.ok(small.includes("background-size:contain"));
  assert.equal(/(^|[;{])\s*(?:-webkit-)?transform\s*:/.test(small.replace(/\/\*[\s\S]*?\*\//g, "")), false);

  // Without one it degrades to contain: it may enlarge, but it never breaks.
  const unknown = sized(null);
  assert.ok(unknown.includes("background-size:contain"));
  assert.equal(unknown.includes("min(100%,"), false);
  // AVIF is the format we cannot measure, so this is the path it takes.
  assert.ok(sized(undefined).includes("background-size:contain"));
});

test("the image header reader finds the natural size of the formats the host allows", () => {
  const { readImageSize } = require("../features/glass/image-size.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piopt-size-"));
  try {
    // Minimal PNG header: signature + IHDR with a 3×2 image.
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(3, 16);
    png.writeUInt32BE(2, 20);
    const pngPath = path.join(dir, "a.png");
    fs.writeFileSync(pngPath, png);
    assert.deepEqual(readImageSize(pngPath), { width: 3, height: 2 });

    // SOF0 carries height then width, both big endian.
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20,
      0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    const jpegPath = path.join(dir, "a.jpg");
    fs.writeFileSync(jpegPath, jpeg);
    assert.deepEqual(readImageSize(jpegPath), { width: 32, height: 16 });

    const svgPath = path.join(dir, "a.svg");
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 45"></svg>');
    assert.deepEqual(readImageSize(svgPath), { width: 120, height: 45 });
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"></svg>');
    assert.deepEqual(readImageSize(svgPath), { width: 64, height: 48 });

    // Unreadable input answers null instead of throwing.
    fs.writeFileSync(path.join(dir, "bad.png"), Buffer.from("not an image at all"));
    assert.equal(readImageSize(path.join(dir, "bad.png")), null);
    assert.equal(readImageSize(path.join(dir, "missing.png")), null);
    assert.equal(readImageSize(""), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("picking a wallpaper stores it without touching the glass switch", async () => {
  const file = tempWallpaper();
  const host = makePi();
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    const result = await feature.onPanelInvoke("glass.setWallpaper", { path: file });
    assert.equal(result.ok, true);
    assert.equal(host.store[glass.SETTINGS_KEY].wallpaper, file);
    // The photo is its own layer: it has to stay visible with the glass off, so
    // picking one must not flip the switch behind the user's back.
    assert.equal(host.store[glass.SETTINGS_KEY].enabled, false);
  } finally {
    delete global.pi;
  }
});

test("a missing or unsupported wallpaper is refused, not stored", async () => {
  const host = makePi();
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    const missing = await feature.onPanelInvoke("glass.setWallpaper", { path: "/nope/none.png" });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "missing");
    assert.match(missing.message, /找不到/);

    const wrong = await feature.onPanelInvoke("glass.setWallpaper", { path: "/nope/none.exe" });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, "unsupported");

    assert.equal(host.store[glass.SETTINGS_KEY], undefined);
  } finally {
    delete global.pi;
  }
});

test("a whole-config write cannot drop the wallpaper", async () => {
  const file = tempWallpaper("keep.png");
  const host = makePi({
    [glass.SETTINGS_KEY]: { enabled: true, wallpaper: file, preset: "deep", intensity: 1.2, fit: "fill" },
  });
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    await feature.onLoad();
    // The panel sends the config it rendered, where the wallpaper is whatever it
    // last saw; the process stays the authority on it.
    await feature.onPanelInvoke("glass.apply", {
      config: { preset: "light", intensity: 1, wallpaper: "", fit: "scale-down" },
    });
    const stored = host.store[glass.SETTINGS_KEY];
    assert.equal(stored.wallpaper, file);
    assert.equal(stored.preset, "light");
    assert.equal(stored.fit, "scale-down");
  } finally {
    delete global.pi;
  }
});

test("clearing the wallpaper keeps every other setting", async () => {
  const file = tempWallpaper("clear.png");
  const host = makePi({
    [glass.SETTINGS_KEY]: { enabled: true, wallpaper: file, preset: "deep", intensity: 1.3, fit: "scale-down" },
  });
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    await feature.onLoad();
    const result = await feature.onPanelInvoke("glass.clearWallpaper", {});
    assert.equal(result.config.wallpaper, "");
    assert.equal(result.config.enabled, true);
    assert.equal(result.config.preset, "deep");
    assert.equal(result.config.fit, "scale-down");
  } finally {
    delete global.pi;
  }
});

test("a wallpaper that vanished is dropped on load instead of breaking the theme", async () => {
  const host = makePi({
    [glass.SETTINGS_KEY]: { enabled: true, wallpaper: "/gone/missing.png", preset: "standard", intensity: 1, fit: "fill" },
  });
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    await feature.onLoad();
    // A stale reference makes `themes.upsert` fail outright, which would take
    // the motion layer down with it.
    assert.equal(feature.getConfig().wallpaper, "");
    assert.equal(host.store[glass.SETTINGS_KEY].wallpaper, "");
    assert.equal(host.store[glass.SETTINGS_KEY].enabled, true);
  } finally {
    delete global.pi;
  }
});

test("the panel gets the values it renders the controls from", async () => {
  const host = makePi();
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    const state = await feature.onPanelInvoke("glass.getState", {});
    assert.deepEqual(state.presets, ["light", "standard", "deep"]);
    assert.deepEqual(state.fits, ["fill", "contain", "cover", "none", "scale-down"]);
    assert.deepEqual(state.limits.intensity, [0.6, 1.6]);
  } finally {
    delete global.pi;
  }
});

test("an uploaded image is written into the plugin data folder and adopted", async () => {
  const host = makePi();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "piopt-data-"));
  host.pi.plugin.getDataPath = async () => dataDir;
  host.pi.ui.showToast = async () => {};
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const result = await feature.onPanelInvoke("glass.saveWallpaper", {
      name: "My Photo.PNG",
      data: bytes.toString("base64"),
    });
    assert.equal(result.ok, true);
    const stored = host.store[glass.SETTINGS_KEY];
    assert.equal(path.basename(stored.wallpaper), "wallpaper.png");
    // The photo lives on its own layer, so the switch is left exactly as it was.
    assert.equal(stored.enabled, false);
    assert.deepEqual(fs.readFileSync(stored.wallpaper), bytes);
  } finally {
    delete global.pi;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an upload of the wrong type or an oversized one is refused", async () => {
  const host = makePi();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "piopt-data-"));
  host.pi.plugin.getDataPath = async () => dataDir;
  host.pi.ui.showToast = async () => {};
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    const wrong = await feature.onPanelInvoke("glass.saveWallpaper", {
      name: "photo.bmp",
      data: Buffer.from([1, 2, 3]).toString("base64"),
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, "unsupported");

    const empty = await feature.onPanelInvoke("glass.saveWallpaper", { name: "photo.png", data: "" });
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, "unreadable");

    assert.deepEqual(fs.readdirSync(dataDir), []);
    assert.equal(host.store[glass.SETTINGS_KEY], undefined);
  } finally {
    delete global.pi;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the photo survives the glass switch being off", () => {
  const photo = "/pictures/shot.png";
  const off = glass.buildGlassCss({ enabled: false, wallpaper: photo }, { size: { width: 400, height: 300 } });

  // The backdrop and the see-through content pane belong to the photo, not to
  // the switch: without them the picture would vanish the moment glass is off.
  assert.ok(off.includes(`url("${photo}")`));
  assert.ok(off.includes(".app-shell::before{"));
  assert.match(off, /--pg-canvas-alpha:74%/);
  assert.ok(off.includes(".main-pane{background-color:color-mix(in oklab,var(--ds-bg-primary) var(--pg-canvas-alpha),transparent)!important}"));

  // The switch is exactly the blur: no filter declaration anywhere in this
  // sheet. Comments are stripped first — the word appears in prose there.
  const offDecl = off.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(offDecl.includes("backdrop-filter"), false);
  assert.equal(off.includes("@supports not"), false);

  // With the switch on, the same photo gains the frosting.
  const on = glass.buildGlassCss({ enabled: true, wallpaper: photo }, { size: { width: 400, height: 300 } });
  // Frosting goes to the leaf menus only. A blur on a menu that can open a
  // submenu makes it the containing block for that fixed child, and the host
  // reads the parent's rect to place the child — the submenu then stays
  // trapped inside the menu that opened it.
  assert.doesNotMatch(on, /\.sidebar-floating-menu[^{]*\{[^}]*backdrop-filter/);
  assert.match(on, /:is\(\.sidebar-submenu,\.context-menu-submenu\)\{[^}]*backdrop-filter/);
  assert.ok(on.includes("@supports not"));
  // No photo and no switch still means an empty sheet, byte for byte.
  assert.equal(glass.buildGlassCss({ enabled: false, wallpaper: "" }), "");
});
