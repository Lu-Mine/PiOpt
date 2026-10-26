"use strict";

/**
 * Motion Lab registers exactly one theme (`motion`), whose base follows the
 * setting: "auto" is the system, and the explicit choices override it. The host
 * namespaces the id as `plugin:<plugin id>:<theme id>`.
 *
 * These tests pin the id, the base each setting resolves to, that the old
 * light/dark pair is cleaned up, and that the palette cross-fade follows the
 * speed and preset settings.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const motion = require("../features/motion/motion.js");
const feature = require("../features/motion/index.js");

const PLUGIN_ID = "local.piopt";
const THEME = `plugin:${PLUGIN_ID}:${motion.THEME_ID}`;

function installHost({
  pluginTheme = null,
  base = "dark",
  theme = base,
  settings: initial = {},
  registered,
} = {}) {
  const applied = [];
  const upserted = [];
  const removed = [];
  const settings = { ...initial };
  global.pi = {
    plugin: {
      getId: () => PLUGIN_ID,
      getSettings: async () => settings,
      setSettings: async (partial) => Object.assign(settings, partial),
    },
    app: {
      getAppearance: async () => ({ base, theme, pluginTheme }),
      setTheme: async (id) => applied.push(id),
    },
    themes: {
      upsert: async (input) => upserted.push({ id: input.id, base: input.base, label: input.label }),
      remove: async (id) => removed.push(id),
      list: async () =>
        registered ?? [{ id: THEME, pluginId: PLUGIN_ID, themeId: motion.THEME_ID }],
    },
  };
  return { applied, upserted, removed, settings };
}

function apply(config, hints = {}) {
  return feature.onPanelInvoke("motion.apply", { config, hints });
}

test("one theme is registered, whatever the setting", async () => {
  const host = installHost();
  try {
    await apply({ ...motion.DEFAULT_CONFIG, mode: "dark" });
    await apply({ ...motion.DEFAULT_CONFIG, mode: "light" });
    assert.deepEqual(
      host.upserted.map((theme) => theme.id),
      [motion.THEME_ID, motion.THEME_ID],
      "the host must only ever see one Motion Lab theme"
    );
    assert.deepEqual(host.upserted.map((theme) => theme.base), ["dark", "light"]);
    assert.equal(host.upserted[0].label, "Motion Lab");
  } finally {
    delete global.pi;
  }
});

test("the old light/dark pair is removed on sight", async () => {
  const host = installHost();
  try {
    await apply({ ...motion.DEFAULT_CONFIG, mode: "auto" }, { prefersLight: true });
    assert.deepEqual(host.removed, ["motion-light", "motion-dark"]);
  } finally {
    delete global.pi;
  }
});

test("auto follows the system, whatever the host currently shows", async () => {
  const host = installHost({
    base: "light",
    theme: THEME,
    settings: { "motion.hostPreference": "light" },
  });
  try {
    const answer = await apply({ ...motion.DEFAULT_CONFIG, mode: "auto" }, { prefersLight: false });
    assert.equal(answer.resolvedBase, "dark");
    assert.equal(host.upserted.at(-1).base, "dark");
  } finally {
    delete global.pi;
  }
});

test("an explicit choice sets the base without consulting the system", async () => {
  const host = installHost({ base: "dark", theme: THEME });
  try {
    const light = await apply({ ...motion.DEFAULT_CONFIG, mode: "light" }, { prefersLight: false });
    assert.equal(light.resolvedBase, "light");
    assert.equal(host.upserted.at(-1).base, "light");
    const dark = await apply({ ...motion.DEFAULT_CONFIG, mode: "dark" }, { prefersLight: true });
    assert.equal(dark.resolvedBase, "dark");
    assert.equal(host.upserted.at(-1).base, "dark");
  } finally {
    delete global.pi;
  }
});

test("the theme is selected once and then left alone", async () => {
  const host = installHost({ pluginTheme: { id: THEME } });
  try {
    const answer = await apply({ ...motion.DEFAULT_CONFIG, mode: "auto" }, { prefersLight: true });
    assert.equal(answer.appliedTheme, THEME);
    assert.deepEqual(host.applied, [], "an already selected theme is not re-selected");
  } finally {
    delete global.pi;
  }
});

test("the first apply selects the theme", async () => {
  const host = installHost();
  try {
    await apply({ ...motion.DEFAULT_CONFIG, mode: "auto" }, { prefersLight: true });
    assert.deepEqual(host.applied, [THEME]);
  } finally {
    delete global.pi;
  }
});

test("the palette cross-fade follows the speed and preset settings", () => {
  const base = motion.motionTokens({ preset: "balanced", speed: 1 }).themeSwitch;
  const faster = motion.motionTokens({ preset: "balanced", speed: 1.4 }).themeSwitch;
  const slower = motion.motionTokens({ preset: "balanced", speed: 0.65 }).themeSwitch;
  const reduced = motion.motionTokens({ preset: "reduced", speed: 1 }).themeSwitch;
  assert.equal(base, 160);
  assert.ok(faster < base && slower > base, `${faster} < ${base} < ${slower}`);
  assert.ok(reduced < base);

  const css = motion.buildThemeCss({}, "dark");
  assert.match(css, /--pm-switch:160ms/);
  // Cheap on purpose: one property, on solid surfaces only, never html/body.
  assert.match(
    css,
    /:is\(\.app-shell,\.main-pane,\.chat-surface,\.sidebar-surface,\.topbar,\.settings-content\)\{transition:background-color var\(--pm-switch\) var\(--pm-ease-standard\)\}/
  );
  assert.doesNotMatch(css, /:is\(html,body/);
});

test("release hands the selection back so the page can read the system", async () => {
  // The host pins nativeTheme.themeSource to our base, so the page can only see
  // the real system value while the selection belongs to the host again.
  const host = installHost({ pluginTheme: { id: THEME } });
  try {
    const answer = await feature.onPanelInvoke("motion.release");
    assert.deepEqual(answer, { ok: true });
    assert.deepEqual(host.applied, ["system"]);
  } finally {
    delete global.pi;
  }
});
