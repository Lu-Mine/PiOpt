"use strict";

/**
 * The motion lab applies a runtime theme by id, and the host namespaces every
 * plugin theme as `plugin:<plugin id>:<theme id>`. That prefix was hard-coded to
 * the pre-merge `local.pi-modify`, so after the two plugins became `local.piopt`
 * the host answered `unknown theme id` and moving a slider failed. These tests
 * pin the id the feature actually asks for.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const motion = require("../features/motion/motion.js");
const feature = require("../features/motion/index.js");

const PLUGIN_ID = "local.piopt";

function installHost({ registered, pluginTheme = null, base = "dark" } = {}) {
  const applied = [];
  const upserted = [];
  global.pi = {
    plugin: {
      getId: () => PLUGIN_ID,
      getSettings: async () => ({}),
      setSettings: async () => {},
    },
    app: {
      getAppearance: async () => ({ base, theme: base, pluginTheme }),
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
  return { applied, upserted };
}

test("motion.apply names the theme the host registered for this plugin", async () => {
  const host = installHost();
  try {
    const answer = await feature.onPanelInvoke("motion.apply", {
      config: { ...motion.DEFAULT_CONFIG, mode: "dark" },
    });
    assert.deepEqual(host.upserted.sort(), ["motion-dark", "motion-light"]);
    const expected = `plugin:${PLUGIN_ID}:${motion.THEME_IDS.dark}`;
    assert.deepEqual(host.applied, [expected]);
    assert.equal(answer.appliedTheme, expected);
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
  const current = `plugin:${PLUGIN_ID}:${motion.THEME_IDS.dark}`;
  const host = installHost({ pluginTheme: { id: current } });
  try {
    await feature.onPanelInvoke("motion.apply", {
      config: { ...motion.DEFAULT_CONFIG, mode: "dark" },
    });
    assert.deepEqual(host.applied, []);
  } finally {
    delete global.pi;
  }
});
