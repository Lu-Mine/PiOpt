// PiOpt — Wallpaper Engine 的视频壁纸层。
//
// 宿主的主题资源只吃静态图片（4 MB，png/jpg/webp/avif/svg），所以一张
// Wallpaper Engine 的 video 壁纸不能走 `background-image`。这里换一条路：往
// `.app-shell` 里插一个原生 `<video>`，铺满窗口、压在内容之下，由 Chromium
// 自己硬解。
//
// 三条边界，都是宿主给的：
//
// 1. 层的位置。`.app-shell::before` 已经是 `z-index:-1`，主题里的玻璃层把它
//    当作背景。容器用同一个 `-1` 并排在它后面，同层按 DOM 顺序绘制——于是
//    视频在光场之上、内容之下。容器自己带 `::after` 画 `--pg-scrim`，暗层就
//    不必再指望伪元素。
//
// 2. 资源。CSP 是 `media-src 'self' data: blob: https:`：没有 `plugin-asset:`，
//    也不能连本地 HTTP。`file:` 与页面同源，是唯一不把整段视频读进内存的路。
//
// 3. 状态。渲染模块没有设置变更事件，而这个层必须跟着面板走。所以它轮询
//    `plugin.call`（4 秒一次、窗口隐藏时不跑），并在 `.app-shell` 被 React
//    重建后把自己挂回去。

export const WALLPAPER_RUNTIME_CSS = [
  `[data-piopt-engine-wallpaper]{position:absolute;inset:0;z-index:-1;overflow:hidden;pointer-events:none;background:transparent}`,
  `[data-piopt-engine-wallpaper]::after{content:"";position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(rgba(0,0,0,var(--pg-scrim,.2)),rgba(0,0,0,var(--pg-scrim,.2)))}`,
  `[data-piopt-engine-video]{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;background:transparent}`,
  `[data-piopt-engine-wallpaper][data-piopt-engine-failed="true"]{display:none}`,
].join("\n");

const CONTAINER_ATTR = "data-piopt-engine-wallpaper";
const VIDEO_ATTR = "data-piopt-engine-video";
const SHELL_SELECTOR = ".app-shell";
const FIT_VALUES = ["fill", "contain", "cover", "none"];
const POLL_MS = 4000;
const ENSURE_DELAY_MS = 180;

let host = null;
let container = null;
let video = null;
let observer = null;
let pollTimer = null;
let ensureTimer = null;
let listenersBound = false;
// What the layer is showing right now, so a poll that changes nothing costs nothing.
let current = { kind: "", file: "", title: "" };
let currentFit = "cover";

// ---------------------------------------------------------------- file urls

/**
 * 一个磁盘路径的 `file:` URL。
 *
 * 每一段单独编码：Windows 路径直接拼进 `url` 会把 `#`、`?`、空格当成语法，
 * 而中文文件名（这个库里到处都是）不编码就无法解析。盘符那一段保留原样，
 * `D%3A` 不是任何浏览器认识的形式。
 */
