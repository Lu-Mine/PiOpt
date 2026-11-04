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
const glass = require("../features/appearance/glass.js");

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
      themes: {
        upsert: async (theme) => calls.push({ api: "upsert", theme }),
        remove: async (id) => calls.push({ api: "removeTheme", id }),
        list: async () => [],
      },
      app: {
        getAppearance: async () => ({ base: "dark", theme: "dark", pluginTheme: null }),
        setTheme: async (id) => calls.push({ api: "setTheme", id }),
      },
    },
  };
}

// The material is one half of the appearance feature now: its panel calls live
// there, namespaced under `appearance.glass.`, and the store is tapped through
// the same fake host.
const APPEARANCE = "../features/appearance/index.js";

function loadFeature() {
  delete require.cache[require.resolve(APPEARANCE)];
  return require(APPEARANCE);
}

// The panel still says `glass.apply`; the feature accepts the pre-merge names
// and this helper keeps the older call sites readable.
function glassChannel(name) {
  return `appearance.glass.${name}`;
}


// -------------------------------------------------------------------- config

test("glass is off by default, so nothing is injected until it is asked for", () => {
  const config = glass.normalizeGlassConfig(undefined);
  assert.deepEqual(config, { enabled: false, preset: "standard", intensity: 1, wallpaper: "", fit: "fill", recent: [] });
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
  // Every chrome surface shares the one selector rule, and the work panel
  // header is one of them: it has to carry the same fill AND the same underlay
  // as the conversation top bar, or it reads as a thinner, differently tinted
  // strip. A copy is how those drift apart.
  assert.match(
    css,
    /\.main-titlebar,:is\(\.conversation-topbar,\[data-slot=topbar\]\),\.window-controls,\.work-panel-header\{background-color:color-mix\(in oklab,var\(--ds-bg-primary\) var\(--pg-chrome-alpha\)/
  );
  // The underlay is half the material: the top bar sits on .main-pane at
  // --pg-canvas-alpha, so the panel paints that same band over its own top
  // --ds-toolbar-height and keeps the denser dock colour below it.
  assert.match(
    css,
    /\.work-panel::before\{[^}]*linear-gradient\(to bottom,color-mix\(in oklab,var\(--ds-bg-primary\) var\(--pg-canvas-alpha\),transparent\) 0 var\(--ds-toolbar-height\),color-mix\(in oklab,var\(--ds-bg-dock\) var\(--pg-sidebar-alpha\),transparent\) var\(--ds-toolbar-height\)\)/
  );
  assert.match(css, /\.work-panel::before\{[^}]*backdrop-filter:blur/);
  // A backdrop-filter on .work-panel itself would make it the Backdrop Root of
  // the header, so the layer lives on the pseudo element, which is a sibling of
  // the header in paint order and does not cut its blur off from the photo.
  assert.doesNotMatch(css, /\.work-panel\{[^}]*backdrop-filter/);
  assert.doesNotMatch(css, /\.work-panel\{[^}]*backdrop-filter/);
  assert.match(css, /\.work-panel\{background-color:transparent!important;animation:none!important\}/);
  // This guard must survive motion being disabled. The host's work-panel-in
  // uses both and retains its opacity effect after finishing, which otherwise
  // becomes a permanent Backdrop Root and brings the header colour mismatch
  // back. The exit name must keep the host's work-panel-out prefix.
  assert.match(css, /\.work-panel\.is-exiting\{animation:work-panel-out-glass /);
  const exit = css.match(/@keyframes work-panel-out-glass\{(?:[^{}]*\{[^{}]*\})+\}/);
  assert.ok(exit);
  assert.doesNotMatch(exit[0], /opacity/);
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
  // A `backdrop-filter:none` reset is fine — it removes a filter rather than
  // creating one, which is what the window-controls override does while the
  // work panel's own glass is the single layer underneath.
  assert.doesNotMatch(css, /\.app-shell(?!::before)[^{}]*\{[^}]*backdrop-filter:(?!none)/);
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
  // The layer reaches every popup and the composer now, so its selector lists are
  // longer than the four surfaces it started with. This budget is what keeps a
  // future addition honest; the host's own ceiling is CSS_LIMIT_BYTES.
  assert.ok(Buffer.byteLength(css, "utf8") < 12 * 1024, "the glass layer must stay small");
});

test("popups and the composer are frosted where a submenu cannot be re-anchored", () => {
  const css = glass.buildGlassCss({ enabled: true, preset: "standard", intensity: 1 });
  // Comments may mention backdrop-filter; only declarations count.
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");

  // A leaf popup — the model picker is one — takes the filter on the element
  // itself, next to the translucent fill that gives the blur a floor. That is
  // also the only way the frosting travels with the popup's own scrollbar.
  assert.ok(declarations.includes(`:is(${glass.FROSTED_POPUPS.join(",")}){background-color:color-mix(`));
  assert.ok(declarations.includes("backdrop-filter:blur(var(--pg-blur-strong))"));

  // Every menu that may open a fixed submenu, and the composer (which owns the
  // Menus that may open a submenu take the popup-strength blur, the composer the
  // frame-strength one: it is the one large surface, and a 46px radius there buys
  // no legibility.
  assert.ok(declarations.includes(`:is(${glass.FROSTED_FRAMES.join(",")})::before{content:"";`));
  assert.ok(declarations.includes(`${glass.FROSTED_SHELL}::before{content:"";`));
  assert.ok(declarations.includes(`${glass.FROSTED_SHELL}::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;border-radius:inherit;-webkit-backdrop-filter:blur(var(--pg-blur))`));
  const layered = [glass.FROSTED_SHELL, ...glass.FROSTED_FRAMES];
  for (const selector of layered) {
    // The element itself must stay filter-free, or the submenu it opens resolves
    // its viewport coordinates against the menu instead of the viewport.
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.doesNotMatch(declarations, new RegExp(`${escaped}\\{[^}]*backdrop-filter`), selector);
  }

  // The composer's fill is the one host surface this layer repaints. It has to be
  // translucent, or the frosting would sit on top of an opaque colour, and it has
  // to fall back to the host's own colour where backdrop blur does not exist.
  assert.ok(
    declarations.includes(
      ".composer-shell{background-color:color-mix(in oklab,var(--ds-bg-composer) var(--pg-overlay-alpha),transparent)!important"
    )
  );
  assert.ok(declarations.includes(".composer-shell{background-color:var(--ds-bg-composer)!important}"));
});

// -------------------------------------------------------------------- feature

test("the material keeps its own command, both halves are unregistered on unload", async () => {
  const host = makePi();
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    await feature.onLoad();
    const registered = host.calls.filter((call) => call.api === "register").map((call) => call.id);
    // One command per half: both open the appearance view, on a different section.
    assert.deepEqual(registered, ["pi-modify.open", "piopt.glass"]);
    await feature.onUnload();
    const removed = host.calls.filter((call) => call.api === "unregister").map((call) => call.id);
    assert.deepEqual(removed, ["pi-modify.open", "piopt.glass"]);
  } finally {
    delete global.pi;
  }
});

test("apply writes the setting and rebuilds the one theme", async () => {
  const host = makePi();
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    const result = await feature.onPanelInvoke(glassChannel("apply"), {
      config: { enabled: true, preset: "deep", intensity: 1.4 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.deepEqual(host.store[glass.SETTINGS_KEY], { enabled: true, preset: "deep", intensity: 1.4, wallpaper: "", fit: "fill", recent: [] });
    // One theme, rebuilt once from both halves: the material never injects a
    // stylesheet of its own, it changes the one the motion rules live in.
    const upserts = host.calls.filter((call) => call.api === "upsert");
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].theme.id, "motion");
    assert.equal(upserts[0].theme.label, "PiOpt Appearance");
    assert.ok(upserts[0].theme.css.includes("--pg-blur"), "the material layer must be in the theme");
    assert.deepEqual(result.config, { enabled: true, preset: "deep", intensity: 1.4, wallpaper: "", fit: "fill", recent: [] });
  } finally {
    delete global.pi;
  }
});

test("apply refuses when the host has no runtime theme API", async () => {
  const host = makePi();
  delete host.pi.themes;
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    // Both halves are one stylesheet in a runtime theme: with no theme API there
    // is nowhere to put either layer, so the write fails instead of silently
    // leaving the switch "on" while the shell stays solid.
    await assert.rejects(
      () => feature.onPanelInvoke(glassChannel("apply"), { config: { enabled: true } }),
      /不支持运行时主题 API/
    );
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
    const state = await feature.onPanelInvoke(glassChannel("getState"), {});
    assert.deepEqual(state.config, { enabled: true, preset: "light", intensity: 0.8, wallpaper: "", fit: "fill", recent: [] });
    assert.deepEqual(state.presets, ["light", "standard", "deep"]);
  } finally {
    delete global.pi;
  }
});

test("reset returns to the shipped default but keeps the user's photo", async () => {
  const file = tempWallpaper("reset.png");
  const host = makePi({ [glass.SETTINGS_KEY]: { enabled: true, preset: "deep", intensity: 1.6, wallpaper: file } });
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    // The stored config holds the photo before the reset is asked for.
    await feature.onPanelInvoke(glassChannel("getState"), {});
    const result = await feature.onPanelInvoke(glassChannel("reset"), {});
    assert.deepEqual(result.config, { enabled: false, preset: "standard", intensity: 1, wallpaper: file, fit: "fill", recent: [] });
    assert.equal(host.store[glass.SETTINGS_KEY].enabled, false);
    // The photo is the user's own file, not part of the recipe.
    assert.equal(host.store[glass.SETTINGS_KEY].wallpaper, file);
  } finally {
    delete global.pi;
  }
});

