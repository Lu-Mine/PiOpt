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

// 没存过设置时的整份形状：排列方式按供应商分组，两项改写都先关着。
const DEFAULTS = { grouping: "provider", frameSelected: false, translateThinking: false };

test("the grouping has one default and three rearrangements", () => {
  // 按钮的先后就是这里的先后：「默认」在最前面，后面三种都自己重排。
  assert.deepEqual(modelPicker.GROUPINGS, ["default", "provider", "vendor", "name"]);
  assert.equal(modelPicker.SETTINGS_KEY, "modelPicker");
  // 没存过设置时仍是按供应商分组：新增「默认」不改老用户打开浮窗看到的样子。
  assert.deepEqual(modelPicker.normalizeConfig(undefined), DEFAULTS);
  assert.deepEqual(modelPicker.normalizeConfig({ grouping: "name" }), { ...DEFAULTS, grouping: "name" });
  assert.deepEqual(modelPicker.normalizeConfig({ grouping: "default" }), { ...DEFAULTS, grouping: "default" });
  // 旧值、大小写、别的功能的键都不该漏进来。
  assert.deepEqual(modelPicker.normalizeConfig({ grouping: "NAME" }), DEFAULTS);
  assert.deepEqual(modelPicker.normalizeConfig({ grouping: "size" }), DEFAULTS);
  assert.deepEqual(modelPicker.normalizeConfig("name"), DEFAULTS);
});

test("the two popup rewrites are booleans, off unless asked for", () => {
  // 对勾换圆角框、推理强度译成中文：都是「开着才做」，别的写法一律当关。
  assert.deepEqual(modelPicker.normalizeConfig({ frameSelected: true }), { ...DEFAULTS, frameSelected: true });
  assert.deepEqual(modelPicker.normalizeConfig({ translateThinking: true }), { ...DEFAULTS, translateThinking: true });
  assert.equal(modelPicker.normalizeConfig({ frameSelected: "yes" }).frameSelected, false);
  assert.equal(modelPicker.normalizeConfig({ translateThinking: 1 }).translateThinking, false);
  // 只写一个字段不会把另一个抹掉。
  assert.deepEqual(
    modelPicker.normalizeConfig({ frameSelected: true, translateThinking: true, grouping: "vendor" }),
    { grouping: "vendor", frameSelected: true, translateThinking: true }
  );
});

// ------------------------------------------------------------------- channels

