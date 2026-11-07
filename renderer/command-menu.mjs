// Draft-safe replica of the host composer autocomplete, using its command catalog and CSS.
let menu = null, owner = null, sequence = 0, keyHandler = null;
const KINDS = ['template', 'builtin', 'plugin', 'extension', 'mcp', 'skill'];
const CACHE_MS = 10000;
let cachedCommands = null, cachedAt = 0, pending = null, cacheGeneration = 0;
export function clearCommandCache() { cacheGeneration++; cachedCommands = null; cachedAt = 0; pending = null; }
export function prefetchCommands() {
  if (cachedCommands && Date.now() - cachedAt < CACHE_MS) return Promise.resolve(cachedCommands);
  if (pending) return pending;
  const generation = cacheGeneration;
  const request = Promise.resolve().then(() => window.piDesktop.invoke('pi-desktop/composer/commands')).then(response => {
    if (!response?.ok) throw new Error(response?.error?.message || '读取指令失败');
    const commands = Array.isArray(response.data?.commands) ? response.data.commands.slice() : [];
    if (generation === cacheGeneration) { cachedCommands = commands; cachedAt = Date.now(); }
    return commands;
  }).finally(() => { if (pending === request) pending = null; });
  pending = request;
  return request;
}
const HOST_STATE_COMMANDS = new Set(['builtin.session.new', 'builtin.agent.compact', 'builtin.mode.agent', 'builtin.mode.plan', 'builtin.mode.goal']);
function canExecuteDirectly(item) {
  return typeof item.id === 'string' && item.id.length > 0 && !item.argumentHint &&
    ['builtin', 'plugin', 'mcp', 'skill'].includes(item.kind) && !HOST_STATE_COMMANDS.has(item.id);
}
async function executeCommand(item) {
  const result = await window.piDesktop.invoke('pi-desktop/commandPalette/execute', item.id);
  if (!result?.ok) throw new Error(result?.error?.message || '指令执行失败');
}
const GROUPS = { template: '模板', builtin: '内置指令', plugin: '插件指令', extension: '扩展指令', mcp: 'MCP', skill: '技能' };
const ICONS = {
  template: '<path d="M4 4h16v16H4zM8 8h8M8 12h8"/>',
  builtin: '<path d="m5 7 5 5-5 5M12 19h7"/>',
  plugin: '<path d="M8 3v4M16 3v4M5 7h14v3a7 7 0 0 1-14 0zM12 17v4"/>',
  skill: '<path d="m12 3 2.2 5.2L20 10l-4.5 3.7L16 20l-4-3-4 3 .5-6.3L4 10l5.8-1.8z"/>',
};
export const COMMAND_MENU_CSS = `.composer-autocomplete .piopt-command-search{appearance:none;flex:none;margin:6px 6px 0;padding:7px 8px;min-width:0;border:0;border-bottom:1px solid var(--ds-border-subtle);border-radius:0;outline:none;box-shadow:none!important;color:var(--ds-text-primary);background:transparent!important;font:inherit}.composer-autocomplete .piopt-command-search:focus-visible{border-bottom-color:var(--ds-focus);outline:none;box-shadow:none!important}.composer-autocomplete .piopt-command-search::placeholder{color:var(--ds-text-muted)}`;
function dismiss(event) { if (!menu?.contains(event.target) && !owner?.contains(event.target)) closeCommandMenu(); }
function position() {
  if (!menu || !owner) return;
  const anchor = owner.closest('.composer-stack')?.querySelector('.composer-input-wrap') || document.querySelector('.composer-input-wrap') || owner;
  const rect = anchor.getBoundingClientRect();
  menu.style.width = `${Math.min(rect.width, window.innerWidth - 24)}px`;
  menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 12))}px`;
  menu.style.top = 'auto';
  menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
}
export function closeCommandMenu() {
  sequence++;
  document.removeEventListener('pointerdown', dismiss, true);
  if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
  if (typeof window !== 'undefined') { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); }
  keyHandler = null;
  menu?.remove(); menu = null;
  owner?.setAttribute('aria-expanded', 'false'); owner = null;
}
export async function openCommandMenu(button, host) {
  if (menu) { closeCommandMenu(); return; }
  owner = button; button.setAttribute('aria-expanded', 'true');
  const current = ++sequence;
  const editor = document.querySelector('.composer-input');
  const selection = window.getSelection();
  const range = selection?.rangeCount && editor?.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
  menu = document.createElement('div'); menu.className = 'composer-autocomplete'; menu.setAttribute('data-piopt-command-menu', '');
  menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', '指令');
  const search = document.createElement('input'); search.className = 'piopt-command-search'; search.placeholder = '搜索指令'; search.setAttribute('aria-label', '搜索指令');
  const list = document.createElement('div'); list.className = 'composer-ac-list';
  const footer = document.createElement('div'); footer.className = 'composer-ac-footer'; footer.textContent = '↑↓ 选择 · Enter 确认 · Esc 关闭';
  menu.append(search, list, footer); document.body.append(menu); position();
  const openedMenu = menu;
  requestAnimationFrame(() => { if (menu === openedMenu && openedMenu.isConnected) { openedMenu.classList.add('is-open'); search.focus(); } });
  document.addEventListener('pointerdown', dismiss, true);
  window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
  list.textContent = '正在加载指令…';
  let rows = [], selected = 0;
  const highlight = index => {
    if (!rows.length) return;
    selected = (index + rows.length) % rows.length;
    rows.forEach((row, i) => { row.classList.toggle('kb-active', i === selected); row.setAttribute('aria-selected', String(i === selected)); });
    rows[selected].scrollIntoView({ block: 'nearest' });
  };
  keyHandler = event => {
    if (event.key === 'Escape') { event.preventDefault(); const previous = owner; closeCommandMenu(); previous?.focus(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); highlight(selected + (event.key === 'ArrowDown' ? 1 : -1)); }
    else if (event.key === 'Enter' && rows.length) { event.preventDefault(); rows[selected].click(); }
  };
  document.addEventListener('keydown', keyHandler, true);
  try {
    const commands = cachedCommands ? cachedCommands.slice() : (await prefetchCommands()).slice();
    if (current !== sequence || !menu) return;
    const rank = kind => { const index = KINDS.indexOf(kind); return index < 0 ? 99 : index; };
    commands.sort((a, b) => rank(a.kind) - rank(b.kind) || String(a.name).localeCompare(String(b.name)));
    const render = () => {
      list.replaceChildren(); rows = []; selected = 0;
      const query = search.value.trim().toLowerCase();
      const filtered = commands.filter(item => typeof item.name === 'string' && [item.name, item.title, item.description].some(value => String(value || '').toLowerCase().includes(query)));
      if (!filtered.length) { const empty = document.createElement('div'); empty.className = 'composer-model-empty'; empty.textContent = '没有匹配的指令'; list.append(empty); return; }
      let group = null;
      for (const item of filtered) {
        if (item.kind !== group) { group = item.kind; const heading = document.createElement('div'); heading.className = 'composer-model-group-label'; heading.textContent = GROUPS[group] || '其他'; list.append(heading); }
        const row = document.createElement('button'); row.type = 'button'; row.className = 'composer-plus-item composer-ac-item'; row.setAttribute('role', 'option');
        const icon = document.createElement('span'); icon.className = 'composer-ac-icon'; icon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[item.kind] || ICONS.plugin}</svg>`; row.append(icon);
        const name = document.createElement('span'); name.className = 'composer-ac-name'; name.textContent = `/${item.name.replace(/^\/+/, '')}`; row.append(name);
        for (const hint of [(item.kind === 'skill' || item.kind === 'mcp') && item.title !== item.name ? item.title : '', item.argumentHint]) if (hint) { const element = document.createElement('span'); element.className = 'composer-ac-hint'; element.textContent = hint; row.append(element); }
        if (item.description) { const desc = document.createElement('span'); desc.className = 'composer-ac-desc'; desc.textContent = item.description; row.append(desc); }
        row.addEventListener('mousemove', () => highlight(rows.indexOf(row)));
        row.addEventListener('click', async () => {
          if (row.disabled) return;
          if (canExecuteDirectly(item)) {
            row.disabled = true;
            try {
              await executeCommand(item);
              if (menu === openedMenu) closeCommandMenu();
            } catch (error) {
              if (menu === openedMenu) { row.disabled = false; footer.textContent = `执行失败：${error.message || error}`; footer.setAttribute('role', 'alert'); }
            }
            return;
          }
          if (editor?.isConnected) { editor.focus(); if (range && editor.contains(range.commonAncestorContainer)) { const currentSelection = window.getSelection(); currentSelection.removeAllRanges(); currentSelection.addRange(range); } }
          const text = `/${item.name.replace(/^\/+/, '')} `;
          try { await host.dispatch('composer.insertText', { text }); if (menu === openedMenu) closeCommandMenu(); }
          catch (error) { if (menu === openedMenu) { footer.textContent = `无法插入指令：${error.message || error}`; footer.setAttribute('role', 'alert'); } }
        });
        rows.push(row); list.append(row);
      }
      highlight(0);
    };
    search.addEventListener('input', render); render();
    if (cachedCommands && Date.now() - cachedAt >= CACHE_MS) void prefetchCommands().catch(() => {});
  } catch (error) { if (current === sequence && menu) list.textContent = `无法读取指令：${error.message || error}`; }
}
