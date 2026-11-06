"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("manifest.json"));

test("manifest declares the merged PiOpt identity and panel", () => {
  assert.equal(manifest.id, "local.piopt");
  assert.equal(manifest.main, "main.js");
  assert.ok(fs.existsSync(path.join(root, manifest.ui.panel)));
  assert.ok(manifest.categories.includes("appearance"));
});

test("manifest keeps every feature command set", () => {
  // One command per feature entry point; motion and glass share the appearance
  // view but keep their own command, so the command palette is unchanged.
  const ids = manifest.contributes.commands.map((item) => item.id);
  assert.deepEqual(ids, [
    "piopt.open",
    "pimarket.open",
    "pimarket.prepare-updates",
    "pi-modify.open",
    "piopt.glass",
    "remote.open",
  ]);
  // A command still runs after onStartup without an activation event, but the
  // two lists describe one surface and are meant to stay in step.
  for (const id of ids) assert.ok(manifest.activationEvents.includes(`onCommand:${id}`), id);
});

test("manifest unions the feature permissions without fs access", () => {
  for (const permission of ["ui.panel", "ui.theme", "net.fetch", "agent.tool.register"]) {
    assert.ok(manifest.permissions.includes(permission), permission);
  }
  assert.equal(manifest.permissions.some((item) => item.startsWith("fs.")), false);
  assert.ok(manifest.net.domains.includes("cdn.jsdelivr.net"));
});

test("agent tools and settings survive the merge", () => {
  const tools = manifest.contributes.agentTools.map((item) => item.name).sort();
  assert.deepEqual(tools, [
    "list_plugin_updates",
    "prepare_plugin_update",
    "remote_control",
    "remote_status",
  ]);
  const keys = manifest.contributes.settings.map((item) => item.key).sort();
  assert.deepEqual(keys, ["dataDir", "mirrorRef", "mirrorRepo"]);
  assert.deepEqual(manifest.contributes.skills, ["skills/piopt.md"]);
});

test("host routes panel channels to the owning feature", () => {
  const entry = require("../main.js");
  assert.equal(entry._featureFor("market.snapshot"), entry._features.market);
  // 行为那一层只有一个通道组：模型浮窗的排列方式。
  assert.equal(entry._featureFor("behavior.modelPicker.getState"), entry._features.behavior);
  // Motion and the material are one feature: one owner for both halves, under
  // the merged prefix and under the names they had before the merge.
  for (const channel of ["appearance.motion.apply", "appearance.glass.apply", "motion.apply", "glass.getState"]) {
    assert.equal(entry._featureFor(channel), entry._features.appearance, channel);
  }
  assert.equal(entry._featureFor("unknown.channel"), null);
  assert.equal(entry._featureFor(undefined), null);
});

test("every feature is composed by the host entry", () => {
  const entry = require("../main.js");
  for (const name of ["market", "appearance", "behavior", "remote"]) {
    assert.ok(entry._features[name], name);
  }
  // Motion and the material are one feature, so there is nothing left to wire
  // between them: the stylesheet is built in one place and neither half imports
  // the other's lifecycle.
  assert.equal(entry._features.motion, undefined);
  assert.equal(entry._features.glass, undefined);
  const appearance = read("features/appearance/index.js");
  assert.match(appearance, /const motion = require\("\.\/motion\.js"\)/);
  assert.match(appearance, /const glass = require\("\.\/glass\.js"\)/);
  assert.doesNotMatch(read("main.js"), /bindTheme/);
});

test("panel loads shared tokens, scoped feature styles and every feature", () => {
  const html = read("renderer/index.html");
  for (const asset of [
    "./tokens.css",
    "./base.css",
    "./market.css",
    "./appearance.css",
    "./behavior.css",
    "./market.js",
    "./appearance.js",
    "./behavior.js",
    "./shell.js",
  ]) {
    assert.ok(html.includes(asset), asset);
  }
  assert.equal(/<script>/.test(html), false, "inline scripts would share one global scope");
  assert.match(html, /id="view-market"/);
  assert.match(html, /id="view-appearance"/);
  // 行为那一屏只念当前值：切换按钮在浮窗里，面板不再放第二个开关。
  assert.match(html, /id="view-behavior"[^>]*>\s*<main class="workspace">/);
  assert.match(html, /id="behavior-grouping"/);
  assert.doesNotMatch(html, /data-model-grouping/);
  // One view, two sections: motion and the material are not separate panels.
  assert.match(html, /id="section-motion"/);
  assert.match(html, /id="section-glass"/);
  assert.doesNotMatch(html, /id="view-motion"/);
  assert.doesNotMatch(html, /id="view-glass"/);
  // 远程屏是一页设置式界面，内容由 remote.js 渲染，HTML 里只留空壳。
  assert.match(html, /id="view-remote"[^>]*><\/section>/);
});

