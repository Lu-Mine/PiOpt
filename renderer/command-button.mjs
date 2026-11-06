import { COMMAND_MENU_CSS, openCommandMenu, closeCommandMenu, prefetchCommands, clearCommandCache } from './command-menu.mjs';
// A shortcut to the host's own slash-command completion, not a separate list.
const ATTR = "data-piopt-command-button";
export const COMMAND_BUTTON_CSS = `[${ATTR}]{cursor:pointer} [${ATTR}] .piopt-command-icon{width:15px;height:15px;flex:none}` + COMMAND_MENU_CSS;
let host, observer, button, tooltip, tooltipTimer, enabled = false, active = false, generation = 0;

function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTimer = null;
  tooltip?.remove();
  tooltip = null;
  button?.removeAttribute('aria-describedby');
}

function showTooltip() {
  if (tooltip || tooltipTimer) return;
  tooltipTimer = setTimeout(() => {
    tooltipTimer = null;
    if (!button?.isConnected) return;
    tooltip = document.createElement('span');
    tooltip.className = 'ui-tooltip';
    tooltip.id = 'piopt-command-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.textContent = '指令';
    document.body.append(tooltip);
    const anchor = button.getBoundingClientRect();
    const bounds = tooltip.getBoundingClientRect();
    const left = Math.min(Math.max(anchor.left + anchor.width / 2, bounds.width / 2 + 8), Math.max(bounds.width / 2 + 8, window.innerWidth - bounds.width / 2 - 8));
    const below = anchor.top - 8 - bounds.height < 8;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${below ? anchor.bottom + 8 : anchor.top - 8}px`;
    tooltip.style.transform = below ? 'translateX(-50%)' : 'translate(-50%, -100%)';
    button.setAttribute('aria-describedby', tooltip.id);
  }, 300);
}

function scan() {
  if (!active) return;
  const toolbar = document.querySelector('.composer-left');
  if (!enabled || !toolbar) {
    closeCommandMenu();
    hideTooltip();
    button?.remove();
    return;
  }
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.setAttribute(ATTR, '');
    button.className = 'icon-btn mode-chip';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', '指令');
    button.innerHTML = '<span class="composer-mode-chip-face"><svg class="piopt-command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M16 4 8 20"/></svg><span class="composer-mode-chip-label text-sm">指令</span></span>';
    button.addEventListener('pointerenter', showTooltip);
    button.addEventListener('pointerleave', hideTooltip);
    button.addEventListener('focus', showTooltip);
    button.addEventListener('blur', hideTooltip);
    button.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
    // Keep the editor selection when the shortcut is clicked.
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      hideTooltip();
      void openCommandMenu(button, host);
    });
  }
  if (button.parentElement !== toolbar || button !== toolbar.lastElementChild) toolbar.append(button);
}

async function refresh() {
  const current = ++generation;
  try {
    const state = await host.dispatch('plugin.call', { method: 'modelPickerState', args: {} });
    if (!active || current !== generation) return;
    enabled = state?.config?.commandButton === true;
    if (enabled && typeof window !== 'undefined' && window.piDesktop?.invoke) void prefetchCommands().catch(() => {});
    scan();
  } catch (error) { console.warn('[PiOpt] 无法读取指令按钮设置', error); }
}

export async function mountCommandButton(pi) {
  host = pi;
  active = true;
  if (typeof MutationObserver === 'function') {
    observer = new MutationObserver(scan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (typeof window !== 'undefined') window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  await refresh();
}

export function unmountCommandButton() {
  active = false;
  generation++;
  clearCommandCache();
  observer?.disconnect();
  closeCommandMenu();
  hideTooltip();
  observer = null;
  if (typeof window !== 'undefined') window.removeEventListener('focus', refresh);
  document.removeEventListener('visibilitychange', refresh);
  button?.remove();
  button = null;
  host = null;
  enabled = false;
}
