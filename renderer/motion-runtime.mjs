// PiOpt — reversible & interruptible motion runtime for the PI-Desktop host window.
//
// Why this module exists alongside features/appearance/motion.js:
//   CSS transitions handle stateful elements that stay in the DOM, and CSS
//   `details::details-content` handles native <details>. However, several
//   high-frequency PI-Desktop components are conditionally rendered by React
//   (`{open ? <Node /> : null}`): closing a menu, popover, dialog, sheet or
//   collapsing a thinking/tool card removes the DOM node on the very first
//   frame, and toggling `.work-panel` / `.sidebar` mid-keyframe restarts from
//   0% instead of reversing from the current width.
//
// Contract & safety boundaries:
//   1. Never intercept or delay React's own DOM mutations: real React nodes are
//      never reparented or kept alive after React unmounts them.
//   2. Outgoing animations run on sanitized, inert, aria-hidden visual clones
//      (`data-pm-ghost="true"`), removed immediately on finish or interruption.
//   3. If the user re-opens / re-expands while an outgoing animation is still
//      in flight, the ghost is sampled at its exact instantaneous progress,
//      destroyed immediately, and the incoming real element resumes from that
//      exact height / opacity / transform / width with symmetric timing.
//   4. Reads `--pm-active` and `--pm-*` custom properties directly from `:root`,
//      requiring zero extra IPC methods or permissions. When motion override is
//      off, disabled, or reduced-motion is active (`--pm-active: 0`), this
//      runtime stays completely inert.

const GHOST_ATTR = "data-pm-ghost";
const LAYER_ATTR = "data-piopt-motion-layer";

export const MOTION_RUNTIME_CSS = [
  `[${LAYER_ATTR}]{position:fixed;inset:0;z-index:2147483640;pointer-events:none;overflow:hidden}`,
  `[${GHOST_ATTR}]{pointer-events:none!important;user-select:none!important;-webkit-user-select:none!important}`,
  `[${GHOST_ATTR}], [${GHOST_ATTR}] *{animation:none!important;transition:none!important}`,
].join("\n");

// Inline disclosures unmounted by React on collapse.
const DISCLOSURE_SELECTORS = [
  ".tool-row-body",
  ".subagent-topology-node>.subagent-run",
  ".review-change-card-body",
  ".task-output",
  ".message-error-details",
  ".projects-inspector",
  ".provider-model-card-details",
  ".provider-chosen-row-body",
  ".ext-sheet-advanced-body",
  ".composer-queued-prompt",
  ".composer-directory-drop",
  ".composer-stack>.asktool-card",
  ".plan-approval-bar",
  ".permission-card",
  ".scheduled-transcript",
];
const DISCLOSURE_SELECTOR = DISCLOSURE_SELECTORS.join(",");

// Compound modal / drawer / viewer layers portaled to document.body.
const MODAL_LAYER_SELECTORS = [
  ".overlay",
  ".search-overlay",
  ".plugins-modal-backdrop",
  ".plugins-sheet-layer",
  ".plugins-reviews-layer",
  ".mcpm-overlay",
  ".sklm-overlay",
  ".composer-image-preview",
  ".generated-image-viewer",
];

// Menus that must animate opacity only (never transform).
const MENU_OVERLAY_SELECTORS = [
  ".composer-model-menu",
  ".composer-permission-menu",
  ".composer-mode-menu",
  ".plan-approval-menu",
  ".agent-capability-menu",
  ".projects-menu",
  ".plugins-menu",
  ".scope-compact-menu",
  ".sidebar-row-menu",
  ".sidebar-popover",
  ".context-menu-submenu",
  ".context-menu",
];

// Standalone popovers that animate opacity + subtle lift/scale.
const POPOVER_OVERLAY_SELECTORS = [
  ".settings-font-menu",
  ".settings-language-menu",
  ".settings-theme-menu",
  ".settings-menu-select-menu",
  ".provider-model-menu",
  ".provider-model-multi-menu",
  ".provider-service-menu",
  ".model-default-menu",
  ".home-project-switcher-menu",
  ".composer-autocomplete",
  ".scope-popover",
  ".turn-usage-popover",
  ".context-inspector-popover",
  ".live-voice-popup",
  ".notification-popover",
];

// Tooltips & hover cards that carry their own positioning transform: fade only.
const FADE_OVERLAY_SELECTORS = [
  ".ui-tooltip",
  ".sidebar-session-hover-card",
  ".minimap-popover",
  ".image-hover-card",
];

const ALL_PORTAL_SELECTOR = [
  ...MODAL_LAYER_SELECTORS,
  ...MENU_OVERLAY_SELECTORS,
  ...POPOVER_OVERLAY_SELECTORS,
  ...FADE_OVERLAY_SELECTORS,
].join(",");

const INLINE_FLOAT_SELECTOR = ".jump-latest-btn,.chat-error-notice,.update-notice,.p-notice";

