"use strict";

/**
 * Wallpaper Engine 的壁纸库读取。
 *
 * 这些测试用真实的临时目录与伪造的 Steam 库表跑，因为这一层唯一的难点就是
 * 「Steam 把内容放在哪」和「这张壁纸属于哪一类」——两者都不该靠猜。
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const engine = require("../features/appearance/engine.js");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeProject(dir, project) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(project));
}

// ------------------------------------------------------------- steam libraries

test("libraryfolders.vdf gives every library path, unescaped", () => {
  const vdf = [
    '"libraryfolders"',
    "{",
    '\t"0"',
    "\t{",
    '\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"',
    "\t}",
    '\t"1"',
    "\t{",
    '\t\t"path"\t\t"D:\\\\Steam"',
    "\t}",
    "}",
  ].join("\n");

  assert.deepEqual(engine.parseLibraryFolders(vdf), ["C:\\Program Files (x86)\\Steam", "D:\\Steam"]);
  assert.deepEqual(engine.parseLibraryFolders(""), []);
});

test("a missing registry value never becomes a relative library path", () => {
  const roots = engine.steamRoots({
    platform: "win32",
    env: {},
    readRegistry: () => {
      throw new Error("no such key");
    },
  });
  for (const root of roots) assert.ok(path.isAbsolute(root), root);
  assert.deepEqual(roots, []);
});

test("a workshop folder living in another Steam library is found", () => {
  const libraryVdf = [
    '"libraryfolders"',
    "{",
    '\t"0"',
    "\t{",
    '\t\t"path"\t\t"C:\\\\Steam"',
    "\t}",
    '\t"1"',
    "\t{",
    '\t\t"path"\t\t"D:\\\\Games"',
    "\t}",
    "}",
  ].join("\n");

  const steam = "C:\\Steam";
  const games = "D:\\Games";
  const workshop = path.join(games, "steamapps", "workshop", "content", engine.WORKSHOP_APP_ID);
  const dirs = new Set([
    steam,
    path.join(steam, "steamapps"),
    games,
    path.join(games, "steamapps"),
    workshop,
  ]);

  const roots = engine.discoverWorkshopRoots({
    platform: "win32",
    env: { ProgramFiles: steam },
    // The installer's Steam path, as the registry reports it for HKCU.
    readRegistry: () => steam,
    isDirectory: (value) => dirs.has(value),
    readText: (file) => (file === path.join(steam, "steamapps", "libraryfolders.vdf") ? libraryVdf : ""),
  });

  assert.deepEqual(roots, [workshop]);
});

test("no installed wallpapers means no workshop root at all", () => {
  const roots = engine.discoverWorkshopRoots({
    platform: "win32",
    env: { ProgramFiles: "C:\\Steam" },
    readRegistry: () => "C:\\Steam",
    isDirectory: (value) => value === "C:\\Steam",
    readText: () => "",
  });
  assert.deepEqual(roots, []);
});

// ------------------------------------------------------------------- projects

test("a video project plays from its own folder", () => {
  const root = tempDir("piopt-engine-");
  const dir = path.join(root, "1001");
  writeProject(dir, { type: "video", title: "Sky", file: "clip.mp4" });
  fs.writeFileSync(path.join(dir, "clip.mp4"), "not really a video");

  try {
    const item = engine.describeProject(dir, "1001");
    assert.equal(item.kind, "video");
    assert.equal(item.supported, true);
    assert.equal(item.reason, "");
    assert.equal(item.file, path.join(dir, "clip.mp4"));
    assert.equal(item.preview, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a scene project falls back to the preview image it ships with", () => {
  const root = tempDir("piopt-engine-");
  const dir = path.join(root, "1002");
  writeProject(dir, { type: "scene", title: "Night", file: "scene.json", preview: "preview.gif" });
  fs.writeFileSync(path.join(dir, "preview.gif"), "gif bytes");

  try {
    const item = engine.describeProject(dir, "1002");
    assert.equal(item.kind, "still");
    assert.equal(item.supported, true);
    assert.equal(item.preview.mime, "image/gif");
    assert.equal(item.file, "");

    const preview = engine.previewOf(item);
    assert.equal(preview.mime, "image/gif");
    assert.equal(Buffer.from(preview.data, "base64").toString(), "gif bytes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a project with no preview, or one over the host's ceiling, is not selectable", () => {
  const root = tempDir("piopt-engine-");
  const bare = path.join(root, "1003");
  writeProject(bare, { type: "scene", title: "Bare" });

  const heavy = path.join(root, "1004");
  writeProject(heavy, { type: "scene", title: "Heavy" });
  fs.writeFileSync(path.join(heavy, "preview.jpg"), Buffer.alloc(engine.MAX_PREVIEW_BYTES + 1));

  try {
    const missing = engine.describeProject(bare, "1003");
    assert.equal(missing.supported, false);
    assert.equal(missing.reason, "no-preview");

    const oversized = engine.describeProject(heavy, "1004");
    assert.equal(oversized.supported, false);
    assert.equal(oversized.reason, "preview-too-large");
    assert.equal(engine.previewOf(oversized), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a video in a container Chromium cannot decode is refused, not black", () => {
  const root = tempDir("piopt-engine-");
  const dir = path.join(root, "1005");
  writeProject(dir, { type: "video", title: "Matroska", file: "clip.mkv" });
  fs.writeFileSync(path.join(dir, "clip.mkv"), "x");

  try {
    const item = engine.describeProject(dir, "1005");
    assert.equal(item.kind, "video");
    assert.equal(item.supported, false);
    assert.equal(item.reason, "video-unplayable");
    assert.equal(item.file, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scanning skips metadata folders and projects without a project.json", () => {
  const root = tempDir("piopt-engine-");
  const first = path.join(root, "2001");
  writeProject(first, { type: "video", title: "Zulu", file: "a.mp4" });
  fs.writeFileSync(path.join(first, "a.mp4"), "x");
  const second = path.join(root, "2002");
  writeProject(second, { type: "scene", title: "Alpha" });
  fs.writeFileSync(path.join(second, "preview.jpg"), "jpeg bytes");
  fs.mkdirSync(path.join(root, "2003"));
  fs.writeFileSync(path.join(root, "notes.txt"), "not a project");

  try {
    const items = engine.scanWorkshop(root);
    assert.deepEqual(items.map((item) => item.id), ["2002", "2001"]);
    // 标题排序把 Alpha 放在 Zulu 前面，而不是按目录名排。
    assert.deepEqual(engine.scanAll([root]).map((item) => item.title), ["Alpha", "Zulu"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a folder with no project.json is not a wallpaper", () => {
  const root = tempDir("piopt-engine-");
  fs.mkdirSync(path.join(root, "3001"));
  try {
    assert.equal(engine.describeProject(path.join(root, "3001"), "3001"), null);
    assert.deepEqual(engine.scanWorkshop(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- the video layer

test("a Windows path becomes a file url with encoded segments", async () => {
  const runtime = await import("../renderer/wallpaper-runtime.mjs");
  assert.equal(
    runtime.fileUrlOf("D:\\Steam\\我的 壁纸\\a.mp4"),
    "file:///D:/Steam/%E6%88%91%E7%9A%84%20%E5%A3%81%E7%BA%B8/a.mp4"
  );
  assert.equal(runtime.fileUrlOf("/home/user/x.mp4"), "file:///home/user/x.mp4");
  assert.equal(runtime.fileUrlOf(""), "");
});

test("the fit mode is the one the video layer can express", async () => {
  const runtime = await import("../renderer/wallpaper-runtime.mjs");
  for (const fit of ["fill", "contain", "cover", "none"]) assert.equal(runtime.fitOf(fit), fit);
  assert.equal(runtime.fitOf("stretch"), "cover");
  assert.equal(runtime.fitOf(undefined), "cover");
});

test("the video layer sits under the shell's content and carries its own scrim", async () => {
  const runtime = await import("../renderer/wallpaper-runtime.mjs");
  const css = runtime.WALLPAPER_RUNTIME_CSS;

  assert.match(css, /\[data-piopt-engine-wallpaper\]\{[^}]*position:absolute/);
  assert.match(css, /\[data-piopt-engine-wallpaper\]\{[^}]*z-index:-1/);
  // The scrim has to live on the layer: with a clip behind it, `.app-shell::before`
  // paints nothing, so the dimming cannot come from there.
  assert.match(css, /\[data-piopt-engine-wallpaper\]::after\{[^}]*--pg-scrim/);
  assert.match(css, /\[data-piopt-engine-video\]\{[^}]*object-fit:cover/);
  // Same trap as the glass layer: a transform re-anchors the host's fixed popups.
  assert.doesNotMatch(css, /transform:/);
});

test("the entry mounts and unmounts the video layer with the rest of the module", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "entry.mjs"), "utf8");
  assert.match(source, /from "\.\/wallpaper-runtime\.mjs"/);
  assert.match(source, /WALLPAPER_RUNTIME_CSS/);
  assert.match(source, /await mountEngineWallpaper\(pi\)/);
  assert.match(source, /unmountEngineWallpaper\(\)/);
});
