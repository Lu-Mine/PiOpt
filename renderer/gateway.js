(function () {
  "use strict";

  const bridge = window.pluginBridge;
  const root = () => document.getElementById("view-gateway");
  const state = {
    booted: false,
    timer: null,
    busy: false,
    status: null,
    data: null,
    usage: null,
    quota: null,
    quotaLoading: false,
    range: "today",
    metric: "tokens",
    dimension: "model",
    sortKey: "name",
    sortDir: 1,
    actionBusy: "",
    error: "",
    flash: "",
    oauth: null,
    drafts: {},
  };

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

  function button(text, handler, options = {}) {
    const node = el("button", `ui-btn ${options.primary ? "ui-btn-primary" : ""} ${options.small ? "ui-btn-sm" : ""} ${options.danger ? "ui-btn-danger" : ""}`, text);
    node.type = "button";
    node.disabled = Boolean(options.disabled);
    if (options.title) node.title = options.title;
    node.addEventListener("click", handler);
    return node;
  }

  function input(value, placeholder, onInput, options = {}) {
    const node = el("input", "gw-input");
    node.type = options.type || "text";
    node.value = value || "";
    node.placeholder = placeholder || "";
    node.autocomplete = "off";
    node.spellcheck = false;
    node.addEventListener("input", () => onInput(node.value));
    return node;
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
    if (n < 3600) return `${Math.floor(n / 60)} 分`;
    return `${Math.floor(n / 3600)} 时 ${Math.floor((n % 3600) / 60)} 分`;
  }

  function errorText(error) {
    return error && error.message ? error.message : String(error);
  }

  function notify(message, isError = false) {
    if (isError) state.error = message;
    else {
      state.flash = message;
      state.error = "";
    }
    render();
  }

  function toast() {
    const text = state.error || state.flash;
    if (!text) return null;
    const box = el("div", `gw-toast ${state.error ? "is-error" : ""}`);
    box.setAttribute("role", state.error ? "alert" : "status");
    box.append(el("span", "", text));
    const close = el("button", "gw-toast-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭提示");
    close.addEventListener("click", () => { state.error = ""; state.flash = ""; render(); });
    box.append(close);
    return box;
  }

  function section(id, title, subtitle, actions) {
    const box = el("section", "gw-section");
    box.id = id;
    const head = el("header", "gw-section-head");
    const copy = el("div", "gw-section-copy");
    copy.append(el("h2", "", title));
    if (subtitle) copy.append(el("p", "", subtitle));
    head.append(copy);
    if (actions && actions.length) {
      const tools = el("div", "gw-section-actions");
      tools.append(...actions);
      head.append(tools);
    }
    box.append(head);
    return box;
  }

  function statusBar() {
    const status = state.status || {};
    const bar = el("header", "gw-statusbar");
    const dot = el("i", "ui-dot");
    dot.dataset.live = String(Boolean(status.ok));
    bar.append(dot, el("strong", "", status.ok ? "网关运行中" : "网关未运行"));
    const meta = el("span", "gw-status-meta");
    const parts = [];
    if (status.supervisor) parts.push(`PID ${status.supervisor.pid}`, `已运行 ${uptime(status.supervisor.uptimeSeconds)}`);
    if (status.lastError) parts.push(status.lastError);
    meta.textContent = parts.join(" · ");
    bar.append(meta);
    const actions = el("div", "gw-status-actions");
    actions.append(
      button(state.busy ? "刷新中…" : "刷新", () => load(true), { small: true, disabled: state.busy }),
      button(state.actionBusy === "restart" ? "重启中…" : "重启网关", restart, { small: true, disabled: state.actionBusy === "restart" }),
    );
    bar.append(actions);
    return bar;
  }

  function panelConnection(kind) {
    const panel = state.data && state.data.panels && state.data.panels[kind];
    if (!panel) return el("div");
    const box = el("article", "gw-panel-connection");
    const head = el("div", "gw-panel-title");
    head.append(el("strong", "", panel.name));
    head.append(button("打开面板", () => openExternal("panel", panel.url), { small: true }));
    box.append(head);
    const fields = el("div", "gw-connection-fields");
    const username = input(panel.connection.username, "账号（如有）", value => { state.drafts[`${kind}Username`] = value; });
    username.value = state.drafts[`${kind}Username`] ?? panel.connection.username;
    const password = input("", panel.connection.passwordSet ? "密码（已保存，留空保持不变）" : "密码（如有）", value => { state.drafts[`${kind}Password`] = value; }, { type: "password" });
    password.value = state.drafts[`${kind}Password`] || "";
    fields.append(username, password);
    if (kind === "cp") {
      const management = input("", panel.connection.managementKeySet ? "管理密钥（已保存，留空保持不变）" : "管理密钥（面板需要时填写）", value => { state.drafts.cpManagementKey = value; }, { type: "password" });
      management.value = state.drafts.cpManagementKey || "";
      fields.append(management);
    }
    fields.append(button("保存连接", () => saveConnection(kind), { small: true, disabled: state.actionBusy === `connection-${kind}` }));
    box.append(fields);
    return box;
  }

  function protocolRows() {
    const box = el("div", "gw-protocols");
    for (const protocol of (state.data && state.data.protocols) || []) {
      const row = el("div", "gw-protocol-row");
      row.append(el("span", "gw-protocol-label", protocol.label), el("code", "", protocol.url));
      row.append(button("复制", () => copy(protocol.url), { small: true }));
      box.append(row);
    }
    return box;
  }

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

  function modelList(models, error) {
    const box = el("div", "gw-model-list");
    if (error) return el("p", "gw-empty", error);
    if (!models || !models.length) return el("p", "gw-empty", "暂无模型数据");
    for (const model of models) {
      const row = el("div", "gw-model-row");
      row.append(modelLogo(model.id), el("code", "", model.id));
      box.append(row);
    }
    return box;
  }

  function keysBlock() {
    const box = el("div", "gw-block");
    const head = el("div", "gw-block-head");
    head.append(el("h3", "", "CLIProxyAPI API Key"), el("span", "gw-count", String((state.data.keys || []).length)));
    box.append(head);
    for (const key of (state.data && state.data.keys) || []) {
      const row = el("div", "gw-key-row");
      const name = input(key.label, "备注名", value => { state.drafts[`label-${key.id}`] = value; });
      name.value = state.drafts[`label-${key.id}`] ?? key.label;
      name.addEventListener("change", () => runAction(`label-${key.id}`, "gateway.keys", { action: "label", id: key.id, label: name.value }, "备注已保存", false));
      row.append(name, el("code", "gw-key-mask", key.mask));
      row.append(button("复制", () => copy(key.key), { small: true }));
      row.append(button("删除", () => confirmAction("确定删除这个 API Key？删除后客户端将无法继续用它访问。", () => runAction(`delete-key-${key.id}`, "gateway.keys", { action: "delete", id: key.id }, "API Key 已删除")), { small: true, danger: true }));
      box.append(row);
    }
    const add = el("div", "gw-key-add");
    const label = input("", "备注名（可选）", value => { state.drafts.newKeyLabel = value; });
    label.value = state.drafts.newKeyLabel || "";
    const value = input("", "粘贴新 API Key", value => { state.drafts.newKey = value; }, { type: "password" });
    value.value = state.drafts.newKey || "";
    add.append(label, value, button("生成并添加", async () => {
      const bytes = new Uint8Array(36);
      crypto.getRandomValues(bytes);
      const key = `sk-${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
      await runAction("add-key", "gateway.keys", { action: "add", key, label: state.drafts.newKeyLabel || "" }, "已生成并添加 API Key");
      state.drafts.newKey = "";
      state.drafts.newKeyLabel = "";
    }, { small: true, disabled: state.actionBusy === "add-key" }), button("添加", async () => {
      if (!state.drafts.newKey) return notify("请先填写 API Key", true);
      await runAction("add-key", "gateway.keys", { action: "add", key: state.drafts.newKey, label: state.drafts.newKeyLabel || "" }, "API Key 已添加");
      state.drafts.newKey = "";
      state.drafts.newKeyLabel = "";
    }, { small: true, primary: true, disabled: state.actionBusy === "add-key" }));
    box.append(add);
    return box;
  }

  function connectionSection() {
    const box = section("gw-connection", "一、连接", "本机服务、客户端入口与可用模型");
    const panels = el("div", "gw-panel-grid");
    panels.append(panelConnection("cp"), panelConnection("wb"));
    box.append(panels, protocolRows(), keysBlock());
    const models = el("div", "gw-block");
    const head = el("div", "gw-block-head");
    head.append(el("h3", "", "支持的模型"), el("span", "gw-count", String((state.data.models || []).length)));
    models.append(head, modelList(state.data.models, state.data.errors.models));
    box.append(models);
    return box;
  }

  function credentialsBlock() {
    const box = el("div", "gw-block");
    const head = el("div", "gw-block-head");
    head.append(el("h3", "", "CLIProxyAPI 凭证"));
    const actions = el("div", "gw-inline-actions");
    actions.append(button("OAuth 添加", () => openOAuth("cp"), { small: true }));
    actions.append(button("全部刷新", () => runAction("cp-refresh-all", "gateway.credentials", { action: "refresh", all: true }, "全部凭证已刷新"), { small: true, disabled: state.actionBusy === "cp-refresh-all" }));
    head.append(actions);
    box.append(head);
    if (!(state.data.credentials || []).length) box.append(el("p", "gw-empty", state.data.errors.credentials || "暂无 OAuth 凭证"));
    for (const credential of state.data.credentials || []) {
      const row = el("div", "gw-credential-row");
      const copy = el("div", "gw-credential-copy");
      copy.append(el("strong", "", credential.account));
      copy.append(el("span", "", `${credential.provider} · ${credential.disabled ? "已停用" : credential.unavailable ? "不可用" : "可用"}${credential.failed ? ` · 失败 ${credential.failed}` : ""}`));
      row.append(copy);
      const actions = el("div", "gw-inline-actions");
      actions.append(button("刷新", () => runAction(`cp-refresh-${credential.name}`, "gateway.credentials", { action: "refresh", name: credential.name, authIndex: credential.authIndex }, "凭证已刷新"), { small: true, disabled: Boolean(state.actionBusy) }));
      actions.append(button("删除", () => confirmAction(`确定删除凭证「${credential.account}」？`, () => runAction(`cp-delete-${credential.name}`, "gateway.credentials", { action: "delete", name: credential.name }, "凭证已删除")), { small: true, danger: true }));
      row.append(actions);
      box.append(row);
    }
    return box;
  }

  function sortHeader(label, key) {
    const node = el("button", "gw-sort", label);
    node.type = "button";
    node.append(el("span", "gw-sort-arrow", state.sortKey === key ? (state.sortDir > 0 ? "↑" : "↓") : "↕"));
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
    const box = el("div", "gw-block");
    const head = el("div", "gw-block-head");
    head.append(el("h3", "", "wb2api 账号池"), el("span", "gw-count", `${state.data.pool.available} / ${(state.data.accounts || []).length} 可用`));
    box.append(head);
    const actions = el("div", "gw-account-actions");
    actions.append(
      button("OAuth 授权", () => openOAuth("wb"), { small: true }),
      button("全部签到", () => runAction("wb-checkin", "gateway.accounts", { action: "checkin" }, "签到完成"), { small: true, disabled: state.actionBusy === "wb-checkin" }),
      button("刷新所有积分", () => runAction("wb-credits", "gateway.accounts", { action: "credits" }, "积分统计已刷新"), { small: true, disabled: state.actionBusy === "wb-credits" }),
      button("刷新所有凭证", () => runAction("wb-refresh", "gateway.accounts", { action: "refresh" }, "所有凭证已刷新"), { small: true, disabled: state.actionBusy === "wb-refresh" }),
    );
    box.append(actions);
    const table = el("div", "gw-account-table");
    const header = el("div", "gw-account-row gw-account-header");
    header.append(sortHeader("账号名", "name"), sortHeader("状态", "available"), sortHeader("积分余额", "remain"), sortHeader("积分总额", "total"), sortHeader("今日 Token", "tokens"), el("span", "", "启用"));
    table.append(header);
    for (const account of sortedAccounts()) {
      const row = el("div", "gw-account-row");
      const name = el("div", "gw-account-name");
      name.append(el("strong", "", account.name), el("span", "", account.realm === "intl" ? "国际版" : "国内版"));
      row.append(name);
      const status = el("span", `gw-account-state ${account.available ? "is-ok" : "is-off"}`, !account.enabled ? "已停用" : account.available ? "可用" : "不可用");
      if (account.error) status.title = account.error;
      row.append(status, el("span", "gw-number", fmt(account.remain, 2)), el("span", "gw-number", fmt(account.total, 2)), el("span", "gw-number", compact(account.tokens)));
      const tools = el("div", "gw-account-tools");
      const toggle = el("input", "gw-switch");
      toggle.type = "checkbox";
      toggle.checked = account.enabled;
      toggle.disabled = Boolean(state.actionBusy);
      toggle.setAttribute("aria-label", `${account.enabled ? "停用" : "启用"} ${account.name}`);
      toggle.addEventListener("change", () => runAction(`toggle-${account.uid}`, "gateway.accounts", { action: "toggle", uid: account.uid, enabled: toggle.checked }, toggle.checked ? "账号已启用" : "账号已停用", false));
      tools.append(toggle, button("删除", () => confirmAction(`确定从号池删除「${account.name}」？`, () => runAction(`delete-${account.uid}`, "gateway.accounts", { action: "delete", uid: account.uid }, "账号已删除")), { small: true, danger: true }));
      row.append(tools);
      table.append(row);
    }
    box.append(table);
    return box;
  }

  function upstreamSection() {
    const box = section("gw-upstream", "二、上游", "凭证、号池与 wb2api 模型");
    box.append(credentialsBlock(), accountsBlock());
    const models = el("div", "gw-block");
    const head = el("div", "gw-block-head");
    head.append(el("h3", "", "wb2api 支持的模型"), el("span", "gw-count", String((state.data.wbModels || []).length)));
    models.append(head, modelList(state.data.wbModels, state.data.errors.wbModels || state.data.errors.accounts));
    box.append(models);
    return box;
  }

  function quotaBlock() {
    const box = el("div", "gw-quota-grid");
    const ag = el("article", "gw-quota-card");
    ag.append(el("h3", "", "CLIProxyAPI · Antigravity 总剩余量"));
    const groups = state.quota && state.quota.groups ? state.quota.groups : [];
    for (const group of groups) {
      const row = el("div", "gw-quota-row");
      const label = el("div", "gw-quota-label");
      label.append(el("span", "", group.name), el("strong", "", group.percent === null ? "—" : `${group.percent}%`));
      const track = el("div", "gw-progress");
      const fill = el("i");
      fill.style.width = `${group.percent || 0}%`;
      track.append(fill);
      row.append(label, track, el("span", "gw-quota-meta", group.accounts ? `${group.accounts} 个账号` : "暂无配额数据"));
      ag.append(row);
    }
    if (!groups.length) {
      ag.append(el("p", "gw-empty", state.quotaLoading ? "正在读取配额…" : (state.quota && state.quota.error) || "暂无配额数据"));
    }
    const pool = state.data.pool || { remain: 0, total: 0, used: 0 };
    const wb = el("article", "gw-quota-card");
    wb.append(el("h3", "", "wb2api · 号池积分"));
    const ratio = pool.total > 0 ? Math.max(0, Math.min(100, pool.remain / pool.total * 100)) : 0;
    const head = el("div", "gw-pool-total");
    head.append(el("strong", "", `${fmt(pool.remain, 2)} / ${fmt(pool.total, 2)}`), el("span", "", `${ratio.toFixed(1)}% 剩余`));
    const track = el("div", "gw-progress gw-pool-progress");
    const remain = el("i", "is-remain"), used = el("i", "is-used");
    remain.style.width = `${ratio}%`;
    used.style.width = `${100 - ratio}%`;
    track.append(remain, used);
    const legend = el("div", "gw-pool-legend");
    legend.append(el("span", "", `剩余 ${fmt(pool.remain, 2)}`), el("span", "", `已使用 ${fmt(pool.used, 2)}`));
    wb.append(head, track, legend);
    box.append(ag, wb);
    return box;
  }

  const RANGES = [["today", "今日"], ["d3", "近 3 日"], ["week", "本周"], ["month", "本月"], ["d30", "近 30 天"], ["all", "近一年"]];
  function rangePicker() {
    const group = el("div", "gw-segmented");
    for (const [id, label] of RANGES) {
      const node = el("button", state.range === id ? "is-active" : "", label);
      node.type = "button";
      node.setAttribute("aria-pressed", String(state.range === id));
      node.addEventListener("click", () => loadUsage(id));
      group.append(node);
    }
    return group;
  }

  function summary() {
    return state.usage && state.usage.analytics && state.usage.analytics.summary
      ? state.usage.analytics.summary.window || {}
      : {};
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
      metricCard("总 Token", compact(w.total_tokens), `输入 ${compact(w.prompt_tokens)} · 输出 ${compact(w.completion_tokens)} · 思考 ${compact(w.reasoning_tokens)}`),
      metricCard("请求", `${fmt(w.requests)} 次`, `失败 ${fmt(w.errors)} · 成功率 ${success.toFixed(1)}%`),
      metricCard("生成速度", w.speed_avg == null ? "—" : `${Number(w.speed_avg).toFixed(1)} tok/s`, `平均耗时 ${seconds(w.elapsed_ms_avg)} · 首字 ${seconds(w.ttft_ms_avg)}`),
      metricCard("缓存命中", w.cache_hit_pct == null ? "—" : `${Number(w.cache_hit_pct).toFixed(1)}%`, `复用 ${compact(w.cached_tokens)} tokens`),
      metricCard("积分消耗", fmt(w.credit, 2), w.cost_cny == null ? "暂无等价花费" : `API 等价 ¥${fmt(w.cost_cny, 2)}`),
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
    const head = el("div", "gw-block-head");
    head.append(el("h3", "", "Token 时序"));
    const picker = el("div", "gw-segmented");
    for (const [id, label] of [["tokens", "Token"], ["requests", "请求数"], ["throughput", "吞吐量"]]) {
      const node = el("button", state.metric === id ? "is-active" : "", label);
      node.type = "button";
      node.addEventListener("click", () => { state.metric = id; render(); });
      picker.append(node);
    }
    head.append(picker);
    box.append(head);
    if (!state.usage || !state.usage.series || !(state.usage.series.series || []).length) {
      box.append(el("p", "gw-empty", "该时间范围暂无时序数据"));
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
    const head = el("div", "gw-block-head");
    head.append(el("h3", "", "最近请求"), el("span", "gw-count", `${(state.usage.recent && state.usage.recent.total) || 0} 条`));
    box.append(head);
    const list = el("div", "gw-recent-list");
    for (const row of (state.usage.recent && state.usage.recent.rows) || []) {
      const item = el("div", "gw-recent-row");
      item.append(el("span", "gw-recent-time", String(row.iso || "").slice(11, 19)));
      const model = el("div", "gw-recent-model");
      model.append(modelLogo(row.model), el("code", "", row.model || "未知模型"));
      item.append(model, el("span", "gw-number", `${compact(row.total_tokens)} tok · ${seconds(row.elapsed_ms)}`));
      list.append(item);
    }
    if (!list.children.length) list.append(el("p", "gw-empty", "暂无请求记录"));
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
    const head = el("div", "gw-block-head");
    head.append(el("h3", "", "用量明细"));
    const picker = el("div", "gw-segmented");
    for (const [id, label] of [["model", "按模型"], ["account", "按账号"], ["key", "按 API Key"]]) {
      const node = el("button", state.dimension === id ? "is-active" : "", label);
      node.type = "button";
      node.addEventListener("click", () => { state.dimension = id; render(); });
      picker.append(node);
    }
    head.append(picker);
    box.append(head);
    const table = el("div", "gw-usage-table");
    const header = el("div", "gw-usage-row gw-usage-header");
    for (const text of ["名称", "请求", "Token", "平均速度", "缓存命中", "积分", "等价花费"]) header.append(el("span", "", text));
    table.append(header);
    for (const row of dimensionRows()) {
      const line = el("div", "gw-usage-row");
      const name = el("div", "gw-usage-name");
      if (state.dimension === "model") name.append(modelLogo(row.name));
      name.append(el("span", "", row.name || "—"));
      line.append(name, el("span", "gw-number", fmt(row.requests)), el("span", "gw-number", compact(row.tokens)), el("span", "gw-number", row.speed == null ? "—" : `${Number(row.speed).toFixed(0)} tok/s`), el("span", "gw-number", row.cache == null ? "—" : `${Number(row.cache).toFixed(1)}%`), el("span", "gw-number", row.credit == null ? "—" : fmt(row.credit, 2)), el("span", "gw-number", row.cost == null ? "—" : `¥${fmt(row.cost, 2)}`));
      table.append(line);
    }
    if (!dimensionRows().length) table.append(el("p", "gw-empty", "该时间范围暂无用量"));
    box.append(table);
    return box;
  }

  function usageSection() {
    const box = section("gw-usage", "三、用量", "账号剩余量与 wb2api 请求统计", [rangePicker()]);
    box.append(quotaBlock());
    if (!state.usage) box.append(el("p", "gw-empty", state.usageError || "正在读取用量…"));
    else {
      box.append(usageMetrics());
      const charts = el("div", "gw-chart-grid");
      charts.append(chartBlock(), recentBlock());
      box.append(charts, usageTable());
    }
    return box;
  }

  function oauthDialog() {
    if (!state.oauth) return null;
    const flow = state.oauth;
    const veil = el("div", "gw-dialog-veil");
    const dialog = el("div", "gw-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "gw-oauth-title");
    const head = el("div", "gw-block-head");
    head.append(el("h3", "", flow.kind === "cp" ? "添加 CLIProxyAPI OAuth 凭证" : "wb2api OAuth 授权"));
    head.append(button("关闭", closeOAuth, { small: true }));
    dialog.append(head);
    const choices = flow.kind === "cp" ? ["antigravity", "claude", "codex", "gemini"] : ["intl", "cn"];
    const picker = el("div", "gw-segmented");
    for (const provider of choices) {
      const label = flow.kind === "wb" ? (provider === "intl" ? "国际版" : "国内版") : provider;
      const node = el("button", flow.provider === provider ? "is-active" : "", label);
      node.type = "button";
      node.disabled = Boolean(flow.state);
      node.addEventListener("click", () => { flow.provider = provider; render(); });
      picker.append(node);
    }
    dialog.append(picker);
    if (!flow.state) {
      dialog.append(el("p", "gw-dialog-hint", "授权页面将在系统默认浏览器中打开，完成后这里会自动确认。"));
      dialog.append(button(flow.busy ? "正在发起…" : "开始 OAuth 授权", startOAuth, { primary: true, disabled: flow.busy }));
    } else {
      dialog.append(el("p", "gw-dialog-hint", flow.message || "等待浏览器完成授权…"));
      const link = el("code", "gw-oauth-link", flow.url || "授权链接已生成");
      dialog.append(link);
      const actions = el("div", "gw-inline-actions");
      actions.append(button("打开授权页", () => openExternal("oauth", flow.url), { small: true }));
      actions.append(button("复制链接", () => copy(flow.url), { small: true }));
      dialog.append(actions);
      if (flow.kind === "cp") {
        const callback = input(flow.callback || "", "浏览器未自动回调时，粘贴完整回调 URL", value => { flow.callback = value; });
        dialog.append(callback, button("提交回调", () => submitCallback(callback.value), { small: true, disabled: flow.busy }));
      }
    }
    veil.append(dialog);
    return veil;
  }

  function render() {
    const host = root();
    if (!host || !state.data) return;
    host.replaceChildren();
    const scroll = el("div", "gw-scroll");
    scroll.append(statusBar());
    const content = el("main", "gw-content");
    const message = toast();
    if (message) content.append(message);
    content.append(connectionSection(), upstreamSection(), usageSection());
    scroll.append(content);
    host.append(scroll);
    const dialog = oauthDialog();
    if (dialog) host.append(dialog);
  }

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

  async function saveConnection(kind) {
    await runAction(`connection-${kind}`, "gateway.connectionSave", {
      kind,
      username: state.drafts[`${kind}Username`] ?? "",
      password: state.drafts[`${kind}Password`] || undefined,
      ...(kind === "cp" ? { managementKey: state.drafts.cpManagementKey || undefined } : {}),
    }, "连接信息已保存");
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
    try {
      state.quota = await invoke("gateway.quota");
    } catch (error) {
      state.quota = { ok: false, groups: [], error: errorText(error) };
    } finally {
      state.quotaLoading = false;
    }
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

  async function restart() {
    if (state.actionBusy) return;
    state.actionBusy = "restart";
    render();
    try {
      const result = await invoke("gateway.restart");
      if (!result.ok) throw new Error(result.error || "重启失败");
      state.flash = "网关正在重启";
      setTimeout(() => load(true), 4500);
    } catch (error) { state.error = errorText(error); }
    finally { state.actionBusy = ""; render(); }
  }

  function openOAuth(kind) {
    state.oauth = { kind, provider: kind === "cp" ? "antigravity" : "intl", state: "", url: "", busy: false, message: "", callback: "" };
    render();
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
      flow.message = "授权页已打开，等待完成…";
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
      flow.message = result.message || "等待浏览器完成授权…";
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
      flow.message = "回调已提交，等待确认…";
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