// ------------------------------------------------------------ bezier & math

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseBezier(str) {
  const match = /cubic-bezier\(\s*([+-]?\d*\.?\d+)\s*,\s*([+-]?\d*\.?\d+)\s*,\s*([+-]?\d*\.?\d+)\s*,\s*([+-]?\d*\.?\d+)\s*\)/i.exec(
    String(str || "")
  );
  if (!match) return [0.22, 1, 0.36, 1];
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

// Evaluates y(x) on cubic-bezier(x1, y1, x2, y2) for x in [0, 1].
export function sampleCubicBezier([x1, y1, x2, y2], x) {
  const target = clamp(x, 0, 1);
  if (target === 0 || target === 1) return target;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleSlope = (t) => (3 * ax * t + 2 * bx) * t + cx;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;

  let t = target;
  for (let i = 0; i < 6; i += 1) {
    const dx = sampleX(t) - target;
    if (Math.abs(dx) < 1e-6) break;
    const slope = sampleSlope(t);
    if (Math.abs(slope) < 1e-6) break;
    t = clamp(t - dx / slope, 0, 1);
  }
  return clamp(sampleY(t), 0, 1);
}

function parseMs(raw, fallback) {
  const text = String(raw || "").trim();
  if (!text) return fallback;
  if (text.endsWith("ms")) {
    const n = Number.parseFloat(text);
    return Number.isFinite(n) ? n : fallback;
  }
  if (text.endsWith("s")) {
    const n = Number.parseFloat(text) * 1000;
    return Number.isFinite(n) ? n : fallback;
  }
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n : fallback;
}

function parsePx(raw, fallback) {
  const n = Number.parseFloat(String(raw || "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function parseNum(raw, fallback) {
  const n = Number.parseFloat(String(raw || "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function nowMs() {
  return typeof performance === "object" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function isElement(node) {
  return Boolean(node) && node.nodeType === 1;
}

function matches(el, selector) {
  return isElement(el) && typeof el.matches === "function" && el.matches(selector);
}

function isGhost(el) {
  if (!isElement(el)) return false;
  if (typeof el.hasAttribute === "function" && el.hasAttribute(GHOST_ATTR)) return true;
  return typeof el.closest === "function" && Boolean(el.closest(`[${GHOST_ATTR}],[${LAYER_ATTR}]`));
}

// ------------------------------------------------------------ token reading

export function readMotionState(doc = typeof document !== "undefined" ? document : null) {
  if (!doc || !doc.documentElement || typeof getComputedStyle !== "function") {
    return { active: false };
  }
  const style = getComputedStyle(doc.documentElement);
  const active = style.getPropertyValue("--pm-active").trim() === "1";
  if (!active) return { active: false };
  const easeSymmetric = style.getPropertyValue("--pm-ease-symmetric").trim() || "cubic-bezier(.22,1,.36,1)";
  return {
    active: true,
    fast: Math.max(20, parseMs(style.getPropertyValue("--pm-fast"), 135)),
    base: Math.max(24, parseMs(style.getPropertyValue("--pm-base"), 195)),
    slow: Math.max(30, parseMs(style.getPropertyValue("--pm-slow"), 260)),
    distanceXs: parsePx(style.getPropertyValue("--pm-distance-xs"), 2),
    distanceSm: parsePx(style.getPropertyValue("--pm-distance-sm"), 4),
    distanceMd: parsePx(style.getPropertyValue("--pm-distance-md"), 7),
    distancePanel: parsePx(style.getPropertyValue("--pm-distance-panel"), 10),
    distanceSheet: parsePx(style.getPropertyValue("--pm-distance-sheet"), 16),
    scaleSubtle: parseNum(style.getPropertyValue("--pm-scale-subtle"), 0.988),
    scaleFrom: parseNum(style.getPropertyValue("--pm-scale-from"), 0.982),
    easeSymmetric,
    bezier: parseBezier(easeSymmetric),
  };
}

// ----------------------------------------------------------- clone sanitizer

function sanitizeClone(source) {
  const clone = source.cloneNode(true);
  clone.setAttribute(GHOST_ATTR, "true");
  clone.setAttribute("aria-hidden", "true");
  clone.inert = true;
  const strip = (el) => {
    if (!isElement(el)) return;
    el.removeAttribute("id");
    el.removeAttribute("data-testid");
    el.removeAttribute("data-piopt-entry");
    el.removeAttribute("autofocus");
    if (el.hasAttribute("role")) el.removeAttribute("role");
    if (el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  };
  strip(clone);
  if (typeof clone.querySelectorAll === "function") {
    for (const child of clone.querySelectorAll("[id],[data-testid],[data-piopt-entry],[autofocus],[role],[tabindex]")) {
      strip(child);
    }
  }
  return clone;
}

// Signature used to match an outgoing overlay ghost with an incoming re-open of
// the same component so mid-dismissal re-opens reverse smoothly from mid-flight.
function overlaySignature(el) {
  for (const selector of [
    ...MODAL_LAYER_SELECTORS,
    ...MENU_OVERLAY_SELECTORS,
    ...POPOVER_OVERLAY_SELECTORS,
    ...FADE_OVERLAY_SELECTORS,
  ]) {
    const cls = selector.slice(1);
    if (el.classList && el.classList.contains(cls)) return cls;
  }
  return el.className || el.tagName;
}

function classifyOverlay(el) {
  if (matches(el, ".plugins-sheet-layer,.plugins-reviews-layer,.mcpm-overlay,.sklm-overlay")) return "sheet-layer";
  if (matches(el, ".search-overlay")) return "search-layer";
  if (matches(el, ".overlay,.plugins-modal-backdrop,.composer-image-preview,.generated-image-viewer")) return "dialog-layer";
  if (matches(el, MENU_OVERLAY_SELECTORS.join(","))) return "menu";
  if (matches(el, POPOVER_OVERLAY_SELECTORS.join(","))) return "popover";
  if (matches(el, FADE_OVERLAY_SELECTORS.join(","))) return "fade";
  return null;
}

// Stateful menus/popovers mounted by the host's `$W` helper start hidden and
// only become visible once `.is-open` is added on the next animation frame.
const REQUIRES_OPEN_CLASS = new Set(
  [...MENU_OVERLAY_SELECTORS, ...POPOVER_OVERLAY_SELECTORS]
    .filter((s) => !["sidebar-row-menu", "sidebar-popover", "notification-popover"].includes(s.slice(1)))
    .map((s) => s.slice(1))
);

function wasVisiblyOpen(el, snap) {
  if (el.hasAttribute && el.hasAttribute("data-piopt-mp-probing")) return false;
  for (const cls of REQUIRES_OPEN_CLASS) {
    if (el.classList && el.classList.contains(cls) && !el.classList.contains("is-open")) {
      return false;
    }
  }
  return Boolean(snap && snap.width > 0 && snap.height > 0);
}

// ------------------------------------------------------------ runtime engine

let observer = null;
let layer = null;
let listenersBound = false;

// Geometry snapshots captured right before user interaction mutates the DOM.
let rectSnapshots = new WeakMap();
// Active incoming animations: WeakMap<Element, FlightRecord>
let activeExpands = new WeakMap();
let activeOverlayEntrances = new WeakMap();
// Active outgoing ghosts: Map<ParentOrKey, GhostRecord>
const activeCollapseGhosts = new Map();
const activeOverlayGhosts = new Map();
const activeFloatGhosts = new Map();
// Chrome panel / sidebar mid-flight state: WeakMap<Element, PanelFlight>
let panelFlights = new WeakMap();
let lastSidebarSnap = null;
let activeSidebarGhost = null;

function ensureLayer() {
  if (layer && layer.isConnected !== false) return layer;
  if (typeof document === "undefined" || !document.body) return null;
  layer = document.createElement("div");
  layer.setAttribute(LAYER_ATTR, "true");
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);
  return layer;
}

function runAnimation(el, keyframes, options, onDone) {
  if (!el || typeof el.animate !== "function") {
    if (onDone) onDone();
    return null;
  }
  try {
    const anim = el.animate(keyframes, options);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (onDone) onDone();
    };
    anim.onfinish = finish;
    anim.oncancel = finish;
    return anim;
  } catch {
    if (onDone) onDone();
    return null;
  }
}

function flightProgress(record, bezier) {
  if (!record || !(record.duration > 0)) return 1;
  const linear = clamp((nowMs() - record.startTime) / record.duration, 0, 1);
  return sampleCubicBezier(bezier, linear);
}

// Snapshot visible disclosures, overlays and panels right as an input event
// begins (capture phase), before React processes the click/key and unmounts them.
function captureSnapshot() {
  if (typeof document === "undefined" || !document.body) return;
  const tokens = readMotionState(document);
  if (!tokens.active) return;

  for (const selector of [DISCLOSURE_SELECTOR, ALL_PORTAL_SELECTOR, INLINE_FLOAT_SELECTOR]) {
    for (const el of document.querySelectorAll(selector)) {
      if (isGhost(el)) continue;
      const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      if (rect && rect.width > 0 && rect.height > 0) {
        rectSnapshots.set(el, {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          offsetTop: el.offsetTop || 0,
          offsetLeft: el.offsetLeft || 0,
        });
      }
    }
  }
  for (const rowBtn of document.querySelectorAll("button.file-tree-row")) {
    const dirBox = rowBtn.parentElement;
    if (!dirBox || isGhost(dirBox) || !dirBox.children || dirBox.children.length <= 1) continue;
    let totalHeight = 0;
    for (const child of dirBox.children) {
      if (child === rowBtn || isGhost(child)) continue;
      const r = typeof child.getBoundingClientRect === "function" ? child.getBoundingClientRect() : null;
      if (r && r.height > 0) totalHeight += r.height;
    }
    if (totalHeight > 0) rectSnapshots.set(dirBox, { top: 0, left: 0, width: 1, height: totalHeight });
  }
  const sidebar = document.querySelector(".sidebar");
  if (sidebar && !isGhost(sidebar)) {
    const rect = sidebar.getBoundingClientRect();
    if (rect.width > 0) lastSidebarSnap = { el: sidebar, width: rect.width };
  }
}

function isFileTreeDir(parent) {
  if (!isElement(parent) || !parent.children || !parent.children.length) return false;
  const first = parent.children[0];
  return isElement(first) && first.tagName === "BUTTON" && first.classList && first.classList.contains("file-tree-row");
}

function handleFileTreeCollapsed(parent, removedChildren, tokens) {
  if (!removedChildren.length || parent.isConnected === false) return;
  const incoming = activeExpands.get(parent);
  const snap = rectSnapshots.get(parent);
  let fromHeight = snap ? snap.height : 0;
  let fromOpacity = 1;
  let fullRefHeight = fromHeight;

  if (incoming) {
    const p = flightProgress(incoming, tokens.bezier);
    fullRefHeight = incoming.toHeight || fromHeight;
    fromHeight = incoming.fromHeight + (incoming.toHeight - incoming.fromHeight) * p;
    fromOpacity = clamp(p, 0.12, 1);
    if (incoming.anim) incoming.anim.cancel();
    activeExpands.delete(parent);
  }
  if (fromHeight <= 1 || fullRefHeight <= 1) return;

  const existing = activeCollapseGhosts.get(parent);
  if (existing) existing.cleanup();

  const wrapper = document.createElement("div");
  wrapper.setAttribute(GHOST_ATTR, "true");
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.inert = true;
  wrapper.style.overflow = "hidden";
  for (const child of removedChildren) wrapper.appendChild(sanitizeClone(child));
  parent.appendChild(wrapper);

  const ratio = clamp(fromHeight / fullRefHeight, 0.12, 1);
  const duration = Math.max(24, Math.round(tokens.base * ratio));
  let cleaned = false;
  const record = {
    ghost: wrapper,
    fromHeight,
    fromOpacity,
    startTime: nowMs(),
    duration,
    anim: null,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      activeCollapseGhosts.delete(parent);
      if (record.anim) {
        try { record.anim.cancel(); } catch { /* noop */ }
      }
      wrapper.remove();
    },
  };
  activeCollapseGhosts.set(parent, record);
  record.anim = runAnimation(
    wrapper,
    [
      { height: `${roundPx(fromHeight)}px`, opacity: roundAlpha(fromOpacity) },
      { height: "0px", opacity: 0 },
    ],
    { duration, easing: tokens.easeSymmetric },
    () => record.cleanup()
  );
}

function handleFileTreeExpanded(parent, addedChildren, tokens) {
  if (!addedChildren.length) return;
  let fullHeight = 0;
  for (const child of addedChildren) {
    const r = typeof child.getBoundingClientRect === "function" ? child.getBoundingClientRect() : null;
    fullHeight += (r && r.height) || child.offsetHeight || 0;
  }
  if (fullHeight <= 0) return;

  let startHeight = 0;
  let startOpacity = 0;
  const outgoing = activeCollapseGhosts.get(parent);
  if (outgoing) {
    const p = flightProgress(outgoing, tokens.bezier);
    startHeight = outgoing.fromHeight * (1 - p);
    startOpacity = outgoing.fromOpacity * (1 - p);
    outgoing.cleanup();
  }
  const ratio = clamp(1 - startHeight / fullHeight, 0.12, 1);
  const duration = Math.max(24, Math.round(tokens.base * ratio));
  const record = {
    startTime: nowMs(),
    duration,
    fromHeight: startHeight,
    toHeight: fullHeight,
    anim: null,
  };
  // Animate individual direct rows cleanly without reparenting React's own nodes.
  for (let i = 0; i < addedChildren.length; i += 1) {
    const child = addedChildren[i];
    const r = typeof child.getBoundingClientRect === "function" ? child.getBoundingClientRect() : null;
    const h = (r && r.height) || child.offsetHeight || 0;
    if (h <= 0) continue;
    const childStart = fullHeight > 0 ? (startHeight * h) / fullHeight : 0;
    const anim = runAnimation(
      child,
      [
        { height: `${roundPx(childStart)}px`, opacity: roundAlpha(startOpacity), overflow: "hidden" },
        { height: `${roundPx(h)}px`, opacity: 1, overflow: "hidden" },
      ],
      { duration, easing: tokens.easeSymmetric },
      i === 0 ? () => { if (activeExpands.get(parent) === record) activeExpands.delete(parent); } : undefined
    );
    if (i === 0) record.anim = anim;
  }
  activeExpands.set(parent, record);
}
// ------------------------------------------------ 1. Inline expand / collapse

function handleDisclosureAdded(el, tokens) {
  const parent = el.parentElement;
  if (!parent || typeof el.getBoundingClientRect !== "function") return;

  const fullHeight = el.getBoundingClientRect().height || el.offsetHeight || 0;
  if (fullHeight <= 0) return;

  let startHeight = 0;
  let startOpacity = 0;
  const outgoing = activeCollapseGhosts.get(parent);
  if (outgoing) {
    // Interrupted mid-collapse: sample exact instantaneous height and reverse!
    const p = flightProgress(outgoing, tokens.bezier);
    startHeight = outgoing.fromHeight * (1 - p);
    startOpacity = outgoing.fromOpacity * (1 - p);
    outgoing.cleanup();
  }

  const ratio = clamp(1 - startHeight / fullHeight, 0.12, 1);
  const duration = Math.max(24, Math.round(tokens.base * ratio));
  const record = {
    startTime: nowMs(),
    duration,
    fromHeight: startHeight,
    toHeight: fullHeight,
    anim: null,
  };
  record.anim = runAnimation(
    el,
    [
      { height: `${roundPx(startHeight)}px`, opacity: roundAlpha(startOpacity), overflow: "hidden" },
      { height: `${roundPx(fullHeight)}px`, opacity: 1, overflow: "hidden" },
    ],
    { duration, easing: tokens.easeSymmetric },
    () => {
      if (activeExpands.get(el) === record) activeExpands.delete(el);
    }
  );
  activeExpands.set(el, record);
}

function handleDisclosureRemoved(el, parent, nextSibling, tokens) {
  if (!parent || parent.isConnected === false) return;

  const incoming = activeExpands.get(el);
  const snap = rectSnapshots.get(el);
  let fromHeight = snap ? snap.height : 0;
  let fromOpacity = 1;
  let fullRefHeight = fromHeight;

  if (incoming) {
    // Interrupted mid-expand: compute exact instantaneous height and reverse!
    const p = flightProgress(incoming, tokens.bezier);
    fullRefHeight = incoming.toHeight || fromHeight;
    fromHeight = incoming.fromHeight + (incoming.toHeight - incoming.fromHeight) * p;
    fromOpacity = clamp(p, 0.12, 1);
    if (incoming.anim) incoming.anim.cancel();
    activeExpands.delete(el);
  }

  if (fromHeight <= 1 || fullRefHeight <= 1) return;

  const existing = activeCollapseGhosts.get(parent);
  if (existing) existing.cleanup();

  const ghost = sanitizeClone(el);
  ghost.style.overflow = "hidden";
  ghost.style.boxSizing = "border-box";
  if (nextSibling && nextSibling.parentNode === parent) {
    parent.insertBefore(ghost, nextSibling);
  } else {
    parent.appendChild(ghost);
  }

  const ratio = clamp(fromHeight / fullRefHeight, 0.12, 1);
  const duration = Math.max(24, Math.round(tokens.base * ratio));

  let cleaned = false;
  const record = {
    ghost,
    fromHeight,
    fromOpacity,
    startTime: nowMs(),
    duration,
    anim: null,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      activeCollapseGhosts.delete(parent);
      if (record.anim) {
        try { record.anim.cancel(); } catch { /* noop */ }
      }
      ghost.remove();
    },
  };
  activeCollapseGhosts.set(parent, record);
  record.anim = runAnimation(
    ghost,
    [
      { height: `${roundPx(fromHeight)}px`, opacity: roundAlpha(fromOpacity), marginTop: "", marginBottom: "" },
      { height: "0px", opacity: 0, marginTop: "0px", marginBottom: "0px", paddingTop: "0px", paddingBottom: "0px" },
    ],
    { duration, easing: tokens.easeSymmetric },
    () => record.cleanup()
  );
}

// ----------------------------------------------- 2. Portal pop / dismiss

function overlayKeyframes(kind, tokens, progressFrom = 0, progressTo = 1) {
  const lerp = (closed, open, p) => closed + (open - closed) * p;
  if (kind === "menu" || kind === "fade") {
    return [
      { opacity: roundAlpha(progressFrom) },
      { opacity: roundAlpha(progressTo) },
    ];
  }
  if (kind === "popover") {
    const y0 = lerp(tokens.distanceXs, 0, progressFrom);
    const y1 = lerp(tokens.distanceXs, 0, progressTo);
    const s0 = lerp(tokens.scaleSubtle, 1, progressFrom);
    const s1 = lerp(tokens.scaleSubtle, 1, progressTo);
    return [
      { opacity: roundAlpha(progressFrom), transform: `translateY(${roundPx(y0)}px) scale(${roundScale(s0)})` },
      { opacity: roundAlpha(progressTo), transform: progressTo === 1 ? "none" : `translateY(${roundPx(y1)}px) scale(${roundScale(s1)})` },
    ];
  }
  return [
    { opacity: roundAlpha(progressFrom) },
    { opacity: roundAlpha(progressTo) },
  ];
}

function durationForOverlay(kind, tokens) {
  if (kind === "dialog-layer" || kind === "search-layer" || kind === "sheet-layer") return tokens.slow;
  return tokens.fast;
}

let settingsCategory = "";
let settingsAnimation = null;

function syncSettingsCategory(tokens) {
  const title = document.querySelector(".settings-content-enter .settings-section-title");
  if (!title) { settingsCategory = ""; return; }
  const category = title.textContent.trim();
  if (category === settingsCategory) return;
  settingsCategory = category;
  const content = title.closest(".settings-content-enter");
  if (settingsAnimation) settingsAnimation.cancel();
  settingsAnimation = runAnimation(content,
    [{ opacity: .55 }, { opacity: 1 }],
    { duration: tokens.base, easing: tokens.easeSymmetric });
}

function handleOverlayOpened(el, tokens) {
  const kind = classifyOverlay(el);
  if (!kind) return;
  const sig = overlaySignature(el);
  const fullDuration = durationForOverlay(kind, tokens);
  if (el.hasAttribute("data-piopt-mp-probing")) return;
  const box = el.getBoundingClientRect();
  if (box.width > 0 && box.height > 0) {
    rectSnapshots.set(el, { top: box.top, left: box.left, width: box.width, height: box.height });
  }

  let startProgress = 0;
  const outgoing = activeOverlayGhosts.get(sig);
  if (outgoing) {
    // Re-opened while dismissing: sample current visibility and reverse from mid-air!
    const p = flightProgress(outgoing, tokens.bezier);
    startProgress = clamp(outgoing.startProgress * (1 - p), 0, 0.92);
    outgoing.cleanup();
  }

  const record = {
    startTime: nowMs(),
    duration: Math.max(20, Math.round(fullDuration * (1 - startProgress))),
    startProgress,
    anim: null,
  };
  activeOverlayEntrances.set(el, record);

  // If resuming from an interrupted dismissal, drive the element smoothly from `startProgress` to 1.
  if (startProgress > 0.02) {
    if (kind === "dialog-layer" || kind === "search-layer" || kind === "sheet-layer") {
      animateCompoundLayer(el, kind, tokens, startProgress, 1, record.duration);
    } else {
      record.anim = runAnimation(
        el,
        overlayKeyframes(kind, tokens, startProgress, 1),
        { duration: record.duration, easing: tokens.easeSymmetric },
        () => {
          if (activeOverlayEntrances.get(el) === record) activeOverlayEntrances.delete(el);
        }
      );
    }
  }
}

function animateCompoundLayer(root, kind, tokens, fromP, toP, duration, onDone) {
  const lerp = (closed, open, p) => closed + (open - closed) * p;
  const isSelfDialog = root.matches(".composer-image-preview,.generated-image-viewer");
  const scrim = isSelfDialog
    ? null
    : root.matches(".overlay,.search-overlay,.plugins-modal-backdrop,.mcpm-overlay,.sklm-overlay")
      ? root
      : root.querySelector(".plugins-sheet-scrim,.plugins-reviews-scrim");
  const inner = isSelfDialog
    ? root
    : root.querySelector(
        ".dialog,.p-dialog,.plugins-modal,.search-dialog,.plugins-sheet,.plugins-reviews,.mcpm-sheet,.sklm-sheet"
      );
  if (scrim && scrim !== inner) {
    runAnimation(
      scrim,
      [{ opacity: roundAlpha(fromP) }, { opacity: roundAlpha(toP) }],
      { duration, easing: tokens.easeSymmetric },
      !inner ? onDone : undefined
    );
  }

  if (!inner) {
    if (!scrim && onDone) onDone();
    return;
  }

  let kf;
  if (kind === "sheet-layer" && matches(inner, ".plugins-sheet,.plugins-reviews")) {
    const x0 = lerp(tokens.distanceSheet, 0, fromP);
    const x1 = lerp(tokens.distanceSheet, 0, toP);
    kf = [
      { opacity: roundAlpha(fromP), transform: `translateX(${roundPx(x0)}px)` },
      { opacity: roundAlpha(toP), transform: toP === 1 ? "translateX(0px)" : `translateX(${roundPx(x1)}px)` },
    ];
  } else {
    const sign = kind === "search-layer" ? -1 : 1;
    const y0 = lerp(tokens.distanceMd * sign, 0, fromP);
    const y1 = lerp(tokens.distanceMd * sign, 0, toP);
    const s0 = lerp(tokens.scaleFrom, 1, fromP);
    const s1 = lerp(tokens.scaleFrom, 1, toP);
    kf = [
      { opacity: roundAlpha(fromP), transform: `translateY(${roundPx(y0)}px) scale(${roundScale(s0)})` },
      { opacity: roundAlpha(toP), transform: toP === 1 ? "none" : `translateY(${roundPx(y1)}px) scale(${roundScale(s1)})` },
    ];
  }
  runAnimation(inner, kf, { duration, easing: tokens.easeSymmetric }, onDone);
}

function handleOverlayRemoved(el, tokens) {
  const kind = classifyOverlay(el);
  if (!kind) return;
  const snap = rectSnapshots.get(el);
  if (!wasVisiblyOpen(el, snap)) return;

  const sig = overlaySignature(el);
  const fullDuration = durationForOverlay(kind, tokens);

  let startProgress = 1;
  const incoming = activeOverlayEntrances.get(el);
  if (incoming) {
    const p = flightProgress(incoming, tokens.bezier);
    startProgress = clamp(incoming.startProgress + (1 - incoming.startProgress) * p, 0.12, 1);
    if (incoming.anim) incoming.anim.cancel();
    activeOverlayEntrances.delete(el);
  }

  const hostLayer = ensureLayer();
  if (!hostLayer) return;

  const previous = activeOverlayGhosts.get(sig);
  if (previous) previous.cleanup();

  const ghost = sanitizeClone(el);
  // Pin fixed coordinates for floating popovers/menus that did not inline top/left.
  if (kind !== "dialog-layer" && kind !== "search-layer" && kind !== "sheet-layer" && snap) {
    ghost.style.position = "fixed";
    if (!ghost.style.top) ghost.style.top = `${roundPx(snap.top)}px`;
    if (!ghost.style.left) ghost.style.left = `${roundPx(snap.left)}px`;
    ghost.style.width = `${roundPx(snap.width)}px`;
    ghost.style.opacity = "1";
    ghost.style.visibility = "visible";
  }
  hostLayer.appendChild(ghost);

  const duration = Math.max(20, Math.round(fullDuration * startProgress));
  let cleaned = false;
  const record = {
    ghost,
    startProgress,
    startTime: nowMs(),
    duration,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (activeOverlayGhosts.get(sig) === record) activeOverlayGhosts.delete(sig);
      ghost.remove();
    },
  };
  activeOverlayGhosts.set(sig, record);

  if (kind === "dialog-layer" || kind === "search-layer" || kind === "sheet-layer") {
    animateCompoundLayer(ghost, kind, tokens, startProgress, 0, duration, () => record.cleanup());
  } else {
    runAnimation(
      ghost,
      overlayKeyframes(kind, tokens, startProgress, 0),
      { duration, easing: tokens.easeSymmetric },
      () => record.cleanup()
    );
  }
}

// --------------------------------- 3. Inline floating controls (jump button)

function handleInlineFloatRemoved(el, parent, tokens) {
  if (!parent || parent.isConnected === false) return;
  const snap = rectSnapshots.get(el);
  if (!snap || snap.width <= 0 || snap.height <= 0) return;

  const key = `${parent.className}:${el.className}`;
  const prev = activeFloatGhosts.get(key);
  if (prev) prev.cleanup();

  const ghost = sanitizeClone(el);
  parent.appendChild(ghost);

  let cleaned = false;
  const record = {
    ghost,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (activeFloatGhosts.get(key) === record) activeFloatGhosts.delete(key);
      ghost.remove();
    },
  };
  activeFloatGhosts.set(key, record);

  const isJump = matches(el, ".jump-latest-btn");
  const kf = isJump
    ? [
        { opacity: 1, scale: 1 },
        { opacity: 0, scale: tokens.scaleFrom },
      ]
    : [
        { opacity: 1, transform: "translateY(0) scale(1)" },
        { opacity: 0, transform: `translateY(${roundPx(-tokens.distanceSm)}px) scale(${roundScale(tokens.scaleSubtle)})` },
      ];
  runAnimation(ghost, kf, { duration: tokens.base, easing: tokens.easeSymmetric }, () => record.cleanup());
}

// ------------------------- 4. Interruptible WorkPanel & Sidebar transitions

function syncChromePanel(el, kind, tokens) {
  if (!el || isGhost(el) || typeof el.getBoundingClientRect !== "function") return;
  const isWorkPanel = kind === "work-panel";
  const exiting = el.classList.contains("is-exiting");
  const entering = isWorkPanel ? !exiting && !el.classList.contains("work-panel-pending") : el.classList.contains("is-entering");
  if (!entering && !exiting) return;

  const direction = exiting ? "out" : "in";
  const prev = panelFlights.get(el);
  if (prev && prev.direction === direction) return;

  const fullDuration = isWorkPanel ? tokens.slow : tokens.base;
  const propFrom = isWorkPanel ? "--pm-wp-from" : "--pm-sb-from";
  const propShift = isWorkPanel ? "--pm-wp-shift" : "--pm-sb-shift";
  const sign = isWorkPanel ? 1 : -1;

  // Measure target full width from inline style or computed geometry.
  const targetWidth = isWorkPanel
    ? parsePx(el.style.getPropertyValue("--work-panel-width") || el.style.width, el.getBoundingClientRect().width || 380)
    : Math.max(prev ? prev.targetWidth : 0, lastSidebarSnap ? lastSidebarSnap.width : 0, el.getBoundingClientRect().width || 275);

  let currentWidth = direction === "in" ? 0 : targetWidth;

  // Case A: Reversing an already-running sidebar collapse ghost when re-opening!
  const workGhost = isWorkPanel && activeFloatGhosts.get("work-panel-exit");
  if (workGhost && direction === "in") {
    currentWidth = workGhost.fromWidth * (1 - flightProgress(workGhost, tokens.bezier));
    workGhost.cleanup();
  }
  if (!isWorkPanel && direction === "in" && activeSidebarGhost) {
    const p = flightProgress(activeSidebarGhost, tokens.bezier);
    currentWidth = activeSidebarGhost.fromWidth * (1 - p);
    activeSidebarGhost.cleanup();
  } else if (prev && prev.direction !== direction) {
    // Case B: Mid-flight reversal on the live panel element!
    const p = flightProgress(prev, tokens.bezier);
    currentWidth = prev.fromWidth + (prev.toWidth - prev.fromWidth) * p;
  }

  const interrupted = direction === "in"
    ? currentWidth > 1 && currentWidth < targetWidth - 1
    : currentWidth > 1 && currentWidth < targetWidth - 1;

  const toWidth = direction === "in" ? targetWidth : 0;
  const ratio = targetWidth > 0 ? clamp(Math.abs(toWidth - currentWidth) / targetWidth, 0.12, 1) : 1;
  const duration = Math.max(24, Math.round(fullDuration * ratio));

  if (interrupted) {
    const openRatio = clamp(currentWidth / targetWidth, 0, 1);
    const shift = roundPx((1 - openRatio) * tokens.distancePanel * sign);
    el.style.setProperty(propFrom, `${roundPx(currentWidth)}px`);
    el.style.setProperty(propShift, `${shift}px`);
    el.style.animationDuration = `${duration}ms`;
    el.style.setProperty("animation-duration", `${duration}ms`, "important");
  } else {
    el.style.removeProperty(propFrom);
    el.style.removeProperty(propShift);
    el.style.animationDuration = "";
  }

  const record = {
    direction,
    startTime: nowMs(),
    duration,
    fromWidth: currentWidth,
    toWidth,
    targetWidth,
  };
  panelFlights.set(el, record);

  const clearInline = (event) => {
    if (event && event.target !== el) return;
    el.removeEventListener("animationend", clearInline);
    if (panelFlights.get(el) === record) {
      panelFlights.delete(el);
      el.style.removeProperty(propFrom);
      el.style.removeProperty(propShift);
      el.style.animationDuration = "";
    }
  };
  el.addEventListener("animationend", clearInline);
}

// If speed < 0.8x makes `--pm-base` exceed PI-Desktop's hardcoded 240ms sidebar
// fallback timer, React unmounts `.sidebar.is-exiting` mid-slide. Finish the
// remaining width smoothly without touching opacity (frosted-glass safe).
function handleSidebarPrematureUnmount(el, parent, nextSibling, tokens, workPanel = false) {
  if (!parent || parent.isConnected === false) return;
  const flight = panelFlights.get(el);
  if (!flight || flight.direction !== "out") return;
  const p = flightProgress(flight, tokens.bezier);
  const remainingWidth = flight.fromWidth * (1 - p);
  if (remainingWidth <= 4) return;

  const previousGhost = workPanel ? activeFloatGhosts.get("work-panel-exit") : activeSidebarGhost;
  if (previousGhost) previousGhost.cleanup();
  const ghost = sanitizeClone(el);
  ghost.classList.remove("is-entering", "is-exiting");
  ghost.style.overflow = "hidden";
  if (nextSibling && nextSibling.parentNode === parent) parent.insertBefore(ghost, nextSibling);
  else if (workPanel) parent.appendChild(ghost);
  else parent.prepend(ghost);

  const duration = flight.duration;
  const elapsed = clamp(nowMs() - flight.startTime, 0, duration);
  let cleaned = false;
  const record = {
    ghost,
    fromWidth: flight.fromWidth,
    startTime: flight.startTime,
    duration,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (activeSidebarGhost === record) activeSidebarGhost = null;
      if (workPanel && activeFloatGhosts.get("work-panel-exit") === record) activeFloatGhosts.delete("work-panel-exit");
      ghost.remove();
    },
  };
  if (workPanel) activeFloatGhosts.set("work-panel-exit", record);
  else activeSidebarGhost = record;
  const continuation = runAnimation(
    ghost,
    [
      { flexBasis: `${roundPx(flight.fromWidth)}px`, width: `${roundPx(flight.fromWidth)}px`, transform: `translateX(${roundPx((1 - flight.fromWidth / flight.targetWidth) * tokens.distancePanel * (workPanel ? 1 : -1))}px)` },
      { flexBasis: "0px", width: "0px", transform: `translateX(${roundPx(tokens.distancePanel * (workPanel ? 1 : -1))}px)` },
    ],
    { duration, easing: tokens.easeSymmetric },
    () => record.cleanup()
  );
  // Continue the original curve at the host's cutoff, preserving time and velocity.
  if (continuation) continuation.currentTime = elapsed;
}

