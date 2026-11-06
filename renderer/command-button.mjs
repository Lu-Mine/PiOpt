// A shortcut to the host's own slash-command completion, not a separate list.
const ATTR = "data-piopt-command-button";
export const COMMAND_BUTTON_CSS = `[${ATTR}]{border:0;background:transparent;color:var(--ds-text-secondary);border-radius:var(--radius-md,6px);height:28px;padding:0 8px;cursor:pointer;font:inherit} [${ATTR}]:hover{background:var(--ds-bg-hover);color:var(--ds-text-primary)} [${ATTR}]:focus-visible{outline:2px solid var(--ds-focus);outline-offset:1px}`;
let host, observer, button, enabled = false, active = false, generation = 0;

function scan() {
  if (!active) return;
  const toolbar = document.querySelector('.composer-left');
  if (!enabled || !toolbar) {
    button?.remove();
    return;
  }
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.setAttribute(ATTR, '');
    button.setAttribute('aria-label', '指令');
    button.title = '指令';
    button.textContent = '/';
    // Keep the editor selection when the shortcut is clicked.
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      try {
        Promise.resolve(host.dispatch('composer.insertText', { text: '/' })).catch(error => console.warn('[PiOpt] 指令按钮不可用', error));
      } catch (error) { console.warn('[PiOpt] 指令按钮不可用', error); }
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
  observer?.disconnect();
  observer = null;
  if (typeof window !== 'undefined') window.removeEventListener('focus', refresh);
  document.removeEventListener('visibilitychange', refresh);
  button?.remove();
  button = null;
  host = null;
  enabled = false;
}
