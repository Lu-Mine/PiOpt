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
//    `plugin.call`（2 秒一次、窗口隐藏时不跑），并在 `.app-shell` 被 React
//    重建后把自己挂回去。
//
// 性能模式走的不是这条路。实测一个 4K 源：解码引擎占 GPU 约 28%，渲染进程
// 还要拿走三分之一核去缩放上屏；暂停能全部清掉，但动态壁纸也就没了。这里
// 取中间档——**解码照常（video 仍在播），但只在 canvas 上按目标帧率重绘**：
// 焦点在窗口时 30fps，失焦时 20fps，窗口最小化时直接暂停。实测 30fps 下
// 渲染进程开销从 33.6% 降到 19.0%，解码那一份省不掉，也不打算假装能省。

export const WALLPAPER_RUNTIME_CSS = [
  `[data-piopt-engine-wallpaper]{position:absolute;inset:0;z-index:-1;overflow:hidden;pointer-events:none;background:transparent}`,
  `[data-piopt-engine-wallpaper]::after{content:"";position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(rgba(0,0,0,var(--pg-scrim,.2)),rgba(0,0,0,var(--pg-scrim,.2)))}`,
  `[data-piopt-engine-video]{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;background:transparent}`,
  `[data-piopt-engine-frame]{position:absolute;inset:0;width:100%;height:100%;display:none;pointer-events:none;background:transparent}`,
  `[data-piopt-engine-wallpaper][data-piopt-engine-failed="true"]{display:none}`,
].join("\n");

const CONTAINER_ATTR = "data-piopt-engine-wallpaper";
const VIDEO_ATTR = "data-piopt-engine-video";
const CANVAS_ATTR = "data-piopt-engine-frame";
const SHELL_SELECTOR = ".app-shell";
const FIT_VALUES = ["fill", "contain", "cover", "none"];
const POLL_MS = 2000;
const ENSURE_DELAY_MS = 180;
// 限帧档位：看着窗口时 30fps 已经够顺，失焦时再省一档。
const FPS_FOCUSED = 30;
const FPS_UNFOCUSED = 20;

let host = null;
let container = null;
let video = null;
let canvas = null;
let context = null;
let observer = null;
let pollTimer = null;
let ensureTimer = null;
let frameHandle = null;
let lastFrameAt = 0;
let focused = true;
let listenersBound = false;
// What the layer is showing right now, so a poll that changes nothing costs nothing.
let current = { kind: "", file: "", title: "" };
let currentFit = "cover";
// 性能模式：视频仍解码，但只按目标帧率重绘到 canvas 上。
let performanceMode = false;

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

function ensureCanvas() {
  if (canvas) return canvas;
  canvas = document.createElement("canvas");
  canvas.setAttribute(CANVAS_ATTR, "true");
  canvas.setAttribute("aria-hidden", "true");
  context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  return canvas;
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
    // 不播放时也要有一帧画面，否则视频层就是一块黑。
    try {
      video.currentTime = 0.01;
    } catch {
      /* 有些容器不允许 seek，保持首帧即可 */
    }
    video.pause();
    return;
  }
  syncPlayback();
}

