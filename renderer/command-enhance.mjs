// Enhance host-owned slash lists without moving or rewriting React nodes.
const MENU_ATTR = 'data-piopt-slash-menu';
const HIDDEN = 'data-piopt-slash-hidden';
const TITLE = 'data-piopt-slash-title';
export const COMMAND_ENHANCE_CSS = `
.composer-autocomplete[data-piopt-slash-menu] .composer-model-group-label[data-piopt-slash-title]{background:transparent;background-image:none;-webkit-backdrop-filter:none;backdrop-filter:none;container-type:scroll-state;color:transparent;position:sticky}
.composer-autocomplete[data-piopt-slash-menu] .composer-model-group-label[data-piopt-slash-title]::after{content:attr(data-piopt-slash-title);position:absolute;left:8px;top:6px;color:var(--ds-text-muted);display:inline-block;padding:2px 6px;margin:-2px -6px;border-radius:6px}
@container scroll-state(stuck: top){.composer-autocomplete[data-piopt-slash-menu] .composer-model-group-label[data-piopt-slash-title]::after{background:color-mix(in oklab,var(--ds-bg-elevated-opaque) 96%,transparent);-webkit-backdrop-filter:saturate(1.4) blur(20px);backdrop-filter:saturate(1.4) blur(20px);box-shadow:0 1px 2px color-mix(in oklab,#000000 30%,transparent),0 8px 18px -6px color-mix(in oklab,#000000 42%,transparent)}}
.composer-autocomplete[data-piopt-slash-menu] .composer-model-group-label[data-piopt-slash-title]{transform:translateY(var(--piopt-heading-shift,0px));clip-path:inset(0)}
.composer-autocomplete[data-piopt-slash-menu] [data-piopt-slash-hidden]{display:none!important}`;
const SEARCH = 'data-piopt-native-search';
let observer, scheduled = false, active = false;
const inputs = new Map();

