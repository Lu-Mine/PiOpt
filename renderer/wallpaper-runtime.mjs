// PiOpt — Wallpaper Engine 的动态壁纸层（video 与 scene）。
//
// 宿主的主题资源只吃静态图片（4 MB，png/jpg/webp/avif/svg），所以一张
// Wallpaper Engine 的壁纸不能走 `background-image`。这里有两条路，都在
// `.app-shell` 里铺满窗口、压在内容之下：
//
// - video：一个原生 `<video>`，由 Chromium 自己硬解。
// - scene：随插件分发的 WebWallGL 引擎（WebGL2），把 `scene.pkg` 的字节解析成
//   图层再画出来。引擎在 `vendor/` 下，是自包含的 UMD 包转成的 ES module。
//
// 四条边界，都是宿主给的：
//
// 1. 层的位置。`.app-shell::before` 已经是 `z-index:-1`，主题里的玻璃层把它
//    当作背景。容器用同一个 `-1` 并排在它后面，同层按 DOM 顺序绘制——于是
//    壁纸在光场之上、内容之下。容器自己带 `::after` 画 `--pg-scrim`，暗层就
//    不必再指望伪元素。
//
// 2. 资源。CSP 是 `media-src 'self' data: blob: https:`：没有 `plugin-asset:`，
//    也不能连本地 HTTP（`connect-src 'self'` 堵死了本地服务）。video 走
//    `file:` URL，与页面同源；scene 走插件桥，主进程读盘、按 8 MB 分块给
//    base64——引擎要的是一份字节，不是一个能加载的 URL。
//
// 3. 脚本。宿主 `script-src` 没有 `'unsafe-eval'`，所以 scene 壁纸自带的
//    SceneScript 一定跑不起来（引擎用 `new Function` 编译）。挂载时显式传
//    `scripts: false`：让引擎停在 scene.json 的快照值上，而不是让每一次求值
//    都撞一次 CSP 拒绝。代价是粒子、时钟、鼠标视差这些脚本效果会缺。
//
// 4. 状态。渲染模块没有设置变更事件，而这个层必须跟着面板走。所以它轮询
//    `plugin.call`（2 秒一次、窗口隐藏时不跑），并在 `.app-shell` 被 React
//    重建后把自己挂回去。
//
// 性能：scene 是持续出帧的 WebGL2 画布。实测（GTX 1660 SUPER、1600×1000）
// 30fps 下重粒子壁纸 CPU +9%、GPU +16%，60fps 再贵约六成；轻量壁纸几乎没有
// 增量。所以这里固定 30fps，并在窗口不可见、系统要求减弱动态、或用户关掉
// 总开关时立刻 `pause()`。
//
// 视频的性能模式走的不是这条路。实测一个 4K 源：解码引擎占 GPU 约 28%，渲染
// 进程还要拿走三分之一核去缩放上屏；暂停能全部清掉，但动态壁纸也就没了。这里
// 取中间档——**解码照常（video 仍在播），但只在 canvas 上按目标帧率重绘**：
// 焦点在窗口时 30fps，失焦时 10fps，窗口最小化时直接暂停。实测 30fps 下
// 渲染进程开销从 33.6% 降到 19.0%，解码那一份省不掉，也不打算假装能省。

