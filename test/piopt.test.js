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
