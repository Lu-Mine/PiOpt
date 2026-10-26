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

const ENTRY_ATTR = "data-piopt-entry";
const ENTRY_CLASS = "piopt-entry";
const HOST_ACTION_CLASS = "footer-action";
const CONTAINER_SELECTOR = ".sidebar-footer .footer-actions";
const ANCHOR_SELECTOR = '[data-nav="plugins"]';
const LABEL = "PiOpt 控制台";
const STYLE_ATTR = "data-piopt-entry-style";
const BUSY_ATTR = "data-piopt-busy";
const SCAN_DELAY_MS = 120;

// The host draws its footer icons at 14px with a 1.75 stroke; this one matches,
// so the row reads as five of the same kind.
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"' +
  ' fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"' +
  ' stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<line x1="21" y1="4" x2="14" y2="4"/><line x1="10" y1="4" x2="3" y2="4"/>' +
  '<line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/>' +
  '<line x1="21" y1="20" x2="16" y2="20"/><line x1="12" y1="20" x2="3" y2="20"/>' +
  '<line x1="14" y1="2" x2="14" y2="6"/><line x1="8" y1="10" x2="8" y2="14"/>' +
  '<line x1="16" y1="18" x2="16" y2="22"/>' +
  "</svg>";

const STYLE = [
  `[${ENTRY_ATTR}]{border:0;background:transparent;padding:0;margin:0;cursor:pointer}`,
  `[${ENTRY_ATTR}] svg{display:block}`,
  `[${ENTRY_ATTR}][${BUSY_ATTR}="true"]{opacity:.55}`,
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
