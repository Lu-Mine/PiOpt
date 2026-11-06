// A draft-safe command picker backed by the same host catalog as slash completion.
let menu = null, owner = null, sequence = 0;
const KINDS = ['template', 'builtin', 'plugin', 'extension', 'mcp', 'skill'];
export const COMMAND_MENU_CSS = `
+.piopt-command-menu{position:fixed;z-index:1000;width:min(380px,calc(100vw - 16px));max-height:min(420px,calc(100vh - 24px));display:flex;flex-direction:column;padding:6px;border:1px solid var(--ds-border-subtle);border-radius:var(--radius-lg);background:var(--ds-bg-elevated-opaque);box-shadow:var(--ds-shadow-dialog);color:var(--ds-text-primary)}
+.piopt-command-search{width:100%;padding:8px;border:0;border-bottom:1px solid var(--ds-border-subtle);outline:none;color:inherit;background:transparent;font:inherit}
+.piopt-command-list{overflow:auto;min-height:0}.piopt-command-row{width:100%;display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:7px 9px;border:0;border-radius:var(--radius-md);background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}.piopt-command-row:hover,.piopt-command-row:focus-visible{background:var(--ds-bg-hover)}.piopt-command-desc{color:var(--ds-text-secondary);font-size:var(--text-sm)}.piopt-command-empty{padding:12px;color:var(--ds-text-secondary)}
+`.replace(/^\+/gm, '');
function dismiss(event) { if (event && (menu?.contains(event.target) || owner?.contains(event.target))) return; closeCommandMenu(); }
function onKey(event) { if (event.key === 'Escape') { event.preventDefault(); const previous = owner; closeCommandMenu(); previous?.focus(); } }
export function closeCommandMenu() {
  sequence++;
  document.removeEventListener('pointerdown', dismiss, true);
  document.removeEventListener('keydown', onKey, true);
  menu?.remove(); menu = null;
  owner?.setAttribute('aria-expanded', 'false');
  owner = null;
}
export async function openCommandMenu(button, host) {
  if (menu) { closeCommandMenu(); return; }
  owner = button;
  button.setAttribute('aria-expanded', 'true');
  const current = ++sequence;
  const editor = document.querySelector('.composer-input');
  const selection = window.getSelection();
  const range = selection?.rangeCount && editor?.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
  menu = document.createElement('div');
  menu.className = 'piopt-command-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', '指令');
  const search = document.createElement('input');
  search.className = 'piopt-command-search'; search.placeholder = '搜索指令'; search.setAttribute('aria-label', '搜索指令');
  const list = document.createElement('div'); list.className = 'piopt-command-list';
  menu.append(search, list); document.body.append(menu);
  const rect = button.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
  document.addEventListener('pointerdown', dismiss, true);
  document.addEventListener('keydown', onKey, true);
  search.focus();
  list.textContent = '正在加载指令…';
  try {
    const response = await window.piDesktop.invoke('pi-desktop/composer/commands');
    if (current !== sequence || !menu) return;
    if (!response?.ok) throw new Error(response?.error?.message || '读取指令失败');
    const commands = Array.isArray(response.data?.commands) ? response.data.commands : [];
    commands.sort((a, b) => (KINDS.indexOf(a.kind) < 0 ? 99 : KINDS.indexOf(a.kind)) - (KINDS.indexOf(b.kind) < 0 ? 99 : KINDS.indexOf(b.kind)) || String(a.name).localeCompare(String(b.name)));
    const render = () => {
      list.replaceChildren();
      const query = search.value.trim().toLowerCase();
      const filtered = commands.filter(item => typeof item.name === 'string' && [item.name, item.title, item.description].some(value => String(value || '').toLowerCase().includes(query)));
      if (!filtered.length) { const empty = document.createElement('div'); empty.className = 'piopt-command-empty'; empty.textContent = '没有匹配的指令'; list.append(empty); return; }
      for (const item of filtered) {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'piopt-command-row';
        const name = document.createElement('span'); name.textContent = `/${item.name.replace(/^\/+/, '')}`; row.append(name);
        if (item.description) { const desc = document.createElement('span'); desc.className = 'piopt-command-desc'; desc.textContent = item.description; row.append(desc); }
        row.addEventListener('click', () => {
          if (editor?.isConnected) { editor.focus(); if (range && editor.contains(range.commonAncestorContainer)) { const currentSelection = window.getSelection(); currentSelection.removeAllRanges(); currentSelection.addRange(range); } }
          const text = `/${item.name.replace(/^\/+/, '')} `;
          try { Promise.resolve(host.dispatch('composer.insertText', { text })).catch(error => console.warn('[PiOpt] 无法插入指令', error)); } catch (error) { console.warn('[PiOpt] 无法插入指令', error); }
          closeCommandMenu();
        });
        list.append(row);
      }
    };
    search.addEventListener('input', render); render();
  } catch (error) { if (current === sequence && menu) list.textContent = `无法读取指令：${error.message || error}`; }
}