function roundPx(value) {
  return Math.round(value * 100) / 100;
}

function roundAlpha(value) {
  return Math.round(clamp(value, 0, 1) * 1000) / 1000;
}

function roundScale(value) {
  return Math.round(value * 10000) / 10000;
}

// -------------------------------------------------------- mutation dispatch

function processMutations(records) {
  const tokens = readMotionState();
  if (!tokens.active) return;

  // Collect every added node in this batch so we distinguish an interactive
  // disclosure opening inside an existing row from an entire page/turn mount.
  const batchAdded = new Set();
  const batchRemoved = new Set();
  for (const record of records) {
    if (record.type !== "childList") continue;
    for (const node of record.addedNodes) if (isElement(node) && !isGhost(node)) batchAdded.add(node);
    for (const node of record.removedNodes) if (isElement(node) && !isGhost(node)) batchRemoved.add(node);
  }
  syncSettingsCategory(tokens);

  for (const record of records) {
    if (record.type === "attributes" && record.attributeName === "class") {
      const target = record.target;
      if (!isElement(target) || isGhost(target)) continue;
      if (target.classList.contains("work-panel")) {
        syncChromePanel(target, "work-panel", tokens);
      } else if (target.classList.contains("sidebar")) {
        syncChromePanel(target, "sidebar", tokens);
      } else if (matches(target, ALL_PORTAL_SELECTOR)) {
        const wasOpen = String(record.oldValue || "").split(/\s+/).includes("is-open");
        if (target.classList.contains("is-open") && !wasOpen) handleOverlayOpened(target, tokens);
        // Keep the incoming flight until removal: it is needed for a quick dismissal.
      }
      continue;
    }

    if (record.type !== "childList") continue;
    const parent = record.target;
    if (!isElement(parent) || isGhost(parent)) continue;

    // File-tree directory children expand/collapse as a sibling group under the folder wrapper.
    if (isFileTreeDir(parent) && !batchAdded.has(parent) && !batchRemoved.has(parent)) {
      const dirRemoved = [...record.removedNodes].filter((n) => isElement(n) && !isGhost(n));
      const dirAdded = [...record.addedNodes].filter((n) => isElement(n) && !isGhost(n));
      if (dirRemoved.length) handleFileTreeCollapsed(parent, dirRemoved, tokens);
      if (dirAdded.length) handleFileTreeExpanded(parent, dirAdded, tokens);
      continue;
    }

    // 1. Removals
    for (const node of record.removedNodes) {
      if (!isElement(node) || isGhost(node)) continue;
      if (batchRemoved.has(parent) || parent.isConnected === false) continue;

      if (node.classList && node.classList.contains("work-panel")) {
        handleSidebarPrematureUnmount(node, parent, record.nextSibling, tokens, true);
        continue;
      }
      if (node.classList && node.classList.contains("sidebar")) {
        handleSidebarPrematureUnmount(node, parent, record.nextSibling, tokens);
        continue;
      }
      if (matches(node, DISCLOSURE_SELECTOR)) {
        handleDisclosureRemoved(node, parent, record.nextSibling, tokens);
        continue;
      }
      if (matches(node, ALL_PORTAL_SELECTOR)) {
        handleOverlayRemoved(node, tokens);
        continue;
      }
      if (matches(node, INLINE_FLOAT_SELECTOR)) {
        handleInlineFloatRemoved(node, parent, tokens);
      }
    }

    // 2. Additions
    for (const node of record.addedNodes) {
      if (!isElement(node) || isGhost(node)) continue;

      if (node.classList && node.classList.contains("work-panel")) {
        syncChromePanel(node, "work-panel", tokens);
        continue;
      }
      if (node.classList && node.classList.contains("sidebar")) {
        syncChromePanel(node, "sidebar", tokens);
        continue;
      }
      if (matches(node, ALL_PORTAL_SELECTOR)) {
        const needsOpenClass = [...REQUIRES_OPEN_CLASS].some((cls) => node.classList && node.classList.contains(cls));
        if (!needsOpenClass || node.classList.contains("is-open")) {
          handleOverlayOpened(node, tokens);
        }
        continue;
      }
      // Inline disclosure: animate only when its parent was already in the DOM
      // (i.e. user toggled a row open, not initial bulk render of a whole page).
      if (matches(node, DISCLOSURE_SELECTOR) && !batchAdded.has(parent)) {
        handleDisclosureAdded(node, tokens);
      }
    }
  }
}

