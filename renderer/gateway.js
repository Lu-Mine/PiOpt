(function () {
  "use strict";

  const bridge = window.pluginBridge;
  const root = () => document.getElementById("view-gateway");

  const state = {
    booted: false, timer: null, busy: false,
    status: null, data: null, usage: null, quota: null, quotaLoading: false,
    range: "today", metric: "tokens", dimension: "model",
    sortKey: "name", sortDir: 1,
    actionBusy: "", error: "", flash: "",
    oauth: null, drafts: {},
  };

  const RANGES = [["today", "今日"], ["d3", "近 3 日"], ["week", "本周"], ["month", "本月"], ["d30", "近 30 天"], ["all", "近一年"]];
  const METRICS = [["tokens", "Token"], ["requests", "请求数"], ["throughput", "吞吐量"]];
  const DIMENSIONS = [["model", "模型"], ["account", "账号"], ["key", "API Key"]];
  const CP_PROVIDERS = ["antigravity", "claude", "codex", "gemini"];
  const WB_PROVIDERS = [["intl", "国际版"], ["cn", "国内版"]];

  // ---- 小工具 -----------------------------------------------------------------

  function invoke(channel, payload) {
    if (!bridge || typeof bridge.invoke !== "function") return Promise.reject(new Error("plugin bridge 不可用"));
    return bridge.invoke(channel, payload);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function svgIcon(paths, size = 16) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", size); svg.setAttribute("height", size);
    svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7"); svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const p = document.createElementNS(svg.namespaceURI, "path");
      p.setAttribute("d", d);
      svg.append(p);
    }
    return svg;
  }

  const I = {
    external: () => svgIcon(["M14 4h6v6", "M20 4 11 13", "M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"]),
    copy: () => svgIcon(["M9 9h10v12H9z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"]),
    plus: () => svgIcon(["M12 5v14", "M5 12h14"]),
    refresh: () => svgIcon(["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"]),
    trash: () => svgIcon(["M4 7h16", "M9 7V4h6v3", "M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13", "M10 11v6M14 11v6"]),
    key: () => svgIcon(["M15 9a6 6 0 1 0-5.2 8.97L12 20v-2h2v-2h2v-2h2l2-2V9z", "M16.5 7.5h.01"]),
    check: () => svgIcon(["M20 6 9 17l-5-5"]),
    x: () => svgIcon(["M18 6 6 18", "M6 6l12 12"]),
    link: () => svgIcon(["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"]),
    bolt: () => svgIcon(["M13 2 3 14h7l-1 8 11-13h-8z"]),
    sort: () => svgIcon(["M9 9l3-3 3 3", "M9 15l3 3 3-3"], 13),
    up: () => svgIcon(["M9 15l3-3 3 3"], 13),
    down: () => svgIcon(["M9 9l3 3 3-3"], 13),
  };

  function actionButton(label, iconName, handler, options = {}) {
    const node = el("button", `ui-btn ui-btn-sm ${options.primary ? "ui-btn-primary" : ""} ${options.danger ? "ui-btn-danger" : ""}`);
    node.type = "button";
    if (iconName && I[iconName]) node.append(I[iconName]());
    if (label) node.append(el("span", "", label));
    else node.setAttribute("aria-label", options.aria || label);
    if (options.aria) node.setAttribute("aria-label", options.aria);
    if (options.title) node.title = options.title;
    node.disabled = Boolean(options.disabled);
    node.addEventListener("click", handler);
    return node;
  }

  function fieldInput(value, placeholder, onInput, options = {}) {
    const node = el("input", "gw-input");
    node.type = options.type || "text";
    node.value = value || "";
    node.placeholder = placeholder || "";
    node.autocomplete = "off";
    node.spellcheck = false;
    if (options.aria) node.setAttribute("aria-label", options.aria);
    node.addEventListener("input", () => onInput(node.value));
    return node;
  }

  function segmented(items, current, onPick, label) {
    const group = el("div", "gw-segmented");
    if (label) group.setAttribute("role", "group"), group.setAttribute("aria-label", label);
    for (const [id, text] of items) {
      const node = el("button", current === id ? "is-active" : "", text);
      node.type = "button";
      node.setAttribute("aria-pressed", String(current === id));
      node.addEventListener("click", () => onPick(id));
      group.append(node);
    }
    return group;
  }

  function fmt(value, digits = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("zh-CN", { maximumFractionDigits: digits });
  }

  function compact(value, digits = 1) {
    const n = Number(value) || 0;
    const abs = Math.abs(n);
    if (abs < 10000) return fmt(n, digits);
    if (abs < 1e6) return `${fmt(n / 1e3, abs < 1e5 ? digits : 0)}K`;
    if (abs < 1e9) return `${fmt(n / 1e6, abs < 1e7 ? 2 : 1)}M`;
    return `${fmt(n / 1e9, 2)}B`;
  }

  function seconds(ms) {
    if (!Number.isFinite(Number(ms))) return "—";
    return `${(Number(ms) / 1000).toFixed(Number(ms) >= 10000 ? 1 : 2)}s`;
  }

  function uptime(value) {
    const n = Number(value) || 0;
    if (n < 3600) return `${Math.floor(n / 60)} 分钟`;
    return `${Math.floor(n / 3600)} 小时 ${Math.floor((n % 3600) / 60)} 分`;
  }

  function errorText(error) { return error && error.message ? error.message : String(error); }

  function modelLogo(id) {
    const value = String(id || "").toLowerCase();
    let name = "workbuddy";
    if (/claude|anthropic/.test(value)) name = "anthropic";
    else if (/gemini/.test(value)) name = "gemini";
    else if (/gpt|openai|codex|o[1-9]/.test(value)) name = "openai";
    else if (/deepseek/.test(value)) name = "deepseek";
    else if (/glm|zhipu|chatglm/.test(value)) name = "zhipu";
    else if (/kimi|moonshot/.test(value)) name = "moonshot";
    else if (/minimax|mimo/.test(value)) name = "minimax";
    else if (/qwen|qwq/.test(value)) name = "qwen";
    else if (/grok|xai/.test(value)) name = "grok";
    else if (/mistral|devstral/.test(value)) name = "mistral";
    else if (/step/.test(value)) name = "stepfun";
    else if (/hunyuan/.test(value)) name = "hunyuan";
    else if (/hy[0-9]|workbuddy/.test(value)) name = "tencent";
    const image = el("img", "gw-model-logo");
    image.src = `./model-logos/${name}.svg`;
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    image.loading = "lazy";
    return image;
  }

  // ---- 顶栏 -------------------------------------------------------------------

  function statusBar() {
    const status = state.status || {};
    const bar = el("header", "gw-statusbar");
    const dot = el("i", "ui-dot");
    dot.dataset.live = String(Boolean(status.ok));
    bar.append(dot, el("strong", "", status.mode === "reused" ? "复用已有实例" : status.ok ? "网关运行中" : "网关未运行"));
    if (status.process) {
      bar.append(el("span", "gw-status-meta", `PID ${status.process.pid} · ${uptime(status.process.uptimeSeconds)}`));
    }
    if (status.lastError) bar.append(el("span", "gw-status-error", status.lastError));
    const actions = el("div", "gw-status-actions");
    actions.append(
      actionButton(state.busy ? "刷新中" : "刷新", "refresh", () => load(true), { disabled: state.busy }),
      actionButton(status.mode === "reused" ? "接管" : "重启", "bolt", restart, { disabled: state.actionBusy === "restart" || migrating() }),
    );
    if (status.rootSource === "legacy" || migrating()) {
      actions.prepend(actionButton(migrating() ? migrationText() : "迁移到插件目录", "refresh", migrateGateway, { disabled: migrating() }));
    }
    bar.append(actions);
    return bar;
  }

  function toast() {
    const text = state.error || state.flash;
    if (!text) return null;
    const box = el("div", `gw-toast ${state.error ? "is-error" : ""}`);
    box.setAttribute("role", state.error ? "alert" : "status");
    box.append(el("span", "", text));
    box.append(actionButton("", "x", () => { state.error = ""; state.flash = ""; render(); }, { aria: "关闭提示" }));
    return box;
  }

  // 主分区用 h2，子块用 h3：字号台阶是唯一需要的层级信号。
  function sectionHead(title, tools, level = "h2") {
    const head = el("header", "gw-section-head");
    head.append(el(level, "", title));
    if (tools && tools.length) {
      const box = el("div", "gw-section-tools");
      box.append(...tools);
      head.append(box);
    }
    return head;
  }

  // ---- 一、连接 ---------------------------------------------------------------

  function panelCard(kind) {
    const panel = state.data.panels && state.data.panels[kind];
    if (!panel) return null;
    const ready = panel.connection.auth !== "missing-key";
    const card = el("article", "gw-panel-card");
    card.append(el("strong", "", panel.name));
    const dot = el("i", "ui-dot");
    dot.dataset.state = ready ? "ok" : "bad";
    const state_ = el("span", "gw-panel-state");
    state_.append(dot, el("span", "", ready ? "凭据就绪" : "缺密钥"));
    card.append(state_);
    card.append(actionButton("打开", "external", () => openExternal("panel", panel.url), { aria: `打开 ${panel.name} 面板` }));
    return card;
  }

  function protocolsBlock() {
    const box = el("div", "gw-protocols");
    for (const p of state.data.protocols || []) {
      const row = el("div", "gw-protocol-row");
      row.append(el("span", "gw-protocol-label", p.label), el("code", "", p.url));
      row.append(actionButton("复制", "copy", () => copy(p.url), { aria: `复制 ${p.label} 地址` }));
      box.append(row);
    }
    return box;
  }

  function keysBlock() {
    const box = el("section", "gw-block");
    const head = sectionHead("API Key", [actionButton("生成并添加", "key", generateKey, { primary: true, disabled: state.actionBusy === "add-key" })], "h3");
    box.append(head);
    for (const key of state.data.keys || []) {
      const row = el("div", "gw-key-row");
      const name = fieldInput(state.drafts[`label-${key.id}`] ?? key.label, "备注名", value => { state.drafts[`label-${key.id}`] = value; }, { aria: "密钥备注名" });
      name.addEventListener("change", () => runAction(`label-${key.id}`, "gateway.keys", { action: "label", id: key.id, label: name.value }, "备注已保存", false));
      row.append(name, el("code", "gw-key-mask", key.mask));
      row.append(actionButton("复制", "copy", () => runAction(`copy-key-${key.id}`, "gateway.keys", { action: "copy", id: key.id }, "已复制", false), { aria: "复制 API Key" }));
      row.append(actionButton("", "trash", () => confirmAction("删除这个 API Key？客户端将无法继续用它访问。", () => runAction(`delete-key-${key.id}`, "gateway.keys", { action: "delete", id: key.id }, "API Key 已删除")), { aria: "删除 API Key", danger: true }));
      box.append(row);
    }
    const add = el("div", "gw-key-add");
    const label = fieldInput(state.drafts.newKeyLabel || "", "备注名", value => { state.drafts.newKeyLabel = value; }, { aria: "新密钥备注名" });
    const value = fieldInput(state.drafts.newKey || "", "粘贴新 API Key", value => { state.drafts.newKey = value; }, { type: "password", aria: "新 API Key" });
    add.append(label, value, actionButton("添加", "plus", async () => {
      if (!state.drafts.newKey) return notify("请先填写 API Key", true);
      await runAction("add-key", "gateway.keys", { action: "add", key: state.drafts.newKey, label: state.drafts.newKeyLabel || "" }, "API Key 已添加");
      state.drafts.newKey = "";
      state.drafts.newKeyLabel = "";
    }, { primary: true, disabled: state.actionBusy === "add-key" }));
    box.append(add);
    return box;
  }

  function modelList(models, error) {
    if (error) return el("p", "gw-empty", error);
    if (!models || !models.length) return el("p", "gw-empty", "暂无模型");
    const box = el("div", "gw-model-list");
    for (const model of models) {
      const row = el("div", "gw-model-row");
      row.append(modelLogo(model.id), el("code", "", model.id));
      box.append(row);
    }
    return box;
  }

  function connectionSection() {
    const box = el("section", "gw-section");
    box.id = "gw-connection";
    box.append(sectionHead("连接"));
    const panels = el("div", "gw-panel-grid");
    panels.append(panelCard("cp"), panelCard("wb"));
    box.append(panels, protocolsBlock(), keysBlock());
    const models = el("section", "gw-block");
    models.append(sectionHead("模型", [el("span", "gw-count", String((state.data.models || []).length))], "h3"));
    models.append(modelList(state.data.models, state.data.errors.models));
    box.append(models);
    return box;
  }

  // ---- 二、上游 ---------------------------------------------------------------

  function credentialsBlock() {
    const box = el("section", "gw-block");
    box.id = "gw-credentials";
    box.append(sectionHead("凭证", [
      actionButton("OAuth 添加", "plus", () => toggleOAuth("cp")),
      actionButton("全部刷新", "refresh", () => runAction("cp-refresh-all", "gateway.credentials", { action: "refresh", all: true }, "全部凭证已刷新"), { disabled: state.actionBusy === "cp-refresh-all" }),
    ], "h3"));
    if (state.oauth && state.oauth.kind === "cp") box.append(oauthInline());
    if (!(state.data.credentials || []).length) box.append(el("p", "gw-empty", state.data.errors.credentials || "暂无凭证"));
    for (const credential of state.data.credentials || []) {
      const row = el("div", "gw-credential-row");
      const copy = el("div", "gw-credential-copy");
      copy.append(el("strong", "", credential.account));
      copy.append(el("span", "", credential.disabled ? "已停用" : credential.unavailable ? "不可用" : credential.provider));
      row.append(copy);
      const actions = el("div", "gw-row-actions");
      actions.append(actionButton("刷新", "refresh", () => runAction(`cp-refresh-${credential.name}`, "gateway.credentials", { action: "refresh", name: credential.name, authIndex: credential.authIndex }, "凭证已刷新"), { disabled: Boolean(state.actionBusy) }));
      actions.append(actionButton("", "trash", () => confirmAction(`删除凭证「${credential.account}」？`, () => runAction(`cp-delete-${credential.name}`, "gateway.credentials", { action: "delete", name: credential.name }, "凭证已删除")), { aria: "删除凭证", danger: true }));
      row.append(actions);
      box.append(row);
    }
    return box;
  }

  function sortHeader(label, key) {
    const node = el("button", "gw-sort", label);
    node.type = "button";
    node.append(I[state.sortKey !== key ? "sort" : state.sortDir > 0 ? "up" : "down"]());
    node.setAttribute("aria-label", `${label}排序`);
    node.addEventListener("click", () => {
      if (state.sortKey === key) state.sortDir *= -1;
      else { state.sortKey = key; state.sortDir = 1; }
      render();
    });
    return node;
  }

  function sortedAccounts() {
    const rows = [...(state.data.accounts || [])];
    const key = state.sortKey;
    rows.sort((a, b) => {
      const left = a[key], right = b[key];
      const result = typeof left === "string" ? left.localeCompare(right, "zh-CN") : Number(left) - Number(right);
      return (result || a.name.localeCompare(b.name, "zh-CN")) * state.sortDir;
    });
    return rows;
  }

  function accountsBlock() {
    const box = el("section", "gw-block");
    box.id = "gw-accounts";
    box.append(sectionHead("账号池", [
      actionButton("OAuth 授权", "plus", () => toggleOAuth("wb")),
      actionButton("全部签到", "check", () => runAction("wb-checkin", "gateway.accounts", { action: "checkin" }, "签到完成"), { disabled: state.actionBusy === "wb-checkin" }),
      actionButton("刷新积分", "refresh", () => runAction("wb-credits", "gateway.accounts", { action: "credits" }, "积分统计已刷新"), { disabled: state.actionBusy === "wb-credits" }),
      actionButton("刷新凭证", "refresh", () => runAction("wb-refresh", "gateway.accounts", { action: "refresh" }, "所有凭证已刷新"), { disabled: state.actionBusy === "wb-refresh" }),
    ], "h3"));
    if (state.oauth && state.oauth.kind === "wb") box.append(oauthInline());
    const table = el("div", "gw-account-table");
    const header = el("div", "gw-account-row gw-account-header");
    header.append(sortHeader("账号", "name"), sortHeader("状态", "available"), sortHeader("余额", "remain"), sortHeader("总额", "total"), sortHeader("Token", "tokens"), el("span", "", "启用"));
    table.append(header);
    for (const account of sortedAccounts()) {
      const row = el("div", "gw-account-row");
      const name = el("div", "gw-account-name");
      name.append(el("strong", "", account.name), el("span", "", account.realm === "intl" ? "国际版" : "国内版"));
      row.append(name);
      const status = el("span", `gw-account-state ${account.available ? "is-ok" : "is-off"}`, !account.enabled ? "已停用" : account.available ? "可用" : "不可用");
      if (account.error) status.title = account.error;
      row.append(status, el("span", "gw-number", fmt(account.remain, 2)), el("span", "gw-number", fmt(account.total, 2)), el("span", "gw-number", compact(account.tokens)));
      const tools = el("div", "gw-row-actions");
      const toggle = el("input", "gw-switch");
      toggle.type = "checkbox";
      toggle.checked = account.enabled;
      toggle.disabled = Boolean(state.actionBusy);
      toggle.setAttribute("aria-label", `${account.enabled ? "停用" : "启用"} ${account.name}`);
      toggle.addEventListener("change", () => runAction(`toggle-${account.uid}`, "gateway.accounts", { action: "toggle", uid: account.uid, enabled: toggle.checked }, toggle.checked ? "账号已启用" : "账号已停用", false));
      tools.append(toggle, actionButton("", "trash", () => confirmAction(`从号池删除「${account.name}」？`, () => runAction(`delete-${account.uid}`, "gateway.accounts", { action: "delete", uid: account.uid }, "账号已删除")), { aria: "删除账号", danger: true }));
      row.append(tools);
      table.append(row);
    }
    box.append(table);
    return box;
  }

  function upstreamSection() {
    const box = el("section", "gw-section");
    box.id = "gw-upstream";
    box.append(sectionHead("上游"));
    box.append(credentialsBlock(), accountsBlock());
    const models = el("section", "gw-block");
    models.append(sectionHead("wb2api 模型", [el("span", "gw-count", String((state.data.wbModels || []).length))], "h3"));
    models.append(modelList(state.data.wbModels, state.data.errors.wbModels || state.data.errors.accounts));
    box.append(models);
    return box;
  }

  // ---- 三、用量 ---------------------------------------------------------------

  function quotaBlock() {
    const box = el("div", "gw-quota-grid");
    const ag = el("article", "gw-quota-card");
    ag.append(el("h3", "", "Antigravity 剩余量"));
    const groups = state.quota && state.quota.groups ? state.quota.groups : [];
    for (const group of groups) {
      const row = el("div", "gw-quota-row");
      const label = el("div", "gw-quota-label");
      label.append(el("span", "", group.name), el("strong", "", group.percent === null ? "—" : `${group.percent}%`));
      const track = el("div", "gw-progress");
      const fill = el("i");
      fill.style.width = `${group.percent || 0}%`;
      track.append(fill);
      row.append(label, track);
      ag.append(row);
    }
    if (!groups.length) ag.append(el("p", "gw-empty", state.quotaLoading ? "读取中" : "暂无配额"));
    const pool = state.data.pool || { remain: 0, total: 0, used: 0 };
    const wb = el("article", "gw-quota-card");
    wb.append(el("h3", "", "号池积分"));
    const ratio = pool.total > 0 ? Math.max(0, Math.min(100, pool.remain / pool.total * 100)) : 0;
    const head = el("div", "gw-pool-total");
    head.append(el("strong", "", `${fmt(pool.remain, 2)} / ${fmt(pool.total, 2)}`), el("span", "", `${ratio.toFixed(1)}%`));
    const track = el("div", "gw-progress gw-pool-progress");
    const remain = el("i", "is-remain"), used = el("i", "is-used");
    remain.style.width = `${ratio}%`;
    used.style.width = `${100 - ratio}%`;
    track.append(remain, used);
    const legend = el("div", "gw-pool-legend");
    legend.append(el("span", "", `剩余 ${fmt(pool.remain, 2)}`), el("span", "", `已用 ${fmt(pool.used, 2)}`));
    wb.append(head, track, legend);
    box.append(ag, wb);
    return box;
  }

  function summary() {
    return state.usage && state.usage.analytics && state.usage.analytics.summary
      ? state.usage.analytics.summary.window || {} : {};
  }

  function metricCard(label, value, detail) {
    const box = el("article", "gw-metric-card");
    box.append(el("span", "", label), el("strong", "", value));
    if (detail) box.append(el("p", "", detail));
    return box;
  }

  function usageMetrics() {
    const w = summary();
    const success = w.requests ? (w.requests - w.errors) / w.requests * 100 : 100;
    const box = el("div", "gw-metrics-grid");
    box.append(
      metricCard("总 Token", compact(w.total_tokens), `输入 ${compact(w.prompt_tokens)} · 输出 ${compact(w.completion_tokens)}`),
      metricCard("请求", `${fmt(w.requests)} 次`, `失败 ${fmt(w.errors)} · 成功率 ${success.toFixed(1)}%`),
      metricCard("速度", w.speed_avg == null ? "—" : `${Number(w.speed_avg).toFixed(1)} tok/s`, `耗时 ${seconds(w.elapsed_ms_avg)} · 首字 ${seconds(w.ttft_ms_avg)}`),
      metricCard("缓存命中", w.cache_hit_pct == null ? "—" : `${Number(w.cache_hit_pct).toFixed(1)}%`, `复用 ${compact(w.cached_tokens)} tok`),
      metricCard("积分消耗", fmt(w.credit, 2), w.cost_cny == null ? "" : `¥${fmt(w.cost_cny, 2)}`),
    );
    return box;
  }

  function seriesValues(bucket) {
    if (state.metric === "requests") return Number(bucket.requests) || 0;
    if (state.metric === "throughput") return (Number(bucket.completion_tokens) || 0) / (state.usage.series.bucket_seconds || 3600);
    return Number(bucket.total_tokens) || 0;
  }

  function chartBlock() {
    const box = el("article", "gw-chart-card");
    box.append(sectionHead("时序", [segmented(METRICS, state.metric, id => { state.metric = id; render(); }, "时序指标")], "h3"));
    if (!state.usage || !state.usage.series || !(state.usage.series.series || []).length) {
      box.append(el("p", "gw-empty", "该区间暂无时序"));
      return box;
    }
    const rows = state.usage.series.series;
    const width = 760, height = 220, left = 58, right = 16, top = 12, bottom = 32;
    const innerW = width - left - right, innerH = height - top - bottom;
    const max = Math.max(1, ...rows.map(seriesValues));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("class", "gw-chart");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "用量时序图");
    for (let i = 0; i <= 4; i++) {
      const y = top + innerH - innerH * i / 4;
      const line = document.createElementNS(svg.namespaceURI, "line");
      line.setAttribute("x1", left); line.setAttribute("x2", width - right); line.setAttribute("y1", y); line.setAttribute("y2", y);
      line.setAttribute("class", "gw-chart-grid");
      svg.append(line);
      const text = document.createElementNS(svg.namespaceURI, "text");
      text.setAttribute("x", 0); text.setAttribute("y", y + 3); text.setAttribute("class", "gw-chart-label");
      text.textContent = compact(max * i / 4, 0);
      svg.append(text);
    }
    const step = innerW / rows.length;
    rows.forEach((bucket, index) => {
      const value = seriesValues(bucket);
      const barWidth = Math.max(1, Math.min(16, step * 0.55));
      const barHeight = Math.max(value > 0 ? 1 : 0, value / max * innerH);
      const x = left + step * index + (step - barWidth) / 2;
      const y = top + innerH - barHeight;
      const rect = document.createElementNS(svg.namespaceURI, "rect");
      rect.setAttribute("x", x); rect.setAttribute("y", y); rect.setAttribute("width", barWidth); rect.setAttribute("height", barHeight);
      rect.setAttribute("rx", Math.min(2, barWidth / 2)); rect.setAttribute("class", "gw-chart-bar");
      const title = document.createElementNS(svg.namespaceURI, "title");
      title.textContent = `${new Date(bucket.at * 1000).toLocaleString("zh-CN")}\nToken ${fmt(bucket.total_tokens)}\n请求 ${fmt(bucket.requests)}\n吞吐 ${((bucket.completion_tokens || 0) / (state.usage.series.bucket_seconds || 3600)).toFixed(1)} tok/s`;
      rect.append(title);
      svg.append(rect);
      if (rows.length <= 45 && (index % Math.ceil(rows.length / 8) === 0 || index === rows.length - 1)) {
        const label = document.createElementNS(svg.namespaceURI, "text");
        label.setAttribute("x", x + barWidth / 2); label.setAttribute("y", height - 8); label.setAttribute("text-anchor", "middle"); label.setAttribute("class", "gw-chart-label");
        const date = new Date(bucket.at * 1000);
        label.textContent = state.usage.series.bucket_seconds >= 86400 ? `${date.getMonth() + 1}-${date.getDate()}` : `${String(date.getHours()).padStart(2, "0")}:00`;
        svg.append(label);
      }
    });
    box.append(svg);
    return box;
  }

  function recentBlock() {
    const box = el("article", "gw-recent-card");
    box.append(sectionHead("最近请求", [el("span", "gw-count", `${(state.usage.recent && state.usage.recent.total) || 0}`)], "h3"));
    const list = el("div", "gw-recent-list");
    for (const row of (state.usage.recent && state.usage.recent.rows) || []) {
      const item = el("div", "gw-recent-row");
      item.append(el("span", "gw-recent-time", String(row.iso || "").slice(11, 19)));
      const model = el("div", "gw-recent-model");
      model.append(modelLogo(row.model), el("code", "", row.model || "未知模型"));
      item.append(model, el("span", "gw-number", `${compact(row.total_tokens)} · ${seconds(row.elapsed_ms)}`));
      list.append(item);
    }
    if (!list.children.length) list.append(el("p", "gw-empty", "暂无请求"));
    box.append(list);
    return box;
  }

  function dimensionRows() {
    const a = state.usage && state.usage.analytics;
    if (!a) return [];
    const source = state.dimension === "account" ? a.accounts : state.dimension === "key" ? a.keys : a.models;
    const list = Array.isArray(source) ? source : Object.entries(source || {}).map(([name, value]) => ({ model: name, window: value }));
    return list.map(item => {
      const w = item.window || {};
      return {
        name: state.dimension === "model" ? item.model || item.name : state.dimension === "account" ? item.nickname || item.uid : item.name || item.key,
        requests: w.requests || 0,
        tokens: w.total_tokens ?? w.tokens ?? 0,
        speed: w.speed_avg,
        cache: w.cache_hit_pct,
        credit: w.credit,
        cost: w.cost_cny,
      };
    }).filter(row => row.requests || row.tokens).sort((a, b) => b.tokens - a.tokens);
  }

  function usageTable() {
    const box = el("article", "gw-usage-table-card");
    box.append(sectionHead("明细", [segmented(DIMENSIONS, state.dimension, id => { state.dimension = id; render(); }, "用量维度")], "h3"));
    const table = el("div", "gw-usage-table");
    const header = el("div", "gw-usage-row gw-usage-header");
    for (const text of ["名称", "请求", "Token", "速度", "缓存", "积分", "花费"]) header.append(el("span", "", text));
    table.append(header);
    for (const row of dimensionRows()) {
      const line = el("div", "gw-usage-row");
      const name = el("div", "gw-usage-name");
      if (state.dimension === "model") name.append(modelLogo(row.name));
      name.append(el("span", "", row.name || "—"));
      line.append(name, el("span", "gw-number", fmt(row.requests)), el("span", "gw-number", compact(row.tokens)), el("span", "gw-number", row.speed == null ? "—" : `${Number(row.speed).toFixed(0)} tok/s`), el("span", "gw-number", row.cache == null ? "—" : `${Number(row.cache).toFixed(1)}%`), el("span", "gw-number", row.credit == null ? "—" : fmt(row.credit, 2)), el("span", "gw-number", row.cost == null ? "—" : `¥${fmt(row.cost, 2)}`));
      table.append(line);
    }
    if (!dimensionRows().length) table.append(el("p", "gw-empty", "该区间暂无用量"));
    box.append(table);
    return box;
  }

  function usageSection() {
    const box = el("section", "gw-section");
    box.id = "gw-usage";
    box.append(sectionHead("用量", [segmented(RANGES, state.range, id => loadUsage(id), "时间范围")]));
    box.append(quotaBlock());
    if (!state.usage) box.append(el("p", "gw-empty", state.usageError || "读取中"));
    else {
      box.append(usageMetrics());
      const charts = el("div", "gw-chart-grid");
      charts.append(chartBlock(), recentBlock());
      box.append(charts, usageTable());
    }
    return box;
  }

  // ---- OAuth 内联 -------------------------------------------------------------

  function toggleOAuth(kind) {
    if (state.oauth && state.oauth.kind === kind) { closeOAuth(); return; }
    state.oauth = { kind, provider: kind === "cp" ? "antigravity" : "intl", state: "", url: "", busy: false, message: "", callback: "" };
    render();
  }

  function oauthInline() {
    const flow = state.oauth;
    const box = el("div", "gw-oauth-inline");
    const choices = flow.kind === "cp" ? CP_PROVIDERS.map(p => [p, p]) : WB_PROVIDERS;
    box.append(segmented(choices, flow.provider, id => { flow.provider = id; render(); }, "OAuth 提供方"));
    if (!flow.state) {
      box.append(actionButton(flow.busy ? "发起中" : "开始授权", "external", startOAuth, { primary: true, disabled: flow.busy }));
    } else {
      box.append(el("code", "gw-oauth-link", flow.url || ""));
      const actions = el("div", "gw-row-actions");
      actions.append(actionButton("打开", "external", () => openExternal("oauth", flow.url)));
      actions.append(actionButton("复制链接", "copy", () => copy(flow.url)));
      actions.append(actionButton("取消", "x", closeOAuth));
      box.append(actions);
      if (flow.kind === "cp") {
        const callback = fieldInput(flow.callback || "", "回调 URL（未自动回调时粘贴）", value => { flow.callback = value; }, { aria: "OAuth 回调 URL" });
        box.append(callback, actionButton("提交回调", "check", () => submitCallback(callback.value), { disabled: flow.busy }));
      }
      box.append(el("span", "gw-oauth-status", flow.message || "等待授权"));
    }
    return box;
  }

  // ---- 渲染 -------------------------------------------------------------------

  function render() {
    const host = root();
    if (!host || !state.data) return;
    const scrollTop = host.querySelector(".gw-scroll") ? host.querySelector(".gw-scroll").scrollTop : 0;
    host.replaceChildren();
    const scroll = el("div", "gw-scroll");
    scroll.append(statusBar());
    const content = el("main", "gw-content");
    const message = toast();
    if (message) content.append(message);
    content.append(connectionSection(), upstreamSection(), usageSection());
    scroll.append(content);
    host.append(scroll);
    scroll.scrollTop = scrollTop;
  }

  // ---- 动作 -------------------------------------------------------------------

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(String(text || ""));
      state.flash = "已复制";
      state.error = "";
    } catch (error) { state.error = `复制失败：${errorText(error)}`; }
    render();
  }

  async function openExternal(kind, url) {
    try { await invoke("gateway.open", { kind, url }); }
    catch (error) { notify(`打开浏览器失败：${errorText(error)}`, true); }
  }

  function notify(message, isError = false) {
    if (isError) state.error = message;
    else { state.flash = message; state.error = ""; }
    render();
  }

  async function generateKey() {
    const bytes = new Uint8Array(36);
    crypto.getRandomValues(bytes);
    const key = `sk-${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
    await runAction("add-key", "gateway.keys", { action: "add", key, label: state.drafts.newKeyLabel || "" }, "已生成并添加 API Key");
    state.drafts.newKey = "";
    state.drafts.newKeyLabel = "";
  }

  async function runAction(id, channel, payload, message, refresh = true) {
    if (state.actionBusy) return;
    state.actionBusy = id;
    state.error = "";
    render();
    try {
      const result = await invoke(channel, payload);
      if (result && result.ok === false) throw new Error(result.error || result.message || "操作失败");
      state.flash = message;
      if (refresh) await loadOverview();
      if (state.range && (channel === "gateway.accounts" || channel === "gateway.credentials")) await loadUsage(state.range, true);
    } catch (error) { state.error = errorText(error); }
    finally { state.actionBusy = ""; render(); }
  }

  function confirmAction(message, action) {
    if (window.confirm(message)) action();
  }

  async function loadOverview() {
    state.data = await invoke("gateway.overview");
    if (!state.data.accounts) state.data.accounts = [];
    if (!state.data.pool) state.data.pool = { remain: 0, total: 0, used: 0, tokens: 0, available: 0 };
    if (!state.data.errors) state.data.errors = {};
  }

  async function loadUsage(range, background = false) {
    if (!background) {
      state.range = range;
      state.usage = null;
      state.usageError = "";
      render();
    }
    try {
      const usage = await invoke("gateway.usage", { range });
      if (range === state.range) state.usage = usage;
    } catch (error) {
      state.usageError = errorText(error);
      if (!background) state.error = `用量读取失败：${state.usageError}`;
    }
    render();
  }

  async function loadQuota() {
    state.quotaLoading = true;
    try { state.quota = await invoke("gateway.quota"); }
    catch (error) { state.quota = { ok: false, groups: [], error: errorText(error) }; }
    finally { state.quotaLoading = false; }
    render();
  }

  async function load(manual) {
    if (state.busy) return;
    state.busy = true;
    if (manual) render();
    try {
      const [status] = await Promise.all([invoke("gateway.status"), loadOverview()]);
      state.status = status;
      state.error = "";
      render();
      loadQuota();
      await loadUsage(state.range, true);
    } catch (error) { state.error = errorText(error); }
    finally { state.busy = false; render(); }
  }

  function migrating() {
    return Boolean(state.migration && ["stopping", "copy", "starting"].includes(state.migration.phase));
  }

  function migrationText() {
    const job = state.migration || {};
    if (job.phase === "copy" && job.total) return `迁移中 ${Math.floor((job.done / job.total) * 100)}%`;
    return job.phase === "starting" ? "启动新目录" : "停止旧实例";
  }

  async function migrateGateway() {
    if (migrating()) return;
    if (!window.confirm("把网关复制到插件数据目录并从那里启动？期间网关会停几十秒，旧目录 ~/ai-gateway 不会被改动。")) return;
    try {
      const result = await invoke("gateway.migrate");
      if (!result.ok) throw new Error(result.error || "迁移失败");
      state.migration = result;
      state.error = "";
      render();
      pollMigration();
    } catch (error) { state.error = errorText(error); render(); }
  }

  async function pollMigration() {
    try { state.migration = await invoke("gateway.migrateStatus"); }
    catch (error) { state.migration = { phase: "failed", error: errorText(error) }; }
    if (migrating()) {
      render();
      setTimeout(pollMigration, 700);
      return;
    }
    if (state.migration && state.migration.phase === "failed") state.error = `迁移失败，仍使用旧目录：${state.migration.error}`;
    else if (state.migration && state.migration.phase === "done") state.flash = "已迁移到插件目录";
    await load(true);
  }

  async function restart() {
    if (state.actionBusy) return;
    state.actionBusy = "restart";
    render();
    try {
      const result = await invoke("gateway.restart");
      if (!result.ok) throw new Error(result.error || "重启失败");
      state.flash = result.takenOver && result.takenOver.length ? "已接管并重新启动" : "网关正在重启";
      setTimeout(() => load(true), 4500);
    } catch (error) { state.error = errorText(error); }
    finally { state.actionBusy = ""; render(); }
  }

  function closeOAuth() {
    const flow = state.oauth;
    if (flow && flow.state) {
      const channel = flow.kind === "cp" ? "gateway.credentials" : "gateway.accounts";
      invoke(channel, { action: "oauthCancel", state: flow.state }).catch(() => {});
    }
    state.oauth = null;
    render();
  }

  async function startOAuth() {
    const flow = state.oauth;
    if (!flow || flow.busy) return;
    flow.busy = true;
    render();
    try {
      const channel = flow.kind === "cp" ? "gateway.credentials" : "gateway.accounts";
      const result = await invoke(channel, { action: "oauthStart", provider: flow.provider, realm: flow.provider });
      flow.state = result.state;
      flow.url = result.url || result.authUrl || result.auth_url || "";
      if (!flow.state || !flow.url) throw new Error("服务未返回有效的授权地址");
      flow.message = "等待授权";
      await openExternal("oauth", flow.url);
      pollOAuth();
    } catch (error) { state.error = errorText(error); flow.state = ""; }
    finally { flow.busy = false; render(); }
  }

  async function pollOAuth() {
    const flow = state.oauth;
    if (!flow || !flow.state) return;
    try {
      const channel = flow.kind === "cp" ? "gateway.credentials" : "gateway.accounts";
      const result = await invoke(channel, { action: "oauthPoll", state: flow.state });
      if (result.status === "ok") {
        state.oauth = null;
        state.flash = "OAuth 授权完成";
        await loadOverview();
        render();
        return;
      }
      if (["error", "expired", "unknown"].includes(result.status)) throw new Error(result.error || result.message || "授权未完成");
      flow.message = result.message || "等待授权";
    } catch (error) { state.error = errorText(error); }
    render();
    if (state.oauth === flow && flow.state) setTimeout(pollOAuth, 2200);
  }

  async function submitCallback(url) {
    const flow = state.oauth;
    if (!flow || !url.trim()) return notify("请粘贴完整回调 URL", true);
    flow.busy = true;
    try {
      await invoke("gateway.credentials", { action: "oauthCallback", provider: flow.provider, url: url.trim() });
      flow.message = "回调已提交";
      flow.error = "";
    } catch (error) { state.error = errorText(error); }
    finally { flow.busy = false; render(); }
  }

  function boot() {
    if (state.booted) return;
    state.booted = true;
    load(true);
    state.timer = setInterval(() => {
      const host = root();
      if (host && !host.hidden && !state.oauth && !state.actionBusy) load(false);
    }, 45000);
  }

  window.PiOptGateway = { boot, _state: state, _load: load };
})();
