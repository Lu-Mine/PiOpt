// PiOpt - host-window entry module (manifest.renderer, renderer.extension).
//
// The host footer differs between PI-Desktop releases. This module keeps the
// console entry beside the footer settings control in 0.23 and supports the
// older footer-actions group without changing the host navigation tree.

import { MODEL_PICKER_CSS, mountModelPicker, unmountModelPicker } from "./model-picker.mjs";
import { MOTION_RUNTIME_CSS, mountMotionRuntime, unmountMotionRuntime } from "./motion-runtime.mjs";
import { NAV_ENTRIES_CSS, mountNavEntries, unmountNavEntries } from "./nav-entries.mjs";
import { COMMAND_BUTTON_CSS, mountCommandButton, unmountCommandButton } from "./command-button.mjs";
import { PERMISSION_ICON_CSS, mountPermissionIcons, unmountPermissionIcons } from "./permission-icons.mjs";
import { mountComposerCompact, unmountComposerCompact } from "./composer-compact.mjs";
import { COMMAND_ENHANCE_CSS, mountCommandEnhance, unmountCommandEnhance } from "./command-enhance.mjs";
import { mountOpenOutput, unmountOpenOutput } from "./open-output.mjs";
import {
  WALLPAPER_RUNTIME_CSS,
  mountEngineWallpaper,
  unmountEngineWallpaper,
} from "./wallpaper-runtime.mjs";

const ENTRY_ATTR = "data-piopt-entry";
const ENTRY_CLASS = "piopt-entry";
const HOST_ACTION_CLASS = "footer-settings";
const LEGACY_ACTION_CLASS = "footer-action";
const FOOTER_SELECTOR = ".sidebar-footer";
const LEGACY_CONTAINER_SELECTOR = ".sidebar-footer .footer-actions";
const ANCHOR_SELECTOR = '[data-nav="settings"]';
const LEGACY_ANCHOR_SELECTOR = '[data-nav="plugins"]';
const LABEL = "PiOpt 控制台";
const STYLE_ATTR = "data-piopt-entry-style";
const BUSY_ATTR = "data-piopt-busy";
const SCAN_DELAY_MS = 120;
const ICON = '<span class="piopt-mark" aria-hidden="true"><i></i><i></i><i></i></span>';

export const KATEX_OVERLAY_CSS = '.katex span.overlay{position:static;inset:auto;z-index:auto;background:transparent;padding:0;display:block;animation:none}';

const STYLE = [
  `[${ENTRY_ATTR}]{border:0;background:transparent;padding:0;margin:0;cursor:pointer;user-select:none;-webkit-user-select:none}`,
  `[${ENTRY_ATTR}] .piopt-mark{width:13px;height:13px;display:grid;grid-template-columns:repeat(3,3px);align-items:end;gap:2px}`,
  `[${ENTRY_ATTR}] .piopt-mark i{display:block;border-radius:1px;background:currentColor}`,
  `[${ENTRY_ATTR}] .piopt-mark i:nth-child(1){height:6px;opacity:.55}`,
  `[${ENTRY_ATTR}] .piopt-mark i:nth-child(2){height:13px}`,
  `[${ENTRY_ATTR}] .piopt-mark i:nth-child(3){height:9px;opacity:.75}`,
  `[${ENTRY_ATTR}] svg{display:block}`,
  `[${ENTRY_ATTR}][${BUSY_ATTR}="true"]{opacity:.55}`,
  `.sidebar-footer > [${ENTRY_ATTR}]{width:32px;min-width:32px;flex:0 0 32px;padding:0!important;justify-content:center}`,
  KATEX_OVERLAY_CSS,
  MODEL_PICKER_CSS,
  MOTION_RUNTIME_CSS,
  NAV_ENTRIES_CSS,
  PERMISSION_ICON_CSS,
  COMMAND_ENHANCE_CSS,
  COMMAND_BUTTON_CSS,
  WALLPAPER_RUNTIME_CSS,
].join("\n");

let host = null;
let observer = null;
let scanTimer = null;
let styleDisposer = null;

async function openConsole(button) {
  if (!host || typeof host.dispatch !== "function") return;
  if (button) button.setAttribute(BUSY_ATTR, "true");
  try {
    await host.dispatch("plugin.call", { method: "openConsole", args: {} });
  } catch (error) {
    console.warn("[PiOpt] the footer entry could not open the console", error);
  } finally {
    if (button) button.removeAttribute(BUSY_ATTR);
  }
}

function buildButton(legacy) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${legacy ? LEGACY_ACTION_CLASS : HOST_ACTION_CLASS} ${ENTRY_CLASS}`;
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
    if (button.previousElementSibling !== anchor) anchor.after(button);
    return;
  }
  if (button.parentElement !== container || button !== container.lastElementChild) container.append(button);
}

function scan() {
  scanTimer = null;
  const footer = document.querySelector(FOOTER_SELECTOR);
  if (!footer) return;

  const legacyContainer = footer.querySelector(LEGACY_CONTAINER_SELECTOR);
  const container = legacyContainer || footer;
  const legacy = Boolean(legacyContainer);
  const anchor = container.querySelector(legacy ? LEGACY_ANCHOR_SELECTOR : ANCHOR_SELECTOR);
  let button = document.querySelector(`[${ENTRY_ATTR}]`);
  if (!button) button = buildButton(legacy);
  button.className = `${legacy ? LEGACY_ACTION_CLASS : HOST_ACTION_CLASS} ${ENTRY_CLASS}`;
  if (!button.innerHTML.includes("piopt-mark")) button.innerHTML = ICON;
  if (button.parentElement !== container) container.append(button);
  placeButton(container, button, anchor);
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

export async function onLoad(pi) {
  host = pi;
  if (!styleDisposer) styleDisposer = mountStyle(STYLE);
  scan();
  if (typeof MutationObserver === "function" && document.documentElement) {
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  document.addEventListener("visibilitychange", scheduleScan);
  mountComposerCompact();
  mountOpenOutput(pi);
  mountMotionRuntime();
  mountCommandEnhance();
  mountPermissionIcons();
  await mountNavEntries(pi);
  await mountCommandButton(pi);
  await mountModelPicker(pi);
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
  unmountComposerCompact();
  unmountOpenOutput();
  unmountCommandEnhance();
  document.removeEventListener("visibilitychange", scheduleScan);
  unmountPermissionIcons();
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

export const __internals = {
  FOOTER_SELECTOR,
  LEGACY_CONTAINER_SELECTOR,
  ANCHOR_SELECTOR,
  LEGACY_ANCHOR_SELECTOR,
  ENTRY_ATTR,
  HOST_ACTION_CLASS,
  LEGACY_ACTION_CLASS,
  LABEL,
};