// ---------------------------------------------------------------- lifecycle

export function mountMotionRuntime() {
  if (typeof document === "undefined" || !document.documentElement) return;
  if (!listenersBound && typeof document.addEventListener === "function") {
    document.addEventListener("pointerdown", captureSnapshot, true);
    document.addEventListener("click", captureSnapshot, true);
    document.addEventListener("keydown", captureSnapshot, true);
    listenersBound = true;
  }
  if (!observer && typeof MutationObserver === "function" && document.body) {
    observer = new MutationObserver(processMutations);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      attributeFilter: ["class"],
    });
  }
}

export function unmountMotionRuntime() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (listenersBound && typeof document !== "undefined" && typeof document.removeEventListener === "function") {
    document.removeEventListener("pointerdown", captureSnapshot, true);
    document.removeEventListener("click", captureSnapshot, true);
    document.removeEventListener("keydown", captureSnapshot, true);
    listenersBound = false;
  }
  for (const record of [...activeCollapseGhosts.values()]) record.cleanup();
  for (const record of [...activeOverlayGhosts.values()]) record.cleanup();
  for (const record of [...activeFloatGhosts.values()]) record.cleanup();
  if (activeSidebarGhost) activeSidebarGhost.cleanup();
  activeCollapseGhosts.clear();
  activeOverlayGhosts.clear();
  activeFloatGhosts.clear();
  rectSnapshots = new WeakMap();
  activeExpands = new WeakMap();
  activeOverlayEntrances = new WeakMap();
  panelFlights = new WeakMap();
  settingsCategory = "";
  if (settingsAnimation) settingsAnimation.cancel();
  settingsAnimation = null;
  lastSidebarSnap = null;
  if (layer) {
    layer.remove();
    layer = null;
  }
}

export const __internals = {
  GHOST_ATTR,
  LAYER_ATTR,
  DISCLOSURE_SELECTORS,
  MODAL_LAYER_SELECTORS,
  MENU_OVERLAY_SELECTORS,
  POPOVER_OVERLAY_SELECTORS,
  FADE_OVERLAY_SELECTORS,
  captureSnapshot,
  processMutations,
};
