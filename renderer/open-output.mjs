// Extend the host's own file context menu after React renders it. No other
// context menus or link clicks are intercepted.
let handler = null;
let observer = null;
let timer = null;
let generation = 0;

export function localLink(href) {
  if (typeof href !== "string") return null;
  let decoded;
  try { decoded = decodeURIComponent(href); } catch { return null; }
  if (/^(?:file:\/\/|[a-z]:[\\/]|\/)/i.test(decoded) && !/^\/\//.test(decoded)) return href;
  return null;
}

function stopWatching() {
  generation += 1;
  if (observer) observer.disconnect();
  if (timer !== null) clearTimeout(timer);
  observer = null;
  timer = null;
}

export function mountOpenOutput(host) {
  if (handler) return;
  handler = (event) => {
    stopWatching();
    const target = event.target;
    const link = target?.closest?.(".thread-scroll a[href], .thread-scroll button.chat-code-link");
    const file = localLink(link?.getAttribute("href") || (link?.classList.contains("chat-code-link") ? link.textContent : ""));
    if (!file) return;
    let enabled = false;
    const current = generation;
    const addItem = () => {
      const original = document.querySelector('.context-menu [data-context-menu-item="copy-full-path"]');
      const menu = original?.closest('.context-menu[role="menu"]');
      if (current !== generation || !enabled || !menu || menu.querySelector('[data-piopt-open-output]')) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "context-menu-item";
      button.setAttribute("role", "menuitem");
      button.setAttribute("data-context-menu-root-item", "true");
      button.setAttribute("data-piopt-open-output", "true");
      const label = document.createElement("span");
      label.className = "context-menu-label";
      label.textContent = "用系统默认程序打开";
      button.append(label);
      button.addEventListener("click", async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        try { await host.dispatch("plugin.call", { method: "openSessionOutput", args: { path: file } }); }
        catch (error) { window.alert(`打开失败：${error?.message || error}`); }
      });
      menu.append(button);
      stopWatching();
    };
    // Observe before React receives the same event; the host owns opening,
    // closing, positioning and keyboard navigation of its menu.
    observer = new MutationObserver(addItem);
    observer.observe(document.body, { childList: true, subtree: true });
    Promise.resolve(host.dispatch("plugin.call", { method: "modelPickerState", args: {} }))
      .then((state) => { enabled = state?.config?.openSessionOutput === true; if (enabled && current === generation) addItem(); })
      .catch(() => {});
    timer = setTimeout(stopWatching, 1000);
  };
  document.addEventListener("contextmenu", handler, true);
}

export function unmountOpenOutput() {
  if (handler) document.removeEventListener("contextmenu", handler, true);
  stopWatching();
  document.querySelectorAll("[data-piopt-open-output]").forEach((item) => item.remove());
  handler = null;
}
