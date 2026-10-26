"use strict";

/**
 * The motion lab applies a runtime theme by id, and the host namespaces every
 * plugin theme as `plugin:<plugin id>:<theme id>`. That prefix was hard-coded to
 * the pre-merge `local.pi-modify`, so after the two plugins became `local.piopt`
 * the host answered `unknown theme id` and moving a slider failed.
 *
 * These tests pin two things: the id the feature asks for, and what "auto"
 * resolves to. "Auto" is the system, not the last colour the user picked in the
 * host — the recorded preference is only a fallback.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const motion = require("../features/motion/motion.js");
const feature = require("../features/motion/index.js");

const PLUGIN_ID = "local.piopt";

function installHost({
  registered,
  pluginTheme = null,
  base = "dark",
  theme = base,
  settings: initial = {},
} = {}) {
  const applied = [];
  const upserted = [];
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
      upsert: async (input) => upserted.push(input.id),
      list: async () =>
        registered ?? [
          { id: `plugin:${PLUGIN_ID}:motion-light`, pluginId: PLUGIN_ID, themeId: "motion-light" },
          { id: `plugin:${PLUGIN_ID}:motion-dark`, pluginId: PLUGIN_ID, themeId: "motion-dark" },
        ],
    },
  };
  return { applied, upserted, settings };
}

function themeId(base) {
  return `plugin:${PLUGIN_ID}:${motion.THEME_IDS[base]}`;
}

function autoApply(hints, extra = {}) {
  return feature.onPanelInvoke("motion.apply", {
    config: { ...motion.DEFAULT_CONFIG, mode: "auto" },
    hints,
    ...extra,
  });
}

test("motion.apply names the theme the host registered for this plugin", async () => {
  const host = installHost();
  try {
    const answer = await feature.onPanelInvoke("motion.apply", {
      config: { ...motion.DEFAULT_CONFIG, mode: "dark" },
    });
    assert.deepEqual(host.upserted.sort(), ["motion-dark", "motion-light"]);
    assert.deepEqual(host.applied, [themeId("dark")]);
    assert.equal(answer.appliedTheme, themeId("dark"));
    assert.equal(
      host.applied.some((id) => id.includes("pi-modify")),
      false,
      "the pre-merge namespace must never be applied again"
    );
  } finally {
    delete global.pi;
  }
});

test("motion.apply follows the host's id when it names the theme differently", async () => {
  const renamed = `plugin:${PLUGIN_ID}:motion-dark-v9`;
  const host = installHost({
    registered: [{ id: renamed, pluginId: PLUGIN_ID, themeId: motion.THEME_IDS.dark }],
  });
  try {
    const answer = await feature.onPanelInvoke("motion.apply", {
      config: { ...motion.DEFAULT_CONFIG, mode: "dark" },
    });
    assert.deepEqual(host.applied, [renamed]);
    assert.equal(answer.appliedTheme, renamed);
  } finally {
    delete global.pi;
  }
});

test("motion.apply leaves an already selected theme alone", async () => {
  const host = installHost({ pluginTheme: { id: themeId("dark") } });
  try {
    await feature.onPanelInvoke("motion.apply", {
      config: { ...motion.DEFAULT_CONFIG, mode: "dark" },
    });
    assert.deepEqual(host.applied, []);
  } finally {
    delete global.pi;
  }
});

test("auto follows the system while a Motion Lab theme is applied", async () => {
  const host = installHost({ base: "dark", theme: themeId("dark") });
  try {
    const answer = await autoApply({ prefersLight: true });
    assert.equal(answer.resolvedBase, "light");
    assert.deepEqual(host.applied, [themeId("light")]);
  } finally {
    delete global.pi;
  }
});

test("auto is not the colour the user last picked in the host", async () => {
  // The host still reports "light" (our own light theme, or the user's pick);
  // the system is dark, so auto has to be dark.
  const host = installHost({
    base: "light",
    theme: themeId("light"),
    settings: { "motion.hostPreference": "light" },
  });
  try {
    const answer = await autoApply({ prefersLight: false });
    assert.equal(answer.resolvedBase, "dark");
    assert.deepEqual(host.applied, [themeId("dark")]);
  } finally {
    delete global.pi;
  }
});

test("auto falls back to the recorded preference when the page cannot report the system", async () => {
  const host = installHost({
    base: "dark",
    theme: themeId("dark"),
    settings: { "motion.hostPreference": "light" },
  });
  try {
    const answer = await autoApply({});
    assert.equal(answer.resolvedBase, "light");
    assert.deepEqual(host.applied, [themeId("light")]);
  } finally {
    delete global.pi;
  }
});

test("an explicit light or dark choice outranks the system", async () => {
  const host = installHost({ base: "light", theme: themeId("light") });
  try {
    const answer = await feature.onPanelInvoke("motion.apply", {
      config: { ...motion.DEFAULT_CONFIG, mode: "dark" },
      hints: { prefersLight: true },
    });
    assert.equal(answer.resolvedBase, "dark");
    assert.deepEqual(host.applied, [themeId("dark")]);
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
