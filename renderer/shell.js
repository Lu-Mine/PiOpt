/*
 * PiOpt shell: switches between feature views and boots each feature once,
 * on first reveal, so the market does not poll while you are tuning motion.
 */
(function () {
  "use strict";

  const bridge = window.pluginBridge;
  const STORAGE_KEY = "piopt.feature";
  const HINTS = {
    market: "插件市场与更新准备",
    motion: "界面动效调校",
  };

  const tabs = Array.from(document.querySelectorAll("[data-feature]"));
  const views = {
    market: document.getElementById("view-market"),
    motion: document.getElementById("view-motion"),
  };
  const hint = document.getElementById("opt-hint");
  const booted = { market: false, motion: false };
  let current = "market";

  function start(feature) {
    if (booted[feature]) return;
    booted[feature] = true;
    const api = feature === "market" ? window.PiOptMarket : window.PiOptMotion;
    if (!api || typeof api.boot !== "function") {
      hint.textContent = `${HINTS[feature]}不可用`;
      return;
    }
    Promise.resolve()
      .then(() => api.boot())
      .catch((error) => {
        hint.textContent = String((error && error.message) || error);
      });
  }

  function show(feature, remember) {
    if (!views[feature]) feature = "market";
    current = feature;
    for (const tab of tabs) {
      tab.setAttribute("aria-selected", String(tab.dataset.feature === feature));
    }
    for (const name of Object.keys(views)) views[name].hidden = name !== feature;
    hint.textContent = HINTS[feature] || "";
    start(feature);
    if (remember) {
      try { window.localStorage.setItem(STORAGE_KEY, feature); } catch { /* private mode */ }
    }
  }

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
