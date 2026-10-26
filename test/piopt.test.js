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

test("manifest keeps both feature command sets", () => {
  const ids = manifest.contributes.commands.map((item) => item.id);
  assert.deepEqual(ids, ["piopt.open", "pimarket.open", "pimarket.prepare-updates", "pi-modify.open"]);
  for (const id of ids) assert.ok(manifest.activationEvents.includes(`onCommand:${id}`), id);
});

test("manifest unions the two feature permissions without fs access", () => {
  for (const permission of ["ui.panel", "ui.theme", "net.fetch", "agent.tool.register"]) {
    assert.ok(manifest.permissions.includes(permission), permission);
  }
  assert.equal(manifest.permissions.some((item) => item.startsWith("fs.")), false);
  assert.ok(manifest.net.domains.includes("cdn.jsdelivr.net"));
});

test("market tools and settings survive the merge", () => {
  const tools = manifest.contributes.agentTools.map((item) => item.name).sort();
  assert.deepEqual(tools, ["list_plugin_updates", "prepare_plugin_update"]);
  const keys = manifest.contributes.settings.map((item) => item.key).sort();
  assert.deepEqual(keys, ["dataDir", "mirrorRef", "mirrorRepo"]);
  assert.deepEqual(manifest.contributes.skills, ["skills/piopt.md"]);
});

test("host routes panel channels to the owning feature", () => {
  const entry = require("../main.js");
  assert.equal(entry._featureFor("market.snapshot"), entry._features.market);
  assert.equal(entry._featureFor("motion.apply"), entry._features.motion);
  assert.equal(entry._featureFor("motion.previewCss"), entry._features.motion);
  assert.equal(entry._featureFor("unknown.channel"), null);
  assert.equal(entry._featureFor(undefined), null);
});

test("panel loads shared tokens, scoped feature styles and both features", () => {
  const html = read("renderer/index.html");
  for (const asset of ["./tokens.css", "./base.css", "./market.css", "./motion.css", "./market.js", "./motion.js", "./shell.js"]) {
    assert.ok(html.includes(asset), asset);
  }
  assert.equal(/<script>/.test(html), false, "inline scripts would share one global scope");
  assert.match(html, /id="view-market"/);
  assert.match(html, /id="view-motion"/);
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

test("feature styles are scoped so the two views cannot collide", () => {
  assert.match(read("renderer/market.css"), /@scope \(#view-market\)/);
  assert.match(read("renderer/motion.css"), /@scope \(#view-motion\)/);
  for (const file of ["renderer/market.css", "renderer/motion.css"]) {
    const css = read(file);
    assert.equal(!/(^|\n)\s*:root\s*\{/.test(css), true, `${file} must not redefine host root tokens`);
  }
});

test("renderer scripts expose an explicit boot hook and do not self-start", () => {
  assert.match(read("renderer/market.js"), /window\.PiOptMarket = \{ boot \}/);
  assert.match(read("renderer/motion.js"), /window\.PiOptMotion = \{ boot: initialize \}/);
  const motion = read("renderer/motion.js");
  assert.equal(motion.trimEnd().endsWith("})();"), true);
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
  for (const name of ["插件市场", "动效实验室"]) {
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

  // The reveal itself must stay smooth: the button eases to its stretched width
  // and the names fade in only once the rail is nearly open, so no frame shows
  // text squeezed into a sliver.
  assert.match(css, /\.opt-rail button \{[^}]*transition: width 180ms/);
  assert.match(css, /@keyframes rail-label-in \{\n  from \{ opacity: 0; \}/);
  assert.match(css, /body\[data-rail="expanded"\] \.rail-label \{ animation: none; \}/);
  const shell = read("renderer/shell.js");
  assert.match(shell, /const RAIL_KEY = "piopt\.rail";/);
  assert.match(shell, /railToggle\.addEventListener\("click"/);
});