test("panel opts into the paint-through chrome that has no development hint", () => {
  const html = read("renderer/index.html");
  // v2 panels get the host's "top 46px is drag-only" dev hint; v3 does not.
  assert.match(html, /<meta name="pi-plugin-chrome" content="v3" \/>/);
  // The strip still reserves the host band and stays draggable on its own.
  const css = read("renderer/base.css");
  assert.match(css, /grid-template-rows: 46px/);
  assert.match(css, /\.opt-dragbar \{[^}]*-webkit-app-region: drag/);
});

test("panel text is chrome, not a document: only copied values stay selectable", () => {
  const css = read("renderer/base.css");
  // Labels, stats and chips are marked up with the same spans as the copy they
  // sit next to, so the rule has to be root-wide instead of per-component.
  assert.match(css, /body \{[^}]*-webkit-user-select: none;/);
  assert.match(css, /body \{[^}]*\n  user-select: none;/);
  // The values a user actually carries away stay selectable.
  const allow = css.slice(css.search(/input,\s+textarea,/));
  assert.match(allow, /-webkit-user-select: text;/);
  for (const selector of [
    "input,",
    "textarea,",
    "code,",
    "pre,",
    ".kvrow .v,",
  ]) {
    assert.ok(allow.includes(selector), `${selector} must stay selectable`);
  }
  // The sidebar entry is one row of host chrome; dragging it selects nothing.
  assert.match(read("renderer/entry.mjs"), /cursor:pointer;user-select:none;-webkit-user-select:none/);
});

