"use strict";

/**
 * 行为：聊天框模型浮窗始终展开，并按供应商分组或按名称平铺。
 *
 * 这一层要守住三件事，它们分别坏在不同的地方：
 *   1. 设置只有一种形状（`provider` / `name`），主进程与面板读同一份；
 *   2. 宿主窗口里的改写只动克隆出来的按钮，不搬宿主自己的 React 节点；
 *   3. 折叠入口与平铺列表的开关都由模块自己写下的属性驱动，样式规则和它们对得上。
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const modelPicker = require("../features/behavior/model-picker.js");

// ------------------------------------------------------------------ fake host

function makePi(settings = {}) {
  const store = { ...settings };
  const calls = [];
  return {
    store,
    calls,
    pi: {
      plugin: {
        getSettings: async () => ({ ...store }),
        setSettings: async (patch) => {
          Object.assign(store, patch);
          calls.push({ api: "setSettings", patch });
        },
      },
    },
  };
}

const BEHAVIOR = "../features/behavior/index.js";

function loadFeature(fake) {
  delete require.cache[require.resolve(BEHAVIOR)];
  global.pi = fake.pi;
  return require(BEHAVIOR);
}

// ---------------------------------------------------------------------- shape

test("the grouping has one default and one accepted pair", () => {
  assert.deepEqual(modelPicker.GROUPINGS, ["provider", "name"]);
  assert.equal(modelPicker.SETTINGS_KEY, "modelPicker");
  assert.deepEqual(modelPicker.normalizeConfig(undefined), { grouping: "provider" });
  assert.deepEqual(modelPicker.normalizeConfig({ grouping: "name" }), { grouping: "name" });
  // 旧值、大小写、别的功能的键都不该漏进来。
  assert.deepEqual(modelPicker.normalizeConfig({ grouping: "NAME" }), { grouping: "provider" });
  assert.deepEqual(modelPicker.normalizeConfig({ grouping: "size" }), { grouping: "provider" });
  assert.deepEqual(modelPicker.normalizeConfig("name"), { grouping: "provider" });
});

// ------------------------------------------------------------------- channels

test("the panel reads and writes the grouping through the behavior feature", async () => {
  const fake = makePi({ [modelPicker.SETTINGS_KEY]: { grouping: "name" } });
  const feature = loadFeature(fake);
  try {
    await feature.onLoad();
    assert.equal(feature.getState().config.grouping, "name");
    assert.deepEqual(feature.getState().groupings, ["provider", "name"]);

    const saved = await feature.onPanelInvoke("behavior.modelPicker.setGrouping", { grouping: "provider" });
    assert.equal(saved.ok, true);
    assert.equal(saved.config.grouping, "provider");
    assert.deepEqual(fake.store[modelPicker.SETTINGS_KEY], { grouping: "provider" });
    // 主进程里的缓存也跟上了：宿主窗口每次打开浮窗都读这一份。
    assert.equal(feature.getState().config.grouping, "provider");

    // 非法值退回默认，不允许写进去一个宿主不认识的排列方式。
    const coerced = await feature.onPanelInvoke("behavior.modelPicker.setGrouping", { grouping: "alphabetical" });
    assert.equal(coerced.config.grouping, "provider");

    await assert.rejects(
      () => feature.onPanelInvoke("behavior.unknown", {}),
      /Unsupported panel action/
    );
  } finally {
    delete global.pi;
  }
});

test("a fresh plugin load reads the stored grouping, not the default", async () => {
  const fake = makePi({ [modelPicker.SETTINGS_KEY]: { grouping: "name" } });
  const feature = loadFeature(fake);
  try {
    await feature.onLoad();
    assert.equal(feature.getState().config.grouping, "name");
  } finally {
    delete global.pi;
  }
});

// -------------------------------------------------------- host-window rewrite

test("the host window asks the behavior feature for the popup state", async () => {
  const fake = makePi({ [modelPicker.SETTINGS_KEY]: { grouping: "name" } });
  const previous = global.pi;
  global.pi = {
    ...fake.pi,
    ui: { openPanel: async () => {} },
  };
  const main = require("../main.js");
  try {
    await main._features.behavior.onLoad();
    assert.equal((await main.onRendererCall("modelPickerState", {})).config.grouping, "name");

    const saved = await main.onRendererCall("setModelPickerGrouping", { grouping: "provider" });
    assert.equal(saved.config.grouping, "provider");
    assert.deepEqual(fake.store[modelPicker.SETTINGS_KEY], { grouping: "provider" });
  } finally {
    if (previous === undefined) delete global.pi;
    else global.pi = previous;
  }
});

test("the rewrite clones host rows instead of moving them", () => {
  const source = read("renderer/model-picker.mjs");
  // 宿主自己会重渲染这棵子树；把它的节点搬到别处，下一次 insertBefore 就找不到参照。
  assert.match(source, /row\.option\.cloneNode\(true\)/);
  assert.doesNotMatch(source, /\.insertBefore\(/);
  // 原生按钮只被读取（title / 文本 / 类名），不会被搬动或删掉。
  // 点击克隆按钮只是转交给原生按钮，选中模型仍走宿主自己的逻辑。
  assert.match(source, /row\.option\.click\(\)/);
  // 宿主的折叠入口（其他模型）只点一次，随后被样式藏掉。
  assert.match(source, /aria-expanded/);
});

test("the injected rules key off the attributes the module writes", () => {
  const source = read("renderer/model-picker.mjs");
  for (const attribute of [
    "data-piopt-mp-expanded",
    "data-piopt-mp-mode",
    "data-piopt-mp-searching",
  ]) {
    assert.ok(source.includes(attribute), attribute);
  }
  // 折叠入口藏在 `.composer-model-list` 的直接子级里，「其他模型」是它的类名。
  assert.match(
    source,
    /\.composer-model-menu\[\$\{EXPANDED_ATTR\}\] \.composer-model-list > \.\$\{COLLAPSE_CLASS\}\{display:none\}/
  );
  // 平铺时原生分组让位，搜索时反过来 —— 不能靠 revert 把宿主自己的 display 也抹掉。
  assert.ok(source.includes(':not([${SEARCH_ATTR}="true"])'), "平铺规则按搜索属性让位");
  assert.doesNotMatch(source, /display:revert/);
});

test("the entry mounts the popup rewrite with its own lifecycle", () => {
  const entry = read("renderer/entry.mjs");
  assert.match(entry, /import \{ MODEL_PICKER_CSS, mountModelPicker, unmountModelPicker \} from "\.\/model-picker\.mjs";/);
  assert.match(entry, /MODEL_PICKER_CSS,/);
  assert.match(entry, /await mountModelPicker\(pi\)/);
  assert.match(entry, /unmountModelPicker\(\)/);
});

test("the behavior view boots from one hook and writes that one value", () => {
  const view = read("renderer/behavior.js");
  assert.match(view, /window\.PiOptBehavior = \{ boot \}/);
  assert.match(view, /const CHANNEL = "behavior\.modelPicker";/);
  assert.match(view, /const GROUPINGS = \["provider", "name"\];/);
  // 与外观视图一致：脚本只导出 boot，不自己跑起来。
  assert.equal(view.trimEnd().endsWith("})();"), true);
  assert.doesNotMatch(view, /\bboot\(\);\s*$/m);
});
