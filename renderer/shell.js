/*
 * PiOpt shell: switches between feature views and boots each feature once,
 * on first reveal, so the market does not poll while you are tuning motion.
 */
(function () {
  "use strict";

  const bridge = window.pluginBridge;
  const STORAGE_KEY = "piopt.feature";

  const tabs = Array.from(document.querySelectorAll("[data-feature]"));
  const views = {
    market: document.getElementById("view-market"),
    motion: document.getElementById("view-motion"),
  };
  const booted = { market: false, motion: false };
  let current = "market";

  function reportFailure(feature, detail) {
    const view = views[feature];
    if (!view) return;
    let box = view.querySelector(".opt-error");
    if (!box) {
      box = document.createElement("div");
      box.className = "opt-error";
      box.setAttribute("role", "alert");
      view.prepend(box);
    }
    box.textContent = `该功能未能启动：${detail || "未知错误"}。可在插件页重新加载后再试。`;
  }

  function start(feature) {
    if (booted[feature]) return;
    booted[feature] = true;
    const api = feature === "market" ? window.PiOptMarket : window.PiOptMotion;
    const tab = tabs.find((item) => item.dataset.feature === feature);
    if (!api || typeof api.boot !== "function") {
      if (tab) tab.title = "该功能未能加载";
      console.error(`[PiOpt] ${feature} view is not available`);
      reportFailure(feature, "视图脚本未加载");
      return;
    }
    Promise.resolve()
      .then(() => api.boot())
      .catch((error) => {
        if (tab) tab.title = "该功能加载失败，详见控制台";
        console.error(`[PiOpt] ${feature} failed to start`, error);
        reportFailure(feature, (error && error.message) || String(error));
      });
  }

  function show(feature, remember) {
    if (!views[feature]) feature = "market";
    current = feature;
    for (const tab of tabs) {
      tab.setAttribute("aria-selected", String(tab.dataset.feature === feature));
    }
    for (const name of Object.keys(views)) views[name].hidden = name !== feature;
    start(feature);
    if (remember) {
      try { window.localStorage.setItem(STORAGE_KEY, feature); } catch { /* private mode */ }
    }
  }

  // The rail opens and closes from the button at its top. The choice is stored
  // the same way the active view is, so a reopened panel keeps its shape.
  const RAIL_KEY = "piopt.rail";
  const rail = document.getElementById("optRail");
  const railToggle = document.getElementById("railToggle");

  function setRail(expanded, remember) {
    const open = Boolean(expanded);
    document.body.dataset.rail = open ? "expanded" : "collapsed";
    if (rail) rail.dataset.expanded = String(open);
    if (railToggle) {
      const label = open ? "收起菜单" : "展开菜单";
      railToggle.setAttribute("aria-expanded", String(open));
      railToggle.setAttribute("aria-label", label);
      railToggle.title = label;
      const text = railToggle.querySelector(".rail-label");
      if (text) text.textContent = label;
    }
    if (remember) {
      try { window.localStorage.setItem(RAIL_KEY, open ? "expanded" : "collapsed"); } catch { /* private mode */ }
    }
  }

  if (railToggle) {
    railToggle.addEventListener("click", () => {
      const open = rail ? rail.dataset.expanded === "true" : document.body.dataset.rail === "expanded";
      setRail(!open, true);
    });
  }

  let storedRail = null;
  try { storedRail = window.localStorage.getItem(RAIL_KEY); } catch { storedRail = null; }
  setRail(storedRail === "expanded", false);

  for (const tab of tabs) {
    tab.addEventListener("click", () => show(tab.dataset.feature, true));
  }

  document.addEventListener("keydown", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== "1" && event.key !== "2") return;
    event.preventDefault();
    show(event.key === "1" ? "market" : "motion", true);
  });

  let stored = null;
  try { stored = window.localStorage.getItem(STORAGE_KEY); } catch { stored = null; }
  show(stored === "motion" || stored === "market" ? stored : "market", false);

  Promise.resolve()
    .then(() => (bridge && typeof bridge.invoke === "function" ? bridge.invoke("plugin.getSettings") : null))
    .then((settings) => {
      const target = settings && settings.panelFeature;
      if ((target === "motion" || target === "market") && target !== current) show(target, false);
    })
    .catch(() => { /* keep the remembered view */ });
})();