function isSlashMenu(menu) {
  if (menu.hasAttribute('data-piopt-command-menu')) return true;
  return [...menu.querySelectorAll('.composer-ac-name')].some(node => node.textContent.trim().startsWith('/'));
}
const scrollLists = new Map();
function updateSticky(list) {
  const headers = [...list.querySelectorAll('.composer-model-group-label[data-piopt-slash-title]:not([data-piopt-slash-hidden])')];
  const top = list.getBoundingClientRect().top + (parseFloat(getComputedStyle(list).borderTopWidth) || 0);
  for (let i = headers.length - 1; i >= 0; i--) {
    const heading = headers[i], next = headers[i + 1];
    const shift = next ? Math.min(0, next.getBoundingClientRect().top - top - heading.offsetHeight) : 0;
    const value = `${Math.max(-heading.offsetHeight, shift)}px`;
    if (heading.style.getPropertyValue('--piopt-heading-shift') !== value) heading.style.setProperty('--piopt-heading-shift', value);
  }
}
function observeList(menu) {
  const list = menu.querySelector('.composer-ac-list');
  const old = scrollLists.get(menu);
  if (old && old.list !== list) { old.list.removeEventListener('scroll', old.handler); scrollLists.delete(menu); }
  if (list && !scrollLists.has(menu)) { const handler = () => updateSticky(list); list.addEventListener('scroll', handler, { passive: true }); scrollLists.set(menu, { list, handler }); }
  if (list) updateSticky(list);
}
function motionEnabled() {
  return typeof getComputedStyle === 'function' && getComputedStyle(document.documentElement).getPropertyValue('--piopt-permission-icon-size').trim() !== '';
}
function filter(menu, input) {
  const list = menu.querySelector('.composer-ac-list');
  if (!list) return;
  const query = input.value.trim().toLocaleLowerCase();
  let heading = null, visible = false, rows = [];
  const finish = () => { if (heading) heading.toggleAttribute(HIDDEN, !visible); };
  for (const node of list.children) {
    if (node.classList.contains('composer-model-group-label')) { finish(); heading = node; visible = false; continue; }
    if (!node.classList.contains('composer-ac-item')) continue;
    const match = !query || node.textContent.toLocaleLowerCase().includes(query);
    node.toggleAttribute(HIDDEN, !match);
    if (match) { visible = true; rows.push(node); }
  }
  finish();
  input._rows = rows;
  input._index = Math.min(input._index || 0, Math.max(0, rows.length - 1));
}
function addSearch(menu) {
  if (inputs.has(menu)) return;
  const input = document.createElement('input');
  const editor = document.querySelector('.composer-input');
  const resetOnEditorFocus = () => { if (input.value) { input.value = ''; filter(menu, input); } };
  editor?.addEventListener('focus', resetOnEditorFocus);
  input._cleanup = () => editor?.removeEventListener('focus', resetOnEditorFocus);
  input.type = 'search'; input.className = 'piopt-command-search';
  input.setAttribute(SEARCH, ''); input.setAttribute('aria-label', '搜索指令'); input.placeholder = '搜索指令';
  // React's delegated focusout handler dismisses autocomplete when the editor
  // loses focus. Suppress only the transfer into this menu's search input.
  const keepOpen = event => { if (event.relatedTarget === input) event.stopPropagation(); };
  editor?.addEventListener('focusout', keepOpen);
  const oldCleanup = input._cleanup;
  input.addEventListener('input', () => { input._index = 0; filter(menu, input); });
  input._cleanup = () => { oldCleanup(); editor?.removeEventListener('focusout', keepOpen); };
  input.addEventListener('keydown', event => {
    const rows = input._rows || [];
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && rows.length) {
      event.preventDefault(); event.stopPropagation();
      input._index = ((input._index || 0) + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      for (const [index, row] of rows.entries()) { row.classList.toggle('kb-active', index === input._index); row.setAttribute('aria-selected', String(index === input._index)); }
      rows[input._index].scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && rows.length) {
      event.preventDefault(); event.stopPropagation();
      rows[input._index || 0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      const editor = document.querySelector('.composer-input');
      editor?.focus(); editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }
  });
  menu.insertBefore(input, menu.firstChild);
  inputs.set(menu, input);
  filter(menu, input);
}
function clean(menu) {
  inputs.get(menu)?._cleanup?.(); inputs.get(menu)?.remove(); inputs.delete(menu);
  menu.removeAttribute(MENU_ATTR);
  const scroll = scrollLists.get(menu); if (scroll) { scroll.list.removeEventListener('scroll', scroll.handler); scrollLists.delete(menu); }
  for (const heading of menu.querySelectorAll(`[${TITLE}]`)) heading.style.removeProperty('--piopt-heading-shift');
  for (const node of menu.querySelectorAll(`[${HIDDEN}],[${TITLE}]`)) { node.removeAttribute(HIDDEN); node.removeAttribute(TITLE); }
}
function scan() {
  scheduled = false;
  if (!active) return;
  const enabled = motionEnabled();
  for (const [menu] of scrollLists) if (!enabled || !menu.isConnected || !isSlashMenu(menu)) clean(menu);
  for (const [menu] of inputs) if (!enabled || !menu.isConnected || !isSlashMenu(menu)) clean(menu);
  for (const menu of document.querySelectorAll('.composer-autocomplete')) {
    if (!enabled || !isSlashMenu(menu)) { if (menu.hasAttribute(MENU_ATTR)) clean(menu); continue; }
    if (!menu.hasAttribute(MENU_ATTR)) menu.setAttribute(MENU_ATTR, '');
    for (const heading of menu.querySelectorAll('.composer-model-group-label')) {
      const text = heading.textContent.trim();
      if (heading.getAttribute(TITLE) !== text) heading.setAttribute(TITLE, text);
    }
    if (!menu.hasAttribute('data-piopt-command-menu')) { addSearch(menu); filter(menu, inputs.get(menu)); }
    observeList(menu);
  }
}
function schedule() { if (!scheduled && active) { scheduled = true; queueMicrotask(scan); } }
export function mountCommandEnhance() {
  active = true;
  if (typeof MutationObserver === 'function') { observer = new MutationObserver(schedule); observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] }); }
  if (typeof window !== 'undefined') window.addEventListener('focus', schedule);
  schedule();
}
export function unmountCommandEnhance() {
  active = false; observer?.disconnect(); observer = null;
  if (typeof window !== 'undefined') window.removeEventListener('focus', schedule);
  for (const menu of document.querySelectorAll(`[${MENU_ATTR}]`)) clean(menu);
  inputs.clear();
}
