"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { parsePath, resolveOutput } = require("../features/open-output.js");

test("only current session output files can be resolved", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "piopt-output-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".pi-desktop", "scratch", "abc-123");
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "报告 test.pdf");
  const outside = path.join(home, "outside.pdf");
  await fs.writeFile(file, "pdf");
  await fs.writeFile(outside, "outside");
  await fs.writeFile(path.join(root, "run.exe"), "bad");
  assert.equal(await resolveOutput(file + ":12:3", "abc-123", home), await fs.realpath(file));
  assert.equal(await resolveOutput(pathToFileURL(file).href, "abc-123", home), await fs.realpath(file));
  if (process.platform === "win32") assert.equal(await resolveOutput("/" + file.replace(/\\/g, "/"), "abc-123", home), await fs.realpath(file));
  if (process.platform === "win32") {
    const broken = file.replace(home + path.sep + ".pi-desktop", home + ".pi-desktop");
    assert.equal(await resolveOutput(broken, "abc-123", home), await fs.realpath(file));
    await assert.rejects(resolveOutput(broken, "other-session", home));
  }
  assert.equal(await resolveOutput(outside, "abc-123", home, home), await fs.realpath(outside));
  await assert.rejects(resolveOutput(outside, "abc-123", home, path.join(home, "other")), /当前会话/);
  await assert.rejects(resolveOutput(outside, "abc-123", home), /临时目录/);
  await assert.rejects(resolveOutput(path.join(root, "run.exe"), "abc-123", home), /文件类型/);
  await assert.rejects(resolveOutput(file, "../abc-123", home), /会话/);
  await assert.rejects(resolveOutput(path.join(root, "missing.pdf"), "abc-123", home));
  if (process.platform !== "win32") {
    const link = path.join(root, "escape.pdf");
    await fs.symlink(outside, link);
    await assert.rejects(resolveOutput(link, "abc-123", home), /临时目录/);
  }
  assert.throws(() => parsePath("https://example.com/test.pdf"));
});

test("renderer recognises local links but not web links", async () => {
  const { localLink } = await import("../renderer/open-output.mjs");
  assert.equal(localLink("C:/temp/file.pdf:2"), "C:/temp/file.pdf:2");
  assert.equal(localLink("/tmp/file.pdf"), "/tmp/file.pdf");
  const encoded = encodeURIComponent("C:\\Users\\测试 目录\\文件.pdf:12:3");
  assert.equal(localLink(encoded), encoded);
  assert.equal(localLink(encodeURIComponent("/tmp/测试 文件.pdf:4")), encodeURIComponent("/tmp/测试 文件.pdf:4"));
  assert.equal(localLink("%E0%A4%A"), null);
  assert.equal(localLink("https://example.com/x.pdf"), null);
  assert.equal(localLink("//example.com/x.pdf"), null);
});

test("adds an action to the host file menu and invokes the plugin", async () => {
  const { mountOpenOutput, unmountOpenOutput } = await import("../renderer/open-output.mjs");
  const listeners = {};
  let observeCallback, action, item, removed = false;
  const menu = { querySelector: () => null, append: (button) => { item = button; } };
  const original = { closest: () => menu };
  const old = { document: global.document, MutationObserver: global.MutationObserver, KeyboardEvent: global.KeyboardEvent };
  global.document = {
    body: {}, addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: (type) => { delete listeners[type]; },
    querySelector: () => original, querySelectorAll: () => [], dispatchEvent: () => {},
    createElement: () => ({ setAttribute() {}, append() {}, addEventListener: (type, fn) => { if (type === "click") action = fn; } }),
  };
  global.KeyboardEvent = class {};
  global.MutationObserver = class { constructor(fn) { observeCallback = fn; } observe() {} disconnect() { removed = true; } };
  const calls = [];
  try {
    let enabled = false;
    mountOpenOutput({ dispatch: async (...args) => {
      if (args[1].method === "modelPickerState") return { config: { openSessionOutput: enabled } };
      calls.push(args);
    } });
    const link = { getAttribute: () => "C:/output/file.pdf", classList: { contains: () => false } };
    listeners.contextmenu({ target: { closest: () => link } });
    await Promise.resolve();
    observeCallback();
    assert.equal(item, undefined);
    enabled = true;
    listeners.contextmenu({ target: { closest: () => link } });
    await Promise.resolve();
    observeCallback();
    assert.ok(item);
    assert.equal(removed, true);
    await action();
    assert.deepEqual(calls, [["plugin.call", { method: "openSessionOutput", args: { path: "C:/output/file.pdf" } }]]);
  } finally {
    unmountOpenOutput();
    Object.assign(global, old);
  }
});