export function fileUrlOf(path) {
  const text = String(path ?? "").trim().replace(/\\/g, "/");
  if (!text) return "";
  const leading = /^[a-zA-Z]:/.test(text) ? "file:///" : "file://";
  const encoded = text
    .split("/")
    .map((segment, index) => (index === 0 && /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
  return `${leading}${encoded}`;
}

export function fitOf(value) {
  return FIT_VALUES.includes(value) ? value : "cover";
}

function reducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ------------------------------------------------------------------ the layer

function ensureContainer() {
  if (typeof document === "undefined" || !document.body) return null;
  const shell = document.querySelector(SHELL_SELECTOR);
  if (!shell) return null;

  if (!container) {
    container = document.createElement("div");
    container.setAttribute(CONTAINER_ATTR, "true");
    container.setAttribute("aria-hidden", "true");
  }
  // 第一个子节点：和 `.app-shell::before` 同层，但排在它后面绘制。
  if (container.parentElement !== shell || shell.firstElementChild !== container) {
    shell.prepend(container);
  }
  return container;
}

function ensureVideo() {
  if (video) return video;
  video = document.createElement("video");
  video.setAttribute(VIDEO_ATTR, "true");
  video.muted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = "auto";
  video.disablePictureInPicture = true;
  video.setAttribute("aria-hidden", "true");
  video.addEventListener("error", onVideoError);
  video.addEventListener("loadeddata", onVideoLoaded);
  return video;
}

function onVideoError() {
  if (container) container.setAttribute("data-piopt-engine-failed", "true");
  // 这几乎总是 CSP 拒绝 `file:` 或容器编码不受支持；说清楚是哪种，别让窗口
  // 只是变黑。
  console.warn("[PiOpt] Wallpaper Engine 视频无法播放：", current.file || "(未设置)");
}

function onVideoLoaded() {
  if (!video) return;
  if (reducedMotion() || document.hidden) {
    // 减弱动态时也要有一帧画面，否则视频层就是一块黑。
    try {
      video.currentTime = 0.01;
    } catch {
      /* 有些容器不允许 seek，保持首帧即可 */
    }
    video.pause();
    return;
  }
  play();
}

function play() {
  if (!video) return;
  if (reducedMotion() || document.hidden) {
    video.pause();
    return;
  }
  try {
    const promise = video.play();
    if (promise && typeof promise.catch === "function") {
      promise.catch(() => {
        /* autoplay 被拒绝时保留首帧，不弹错误 */
      });
    }
  } catch {
    /* 同上 */
  }
}

function teardown() {
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    video = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  current = { kind: "", file: "", title: "" };
}

// ------------------------------------------------------------------- state

function applyState(state) {
  const engine = state && state.engine && state.engine.kind === "video" && state.engine.file ? state.engine : null;
  if (!engine) {
    teardown();
    return;
  }

  const box = ensureContainer();
  if (!box) return;
  box.removeAttribute("data-piopt-engine-failed");

  const element = ensureVideo();
  if (element.parentElement !== box) box.append(element);

  const fit = fitOf(state.fit);
  if (fit !== currentFit) {
    currentFit = fit;
    element.style.objectFit = fit;
  }

  if (current.file !== engine.file) {
    current = { kind: "video", file: engine.file, title: typeof engine.title === "string" ? engine.title : "" };
    element.src = fileUrlOf(engine.file);
    element.load();
    play();
  } else {
    play();
  }
}

async function refresh() {
  if (!host || typeof host.dispatch !== "function") return;
  try {
    const state = await host.dispatch("plugin.call", { method: "engineWallpaperState", args: {} });
    applyState(state);
  } catch (error) {
    console.warn("[PiOpt] 读不到 Wallpaper Engine 壁纸状态", error);
  }
}

// ----------------------------------------------------------------- lifecycle

function scheduleEnsure() {
  if (ensureTimer !== null) return;
  ensureTimer = setTimeout(() => {
    ensureTimer = null;
    if (!container || container.isConnected === false) {
      if (current.file) ensureContainer();
    }
  }, ENSURE_DELAY_MS);
}

function onVisibilityChange() {
  if (document.hidden) {
    if (video) video.pause();
    return;
  }
  void refresh();
  play();
}

export async function mountEngineWallpaper(pi) {
  if (typeof document === "undefined" || !document.documentElement) return;
  host = pi;
  currentFit = "cover";

  if (!listenersBound) {
    document.addEventListener("visibilitychange", onVisibilityChange);
    listenersBound = true;
  }
  if (!observer && typeof MutationObserver === "function" && document.body) {
    observer = new MutationObserver(scheduleEnsure);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  if (pollTimer === null) {
    pollTimer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
  }

  await refresh();
}

export function unmountEngineWallpaper() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (ensureTimer !== null) {
    clearTimeout(ensureTimer);
    ensureTimer = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (listenersBound && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    listenersBound = false;
  }
  teardown();
  host = null;
}

// Exposed for the test that keeps the layer's contract honest.
export const __internals = {
  CONTAINER_ATTR,
  VIDEO_ATTR,
  SHELL_SELECTOR,
  FIT_VALUES,
  POLL_MS,
  applyState,
  ensureContainer,
  teardown,
  getCurrent: () => ({ ...current, fit: currentFit }),
};