/** 全速播放：限帧档关掉时的唯一路径。 */
function play() {
  if (!video) return;
  if (reducedMotion() || document.hidden) {
    video.pause();
    return;
  }
  // 状态轮询每 2 秒回来一次；已经在播就别每次再敲一次 play()。
  if (!video.paused) return;
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

// ------------------------------------------------------------- capped mode

function targetFps() {
  return focused ? FPS_FOCUSED : FPS_UNFOCUSED;
}

function cappedPlayback() {
  return Boolean(performanceMode && video && !reducedMotion() && !document.hidden);
}

function stopPump() {
  if (frameHandle !== null && video && typeof video.cancelVideoFrameCallback === "function") {
    try {
      video.cancelVideoFrameCallback(frameHandle);
    } catch {
      /* 老 Chromium 没有 cancel：句柄置空即可，回调会自己退出 */
    }
  }
  frameHandle = null;
}

function resizeCanvas() {
  if (!canvas || !container) return;
  // 限帧时 <video> 是 display:none，量不到它的尺寸；容器铺满窗口，用它。
  const width = Math.max(1, Math.round(container.clientWidth || 0));
  const height = Math.max(1, Math.round(container.clientHeight || 0));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

/** drawImage 版的 object-fit：这张图在画布上占哪一块，超出的部分由 canvas 裁掉。 */
export function frameBox(cw, ch, vw, vh, fit) {
  if (!(cw > 0) || !(ch > 0) || !(vw > 0) || !(vh > 0)) return { dx: 0, dy: 0, dw: cw, dh: ch };
  const mode = fitOf(fit);
  if (mode === "fill") return { dx: 0, dy: 0, dw: cw, dh: ch };
  // cover 取大的比例（溢出被裁），contain 取小的比例（两侧留边），none 是原尺寸。
  const scale = mode === "none" ? 1 : mode === "cover" ? Math.max(cw / vw, ch / vh) : Math.min(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  return { dx: (cw - dw) / 2, dy: (ch - dh) / 2, dw, dh };
}

/** 按当前 `fit` 把一帧画进 canvas。 */
function paintFrame() {
  if (!context || !canvas || !video) return;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const box = frameBox(canvas.width, canvas.height, vw, vh, currentFit);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(video, box.dx, box.dy, box.dw, box.dh);
}

function startPump() {
  if (!video || typeof video.requestVideoFrameCallback !== "function") return;
  if (frameHandle !== null) return;
  const tick = (now) => {
    frameHandle = null;
    if (!cappedPlayback()) return;
    // 目标帧率由焦点决定；每帧读一次，切焦点时不必重启这条链。
    if (now - lastFrameAt >= 1000 / targetFps()) {
      lastFrameAt = now;
      paintFrame();
    }
    frameHandle = video.requestVideoFrameCallback(tick);
  };
  frameHandle = video.requestVideoFrameCallback(tick);
}

/**
 * 三种状态一个出口：
 *   隐藏 / 减弱动态 → 暂停（解码归零）
 *   性能模式        → video 照常解码，canvas 按帧率重绘
 *   其余            → 原来的全速播放
 */
function syncPlayback() {
  if (!video) return;
  const stopped = reducedMotion() || document.hidden;
  const capped = performanceMode && !stopped;

  if (canvas) canvas.style.display = capped ? "block" : "none";
  video.style.display = capped ? "none" : "block";

  if (stopped) {
    stopPump();
    video.pause();
    return;
  }

  if (capped) {
    const frameElement = ensureCanvas();
    if (frameElement.parentElement !== container) container.append(frameElement);
    resizeCanvas();
    // 解码要照常跑：限帧省的是缩放上屏，不是解码。
    if (video.paused) play();
    startPump();
    return;
  }

  stopPump();
  play();
}

function teardown() {
  stopPump();
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    video = null;
  }
  if (canvas) {
    canvas.remove();
    canvas = null;
    context = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  current = { kind: "", file: "", title: "" };
}

// ------------------------------------------------------------------- state

function applyState(state) {
  // 性能模式只改变绘制节奏，不改变这一层挂什么。
  performanceMode = state ? state.performance === true : false;
  const engine = state && state.engine && state.engine.kind === "video" && state.engine.file ? state.engine : null;
  if (!engine) {
    teardown();
    return;
  }

  const box = ensureContainer();
  if (!box) return;
  box.removeAttribute("data-piopt-engine-failed");

  const element = ensureVideo();
  if (element.parentElement !== box) box.prepend(element);

  const fit = fitOf(state.fit);
  if (fit !== currentFit) {
    currentFit = fit;
    element.style.objectFit = fit;
  }

  if (current.file !== engine.file) {
    current = { kind: "video", file: engine.file, title: typeof engine.title === "string" ? engine.title : "" };
    element.src = fileUrlOf(engine.file);
    element.load();
  }
  syncPlayback();
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
  // 最小化 / 切走：直接暂停，解码归零；回来再按当前档位恢复。
  syncPlayback();
  if (!document.hidden) void refresh();
}

function onFocusChange(event) {
  focused = event ? event.type === "focus" : true;
  // 帧率目标下一帧生效，不必重启重绘链。
}

function onResize() {
  if (canvas) resizeCanvas();
}

export async function mountEngineWallpaper(pi) {
  if (typeof document === "undefined" || !document.documentElement) return;
  host = pi;
  currentFit = "cover";
  performanceMode = false;
  focused = true;

  if (!listenersBound) {
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("focus", onFocusChange);
      window.addEventListener("blur", onFocusChange);
      window.addEventListener("resize", onResize);
    }
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
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("focus", onFocusChange);
      window.removeEventListener("blur", onFocusChange);
      window.removeEventListener("resize", onResize);
    }
    listenersBound = false;
  }
  stopPump();
  teardown();
  host = null;
  performanceMode = false;
  focused = true;
  lastFrameAt = 0;
}

// Exposed for the test that keeps the layer's contract honest.
export const __internals = {
  CONTAINER_ATTR,
  VIDEO_ATTR,
  CANVAS_ATTR,
  SHELL_SELECTOR,
  FIT_VALUES,
  POLL_MS,
  FPS_FOCUSED,
  FPS_UNFOCUSED,
  applyState,
  ensureContainer,
  teardown,
  syncPlayback,
  paintFrame,
  frameBox,
  targetFps,
  getCurrent: () => ({ ...current, fit: currentFit }),
  getMode: () => ({ performance: performanceMode, focused, capped: cappedPlayback() }),
  getCanvas: () => canvas,
};