test("feature styles are scoped so the views cannot collide", () => {
  assert.match(read("renderer/market.css"), /@scope \(#view-market\)/);
  assert.match(read("renderer/appearance.css"), /@scope \(#view-appearance\)/);
  assert.match(read("renderer/behavior.css"), /@scope \(#view-behavior\)/);
  assert.match(read("renderer/remote.css"), /@scope \(#view-remote\)/);
  for (const file of [
    "renderer/market.css",
    "renderer/appearance.css",
    "renderer/behavior.css",
    "renderer/remote.css",
  ]) {
    const css = read(file);
    assert.equal(!/(^|\n)\s*:root\s*\{/.test(css), true, `${file} must not redefine host root tokens`);
  }
});

test("renderer scripts expose an explicit boot hook and do not self-start", () => {
  assert.match(read("renderer/market.js"), /window\.PiOptMarket = \{ boot \}/);
  assert.match(read("renderer/appearance.js"), /window\.PiOptAppearance = \{ boot: initialize \}/);
  const appearance = read("renderer/appearance.js");
  assert.equal(appearance.trimEnd().endsWith("})();"), true);
  // Both halves answer to the one boot hook: the shell boots a view, not a tab.
  assert.doesNotMatch(appearance, /window\.PiOptMotion/);
  assert.doesNotMatch(appearance, /window\.PiOptGlass/);
});

test("dependent settings sit under the option they depend on", () => {
  const html = read("renderer/index.html");
  const js = read("renderer/appearance.js");

  // Two blocks follow a parent row's state (motion override, glass switch). The
  // photo block is always open: without a photo it still holds 「不使用」 and the
  // recent list, so it must never collapse.
  const subs = [
    ...html.matchAll(
      /<div class="settings-sub" id="([a-z-]+)" data-trigger="([a-z-]+)" data-collapsed="(?:true|false)"/g
    ),
  ];
  assert.equal(subs.length, 2);
  for (const [, , trigger] of subs) {
    assert.match(html, new RegExp(`id="${trigger}"`), trigger);
  }
  assert.match(html, /id="glass-backdrop-sub" data-collapsed="false"/);
  assert.doesNotMatch(html, /glass-wallpaper-clear/);
  assert.match(js, /data-wallpaper-off/);
  assert.doesNotMatch(js, /setSub\(elements\.glassWallpaperSub/);

  // 图片与 Wallpaper Engine 是同一个「背景」选项的两个来源：一个 tab 切换条，
  // 两块面板，列表常开。
  const tabs = [...html.matchAll(/data-backdrop-tab="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ["image", "engine"]);
  assert.match(html, /id="glass-panel-image" role="tabpanel"/);
  assert.match(html, /id="glass-panel-engine" role="tabpanel"[^>]*hidden/);
  // Wallpaper Engine 列表一次 30 张，超出时给「显示全部 / 收起」。
  assert.match(js, /const ENGINE_PAGE_SIZE = 30;/);
  assert.match(js, /state\.engineExpanded \? items : items\.slice\(0, ENGINE_PAGE_SIZE\)/);
  assert.match(html, /id="glass-engine-more"/);

  // The three motion rows only exist inside the override block; the base colour
  // is not affected by that switch, so it closes the block and stays first-level.
  const motionSub = html.slice(html.indexOf('id="motion-override-sub"'), html.indexOf('id="glass-view"'));
  for (const id of ["intensity", "speed", "follow-reduced"]) {
    assert.match(motionSub, new RegExp(`id="${id}"`), id);
  }
  assert.match(
    html,
    /<\/label>\s*<\/div>\s*<\/div>\s*<div class="settings-row">\s*<div class="settings-row-copy">\s*<div class="settings-row-title">外观基底/,
    "外观基底 must stay a first-level row after the motion sub-block"
  );

  // Blur strength belongs to the glass switch; the fit and both source panels live
  // inside the backdrop's own block. The absolute path is no longer shown anywhere —
  // the row and the cards name the source file instead.
  const start = html.indexOf('id="glass-backdrop-sub"');
  const photoSub = html.slice(start, html.indexOf("</section>", start));
  assert.match(photoSub, /data-glass-fit="fill"/);
  assert.match(photoSub, /id="glass-recent"/);
  assert.match(photoSub, /id="glass-engine-grid"/);
  assert.doesNotMatch(html, /id="glass-wallpaper-path"/);
  assert.doesNotMatch(html, /class="glass-path"/);
  const blurSub = html.slice(html.indexOf('id="glass-enabled-sub"'), html.indexOf('id="glass-backdrop"'));
  assert.match(blurSub, /id="glass-intensity"/);

  // Collapsing hides the block from the keyboard and tells assistive tech; the
  // switch that owns it also goes unavailable while animations are fully off.

  // The recent list is a thumbnail grid: 1:1 cards that apply on click, a remove
  // icon revealed on hover, and a confirmation before anything is deleted.
  assert.match(js, /class="wallpaper-card/);
  assert.match(js, /class="wallpaper-remove"/);
  assert.match(js, /askConfirm\(\s*"删除这张背景图"/);
  assert.match(js, /entry\.thumb/);
  assert.match(js, /sub\.inert = !expanded;/);
  assert.match(js, /elements\.motionOverride\.disabled = config\.disabled;/);
  assert.match(js, /setSub\(elements\.motionOverrideSub, config\.override\)/);
  assert.match(js, /setSub\(elements\.glassEnabledSub, config\.enabled\)/);
  assert.match(read("renderer/appearance.css"), /\.settings-sub\[data-collapsed="true"\]/);

  // Thumbnails are drawn in the panel (the plugin process has no image decoder)
  // and stored on the entry; missing ones are backfilled from the original bytes.
  assert.match(js, /toDataURL\("image\/png"\)/);
  assert.match(js, /wallpaperBytes/);
  assert.match(js, /saveThumb/);
  const glassHost = read("features/appearance/index.js");
  assert.match(glassHost, /readFileSync\(target\)\.toString\("base64"\)/);
  assert.match(glassHost, /case "appearance\.glass\.saveThumb"/);
  assert.match(read("features/appearance/glass.js"), /thumb: thumbValue\(value\.thumb\)/);
});

test("the rail opens and closes from a toggle above the tabs", () => {
  const html = read("renderer/index.html");
  assert.match(html, /<nav class="opt-rail" id="optRail"[^>]*data-expanded="false"/);
  assert.match(html, /id="railToggle"[^>]*aria-controls="optRail"/);
  // The toggle sits outside the tablist so the tab semantics stay intact.
  const navStart = html.indexOf('id="optRail"');
  const tabsStart = html.indexOf('class="rail-tabs" role="tablist"');
  const toggleStart = html.indexOf('id="railToggle"');
  assert.ok(toggleStart > navStart && tabsStart > toggleStart);
  for (const name of ["外观", "行为", "插件市场", "远程"]) {
    assert.ok(html.includes(`<span class="rail-label">${name}</span>`), name);
  }
  // The rows are read top to bottom in this order, and the shortcut numbers
  // follow it, so the markup is the one place the order is written down.
  assert.deepEqual(
    [...html.matchAll(/data-feature="([a-z]+)"/g)].map((match) => match[1]),
    ["appearance", "behavior", "market", "remote"]
  );

  const css = read("renderer/base.css");
  assert.match(css, /body\[data-rail="expanded"\] \.opt-rail \{ width: 176px/);
  assert.match(css, /body\[data-rail="expanded"\] \.rail-label \{\n  display: inline;\n  animation: rail-label-in 120ms[^;]* 100ms both;/);
  assert.match(css, /\.rail-label \{\n  display: none;/);
  assert.match(css, /body\[data-rail="expanded"\] \.rail-glyph \{ transform: rotate\(180deg\); \}/);
  // Opening the rail must not change row heights or the gap between rows.
  assert.match(css, /\.opt-rail button \{[^}]*height: 36px/);
  assert.doesNotMatch(css, /body\[data-rail="expanded"\] \.opt-rail button \{[^}]*height:/);
  assert.doesNotMatch(css, /\.rail-toggle \{/);

  // The reveal must stay smooth: rows are full width in both states, so the icon
  // only travels with the rail's side padding instead of jumping from a centred
  // box to a stretched one, and the names fade in once the rail is nearly open.
  assert.match(css, /\.opt-rail button \{[^}]*width: 100%/);
  assert.doesNotMatch(css, /justify-content: center/);
  assert.match(css, /\.opt-rail button \{[^}]*transition: padding 180ms/);
  assert.match(css, /body\[data-rail="expanded"\] \.opt-rail button \{ padding: 0 9px; \}/);
  assert.match(css, /@keyframes rail-label-in \{\n  from \{ opacity: 0; \}/);
  assert.match(css, /body\[data-rail="expanded"\] \.rail-label \{ animation: none; \}/);
  const shell = read("renderer/shell.js");
  assert.match(shell, /const RAIL_KEY = "piopt\.rail";/);
  assert.match(shell, /railToggle\.addEventListener\("click"/);
});

test("every rail row has a keyboard shortcut and a shell view", () => {
  const shell = read("renderer/shell.js");
  // Alt+1..4 must cover exactly the four views the shell knows about, in the
  // same order the rail shows them.
  assert.match(shell, /if \(!\["1", "2", "3", "4"\]\.includes\(event\.key\)\) return;/);
  assert.match(shell, /show\(\{ 1: "appearance", 2: "behavior", 3: "market", 4: "remote" \}\[event\.key\], true\);/);
  for (const feature of ["market", "appearance", "behavior", "remote"]) {
    assert.match(shell, new RegExp(`${feature}: document\\.getElementById\\("view-${feature}"\\)`));
  }
  assert.match(shell, /const KNOWN = \["appearance", "behavior", "market", "remote"\];/);
  assert.match(shell, /scrollToSection/);
});

test("the host's window controls follow the panel's own light/dark tokens", () => {
  const css = read("renderer/base.css");
  // The capsule lives in a closed shadow root and paints from these two
  // variables, which the host copies off the page before the panel has picked
  // its palette. Pinning them to our tokens keeps white glyphs off a white
  // title bar; !important is what outranks the host's inline copies.
  assert.match(
    css,
    /pi-plugin-panel-chrome \{\n  --pi-plugin-panel-page-foreground: var\(--ds-text-primary\) !important;/
  );
  assert.match(css, /--pi-plugin-panel-page-background: var\(--ds-bg-primary\) !important;/);

  // Both tokens have to flip with data-base, or the override would freeze one mode.
  const tokens = read("renderer/tokens.css");
  const light = tokens.slice(tokens.indexOf(':root[data-base="light"]'));
  assert.match(light, /--ds-text-primary: #1a1c1f;/);
  assert.match(light, /--ds-bg-primary: #fff(?:fff)?;/);
});

test("downloads without a catalog sha256 are refused, not silently accepted", async () => {
  const downloader = require("../features/market/downloader.js");
  const sha = "a".repeat(64);
  assert.equal(downloader.verify({ sha256: sha, sizeBytes: 10 }, {}).ok, false);
  assert.equal(downloader.verify({ sha256: sha, sizeBytes: 10 }, { sizeBytes: 10 }).ok, false);
  assert.equal(downloader.verify({ sha256: sha, sizeBytes: 10 }, { sizeBytes: 10, shasum: sha }).ok, true);
  assert.equal(downloader.verify({ sha256: sha, sizeBytes: 10 }, { sizeBytes: 10, shasum: "b".repeat(64) }).ok, false);
  await assert.rejects(
    downloader.preparePackage({ id: "local.demo", version: "1.0.0", entry: { version: "1.0.0", sizeBytes: 10 } }),
    error => error.code === "INTEGRITY",
  );
});

test("forgetWallpaper ownership rejects prefix-sharing sibling folders", () => {
  const feature = require("../features/appearance/index.js");
  const owns = feature._ownsWallpaper;
  const dir = path.resolve("C:/data/piopt");
  assert.equal(owns(dir, path.join(dir, "wallpaper.abc.png")), true);
  assert.equal(owns(dir, path.resolve("C:/data/piopt-evil/wallpaper.abc.png")), false);
  assert.equal(owns(dir, path.join(dir, "..", "wallpaper.abc.png")), false);
  assert.equal(owns(dir, path.join(dir, "sub", "wallpaper.abc.png")), false);
  assert.equal(owns(dir, path.join(dir, "photo.png")), false);
  assert.equal(owns("", path.join(dir, "wallpaper.abc.png")), false);
});