test("the panel reads and writes the grouping through the behavior feature", async () => {
  const fake = makePi({ [modelPicker.SETTINGS_KEY]: { grouping: "name" } });
  const feature = loadFeature(fake);
  try {
    await feature.onLoad();
    assert.equal(feature.getState().config.grouping, "name");
    assert.deepEqual(feature.getState().groupings, ["default", "provider", "vendor", "name"]);

    const saved = await feature.onPanelInvoke("behavior.modelPicker.setGrouping", { grouping: "provider" });
    assert.equal(saved.ok, true);
    assert.equal(saved.config.grouping, "provider");
    assert.equal(fake.store[modelPicker.SETTINGS_KEY].grouping, "provider");
    // 写进去的仍是整份设置：两个开关即使没动过也要跟着存下来。
    assert.deepEqual(fake.store[modelPicker.SETTINGS_KEY], DEFAULTS);
    // 主进程里的缓存也跟上了：宿主窗口每次打开浮窗都读这一份。
    assert.equal(feature.getState().config.grouping, "provider");

    // 非法值退回默认，不允许写进去一个宿主不认识的排列方式。
    const coerced = await feature.onPanelInvoke("behavior.modelPicker.setGrouping", { grouping: "alphabetical" });
    assert.equal(coerced.config.grouping, "provider");

    // 「默认」也是宿主认识的排列方式，能存下来、下次打开照样读到。
    const kept = await feature.onPanelInvoke("behavior.modelPicker.setGrouping", { grouping: "default" });
    assert.equal(kept.config.grouping, "default");
    assert.equal(fake.store[modelPicker.SETTINGS_KEY].grouping, "default");
    assert.equal(fake.store[modelPicker.SETTINGS_KEY].frameSelected, false);
    assert.equal(feature.getState().config.grouping, "default");

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

test("file opening is optional, persisted, and blocked when disabled", async () => {
  const fake = makePi();
  const feature = loadFeature(fake);
  const main = require("../main.js");
  try {
    await feature.onLoad();
    assert.equal(feature.getState().config.openSessionOutput, false);
    await assert.rejects(main.onRendererCall("openSessionOutput", { path: "anything" }), /开启文件右键打开/);
    await feature.setOptions({ openSessionOutput: true });
    assert.equal(fake.store.openSessionOutput, true);
    assert.equal(feature.getState().config.openSessionOutput, true);
    await feature.onLoad();
    assert.equal(feature.getState().config.openSessionOutput, true);
    await feature.setOptions({ openSessionOutput: false });
    assert.equal(fake.store.openSessionOutput, false);
  } finally { delete global.pi; }
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
    assert.deepEqual(fake.store[modelPicker.SETTINGS_KEY], DEFAULTS);
  } finally {
    if (previous === undefined) delete global.pi;
    else global.pi = previous;
  }
});

test("the rewrite reads every group instead of cloning the host's rows", () => {
  const source = read("renderer/model-picker.mjs");
  // 宿主自己会重渲染这棵子树；把它的节点搬到别处，下一次 insertBefore 就找不到参照。
  assert.doesNotMatch(source, /\.insertBefore\(/);
  assert.doesNotMatch(source, /\.appendChild\(/);
  // 左栏一格一个供应商，列表里一次只画一组：逐格点开读一遍，读完切回原来那一格。
  assert.match(source, /const RAIL_ITEM_SELECTOR = "\.composer-model-rail-item";/);
  assert.match(source, /function providerRailItems\(rail\)/);
  assert.match(source, /async function collectAll\(list\)/);
  assert.match(source, /const activeIndex = railItems\(list\)\.findIndex\(\(item\) => item\.classList\.contains\("active"\)\);/);
  // 点击自建行只是转交给相对应的原生按钮，选中模型仍走宿主自己的逻辑。
  assert.match(source, /if \(typeof option\.click === "function"\) option\.click\(\);/);
});

test("最近使用那一组整组不收，来源改由行内的小字承担", () => {
  const source = read("renderer/model-picker.mjs");
  // 那一组的每一行都把来源写在行内，它的模型在各自分组里都有：整组跳过。
  assert.match(source, /if \(options\.some\(\(option\) => option\.querySelector\(OPTION_PROVIDER_SELECTOR\)\)\) continue;/);
  // 来源跟在名称后面，宽度不够就省略 —— 每行两行字会让整份列表又高又挤。
  assert.match(source, /source\.className = "piopt-mp-source";/);
  assert.match(source, /\.piopt-mp-source\{flex:0 1 auto;min-width:0;max-width:42%/);
  assert.doesNotMatch(source, /flex:1 0 100%/);
});

test("选中行在四种排列下共用同一套标记", () => {
  const source = read("renderer/model-picker.mjs");
  // 宿主给每一行都画勾位（选中时才有那枚勾），重建出来的行照抄这一套。
  assert.match(source, /item\.setAttribute\("aria-checked", String\(row\.active === true\)\);/);
  assert.match(source, /if \(row\.active\) item\.classList\.add\("active"\);/);
  assert.match(source, /if \(row\.active\) slot\.innerHTML = checkMarkup\(\);/);
  // 换选一行只改视图里的三处，不整份重建。
  assert.match(source, /function markSelected\(key\)/);
  assert.match(source, /const slot = item\.querySelector\(CHECK_SLOT_SELECTOR\);/);
});

test("分组视图把每个模型分回它的组，并按 A–Z 排序", () => {
  const source = read("renderer/model-picker.mjs");
  // 按供应商 / 按厂商共用一份分组视图：分组名排序、组内也排序。
  assert.match(source, /function groupedView\(rows, keyOf\)/);
  assert.match(source, /\.sort\(\(left, right\) => compareNames\(left\[0\], right\[0\]\)\)/);
  assert.match(source, /bucket\.slice\(\)\.sort\(compareRows\)/);
  // 按厂商：FAMILIES 的 label 就是分组名，认不出就落到供应商名下。
  assert.match(source, /function vendorOf\(row\)/);
  assert.match(source, /return family \? family\.label : \(row\.provider \|\| row\.label\);/);
  assert.match(source, /for \(const group of groupedView\(rows, vendorOf\)\)/);
  assert.match(source, /for \(const group of groupedView\(rows, \(row\) => row\.provider \|\| row\.label\)\)/);
  // 分组标题沿用宿主的类名：视图里去掉底色与模糊，只在吸顶时给文字罩一枚圆角小块，
  // 免得滚过去的行和标题叠在一起，也不拉一条整行的色带。
  assert.match(
    source,
    /\.composer-model-menu\[\$\{EXPANDED_ATTR\}\] \.\$\{VIEW_CLASS\} \.composer-model-group-label\{background:transparent;background-image:none;-webkit-backdrop-filter:none;backdrop-filter:none;container-type:scroll-state\}/
  );
  assert.match(source, /const GROUP_TITLE_CLASS = "piopt-mp-group-title";/);
  assert.match(source, /title\.className = GROUP_TITLE_CLASS;/);
  assert.match(source, /\.\$\{GROUP_TITLE_CLASS\}\{display:inline-block;padding:2px 6px;margin:-2px -6px;border-radius:6px\}/);
  assert.ok(source.includes("@container scroll-state(stuck: top)"));
});

test("「默认」排列按左栏的顺序原样平铺", () => {
  const source = read("renderer/model-picker.mjs");
  const branch = source.slice(source.indexOf('if (grouping === "default") {'));
  const body = branch.slice(0, branch.indexOf("} else if"));
  // 行序就是逐格读出来的顺序：设置里怎么排就怎么排，一个不分组、也不按名字重排。
  assert.match(body, /for \(const row of rows\) view\.append\(buildRow\(row, true\)\);/);
  assert.doesNotMatch(body, /buildGroup\(/);
  assert.doesNotMatch(body, /compareRows/);
  assert.doesNotMatch(body, /\.sort\(/);
  // 平铺之后没有抬头写着供应商，所以每行都补一枚来源。
  assert.match(body, /buildRow\(row, true\)/);
});

test("完整清单按左栏逐格读出并缓存", () => {
  const source = read("renderer/model-picker.mjs");
  // 清单按「左栏指纹」整份缓存：宿主的分页一次只给一组，每次打开都全点一遍太贵。
  assert.match(source, /const ROWS_STORAGE_KEY = "piopt\.modelPicker\.rows\.v1";/);
  assert.match(source, /function railSignature\(list\)/);
  assert.match(source, /function needsCollect\(list\)/);
  assert.match(source, /function sectionStale\(list\)/);
  // 点一次左栏之后，用它判断宿主的下一格已经画好了（「最近使用」那一格没有组名）。
  assert.match(source, /function paneSignature\(list\)/);
  assert.match(source, /await waitFor\(\(\) => paneSignature\(list\) !== before\);/);
  assert.match(source, /async function collectHidden\(list\)/);
  assert.match(source, /rowsStore = merged;/);
  // 用户在打字时不去点左栏：换一格会把他刚写的查询清掉。
  assert.match(source, /function searching\(list\)/);
  assert.match(source, /if \(searching\(list\)\) break;/);
  // 打开浮窗时缺清单就先在隐藏状态下读完，再让人看见内容。
  assert.match(source, /if \(list && read\) void collectHidden\(list\);/);
});

test("来源跟着名称走，不另起一行", () => {
  const source = read("renderer/model-picker.mjs");
  assert.match(source, /if \(showSource && row\.provider\) \{/);
  assert.match(source, /source\.setAttribute\(PROVIDER_ATTR, row\.provider\);/);
  assert.match(source, /main\.append\(source\);/);
  // 旧写法把来源铺成第二行（flex:1 0 100% 的伪元素），那正是「又高又挤」的来源。
  assert.doesNotMatch(source, /option-main\[\$\{PROVIDER_ATTR\}\]/);
});

test("排列方式在搜索框外面，四个选项点哪个是哪个", () => {
  const source = read("renderer/model-picker.mjs");
  assert.match(source, /const MODES_CLASS = "piopt-mp-modes";/);
  assert.match(source, /const MODE_CLASS = "piopt-mp-mode";/);
  assert.match(source, /const MODE_ATTR = "data-piopt-mp-mode";/);
  // 挂在根节点里、紧跟搜索框之后：不再塞进搜索框内部。
  assert.match(source, /const root = menuElement\.querySelector\(ROOT_SELECTOR\)/);
  assert.match(source, /search\.after\(bar\)/);
  assert.doesNotMatch(source, /search\.append\(/);
  // 四种模式一轮渲染，点击直接切到那一种。
  assert.match(source, /for \(const mode of GROUPINGS\) \{/);
  assert.match(source, /void setGrouping\(mode\)/);
  assert.match(source, /button\.setAttribute\("aria-pressed", String\(grouping === mode\)\)/);
  // 文案跟随宿主 locale。
  assert.match(source, /function copyOf\(\)/);
  assert.match(source, /document\.documentElement\.lang/);
});
test("the injected rules key off the attributes the module writes", () => {
  const source = read("renderer/model-picker.mjs");
  for (const attribute of [
    "data-piopt-mp-expanded",
    "data-piopt-mp-searching",
    "data-piopt-mp-layout",
    "data-piopt-mp-provider",
  ]) {
    assert.ok(source.includes(attribute), attribute);
  }
  // 左栏与原生分页一起让位：自建视图一次列出全部模型。
  assert.ok(source.includes("[${EXPANDED_ATTR}] .composer-model-rail{display:none}"), "左栏让位");
  assert.ok(
    source.includes("[${EXPANDED_ATTR}] .composer-model-body[data-rail]{display:block}"),
    "列表拿回整行宽度"
  );
  // 自建视图让位给宿主搜索结果，但不用 revert 抹掉宿主自己的 display。
  assert.ok(source.includes(':not([${SEARCH_ATTR}="true"])'), "自建视图按搜索属性让位");
  assert.doesNotMatch(source, /display:revert/);
});

test("the panel writes the two popup rewrites through setOptions", async () => {
  const fake = makePi({ [modelPicker.SETTINGS_KEY]: { grouping: "vendor", frameSelected: false } });
  const feature = loadFeature(fake);
  try {
    await feature.onLoad();
    const framed = await feature.onPanelInvoke("behavior.modelPicker.setOptions", { frameSelected: true });
    assert.equal(framed.ok, true);
    assert.equal(framed.config.frameSelected, true);
    assert.equal(framed.config.translateThinking, false);
    assert.equal(framed.config.grouping, "vendor");
    assert.deepEqual(fake.store[modelPicker.SETTINGS_KEY], { grouping: "vendor", frameSelected: true, translateThinking: false });

    // 关回去、再开中文：两个开关各自独立，互不覆盖。
    const translated = await feature.onPanelInvoke("behavior.modelPicker.setOptions", {
      frameSelected: false,
      translateThinking: true,
    });
    assert.deepEqual(translated.config, {
      grouping: "vendor",
      frameSelected: false,
      translateThinking: true,
      entryActions: false,
      commandButton: false,
      openSessionOutput: false,
    });
    assert.deepEqual(fake.store[modelPicker.SETTINGS_KEY], { grouping: "vendor", frameSelected: false, translateThinking: true });
  } finally {
    delete global.pi;
  }
});

test("the behavior view is the second switchboard for the same settings", () => {
  const view = read("renderer/behavior.js");
  assert.match(view, /window\.PiOptBehavior = \{ boot \}/);
  assert.match(view, /const CHANNEL = "behavior\.modelPicker";/);
  // 排列方式在这一屏也是可点的四选一：与浮窗里那条切换写同一个值。
  assert.match(view, /`\$\{CHANNEL\}\.setGrouping`/);
  assert.match(view, /const GROUPINGS = \["default", "provider", "vendor", "name"\];/);
  assert.match(view, /button\.setAttribute\("aria-pressed", String\(button\.dataset\.grouping === config\.grouping\)\)/);
  // 两项改写走 setOptions，各写各的字段。
  assert.match(view, /`\$\{CHANNEL\}\.setOptions`, \{ frameSelected: elements\.frame\.checked \}/);
  assert.match(view, /`\$\{CHANNEL\}\.setOptions`, \{ translateThinking: elements\.thinking\.checked \}/);
  assert.match(view, /`\$\{CHANNEL\}\.setOptions`, \{ entryActions: elements\.entries\.checked \}/);
  // 与外观视图一致：脚本只导出 boot，不自己跑起来。
  assert.equal(view.trimEnd().endsWith("})();"), true);
  assert.doesNotMatch(view, /\bboot\(\);\s*$/m);
});

test("the behavior screen offers four arrangements on the right and three switches", () => {
  const html = read("renderer/index.html");
  const section = html.slice(html.indexOf('id="view-behavior"'), html.indexOf('id="view-remote"'));
  // 右侧是一组分段按钮，四个都在，一个不少也一个不多。
  assert.match(section, /<div class="segmented" role="group" aria-label="排列方式" id="behavior-grouping">/);
  for (const grouping of ["default", "provider", "vendor", "name"]) {
    assert.ok(section.includes(`data-grouping="${grouping}"`), grouping);
  }
  assert.equal((section.match(/data-grouping="/g) || []).length, 4);
  // 三项改写各是一个开关行，input 与标题一一对应。
  assert.match(section, /<label class="settings-row switch-row" for="behavior-frame">/);
  assert.match(section, /<input id="behavior-frame" type="checkbox" \/>/);
  assert.match(section, /<label class="settings-row switch-row" for="behavior-thinking-zh">/);
  assert.match(section, /<input id="behavior-thinking-zh" type="checkbox" \/>/);
  // 窗口入口那一个开关单独一段：它改的是侧边栏头部，与模型浮窗无关。
  assert.match(section, /<label class="settings-row switch-row" for="behavior-entry-actions">/);
  assert.match(section, /<input id="behavior-entry-actions" type="checkbox" \/>/);
  assert.match(section, /<span class="settings-row-title">调整功能入口<\/span>/);
  // 只读的旧值不再出现：那一格现在是控件本身。
  assert.doesNotMatch(section, /behavior-value/);
  // 行为这一屏自带分段控件与开关的样式（外观那一套是 @scope 锁在别处的）。
  const css = read("renderer/behavior.css");
  assert.match(css, /\.segmented \{/);
  assert.match(css, /\.segmented button\[aria-pressed="true"\] \{/);
  assert.match(css, /\.switch-row input:checked \+ \.switch \{ background: var\(--ds-accent\); \}/);
});

test("行为设置按作用区域分组", () => {
  const html = read("renderer/index.html");
  const composer = html.slice(html.indexOf('aria-labelledby="behavior-composer-title"'), html.indexOf('aria-labelledby="behavior-entry-title"'));
  const entries = html.slice(html.indexOf('aria-labelledby="behavior-entry-title"'), html.indexOf('id="view-remote"'));
  for (const id of ["behavior-grouping", "behavior-frame", "behavior-thinking-zh", "behavior-command-button"]) assert.ok(composer.includes(`id="${id}"`));
  assert.ok(entries.includes('id="behavior-entry-actions"'));
  for (const id of ["behavior-grouping", "behavior-frame", "behavior-thinking-zh", "behavior-command-button", "behavior-entry-actions"]) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  }
});

test("the entry mounts the popup rewrite with its own lifecycle", () => {
  const entry = read("renderer/entry.mjs");
  assert.match(entry, /import \{ MODEL_PICKER_CSS, mountModelPicker, unmountModelPicker \} from "\.\/model-picker\.mjs";/);
  assert.match(entry, /MODEL_PICKER_CSS,/);
  assert.match(entry, /await mountModelPicker\(pi\)/);
  assert.match(entry, /unmountModelPicker\(\)/);
  // 窗口入口那一层与它同一个生命周期：同一个窗口、同一份样式。
  assert.match(entry, /import \{ NAV_ENTRIES_CSS, mountNavEntries, unmountNavEntries \} from "\.\/nav-entries\.mjs";/);
  assert.match(entry, /NAV_ENTRIES_CSS,/);
  assert.match(entry, /mountNavEntries\(pi\)/);
  assert.match(entry, /unmountNavEntries\(\)/);
});

test("the brand icon table ships inside the plugin and is safe to inline", async () => {
  const icons = await import("../renderer/model-logos/icons.mjs");
  const ids = Object.keys(icons.ICONS);
  // 常见几家必须覆盖；新增品牌在 tools/build-model-icons.js 的表里加一行再生成。
  for (const id of [
    "claude", "anthropic", "openai", "gemini", "deepseek", "zhipu", "qwen", "kimi",
    "minimax", "mistral", "meta", "openrouter", "doubao", "hunyuan", "azure",
  ]) {
    assert.ok(ids.includes(id), id);
  }
  // Claude 是自家那朵菊花，Anthropic 是 A 标：两个图标不能是同一张图。
  assert.match(icons.ICONS.claude, /M4\.709 15\.955/);
  assert.doesNotMatch(icons.ICONS.claude, /M13\.827 3\.52/);
  assert.match(icons.ICONS.anthropic, /M13\.827 3\.52/);
  // 混元是那颗蓝球。
  assert.match(icons.ICONS.hunyuan, /<circle[^>]*#0055E9/);
  for (const [id, svg] of Object.entries(icons.ICONS)) {
    assert.ok(svg.startsWith("<svg"), id);
    assert.ok(svg.endsWith("</svg>"), id);
    // 没有标题、没有内联尺寸：尺寸由 CSS 决定。
    assert.doesNotMatch(svg, /<title>/, id);
    assert.doesNotMatch(svg, /(?:height|width)="1em"/, id);
    // 渐变/裁切的 id 必须带品牌前缀，否则同一屏里两个同品牌图标会互相覆盖。
    for (const match of svg.matchAll(/\sid="([^"]+)"/g)) {
      assert.ok(match[1].startsWith(`piopt-${id}-`), `${id}: ${match[1]}`);
    }
  }
});

test("the popup picks an icon by model name first, then by provider", () => {
  const source = read("renderer/model-picker.mjs");
  assert.match(source, /import \{ ICONS \} from "\.\/model-logos\/icons\.mjs";/);
  assert.match(source, /const FAMILIES = \[/);
  assert.match(source, /for \(const family of FAMILIES\) if \(family\.test\.test\(model\)\) return family;/);
  assert.match(source, /for \(const family of FAMILIES\) if \(family\.test\.test\(provider\)\) return family;/);
  // Claude 的菊花排在 Anthropic 的 A 标前面：名字里带 claude/sonnet/opus/haiku 都先吃菊花。
  const claudeRule = source.indexOf('icon: "claude"');
  const anthropicRule = source.indexOf('icon: "anthropic"');
  assert.ok(claudeRule > 0 && anthropicRule > claudeRule, "claude 规则必须在 anthropic 之前");
  // 匹配是按名字里的关键字族做的，未来同族的新版本（gpt-6、claude-5…）照样命中。
  assert.match(source, /claude\|sonnet\|opus\|haiku/);
  assert.match(source, /gemini\|gemma\|bard\|palm\|google/);
  // 中文供应商名（腾讯混元）也要命中，否则只能看到首字母块。
  assert.match(source, /hunyuan\|tencent\|混元\|腾讯/);
  // 认不出来就画供应商首字母，新服务上线也不至于空着。
  assert.match(source, /classList\.add\("piopt-mp-logo-letter"\)/);
  assert.match(source, /--piopt-logo/);
  // 图标和名称进同一个 lead，间距 6px。
  assert.match(source, /lead\.className = "piopt-mp-lead"/);
  assert.match(source, /lead\.append\(buildLogo\(row\), label\)/);
  assert.match(source, /\.piopt-mp-logo\{flex:none;width:14px;height:14px/);
});

test("每行的徽标与上下文读数都来自宿主自己的分组行", () => {
  const source = read("renderer/model-picker.mjs");
  // 供应商分组里宿主把徽标（推理 / 视觉）与上下文读写画全了：直接读那一行，
  // 不必再借一次隐藏搜索把它们问出来。
  assert.match(source, /const meta = option\.querySelector\(META_SELECTOR\);/);
  assert.match(source, /meta: meta \? meta\.innerHTML : "",/);
  // 读到的整份清单按「左栏指纹」缓存，下次打开直接用。
  assert.match(source, /const ROWS_STORAGE_KEY = "piopt\.modelPicker\.rows\.v1";/);
  assert.match(source, /function saveRows\(\)/);
  // 读的过程中内容藏起来，布局不动。
  assert.match(source, /const PROBING_ATTR = "data-piopt-mp-probing";/);
  assert.match(source, /`\.composer-model-menu\[\$\{PROBING_ATTR\}\] \.composer-menu-root\{visibility:hidden\}`/);
  // 宿主的渲染跟不上也不能一直白着：等一格最多 400ms，超时就按现状继续。
  assert.match(source, /const SECTION_TIMEOUT_MS = 400;/);
  assert.match(source, /function waitFor\(predicate, ms = SECTION_TIMEOUT_MS\)/);
  assert.match(source, /await waitFor\(\(\) => paneSignature\(list\) !== before\);/);
});

// ------------------------------------------------- 选中标记与推理强度（浮窗侧）

test("选中标记换成圆角框时只换画法，不动宿主的节点", () => {
  const source = read("renderer/model-picker.mjs");
  // 属性挂在浮窗上，样式按它决定画勾还是画框。
  assert.match(source, /const MARKER_ATTR = "data-piopt-mp-marker";/);
  assert.match(source, /if \(frameSelected\) target\.setAttribute\(MARKER_ATTR, "frame"\);/);
  assert.match(source, /else target\.removeAttribute\(MARKER_ATTR\);/);
  // 框是画在行里的内描边：不新增节点，也不动行高与内边距。
  assert.match(
    source,
    /\.composer-model-menu\[\$\{MARKER_ATTR\}="frame"\] \.composer-model-option\[aria-checked="true"\]\{box-shadow:inset 0 0 0 2px color-mix\(in oklab,var\(--ds-accent\) 64%,transparent\)\}/
  );
  // 勾是被藏掉的，不是被删掉的：勾位留着原来的 13px，行宽不因此跳动。
  assert.match(
    source,
    /\[aria-checked="true"\] \$\{CHECK_SLOT_SELECTOR\} svg\{display:none\}/
  );
});

test("推理强度档位译成中文，原文留在属性里", () => {
  const source = read("renderer/model-picker.mjs");
  // 宿主那套档位全在表里，包括 omit（不发送这个参数、由模型自己决定）。
  const table = source.slice(source.indexOf("const LEVEL_COPY = {"), source.indexOf("};", source.indexOf("const LEVEL_COPY = {")));
  for (const [level, label] of [
    ["off", "关闭"], ["omit", "默认"], ["minimal", "极低"], ["low", "低"],
    ["medium", "中"], ["high", "高"], ["xhigh", "极高"], ["max", "最高"],
  ]) {
    assert.ok(table.includes(`${level}: "${label}"`), `${level} -> ${label}`);
  }
  assert.match(source, /function localizeThinking\(menuElement\)/);
  // 只动刻度按钮；滑杆里那排装饰圆点不动（它们是 aria-hidden 的圆点，塞字只会挤出来）。
  assert.match(source, /const THINKING_TICK_SELECTOR = "\.composer-thinking-tick";/);
  assert.doesNotMatch(source, /composer-thinking-dot"\);?\s*$/m);
  // 原文写回属性，重复调用不会把中文再翻一遍；认不出的档位也要写回（样式靠它判断
  // 这一格处理过了，不写就会被一直藏着）。
  assert.match(source, /const raw = rawLevelOf\(tick\);/);
  assert.match(source, /if \(tick\.getAttribute\(LEVEL_ATTR\) !== raw\) tick\.setAttribute\(LEVEL_ATTR, raw\);/);
  assert.match(source, /if \(textOf\(tick\) !== label\) tick\.textContent = label;/);
  // 宿主重渲染会把英文写回来：文本认识就算新的原文，否则原文还在属性里。
  assert.match(source, /return LEVEL_COPY\[text\.toLowerCase\(\)\] \? text : \(stored \|\| text\);/);
  // range 的 aria-valuetext 跟刻度是同一档：读屏念中文。
  assert.match(source, /range\.setAttribute\("aria-valuetext", label\)/);
  // 开关关着就一个字都不碰；关掉时把英文还回去。
  assert.match(source, /if \(translateThinking\) \{/);
  assert.match(source, /target\.setAttribute\(LEVELS_ATTR, "zh"\);/);
  assert.match(source, /for \(const tick of target\.querySelectorAll\(THINKING_TICK_SELECTOR\)\) restoreLevel\(tick\);/);
});

test("发送键左边的 chip 也译成中文，而且不先闪一帧英文", () => {
  const source = read("renderer/model-picker.mjs");
  // chip 在浮窗外面：单独找它、单独换绑。
  assert.match(source, /const CHIP_SELECTOR = "\.composer-model-thinking-chip";/);
  assert.match(source, /const CHIP_LEVEL_SELECTOR = "\.composer-model-thinking-level";/);
  assert.match(source, /const chip = document\.querySelector\(CHIP_SELECTOR\);/);
  assert.match(source, /const level = chip\.querySelector\(CHIP_LEVEL_SELECTOR\);/);
  // 盯整枚 chip 而不是那枚 span：React 换档时可能把里面的 span 整个换掉，
  // 盯 span 会盯到一个已经不在文档里的节点，之后就不再有任何回调。
  assert.match(source, /chipObserver\.observe\(chip, \{ childList: true, characterData: true, subtree: true \}\);/);
  assert.match(source, /const next = chip\.querySelector\(CHIP_LEVEL_SELECTOR\);/);
  assert.doesNotMatch(source, /chipObserver\.observe\(level,/);
  // 从面板切回来、窗口重新获得焦点时补一眼（那时设置才刚写进去）。
  assert.match(source, /document\.addEventListener\("focusin", onAttention, true\);/);
  assert.match(source, /window\.addEventListener\("focus", onAttention\);/);
  // 刻度在译文写完之前先藏着：菜单一挂上 zh，没处理过的格子就是 visibility:hidden。
  assert.match(source, /const LEVELS_ATTR = "data-piopt-mp-levels";/);
  assert.ok(source.includes(`.composer-model-menu[\${LEVELS_ATTR}="zh"] .composer-thinking-tick:not([\${LEVEL_ATTR}]){visibility:hidden}`));
  // 滑杆那块的变化在观察者里同步译完，不排进 40ms 之后的重建；而且整批扫完才决定
  // 要不要重建 —— 半路 return 会把同一批里的滑杆记录丢掉（拖动时就漏成英文）。
  assert.match(source, /if \(touchesThinking\(record\)\) \{/);
  assert.match(source, /if \(translateThinking\) localizeThinking\(element\);/);
  assert.match(source, /let needsSync = false;/);
  assert.match(source, /if \(needsSync\) scheduleSync\(\);/);
  // chip 每一批都补看一眼（它不在浮窗这棵子树里）。
  assert.match(source, /if \(translateThinking\) syncChip\(\);/);
});

test("两项改写与排列方式一起从主进程读回来", () => {
  const source = read("renderer/model-picker.mjs");
  assert.match(source, /async function refreshConfig\(\)/);
  assert.match(source, /const nextFrame = config\.frameSelected === true;/);
  assert.match(source, /const nextTranslate = config\.translateThinking === true;/);
  assert.match(source, /void refreshConfig\(\);/);
  assert.match(source, /return refreshConfig\(\);/);
  // 滑杆是宿主自己的另一块：它的高亮/译文变化不该触发整份重建。
  assert.match(source, /function touchesThinking\(record\)/);
  assert.match(source, /if \(closestOf\(record\.target, THINKING_SLIDER_SELECTOR\)\) return true;/);
});

test("command button setting persists independently", async () => {
  const fake = makePi();
  const feature = loadFeature(fake);
  try {
    await feature.onLoad();
    assert.equal(feature.getState().config.commandButton, false);
    await feature.setOptions({ commandButton: true });
    assert.equal(fake.store.commandButton, true);
    assert.equal(fake.store.modelPicker, undefined);
    await feature.onLoad();
    assert.equal(feature.getState().config.commandButton, true);
    await feature.setOptions({ commandButton: false });
    assert.equal(fake.store.commandButton, false);
  } finally { delete global.pi; }
});

test("command button mounts and cleans up", async () => {
  const listeners = {};
  const toolbar = { lastElementChild: null, append(node) { this.lastElementChild = node; node.parentElement = this; } };
  const doc = { documentElement: {}, querySelector: () => toolbar, addEventListener() {}, removeEventListener() {},
    createElement() { return { setAttribute() {}, removeAttribute() {}, addEventListener(type, fn) { listeners[type] = fn; }, remove() { if (this.parentElement) this.parentElement.lastElementChild = null; this.parentElement = null; } }; } };
  const oldDoc = global.document, oldWindow = global.window;
  global.document = doc;
  global.window = { addEventListener() {}, removeEventListener() {} };
  const calls = [];
  const pi = { dispatch(action, payload) { calls.push([action, payload]); return action === 'plugin.call' ? { config: { commandButton: true } } : { ok: true }; } };
  try {
    const module = await import('../renderer/command-button.mjs');
    await module.mountCommandButton(pi);
    assert.ok(toolbar.lastElementChild);
    assert.equal(toolbar.lastElementChild.className, 'icon-btn mode-chip');
    assert.match(toolbar.lastElementChild.innerHTML, /<svg.*指令/);
    assert.equal(toolbar.lastElementChild.title, undefined);
    module.unmountCommandButton();
    assert.equal(toolbar.lastElementChild, null);
  } finally { global.document = oldDoc; global.window = oldWindow; }
});
