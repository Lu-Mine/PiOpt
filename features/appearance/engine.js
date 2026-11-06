"use strict";

/**
 * Wallpaper Engine 壁纸库的读取。
 *
 * Wallpaper Engine 把创意工坊的每一张壁纸放在
 * `<Steam 库>/steamapps/workshop/content/431960/<id>/` 下，`project.json` 里
 * 写着类型与入口文件。这里只做三件事：找到这些目录、读出每个项目的类型、
 * 指出哪一种能在这个窗口里真的播放。
 *
 * 只有 `video`（mp4 / webm）能播：渲染进程原生 `<video>` 解码。其余类型
 * （`scene` / `web` / `application` / `preset`）由 Wallpaper Engine 自己的
 * 渲染器绘制，插件里无法复刻——它们在这里一律不可选。
 *
 * 项目自带的 `preview.gif` / `preview.jpg` 是创意工坊列表用的**方形封面**
 * （本机 42 张全是 1:1，192–1024 px），只够当列表里那张卡片的缩略图，绝不是
 * 壁纸画面：拿它铺窗口会是一张被裁切的方图，所以不能当背景用。
 */

const { readdirSync, readFileSync, statSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

// Wallpaper Engine 在 Steam 上的应用号：创意工坊内容按它归类。
const WORKSHOP_APP_ID = "431960";

// 只有 Chromium 原生解码的容器能交给 <video>；mkv 之类会直接黑屏。
const VIDEO_EXTENSIONS = Object.freeze(["mp4", "webm"]);

// 预览图的候选顺序：project.json 里的 preview 字段优先，其次是这些常用名。
const PREVIEW_FILES = Object.freeze([
  "preview.jpg",
  "preview.jpeg",
  "preview.png",
  "preview.webp",
  "preview.avif",
  "preview.gif",
]);

const PREVIEW_MIME = Object.freeze({
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
});

// 宿主对主题资源的硬限制也是 4 MB；超了就没有可用通道。
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
// project.json 是几百字节的元数据；一个异常大的文件不读。
const MAX_PROJECT_BYTES = 512 * 1024;

function extensionOf(value) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(value ?? ""));
  return match ? match[1].toLowerCase() : "";
}

function isAbsolutePath(value) {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path) return false;
  if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(path)) return false;
  if (path.includes("\0")) return false;
  return !path.split(/[\\/]/).some((segment) => segment === "." || segment === "..");
}

function isSupportedVideo(value) {
  return isAbsolutePath(value) && VIDEO_EXTENSIONS.includes(extensionOf(value));
}

// ------------------------------------------------------------- steam libraries

function defaultReadText(file) {
  return readFileSync(file, "utf8");
}

function defaultIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultReadRegistry(key, name) {
  const out = execFileSync("reg", ["query", key, "/v", name], {
    encoding: "utf8",
    timeout: 2000,
    windowsHide: true,
  });
  const match = new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`, "i").exec(out);
  return match ? match[1].trim() : "";
}

/**
 * Steam 的安装位置。
 *
 * Windows 上以注册表为准——库可能在 D:，把路径写死会正好漏掉大多数人。
 * 其它平台没有这张表，交给 `libraryfolders.vdf` 的默认位置兜底。
 */
function steamRoots({ platform = process.platform, env = process.env, readRegistry = defaultReadRegistry } = {}) {
  const roots = [];
  const add = (value) => {
    const path = String(value ?? "").trim();
    // 空的 ProgramFiles 会让 join 出相对路径；那不是库地址。
    if (!isAbsolutePath(path)) return;
    if (!roots.some((entry) => entry.toLowerCase() === path.toLowerCase())) roots.push(path);
  };

  if (platform === "win32") {
    for (const key of ["HKCU\\Software\\Valve\\Steam", "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam"]) {
      try {
        add(readRegistry(key, "SteamPath"));
      } catch {
        /* 没装 Steam，或者这一项不存在 */
      }
    }
    add(join(env["ProgramFiles(x86)"] || "", "Steam"));
    add(join(env.ProgramFiles || "", "Steam"));
  }
  add(join(env.HOME || env.USERPROFILE || "", ".steam", "steam"));
  add(join(env.HOME || env.USERPROFILE || "", "Library", "Application Support", "Steam"));
  return roots;
}

/**
 * `libraryfolders.vdf` 里的库路径。
 *
 * 只认 `"path" "D:\\Steam"` 这一种写法：解析整个 VDF 语法没有必要，而键名
 * `path` 在 Valve 的这份文件里是稳定的。
 */
function parseLibraryFolders(text) {
  const roots = [];
  const pattern = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = pattern.exec(String(text ?? ""))) !== null) {
    const value = match[1].replace(/\\\\/g, "\\").trim();
    if (value) roots.push(value);
  }
  return roots;
}

/**
 * 所有装着创意工坊内容的目录，按发现顺序去重。
 *
 * 一个 Steam 库一个目录；内容不在 `<Steam>/steamapps` 下的情况（移动到别的
 * 盘）正是 `libraryfolders.vdf` 要回答的问题。
 */
function discoverWorkshopRoots(options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    readRegistry = defaultReadRegistry,
    readText = defaultReadText,
    isDirectory = defaultIsDirectory,
  } = options;

  const libraries = [];
  const add = (value) => {
    const path = String(value ?? "").trim();
    if (!isAbsolutePath(path)) return;
    if (!libraries.some((entry) => entry.toLowerCase() === path.toLowerCase())) libraries.push(path);
  };

  for (const root of steamRoots({ platform, env, readRegistry })) {
    if (!isDirectory(root)) continue;
    add(root);
    const vdf = join(root, "steamapps", "libraryfolders.vdf");
    try {
      // 直接读：不存在会抛，和空文件一样落到下面的兜底里，这样调用方可以注入
      // 自己的 readText 而不必同时伪造存在性检查。
      for (const library of parseLibraryFolders(readText(vdf))) add(library);
    } catch {
      /* 读不了这份文件就只用已知的库 */
    }
  }

  const roots = [];
  for (const library of libraries) {
    const workshop = join(library, "steamapps", "workshop", "content", WORKSHOP_APP_ID);
    if (!isDirectory(workshop)) continue;
    if (!roots.some((entry) => entry.toLowerCase() === workshop.toLowerCase())) roots.push(workshop);
  }
  return roots;
}

// ------------------------------------------------------------------- projects

function readProject(dir) {
  const file = join(dir, "project.json");
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.size > MAX_PROJECT_BYTES) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 预览图：`preview` 字段优先，其次按常用文件名找。只收直接子文件。 */
function previewFileOf(dir, project) {
  const names = [];
  const declared = project && typeof project.preview === "string" ? project.preview.trim() : "";
  if (declared && !/[\\/]/.test(declared)) names.push(declared);
  names.push(...PREVIEW_FILES);

  for (const name of names) {
    const file = join(dir, name);
    let stats;
    try {
      stats = statSync(file);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    if (!PREVIEW_MIME[extensionOf(name)]) continue;
    return { path: file, mime: PREVIEW_MIME[extensionOf(name)], size: stats.size };
  }
  return null;
}

/**
 * 一个创意工坊目录能做什么。
 *
 * `kind` 是「这个窗口打算怎么画它」，`supported` 是「能不能画」，`reason`
 * 在不能画时给面板一句话的依据。找不到 project.json 的目录返回 null。
 */
function describeProject(dir, id = "") {
  const project = readProject(dir);
  if (!project) return null;

  const folderId = String(id || "").trim() || dir.split(/[\\/]/).pop() || "";
  const type = typeof project.type === "string" ? project.type.trim().toLowerCase() : "";
  const title = (typeof project.title === "string" ? project.title.trim() : "") || folderId;

  // 封面图只给列表卡片用（1:1），超过 4 MB 就不为它做缩略图。
  const cover = previewFileOf(dir, project);
  const preview = cover && cover.size <= MAX_PREVIEW_BYTES ? cover : null;

  if (type === "video") {
    const declared = typeof project.file === "string" ? project.file.trim() : "";
    const file = declared && !/[\\/]/.test(declared) ? join(dir, declared) : "";
    let playable = false;
    if (file && isSupportedVideo(file)) {
      try {
        playable = statSync(file).isFile();
      } catch {
        playable = false;
      }
    }
    return {
      id: folderId,
      title,
      type,
      kind: "video",
      supported: playable,
      reason: playable ? "" : "video-unplayable",
      file: playable ? file : "",
      preview,
    };
  }

  // scene / web / application / preset：只有 Wallpaper Engine 自己画得出来。
  return {
    id: folderId,
    title,
    type,
    kind: "",
    supported: false,
    reason: "engine-only",
    file: "",
    preview,
  };
}

/**
 * 扫一个创意工坊根目录。
 *
 * 目录名就是创意工坊 id；不是纯数字的目录（比如 Steam 自己写的元数据）跳过。
 */
function scanWorkshop(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{1,20}$/.test(entry.name)) continue;
    const described = describeProject(join(root, entry.name), entry.name);
    if (described) items.push(described);
  }
  items.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
  return items;
}

/** 扫描每个库并合并；同一 id 只留第一次出现的那份。 */
function scanAll(roots) {
  const seen = new Set();
  const items = [];
  for (const root of roots) {
    for (const item of scanWorkshop(root)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  items.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
  return items;
}

/** 封面图字节，交给面板画列表里那张方形缩略图（GIF 的首帧也由面板解码）。 */
function previewOf(item) {
  if (!item || !item.preview) return null;
  if (item.preview.size > MAX_PREVIEW_BYTES) return null;
  try {
    return { mime: item.preview.mime, data: readFileSync(item.preview.path).toString("base64") };
  } catch {
    return null;
  }
}

module.exports = {
  WORKSHOP_APP_ID,
  VIDEO_EXTENSIONS,
  PREVIEW_FILES,
  MAX_PREVIEW_BYTES,
  extensionOf,
  isAbsolutePath,
  isSupportedVideo,
  steamRoots,
  parseLibraryFolders,
  discoverWorkshopRoots,
  readProject,
  describeProject,
  scanWorkshop,
  scanAll,
  previewOf,
  _defaultReadRegistry: defaultReadRegistry,
};