test("glass.tokens answers without writing anything", async () => {
  const host = makePi();
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    const result = await feature.onPanelInvoke(glassChannel("tokens"), { config: { preset: "deep" } });
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
    await assert.rejects(() => feature.onPanelInvoke(glassChannel("nope"), {}), /Unsupported panel action/);
  } finally {
    delete global.pi;
  }
});

// ----------------------------------------------------------------- integration

test("the one appearance theme is the only way the glass layer reaches the host", () => {
  const feature = read("features/appearance/index.js");
  // Built from the motion stylesheet plus the glass layer, in that order, in the
  // one place that registers a theme.
  assert.match(feature, /`\$\{motion\.buildThemeCss\(motionLayer, base\)\}\$\{glassLayer\}`/);
  assert.match(feature, /glass\.buildGlassCss\(config\)/);
  assert.match(feature, /glass\.buildGlassCss\(config\)/);
  // and a failed wallpaper read must not cost the motion layer
  assert.match(feature, /An unreadable wallpaper must not cost the motion layer/);
  // Every appearance write ends in the same function, so a change can never
  // leave the stylesheet carrying only one of the two layers.
  assert.match(feature, /async function applyTheme\(/);
  const writes = feature.match(/await applyTheme\(/g) || [];
  assert.ok(writes.length >= 2, "both halves must apply through applyTheme");
});

test("the panel mirrors the process model so preview mode is honest", () => {
  const panel = read("renderer/appearance.js");
  const feature = read("features/appearance/glass.js");
  // 预设不再有界面，两边的默认值必须仍然一致，否则预览会给出不同的读数。
  const panelDefaults = panel.slice(panel.indexOf("const DEFAULT_GLASS"), panel.indexOf("const GLASS_LIMITS"));
  for (const line of ['enabled: false,', 'preset: "standard",', 'intensity: 1,', 'wallpaper: "",', 'fit: "fill",', 'recent: [],']) {
    assert.ok(panelDefaults.includes(line), `panel defaults must carry ${line}`);
  }
  const featureDefaults = feature.slice(feature.indexOf("const DEFAULT_CONFIG"), feature.indexOf("const RECENT_MAX"));
  for (const line of ["enabled: false", "preset: \"standard\"", "intensity: 1", "recent: Object.freeze([])"]) {
    assert.ok(featureDefaults.includes(line), `feature defaults must carry ${line}`);
  }
  assert.equal(panel.includes("[data-glass-preset]"), false);
  assert.equal(panel.includes("scale-down"), false);
  assert.match(panel, /const FITS = \["fill", "contain", "cover", "none"\];/);
});

test("the material section's stylesheet targets the classes its own markup uses", () => {
  const html = read("renderer/index.html");
  const start = html.indexOf('id="section-glass"');
  const end = html.indexOf('id="view-remote"');
  assert.ok(start > 0 && end > start, "the material section must close before the next view");
  const markup = html.slice(start, end);
  const css = read("renderer/appearance.css");

  const classes = new Set(
    [...markup.matchAll(/class="([^"]+)"/g)]
      .flatMap((match) => match[1].split(/\s+/))
      .filter((name) => name.startsWith("glass-"))
  );
  assert.ok(classes.size >= 2, `expected the glass view to use its own classes, saw ${classes.size}`);

  for (const name of classes) {
    // The rule has to target the element itself. `.glass-metrics dl` looked
    // right but styled a descendant that does not exist — the dl already
    // carries the class — so the readings card silently lost its grid, its
    // border and its row separation.
    assert.match(
      css,
      new RegExp(`\.${name}(?![\w-])[^{}]*\{`),
      `renderer/appearance.css must style .${name}`
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

test("a fit the panel no longer offers falls back to fill", () => {
  // 「不放大」需要读图片的原始尺寸，而 CSS 拿不到；这段依赖已随选项一起删掉。
  assert.equal(glass.FITS.includes("scale-down"), false);
  assert.equal(glass.normalizeGlassConfig({ fit: "scale-down" }).fit, "fill");
  assert.equal(glass.normalizeGlassConfig({ fit: "nonsense" }).fit, "fill");
  assert.ok(glass.buildGlassCss({ enabled: true, wallpaper: "/a.png", fit: "cover" }).includes("background-size:cover"));
});

test("picking a wallpaper stores it without touching the glass switch", async () => {
  const file = tempWallpaper();
  const host = makePi();
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    const result = await feature.onPanelInvoke(glassChannel("setWallpaper"), { path: file });
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
    const missing = await feature.onPanelInvoke(glassChannel("setWallpaper"), { path: "/nope/none.png" });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "missing");
    assert.match(missing.message, /找不到/);

    const wrong = await feature.onPanelInvoke(glassChannel("setWallpaper"), { path: "/nope/none.exe" });
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
    await feature.onPanelInvoke(glassChannel("apply"), {
      config: { preset: "light", intensity: 1, wallpaper: "", fit: "cover" },
    });
    const stored = host.store[glass.SETTINGS_KEY];
    assert.equal(stored.wallpaper, file);
    assert.equal(stored.preset, "light");
    assert.equal(stored.fit, "cover");
  } finally {
    delete global.pi;
  }
});

test("clearing the wallpaper keeps every other setting", async () => {
  const file = tempWallpaper("clear.png");
  const host = makePi({
    [glass.SETTINGS_KEY]: { enabled: true, wallpaper: file, preset: "deep", intensity: 1.3, fit: "cover" },
  });
  global.pi = host.pi;
  const feature = loadFeature();
  try {
    await feature.onLoad();
    const result = await feature.onPanelInvoke(glassChannel("clearWallpaper"), {});
    assert.equal(result.config.wallpaper, "");
    assert.equal(result.config.enabled, true);
    assert.equal(result.config.preset, "deep");
    assert.equal(result.config.fit, "cover");
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
    assert.equal(feature._getGlassConfig().wallpaper, "");
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
    const state = await feature.onPanelInvoke(glassChannel("getState"), {});
    assert.deepEqual(state.presets, ["light", "standard", "deep"]);
    assert.deepEqual(state.fits, ["fill", "contain", "cover", "none"]);
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
    const result = await feature.onPanelInvoke(glassChannel("saveWallpaper"), {
      name: "My Photo.PNG",
      data: bytes.toString("base64"),
    });
    assert.equal(result.ok, true);
    const stored = host.store[glass.SETTINGS_KEY];
    assert.match(path.basename(stored.wallpaper), /^wallpaper\.[a-z0-9]+\.png$/);
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
    const wrong = await feature.onPanelInvoke(glassChannel("saveWallpaper"), {
      name: "photo.bmp",
      data: Buffer.from([1, 2, 3]).toString("base64"),
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, "unsupported");

    const empty = await feature.onPanelInvoke(glassChannel("saveWallpaper"), { name: "photo.png", data: "" });
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

  // The switch is exactly the blur: no filter anywhere in this sheet. The
  // `backdrop-filter:none` resets that keep the clear header and window
  // controls from stacking a second tint are not filters, so they stay.
  assert.doesNotMatch(off, /backdrop-filter:(?!none)/);
  assert.equal(off.includes("@supports not"), false);

  // With the switch on, the same photo gains the frosting.
  const on = glass.buildGlassCss({ enabled: true, wallpaper: photo }, { size: { width: 400, height: 300 } });
  assert.ok(on.includes("backdrop-filter:blur(var(--pg-blur))"));
  assert.ok(on.includes("@supports not"));
  // Popups carry the fill but never the frosting: blurring a menu makes it the
  // containing block for the submenu it opens, which the host positions in
  // viewport coordinates — the submenu then stays trapped inside its parent.
  assert.equal(/\[role=menu\][^{]*\{[^}]*backdrop-filter/.test(on), false);
  assert.ok(on.includes("@supports not"));

  // No photo and no switch still means an empty sheet, byte for byte.
  assert.equal(glass.buildGlassCss({ enabled: false, wallpaper: "" }), "");
});
