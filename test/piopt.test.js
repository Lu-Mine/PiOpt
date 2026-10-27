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
    "gateway.open",
    "piopt.glass",
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
    "gateway_logs",
    "gateway_restart",
    "gateway_status",
    "list_plugin_updates",
    "prepare_plugin_update",
  ]);
  const keys = manifest.contributes.settings.map((item) => item.key).sort();
  assert.deepEqual(keys, ["dataDir", "mirrorRef", "mirrorRepo"]);
  assert.deepEqual(manifest.contributes.skills, ["skills/piopt.md"]);
});

test("host routes panel channels to the owning feature", () => {
  const entry = require("../main.js");
  assert.equal(entry._featureFor("market.snapshot"), entry._features.market);
  assert.equal(entry._featureFor("gateway.status"), entry._features.gateway);
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
  for (const name of ["market", "appearance", "gateway"]) {
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
    "./market.js",
    "./appearance.js",
    "./shell.js",
  ]) {
    assert.ok(html.includes(asset), asset);
  }
  assert.equal(/<script>/.test(html), false, "inline scripts would share one global scope");
  assert.match(html, /id="view-market"/);
  assert.match(html, /id="view-appearance"/);
  // One view, two sections: motion and the material are not separate panels.
  assert.match(html, /id="section-motion"/);
  assert.match(html, /id="section-glass"/);
  assert.doesNotMatch(html, /id="view-motion"/);
  assert.doesNotMatch(html, /id="view-glass"/);
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

test("feature styles are scoped so the views cannot collide", () => {
  assert.match(read("renderer/market.css"), /@scope \(#view-market\)/);
  assert.match(read("renderer/appearance.css"), /@scope \(#view-appearance\)/);
  for (const file of ["renderer/market.css", "renderer/appearance.css", "renderer/gateway.css"]) {
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

test("the rail opens and closes from a toggle above the tabs", () => {
  const html = read("renderer/index.html");
  assert.match(html, /<nav class="opt-rail" id="optRail"[^>]*data-expanded="false"/);
  assert.match(html, /id="railToggle"[^>]*aria-controls="optRail"/);
  // The toggle sits outside the tablist so the tab semantics stay intact.
  const navStart = html.indexOf('id="optRail"');
  const tabsStart = html.indexOf('class="rail-tabs" role="tablist"');
  const toggleStart = html.indexOf('id="railToggle"');
  assert.ok(toggleStart > navStart && tabsStart > toggleStart);
  for (const name of ["插件市场", "外观", "AI 网关"]) {
    assert.ok(html.includes(`<span class="rail-label">${name}</span>`), name);
  }

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
  // Alt+1..3 must cover exactly the three views the shell knows about.
  assert.match(shell, /if \(!\["1", "2", "3"\]\.includes\(event\.key\)\) return;/);
  for (const feature of ["market", "appearance", "gateway"]) {
    assert.match(shell, new RegExp(`${feature}: document\\.getElementById\\("view-${feature}"\\)`));
  }
  assert.match(shell, /const KNOWN = \["market", "appearance", "gateway"\];/);
  // The merged appearance view is two sections, and a command can name one.
  assert.match(shell, /const SECTIONS = \["motion", "glass"\];/);
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
  assert.match(light, /--ds-bg-primary: #fff;/);
});
