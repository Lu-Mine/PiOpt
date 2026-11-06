// Mark the host's permission chip without changing its React-owned children.
export const PERMISSION_ICON_CSS = `
.composer-permission button[data-piopt-permission-icon]::before{content:var(--piopt-permission-icon-content,none);width:var(--piopt-permission-icon-size,0px);height:var(--piopt-permission-icon-size,0px);flex:none;background:currentColor;mask:var(--piopt-permission-mask) center / contain no-repeat;-webkit-mask:var(--piopt-permission-mask) center / contain no-repeat}
.composer-permission button[data-piopt-permission-icon="ask"]{--piopt-permission-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l1.6-4A8.5 8.5 0 1 1 21 11.5Z'/%3E%3Cpath d='M10 9a2 2 0 1 1 3 1.7c-.7.4-1 1-1 1.8M12 16h.01'/%3E%3C/svg%3E")}
.composer-permission button[data-piopt-permission-icon="edit"]{--piopt-permission-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M16 4l4 4M15 5l4 4-9 9-4 1 1-4Z'/%3E%3C/svg%3E")}
.composer-permission button[data-piopt-permission-icon="auto"]{--piopt-permission-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m13 2-9 12h7l-1 8 10-12h-7Z'/%3E%3C/svg%3E")}`;
const ATTR = 'data-piopt-permission-icon';
const LABELS = {
  ask: ['每次询问', '每次詢問', 'Ask every time', 'Immer nachfragen', 'Her seferinde sor', 'Preguntar siempre', 'Demander à chaque fois', '매번 묻기', 'Perguntar'],
  edit: ['允许编辑', '允許編輯', 'Accept edits', 'Änderungen akzeptieren', 'Düzenlemeleri kabul et', 'Aceptar ediciones', 'Accepter les modifications', '편집 허용', 'Aceitar edições'],
  auto: ['全自动', '全自動', 'Auto', 'Otomatik', 'Automático', '자동'],
};
let observer;
function scan() {
  for (const button of document.querySelectorAll('.composer-permission button.mode-chip')) {
    const label = button.querySelector('span.text-sm')?.textContent?.trim();
    const mode = Object.keys(LABELS).find(key => LABELS[key].includes(label));
    if (mode && button.getAttribute(ATTR) !== mode) button.setAttribute(ATTR, mode);
    else if (!mode && button.hasAttribute(ATTR)) button.removeAttribute(ATTR);
  }
}
export function mountPermissionIcons() {
  scan();
  if (typeof MutationObserver === 'function') {
    observer = new MutationObserver(scan);
    observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  }
}
export function unmountPermissionIcons() {
  observer?.disconnect();
  observer = null;
  for (const button of document.querySelectorAll(`[${ATTR}]`)) button.removeAttribute(ATTR);
}
export const __internals = { LABELS, scan };
