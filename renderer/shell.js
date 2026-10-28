/*
 * PiOpt shell: switches between feature views, syncs the host theme onto :root,
 * and boots each feature once on first reveal so inactive views stay quiet.
 *
 * Four views: motion and the window material are one feature (`appearance`), so
 * they share a tab and the commands name a section inside it instead of a view
 * of their own. `behavior` is a row with no controls yet — it still gets a view
 * so the rail reads 外观 / 行为 / AI 网关 / 插件市场 in that order.
 */
(function () {
  "use strict";

  const bridge = window.pluginBridge;
  const STORAGE_KEY = "piopt.feature";
  const HOST_THEME_STYLE_ID = "opt-host-theme";
  const OWN_THEME_PREFIX = "plugin:local.piopt:";

  const tabs = Array.from(document.querySelectorAll("[data-feature]"));
  const views = {
    appearance: document.getElementById("view-appearance"),
    behavior: document.getElementById("view-behavior"),
    gateway: document.getElementById("view-gateway"),
    market: document.getElementById("view-market"),
  };
  const booted = { appearance: false, behavior: false, gateway: false, market: false };
  const KNOWN = ["appearance", "behavior", "gateway", "market"];
  // Sections inside the appearance view, each with the id it scrolls to.
  const SECTIONS = ["motion", "glass"];
  let current = "market";

  // -------------------------------------------------------------- host theme
  // Extracts root-level custom properties (--ds-*, --gray-*, --accent-*, --color-*)
  // from a host plugin theme stylesheet so PiOpt inherits custom themes without
  // importing host-window layout selectors or background assets into the panel.
  function extractThemeVariables(cssText) {
    if (typeof cssText !== "string" || !cssText.trim()) return "";
    const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
    const declarations = [];
    const blockPattern = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    while ((match = blockPattern.exec(stripped)) !== null) {
      const selector = match[1].trim();
      if (!/(^|,)\s*(:root|html|body)\b/.test(selector)) continue;
      const body = match[2];
      const propPattern = /(--(?:ds|gray|accent|color)-[a-z0-9-]+)\s*:\s*([^;{}]+)/gi;
      let prop;
      while ((prop = propPattern.exec(body)) !== null) {
        const name = prop[1].trim();
        const value = prop[2].trim();
        if (!value || /url\s*\(|@import|expression\s*\(/i.test(value)) continue;
        declarations.push(`  ${name}: ${value};`);
      }
    }
    return declarations.length ? `:root {\n${declarations.join("\n")}\n}` : "";
  }

  function syncHostTheme(appearance) {
    const rawBase = appearance && appearance.base;
    const base = rawBase === "light" || rawBase === "dark"
      ? rawBase
      : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    const root = document.documentElement;
    root.dataset.base = base;
    root.dataset.theme = base;
    if (appearance && typeof appearance.locale === "string" && appearance.locale) {
      root.lang = appearance.locale;
    }

    const pluginTheme = appearance && appearance.pluginTheme;
    const themeId = typeof pluginTheme === "string"
      ? pluginTheme
      : (pluginTheme && typeof pluginTheme.id === "string" ? pluginTheme.id : "");
    const themeCss = pluginTheme && typeof pluginTheme === "object" && !themeId.startsWith(OWN_THEME_PREFIX)
      ? extractThemeVariables(pluginTheme.css)
      : "";

    let styleEl = document.getElementById(HOST_THEME_STYLE_ID);
    if (!themeCss) {
      if (styleEl) styleEl.remove();
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = HOST_THEME_STYLE_ID;
      document.head.append(styleEl);
    }
    if (styleEl.textContent !== themeCss) styleEl.textContent = themeCss;
  }

  if (bridge && typeof bridge.on === "function") {
    bridge.on("appearance:changed", syncHostTheme);
  }
  if (bridge && typeof bridge.invoke === "function") {
    bridge.invoke("app.getAppearance").then(syncHostTheme).catch(() => syncHostTheme(null));
  } else {
    syncHostTheme(null);
  }

  window.PiOptTheme = { extractThemeVariables, syncHostTheme };

  // ------------------------------------------------------------------ views

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
    const api = {
      appearance: window.PiOptAppearance,
      behavior: window.PiOptBehavior,
      gateway: window.PiOptGateway,
      market: window.PiOptMarket,
    }[feature];
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

  const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  // A command can ask for one section of the appearance view; the page scrolls
  // there once the view is on screen, so "open the window material" still lands
  // on the material controls rather than on the top of a longer page.
  function scrollToSection(section) {
    if (!SECTIONS.includes(section)) return;
    const target = document.getElementById(`section-${section}`);
    if (!target || typeof target.scrollIntoView !== "function") return;
    target.scrollIntoView({ block: "start", behavior: reduceQuery.matches ? "auto" : "smooth" });
  }

  function show(feature, remember, section) {
    if (!views[feature]) feature = "market";
    const changed = feature !== current;
    current = feature;
    for (const tab of tabs) {
      tab.setAttribute("aria-selected", String(tab.dataset.feature === feature));
    }
    for (const name of Object.keys(views)) views[name].hidden = name !== feature;
    placeMarker(feature);
    if (changed) replayEnter(views[feature]);
    start(feature);
    if (section) scrollToSection(section);
    if (remember) {
      try { window.localStorage.setItem(STORAGE_KEY, feature); } catch { /* private mode */ }
    }
  }

  // The rail opens and closes from the button at its top. The choice is stored
  // the same way the active view is, so a reopened panel keeps its shape.
  const RAIL_KEY = "piopt.rail";
  const rail = document.getElementById("optRail");
  const railToggle = document.getElementById("railToggle");

  // One marker slides between the rows instead of each row drawing its own
  // bar, so switching views reads as movement. It lives outside the tablist
  // (aria-hidden, absolutely placed) to keep the tab semantics untouched.
  const marker = rail ? document.createElement("span") : null;
  if (rail && marker) {
    marker.className = "rail-marker";
    marker.setAttribute("aria-hidden", "true");
    rail.append(marker);
  }
  let markerPlaced = false;

  function placeMarker(feature) {
    if (!rail || !marker) return;
    const tab = tabs.find((item) => item.dataset.feature === feature) || tabs[0];
    if (!tab) return;
    const railBox = rail.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    const offset = `translateY(${Math.round(box.top - railBox.top)}px)`;
    if (!markerPlaced) {
      // First placement has nothing to travel from: land it, then let go.
      marker.style.transition = "none";
      marker.style.transform = offset;
      marker.style.height = `${Math.round(box.height)}px`;
      void marker.offsetWidth;
      marker.style.transition = "";
      marker.dataset.ready = "true";
      markerPlaced = true;
      return;
    }
    marker.style.transform = offset;
    marker.style.height = `${Math.round(box.height)}px`;
  }

  function replayEnter(view) {
    if (!view) return;
    if (reduceQuery.matches) {
      delete view.dataset.enter;
      return;
    }
    delete view.dataset.enter;
    void view.offsetWidth;
    view.dataset.enter = "true";
    view.addEventListener("animationend", () => {
      delete view.dataset.enter;
    }, { once: true });
  }

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
    if (!["1", "2", "3", "4"].includes(event.key)) return;
    event.preventDefault();
    show({ 1: "appearance", 2: "behavior", 3: "gateway", 4: "market" }[event.key], true);
  });

  let stored = null;
  try { stored = window.localStorage.getItem(STORAGE_KEY); } catch { stored = null; }
  show(KNOWN.includes(stored) ? stored : "market", false);

  Promise.resolve()
    .then(() => (bridge && typeof bridge.invoke === "function" ? bridge.invoke("plugin.getSettings") : null))
    .then((settings) => {
      const target = settings && settings.panelFeature;
      // `motion` and `glass` were view names before the merge; a settings record
      // written by the older build still lands on the right section.
      const feature = target === "motion" || target === "glass" ? "appearance" : target;
      const section = settings && settings.panelSection;
      if (KNOWN.includes(feature) && feature !== current) show(feature, false, section);
      else if (section) scrollToSection(section);
    })
    .catch(() => { /* keep the remembered view */ });
})();
