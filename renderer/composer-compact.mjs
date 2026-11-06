// Measure an inert expanded copy so collapsing does not change the expansion threshold.
const ATTR = 'data-piopt-compact';
const PROBE = 'data-piopt-compact-probe';
let mutationObserver, resizeObserver, frame = null, running = false;
const observed = new Set();

function measure(toolbar) {
  const stack = toolbar.closest('.composer-stack');
  const left = toolbar.querySelector('.composer-left');
  const right = toolbar.querySelector('.composer-right');
  if (!stack || !left || !right || !toolbar.isConnected) return;
  const clone = toolbar.cloneNode(true);
  clone.removeAttribute(ATTR);
  clone.setAttribute(PROBE, '');
  clone.setAttribute('aria-hidden', 'true');
  clone.inert = true;
  Object.assign(clone.style, { position: 'fixed', visibility: 'hidden', pointerEvents: 'none', left: '-10000px', top: '0', width: `${toolbar.getBoundingClientRect().width}px` });
  stack.append(clone);
  const a = clone.querySelector('.composer-left');
  const b = clone.querySelector('.composer-right');
  a.style.flex = 'none'; a.style.width = 'max-content'; a.style.maxWidth = 'none';
  b.style.flex = 'none'; b.style.width = 'max-content'; b.style.maxWidth = 'none';
  const style = getComputedStyle(clone);
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const gap = parseFloat(style.columnGap) || 0;
  const required = a.getBoundingClientRect().width + b.getBoundingClientRect().width + padding + gap;
  const available = clone.getBoundingClientRect().width;
  clone.remove();
  const compact = stack.getBoundingClientRect().width <= 450 || required > available + 0.5;
  if (compact) {
    if (toolbar.getAttribute(ATTR) !== 'true') toolbar.setAttribute(ATTR, 'true');
  } else if (toolbar.hasAttribute(ATTR)) toolbar.removeAttribute(ATTR);
}
function scan() {
  frame = null;
  if (!running) return;
  const toolbars = [...document.querySelectorAll(`.composer-toolbar:not([${PROBE}])`)];
  const targets = new Set();
  for (const toolbar of toolbars) {
    targets.add(toolbar);
    const stack = toolbar.closest('.composer-stack');
    if (stack) targets.add(stack);
    measure(toolbar);
  }
  if (resizeObserver) {
    for (const target of observed) if (!targets.has(target)) { resizeObserver.unobserve(target); observed.delete(target); }
    for (const target of targets) if (!observed.has(target)) { resizeObserver.observe(target); observed.add(target); }
  }
}
function schedule() {
  if (running && frame === null) frame = requestAnimationFrame(scan);
}
function relevant(record) {
  const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
  if (element?.closest?.(`[${PROBE}]`)) return false;
  if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node.nodeType === 1 && node.hasAttribute(PROBE))) return false;
  return true;
}
export function mountComposerCompact() {
  running = true;
  if (typeof ResizeObserver === 'function') resizeObserver = new ResizeObserver(schedule);
  if (typeof MutationObserver === 'function') {
    mutationObserver = new MutationObserver(records => { if (records.some(relevant)) schedule(); });
    mutationObserver.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  }
  if (typeof window !== 'undefined') window.addEventListener('resize', schedule);
  document.fonts?.ready?.then(schedule);
  if (typeof requestAnimationFrame === 'function') schedule();
}
export function unmountComposerCompact() {
  running = false;
  mutationObserver?.disconnect(); resizeObserver?.disconnect();
  mutationObserver = resizeObserver = null;
  observed.clear();
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  if (typeof window !== 'undefined') window.removeEventListener('resize', schedule);
  for (const toolbar of document.querySelectorAll(`.composer-toolbar[${ATTR}]`)) toolbar.removeAttribute(ATTR);
}
