// PiOpt — host-window entry module (manifest.renderer, renderer.extension).
//
// PI-Desktop has no slot for the sidebar footer, so this module works on the
// host's own footer the way a stylesheet would: it mounts one button into
// `.sidebar-footer .footer-actions`, directly after the host's plugin button —
// the second of the four — and puts it back whenever a re-render drops it.
//
// The button wears the host's own `.footer-action` geometry so it lines up with
// the four it sits between. The click goes through `plugin.call`, so the main
// process decides how the panel opens; nothing here reaches the panel directly.
//
// The same module also owns the chat composer's model popup rewrite
// (renderer/model-picker.mjs): both are "the host window's own DOM", so they
// travel together and share one injected stylesheet.

import { MODEL_PICKER_CSS, mountModelPicker, unmountModelPicker } from "./model-picker.mjs";
import { MOTION_RUNTIME_CSS, mountMotionRuntime, unmountMotionRuntime } from "./motion-runtime.mjs";
import { NAV_ENTRIES_CSS, mountNavEntries, unmountNavEntries } from "./nav-entries.mjs";
import { COMMAND_BUTTON_CSS, mountCommandButton, unmountCommandButton } from "./command-button.mjs";
import {
  WALLPAPER_RUNTIME_CSS,
  mountEngineWallpaper,
  unmountEngineWallpaper,
} from "./wallpaper-runtime.mjs";
const ENTRY_ATTR = "data-piopt-entry";
const ENTRY_CLASS = "piopt-entry";
const HOST_ACTION_CLASS = "footer-action";
const CONTAINER_SELECTOR = ".sidebar-footer .footer-actions";
const ANCHOR_SELECTOR = '[data-nav="plugins"]';
const LABEL = "PiOpt 控制台";
const STYLE_ATTR = "data-piopt-entry-style";
const BUSY_ATTR = "data-piopt-busy";
const SCAN_DELAY_MS = 120;

// PiOpt's own mark: the three bars that sit beside the product name inside the
// panel, drawn in the current icon colour so the host's row stays one family.
const ICON =
  '<span class="piopt-mark" aria-hidden="true"><i></i><i></i><i></i></span>';

const STYLE = [
  `[${ENTRY_ATTR}]{border:0;background:transparent;padding:0;margin:0;cursor:pointer;user-select:none;-webkit-user-select:none}`,
  `[${ENTRY_ATTR}] .piopt-mark{width:13px;height:13px;display:grid;grid-template-columns:repeat(3,3px);align-items:end;gap:2px}`,
  `[${ENTRY_ATTR}] .piopt-mark i{display:block;border-radius:1px;background:currentColor}`,
  `[${ENTRY_ATTR}] .piopt-mark i:nth-child(1){height:6px;opacity:.55}`,
  `[${ENTRY_ATTR}] .piopt-mark i:nth-child(2){height:13px}`,
  `[${ENTRY_ATTR}] .piopt-mark i:nth-child(3){height:9px;opacity:.75}`,
  `[${ENTRY_ATTR}] svg{display:block}`,
  `[${ENTRY_ATTR}][${BUSY_ATTR}="true"]{opacity:.55}`,
  MODEL_PICKER_CSS,
  MOTION_RUNTIME_CSS,
  NAV_ENTRIES_CSS,
  COMMAND_BUTTON_CSS,
  WALLPAPER_RUNTIME_CSS,
].join("\n");

let host = null;
let observer = null;
let scanTimer = null;
let styleDisposer = null;

// ---------------------------------------------------------------- host bridge

async function openConsole(button) {
  if (!host || typeof host.dispatch !== "function") return;
  if (button) button.setAttribute(BUSY_ATTR, "true");
  try {
    await host.dispatch("plugin.call", { method: "openConsole", args: {} });
  } catch (error) {
    // A refused call leaves the console closed; the command palette still works.
    console.warn("[PiOpt] the footer entry could not open the console", error);
  } finally {
    if (button) button.removeAttribute(BUSY_ATTR);
  }
}

// ------------------------------------------------------------------- mounting

function buildButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${HOST_ACTION_CLASS} ${ENTRY_CLASS}`;
  button.setAttribute(ENTRY_ATTR, "true");
  button.setAttribute("data-nav", "piopt");
  button.setAttribute("data-pi-plugin", "local.piopt");
  button.setAttribute("aria-label", LABEL);
  button.title = LABEL;
  button.innerHTML = ICON;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openConsole(button);
  });
  return button;
}

function placeButton(container, button, anchor) {
  if (anchor) {
    // After the host's own plugin button: the second of the four.
    if (button.previousElementSibling !== anchor) anchor.after(button);
    return;
  }
  // No anchor means the host changed its footer; keep the entry at the end
  // rather than dropping it, and let the next scan try to line it up again.
  if (button.parentElement !== container || button !== container.lastElementChild) {
    container.append(button);
  }
}

function scan() {
  scanTimer = null;
  const container = document.querySelector(CONTAINER_SELECTOR);
  if (!container) return;

  const existing = container.querySelector(`[${ENTRY_ATTR}]`);
  const anchor = container.querySelector(ANCHOR_SELECTOR);
  if (existing) {
    placeButton(container, existing, anchor);
    return;
  }
  placeButton(container, buildButton(), anchor);
}

function scheduleScan() {
  if (scanTimer !== null) return;
  scanTimer = setTimeout(scan, SCAN_DELAY_MS);
}

function mountStyle(css) {
  const element = document.createElement("style");
  element.setAttribute(STYLE_ATTR, "true");
  element.textContent = css;
  document.head.append(element);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    element.remove();
  };
}

// ------------------------------------------------------------------ lifecycle

export async function onLoad(pi) {
  host = pi;
  if (!styleDisposer) styleDisposer = mountStyle(STYLE);

  scan();

  if (typeof MutationObserver === "function" && document.documentElement) {
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  // The footer only exists while a project shell is mounted, so a scan when the
  // window wakes up covers the case where it was built while the tab was hidden.
  document.addEventListener("visibilitychange", scheduleScan);

  // The popup rewrite and reversible motion coordinator ride along: same window, same lifecycle.
  mountMotionRuntime();
  await mountNavEntries(pi);
  await mountCommandButton(pi);
  await mountModelPicker(pi);
  // 视频壁纸跟着面板走：没有设置事件，就靠这个模块自己轮询并挂载。
  await mountEngineWallpaper(pi);
}

export async function onUnload() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (scanTimer !== null) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
  document.removeEventListener("visibilitychange", scheduleScan);
  unmountModelPicker();
  unmountNavEntries();
  unmountCommandButton();
  unmountEngineWallpaper();
  unmountMotionRuntime();
  for (const element of document.querySelectorAll(`[${ENTRY_ATTR}]`)) element.remove();
  if (styleDisposer) {
    styleDisposer();
    styleDisposer = null;
  }
  host = null;
}

// Exposed for the test that keeps the host selectors honest.
export const __internals = {
  CONTAINER_SELECTOR,
  ANCHOR_SELECTOR,
  ENTRY_ATTR,
  HOST_ACTION_CLASS,
  LABEL,
};
