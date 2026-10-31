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
  assert.deepEqual(modelPicker.GROUPINGS, ["provider", "vendor", "name"]);
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
    assert.deepEqual(feature.getState().groupings, ["provider", "vendor", "name"]);

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
  assert.doesNotMatch(source, /row\.option\.remove\(\)/);
  // 点击克隆行只是转交给原生按钮，选中模型仍走宿主自己的逻辑。
  assert.match(source, /row\.option\.click\(\)/);
  // 宿主的折叠入口（其他模型）只点一次，随后被样式藏掉。
  assert.match(source, /aria-expanded/);
});

test("最近使用的行不再把来源写在右边", () => {
  const source = read("renderer/model-picker.mjs");
  // 最近使用那一组的 meta 就是来源文本：克隆时整块摘掉。
  assert.match(source, /if \(row\.recent\) \{/);
  assert.match(source, /meta\.remove\(\)/);
  // 按名称时来源改由下方那行淡字承担（CSS 里用 data-piopt-mp-provider 画）。
  assert.match(source, /::after\{content:attr\(\$\{PROVIDER_ATTR\}\)/);
  assert.match(source, /flex:1 0 100%/);
});

test("最近使用的选中行跟分组里的选中行长一个样", () => {
  const source = read("renderer/model-picker.mjs");
  // 宿主只给分组里的选中行挂 active，那枚勾也只在这一路带 composer-model-check；
  // 「最近使用」那一组的选中行两样都没有，于是选中时上下文读数停在淡色、勾停在
  // 次要文字色。克隆行把这两个类补上，选中态在三种排列下才一致。
  assert.match(source, /if \(item\.getAttribute\("aria-checked"\) === "true"\)/);
  assert.match(source, /item\.classList\.add\("active"\)/);
  assert.match(source, /check\.classList\.add\("composer-model-check"\)/);
});

test("分组视图把最近使用的模型并回分组，并按 A–Z 排序", () => {
  const source = read("renderer/model-picker.mjs");
  // 按供应商 / 按厂商共用一份分组视图：分组名排序、组内也排序。
  assert.match(source, /function groupedView\(rows, keyOf\)/);
  assert.match(source, /\.sort\(\(left, right\) => compareNames\(left\[0\], right\[0\]\)\)/);
  assert.match(source, /bucket\.slice\(\)\.sort\(compareRows\)/);
  // 最近使用过的行已经在 rows 里，不再单独插到某个位置。
  assert.doesNotMatch(source, /insertSorted/);
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


test("排列方式在搜索框外面，三个选项点哪个是哪个", () => {
  const source = read("renderer/model-picker.mjs");
  assert.match(source, /const MODES_CLASS = "piopt-mp-modes";/);
  assert.match(source, /const MODE_CLASS = "piopt-mp-mode";/);
  assert.match(source, /const MODE_ATTR = "data-piopt-mp-mode";/);
  // 挂在根节点里、紧跟搜索框之后：不再塞进搜索框内部。
  assert.match(source, /const root = menuElement\.querySelector\("\.composer-menu-root"\)/);
  assert.match(source, /search\.after\(bar\)/);
  assert.doesNotMatch(source, /search\.append\(/);
  // 三种模式一轮渲染，点击直接切到那一种。
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
  // 折叠入口藏在 `.composer-model-list` 的直接子级里，「其他模型」是它的类名。
  assert.match(
    source,
    /\.composer-model-menu\[\$\{EXPANDED_ATTR\}\] \.composer-model-list > \.\$\{COLLAPSE_CLASS\}\{display:none\}/
  );
  // 自建视图让位给宿主搜索结果，但不用 revert 抹掉宿主自己的 display。
  assert.ok(source.includes(':not([${SEARCH_ATTR}="true"])'), "自建视图按搜索属性让位");
  assert.doesNotMatch(source, /display:revert/);
});

test("the behavior view boots from one hook and only reports the value", () => {
  const view = read("renderer/behavior.js");
  assert.match(view, /window\.PiOptBehavior = \{ boot \}/);
  assert.match(view, /const CHANNEL = "behavior\.modelPicker";/);
  // 排列方式在浮窗里切换：面板不写，避免同一个设置有两个开关。
  assert.doesNotMatch(view, /setGrouping/);
  assert.match(view, /GROUPING_COPY/);
  // 与外观视图一致：脚本只导出 boot，不自己跑起来。
  assert.equal(view.trimEnd().endsWith("})();"), true);
  assert.doesNotMatch(view, /\bboot\(\);\s*$/m);
});

test("the entry mounts the popup rewrite with its own lifecycle", () => {
  const entry = read("renderer/entry.mjs");
  assert.match(entry, /import \{ MODEL_PICKER_CSS, mountModelPicker, unmountModelPicker \} from "\.\/model-picker\.mjs";/);
  assert.match(entry, /MODEL_PICKER_CSS,/);
  assert.match(entry, /await mountModelPicker\(pi\)/);
  assert.match(entry, /unmountModelPicker\(\)/);
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

test("最近使用的行补上能力标记，而不是在右边写来源", () => {
  const source = read("renderer/model-picker.mjs");
  // 来源（宿主写在最近使用行右侧的供应商名）被换成缓存下来的 meta。
  assert.match(source, /const cached = caps\(\)\.get\(row\.key\);/);
  assert.match(source, /meta\.replaceWith\(replacement\)/);
  // 数据来自宿主自己的另一次渲染：搜索时它会把这些模型连同徽标与上下文画出来。
  assert.match(source, /async function probeCaps\(list\)/);
  assert.match(source, /harvestCaps\(list\)/);
  // React 受控输入要用原生 setter + input 事件才会更新查询。
  assert.match(source, /Object\.getOwnPropertyDescriptor\(window\.HTMLInputElement\.prototype, "value"\)/);
  assert.match(source, /dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/);
  // 探测期间内容藏起来，布局不动；结果按供应商␟模型 id 缓存。
  assert.match(source, /const CAPS_STORAGE_KEY = "piopt\.modelPicker\.capabilities\.v1";/);
  assert.match(source, /const PROBING_ATTR = "data-piopt-mp-probing";/);
  assert.match(source, /`\.composer-model-menu\[\$\{PROBING_ATTR\}\] \.composer-menu-root\{visibility:hidden\}`/);
  // 用户在搜的时候别抢输入框；第一个模型就等到不响应就彻底放弃，不再重试。
  assert.match(source, /if \(input\.value !== owned\) return;/);
  assert.match(source, /if \(index === 0\) probeUnsupported = true;/);
});