export const WALLPAPER_RUNTIME_CSS = [
  `[data-piopt-engine-wallpaper]{position:absolute;inset:0;z-index:-1;overflow:hidden;pointer-events:none;background:transparent}`,
  `[data-piopt-engine-wallpaper]::after{content:"";position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(rgba(0,0,0,var(--pg-scrim,.2)),rgba(0,0,0,var(--pg-scrim,.2)))}`,
  `[data-piopt-engine-video]{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;background:transparent}`,
  // scene 的画布由引擎自己建并插进容器；这里只保证它铺满、不吃指针。
  `[data-piopt-engine-wallpaper] canvas{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;background:transparent}`,
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
const FPS_UNFOCUSED = 10;
// scene 的帧率不给档位：30fps 已经够顺，60fps 实测要贵约六成（见文件头）。
const SCENE_FPS = 30;
// 渲染倍率上限。设备像素比更高时不跟：4K 屏 + 200% 会让画布撑到物理最长边
// 封顶 4096，像素数是这个档的两倍多，而肉眼几乎分不出差别。
const SCENE_MAX_DPR = 1.5;
// 引擎随插件分发，所以是相对引入；它是自包含的 ES module，不需要打包器。
const SCENE_ENGINE_URL = "./vendor/webwallgl.mjs";

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
// scene 的状态：引擎第一次用到时才加载；实例代表当前挂着的那个包；token 用来
// 丢弃「字节还没收完就被换掉」的那一次挂载。
let sceneEngineModule = null;
let sceneInstance = null;
let sceneKey = "";
let sceneToken = 0;
// 正在为某个包取字节/挂载：轮询每 2 秒回来一次，没有这道锁，一个 24 MB 的包
// 会被 65 次并发的全量拉取拖死（实测过）。
let scenePending = null;
let sceneEnabled = true;

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
  // 只在这一层不在壳里时挂一次。原先还要求它是第一个子节点，于是宿主每往前插
  // 一个元素，轮询（2 秒一次）就会把这块正在渲染的画布搬一次——那本身就是每
  // 2 秒一次的重排。层叠不靠位置：容器与 `.app-shell::before` 同为 `z-index:-1`，
  // 伪元素本来就先画。
  if (container.parentElement !== shell) {
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

// -------------------------------------------------------------------- scene

/**
 * 引擎是一个 1.1 MB 的自包含 ES module。第一次真正用到时才加载——没有 scene
 * 壁纸的用户不该为它的解析时间买单。
 */
async function loadSceneEngine() {
  if (sceneEngineModule) return sceneEngineModule;
  const loaded = await import(SCENE_ENGINE_URL);
  const engine = loaded && loaded.default ? loaded.default : loaded;
  if (!engine || typeof engine.mount !== "function") throw new Error("scene engine missing");
  sceneEngineModule = engine;
  return engine;
}

/**
 * 场景容器的字节。
 *
 * 主进程把 pkg 转成一份 `window.__pioptScenePkg = "<base64>"` 的数据文件，放在
 * 它自己的数据目录里；这里用 `<script src="file://…">` 取回来。
 *
 * 为什么不是 fetch / XHR：`file://` 页面发起的这两个都被 CORS 挡死（origin 是
 * null），实测过。为什么不是 `plugin.call`：宿主对它单次限 64KB、每秒限 10 次，
 * 合起来 640 KB/s——一个 24 MB 的包要 37 秒，真机上就是这么挂的（stage=pkg，
 * `plugin.call args and answer exceed 64KB`）。`<script src>` 两样限额都不吃，
 * 走的是同一条 `script-src 'self'`，实测 1.4 MB 的包 17 ms、159 MB 的 9 秒。
 */
async function fetchScenePkg(id) {
  const prepared = await host.dispatch("plugin.call", { method: "enginePkg", args: { id } });
  if (!prepared || prepared.ok !== true || !prepared.path) {
    throw new Error((prepared && prepared.reason) || "pkg-unavailable");
  }

  const script = document.createElement("script");
  script.src = fileUrlOf(prepared.path);
  script.async = true;
  try {
    await new Promise((resolve, reject) => {
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("pkg script blocked"));
      document.head.append(script);
    });
    const encoded = globalThis.__pioptScenePkg;
    if (typeof encoded !== "string" || !encoded) throw new Error("pkg payload empty");
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } finally {
    // 几十 MB 的字符串不该在页面上多留一秒。
    try {
      delete globalThis.__pioptScenePkg;
    } catch {
      globalThis.__pioptScenePkg = null;
    }
    script.remove();
  }
}

/** 该不该出帧：减弱动态、窗口不可见、用户关掉总开关，三种都停。 */
function sceneStopped() {
  return reducedMotion() || document.hidden || !sceneEnabled;
}

function syncScene() {
  if (!sceneInstance) return;
  if (sceneStopped()) {
    if (!sceneInstance.paused) sceneInstance.pause();
    return;
  }
  if (sceneInstance.paused) sceneInstance.resume();
}

/**
 * 上一次 scene 挂载的结果，报到插件进程去。
 *
 * 渲染进程的 console 不进宿主的日志，而一条挂不上的壁纸在界面上就是「什么都
 * 没有」——真机上出过一次，只能靠日志里每 2 秒一条的 `reg query` 失败猜到
 * 它在反复重试。所以这里把阶段和原因一起交回去，插件进程落一份文件给面板和
 * 排障用。同一个签名只报一次：失败会重试，重复上报只会刷屏。
 */
let lastReported = "";

function reportEngineStatus(payload) {
  if (!host || typeof host.dispatch !== "function") return;
  const signature = `${payload.ok ? "ok" : "fail"}|${payload.id || ""}|${payload.stage || ""}|${payload.message || ""}`;
  if (signature === lastReported) return;
  lastReported = signature;
  Promise.resolve()
    .then(() => host.dispatch("plugin.call", { method: "reportEngineStatus", args: payload }))
    .catch(() => {
      /* 上报失败不该影响渲染本身 */
    });
}

/**
 * 真实帧率的定期上报。
 *
 * 「帧率低」只能靠数字说话：引擎自己知道每帧出了多少（`stats.fps`），但这台
 * 机器上唯一能读到它的地方是渲染进程的 console——而那不进宿主的日志。所以每
 * 5 秒把帧率、画布尺寸、设备像素比一起交回插件进程落盘，调性能时才有依据。
 */
let statsTimer = null;

function stopSceneStats() {
  if (statsTimer !== null) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

function startSceneStats(id) {
  stopSceneStats();
  statsTimer = setInterval(() => {
    if (!sceneInstance || !host || typeof host.dispatch !== "function") return;
    const stats = sceneInstance.stats || {};
    const canvas = sceneInstance.canvas;
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    Promise.resolve()
      .then(() =>
        host.dispatch("plugin.call", {
          method: "reportEngineStats",
          args: {
            id,
            fps: Math.round((Number(stats.fps) || 0) * 10) / 10,
            running: stats.running !== false,
            width: canvas ? canvas.width : 0,
            height: canvas ? canvas.height : 0,
            dpr: Math.round(dpr * 100) / 100,
            viewport: `${(typeof innerWidth === "number" && innerWidth) || 0}x${(typeof innerHeight === "number" && innerHeight) || 0}`,
          },
        })
      )
      .catch(() => {
        /* 同上 */
      });
  }, 5000);
}

// 挂不上就别每 2 秒再试一遍：重试每次都要扫一遍 Steam 目录，日志里会全是
// reg query 的失败行，而界面还是什么都没有。
const SCENE_RETRY_MS = 30000;
let sceneRetryAt = 0;

async function mountScene(source) {
  const box = ensureContainer();
  if (!box) return;
  // 已经挂着这个包：只同步播放状态。一次挂载要几百毫秒到几秒。
  if (sceneInstance && sceneKey === source.id) {
    syncScene();
    return;
  }
  if (!sceneInstance && Date.now() < sceneRetryAt) return;
  // 上一次为同一个包取的字节还没回来（轮询每 2 秒回来一次）：等它，别再来一遍。
  if (scenePending && scenePending.id === source.id) return;

  const token = (sceneToken += 1);
  sceneKey = "";
  scenePending = { id: source.id, token };
  let stage = "engine";
  try {
    const engine = await loadSceneEngine();
    stage = "pkg";
    const bytes = await fetchScenePkg(source.id);
    // 收字节的这段时间里用户可能已经换了一张：对不上就整段丢弃。
    if (token !== sceneToken) return;

    if (sceneInstance) {
      try {
        sceneInstance.destroy();
      } catch {
        /* 已经拆掉的实例再拆一次不该炸 */
      }
      sceneInstance = null;
    }

    stage = "mount";
    const instance = await engine.mount(box, {
      source: {
        key: source.id,
        async scenePkg() {
          return bytes;
        },
        async project() {
          return { title: source.title || "", type: "scene", file: "scene.pkg" };
        },
      },
      fit: fitOf(currentFit),
      fps: SCENE_FPS,
      renderDpr: Math.min(
        typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
        SCENE_MAX_DPR
      ),
      autoplay: true,
      volume: 0,
      // 宿主 script-src 没有 'unsafe-eval'：开着只会让每次求值都撞一次 CSP。
      scripts: false,
    });
    if (token !== sceneToken) {
      try {
        instance.destroy();
      } catch {
        /* 同上 */
      }
      return;
    }

    sceneInstance = instance;
    sceneKey = source.id;
    sceneRetryAt = 0;
    current = { kind: "scene", file: source.file, title: source.title || "" };
    syncScene();
    reportEngineStatus({ ok: true, stage: "mounted", id: source.id, bytes: bytes.length });
    startSceneStats(source.id);
  } catch (error) {
    if (token !== sceneToken) return;
    sceneKey = "";
    sceneRetryAt = Date.now() + SCENE_RETRY_MS;
    if (container) container.setAttribute("data-piopt-engine-failed", "true");
    const message = String((error && (error.message || error)) || "unknown");
    console.warn("[PiOpt] scene 壁纸渲染失败：", source.id, stage, message);
    reportEngineStatus({ ok: false, stage, id: source.id, message });
  } finally {
    // 只有自己那道锁能解：中途换壁纸时上一次的 finally 不该把新锁清掉。
    if (scenePending && scenePending.token === token) scenePending = null;
  }
}

/** 撤掉视频那一套（含限帧的时间泵），容器留着。 */
function teardownVideo() {
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
  if (current.kind === "video") current = { kind: "", file: "", title: "" };
}

/** 撤掉 scene：先让引擎停循环，否则它会继续往一块没人看的画布上出帧。 */
function teardownScene() {
  sceneToken += 1;
  sceneKey = "";
  scenePending = null;
  stopSceneStats();
  if (sceneInstance) {
    try {
      sceneInstance.destroy();
    } catch {
      /* 同上 */
    }
    sceneInstance = null;
  }
  if (current.kind === "scene") current = { kind: "", file: "", title: "" };
}

function teardown() {
  teardownVideo();
  teardownScene();
  if (container) {
    container.remove();
    container = null;
  }
  current = { kind: "", file: "", title: "" };
}

// ------------------------------------------------------------------- state

function applyVideoLayer(box, source, state) {
  const element = ensureVideo();
  if (element.parentElement !== box) box.prepend(element);

  const fit = fitOf(state.fit);
  if (fit !== currentFit) {
    currentFit = fit;
    element.style.objectFit = fit;
  }

  if (current.file !== source.file) {
    current = { kind: "video", file: source.file, title: typeof source.title === "string" ? source.title : "" };
    element.src = fileUrlOf(source.file);
    element.load();
  }
  syncPlayback();
}

function applyState(state) {
  // 性能模式只改变绘制节奏，不改变这一层挂什么。
  performanceMode = state ? state.performance === true : false;
  sceneEnabled = state ? state.sceneEnabled !== false : true;

  const source = state && state.engine ? state.engine : null;
  const videoSource = source && source.kind === "video" && source.file ? source : null;
  // 总开关关掉时不挂载，但用户的选择留在设置里等你打开。
  const sceneSource = sceneEnabled && source && source.kind === "scene" && source.file ? source : null;

  if (!videoSource && !sceneSource) {
    teardown();
    return;
  }

  const box = ensureContainer();
  if (!box) return;
  box.removeAttribute("data-piopt-engine-failed");

  if (videoSource) {
    teardownScene();
    applyVideoLayer(box, videoSource, state);
    return;
  }

  teardownVideo();
  void mountScene(sceneSource);
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
  syncScene();
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
  focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;

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
  sceneEngineModule = null;
  sceneEnabled = true;
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
  SCENE_FPS,
  applyState,
  ensureContainer,
  teardown,
  teardownScene,
  syncPlayback,
  syncScene,
  mountScene,
  sceneStopped,
  paintFrame,
  frameBox,
  targetFps,
  getCurrent: () => ({ ...current, fit: currentFit }),
  getMode: () => ({ performance: performanceMode, focused, capped: cappedPlayback() }),
  getCanvas: () => canvas,
  getScene: () => sceneInstance,
  getSceneKey: () => sceneKey,
};
