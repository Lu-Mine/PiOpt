/*
 * Gateway view: what the gateway speaks, who it signs in as, and how the
 * credit automation is doing. Results only — no raw log panes.
 */
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
    runningCredits: false,
    error: "",
    flash: "",
    egressBusy: false,
    egressPick: "",
  };

  const T = {
    running: "运行中",
    stopped: "未运行",
    pid: "守护进程",
    uptime: "已运行",
    manager: "执行器",
    self: "本会话管理",
    other: "其他实例持有",
    refresh: "刷新",
    restart: "重启网关",
    protocols: "协议转换",
    protocolsHint: "客户端用任意一种协议都能接入",
    quota: "额度概览",
    models: "可用模型",
    accounts: "账号",
    keys: "客户端密钥",
    upstreams: "上游接入",
    apiKeys: "API Key",
    credits: "WorkBuddy 积分自动化",
    runCredits: "立即跑积分",
    running2: "执行中…",
    lastRun: "上次运行",
    earned: "本次获得",
    claimed: "领取任务",
    none: "暂无记录",
    actions: "最近动作",
    noActions: "还没有积分动作",
    loadFail: "读取网关数据失败",
    plugin: "插件",
    oauth: "OAuth",
    compat: "兼容上游",
  };

  function invoke(channel, payload) {
    if (!bridge || typeof bridge.invoke !== "function") {
      return Promise.reject(new Error("plugin bridge 不可用"));
    }
    return bridge.invoke(channel, payload);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function fmtUptime(s) {
    const n = Number(s) || 0;
    if (n < 60) return `${n} 秒`;
    if (n < 3600) return `${Math.floor(n / 60)} 分`;
    return `${Math.floor(n / 3600)} 时 ${Math.floor((n % 3600) / 60)} 分`;
  }

  function fmtNum(n) {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 1000) {
      return v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
    }
    return String(Math.round(v * 100) / 100);
  }

  function fmtClock(iso) {
    const m = String(iso || "").match(/T(\d{2}:\d{2})/);
    return m ? m[1] : "";
  }

  function fmtDuration(seconds) {
    const n = Number(seconds) || 0;
    if (n <= 0) return "";
    if (n < 3600) return `${Math.ceil(n / 60)} 分`;
    const h = n / 3600;
    return h >= 10 ? `${Math.round(h)} 小时` : `${h.toFixed(1)} 小时`;
  }
  function card(title, opts = {}) {
    const box = el("div", "gw-card" + (opts.wide ? " gw-card-wide" : ""));
    const head = el("div", "gw-card-head");
    head.append(el("b", "", title));
    if (opts.badge !== undefined) head.append(el("span", "gw-count", String(opts.badge)));
    if (opts.action) head.append(opts.action);
    box.append(head);
    if (opts.hint) box.append(el("p", "gw-hint", opts.hint));
    return box;
  }

  function metricRow(pairs) {
    const wrap = el("div", "gw-metrics");
    for (const [k, v, tone] of pairs) {
      const cell = el("div", "gw-metric");
      if (tone) cell.dataset.tone = tone;
      cell.append(el("span", "gw-metric-v", v));
      cell.append(el("span", "gw-metric-k", k));
      wrap.append(cell);
    }
    return wrap;
  }

  // ------------------------------------------------------------ 各区块

  function statusBar() {
    const st = state.status;
    const live = Boolean(st && st.ok);
    const bar = el("div", "gw-bar");
    const dot = el("i", "gw-dot");
    dot.dataset.live = String(live);
    bar.append(dot, el("b", "", live ? T.running : T.stopped));
    const meta = el("span", "gw-bar-meta");
    const bits = [];
    if (st && st.supervisor) bits.push(`${T.pid} ${st.supervisor.pid}`);
    if (st && st.supervisor) bits.push(`${T.uptime} ${fmtUptime(st.supervisor.uptimeSeconds)}`);
    if (st) bits.push(st.manager ? T.self : T.other);
    meta.textContent = bits.join(" · ");
    bar.append(meta);

    const actions = el("div", "gw-bar-actions");
    const rf = el("button", "gw-btn", T.refresh);
    rf.type = "button";
    rf.addEventListener("click", () => load(true));
    const rs = el("button", "gw-btn", T.restart);
    rs.type = "button";
    rs.addEventListener("click", restart);
    actions.append(rf, rs);
    bar.append(actions);
    return bar;
  }

  function protocolCard() {
    const box = card(T.protocols, { hint: T.protocolsHint });
    const list = el("div", "gw-proto-list");
    for (const p of (state.data && state.data.protocols) || []) {
      const row = el("div", "gw-proto");
      row.append(el("span", "gw-proto-name", p.label));
      row.append(el("code", "gw-proto-path", p.path));
      row.append(el("span", "gw-proto-note", p.note));
      list.append(row);
    }
    box.append(list);
    return box;
  }

  function quotaCard() {
    const d = state.data || {};
    const q = d.quota || {};
    const box = card(T.quota);

    if (q.ok) {
      const unit = q.unit === "credits" ? "积分" : (q.unit || "积分");
      box.append(metricRow([
        ["剩余" + unit, fmtNum(q.remain), "accent"],
        ["总" + unit, fmtNum(q.capacity)],
        ["已用", fmtNum(q.used)],
        ["可用模型", (d.models && d.models.total) || 0],
      ]));

      const groupList = q.groups || [];
      if (groupList.length) {
        const list = el("div", "gw-quota-list");
        for (const g of groupList) {
          const row = el("div", "gw-quota-row");
          row.append(el("span", "gw-quota-name", g.name || g.kind || "—"));
          const pct = g.total > 0 ? Math.max(0, Math.min(100, (g.remain / g.total) * 100)) : 0;
          const track = el("div", "gw-qbar");
          const fill = el("div", "gw-qbar-fill");
          fill.style.width = pct.toFixed(1) + "%";
          fill.dataset.level = pct <= 5 ? "empty" : pct <= 25 ? "low" : "ok";
          track.append(fill);
          row.append(track);
          row.append(el("span", "gw-quota-num", `${fmtNum(g.remain)} / ${fmtNum(g.total)}`));
          list.append(row);
        }
        box.append(list);
      }

      const facts = [];
      if (q.tier) facts.push(`档位 ${q.tier}${q.paid ? "（付费）" : "（免费）"}`);
      if (q.checkin) {
        const ci = q.checkin;
        facts.push(`签到${ci.today_checked_in ? "已签" : "未签"} · 连登 ${ci.streak_days || 0} 天`);
      }
      const clock = fmtClock(q.updatedAt);
      if (clock) facts.push(`更新于 ${clock}`);
      if (facts.length) box.append(el("p", "gw-hint", facts.join(" · ")));
      return box;
    }

    // 兜底：快照还没写出来时只给计数，并说明原因
    const m = d.models;
    const modelGroups = (m && m.groups) || {};
    const pairs = [[T.models, m ? m.total : 0, "accent"]];
    for (const [owner, ids] of Object.entries(modelGroups)) pairs.push([owner, ids.length]);
    pairs.push([T.accounts, (d.upstreams || []).filter(u => u.kind === "oauth").length]);
    box.append(metricRow(pairs));
    box.append(el("p", "gw-hint", q.hint || "余额快照尚未生成，插件启动约 20 秒后可用。"));
    return box;
  }

  function antigravityCard() {
    const d = state.data || {};
    const ag = d.antigravity || {};
    const list = ag.accounts || [];
    const box = card("Antigravity 配额", { wide: true, badge: list.length });

    if (!list.length) {
      box.append(el("p", "gw-hint", "没有 Antigravity 账号"));
      return box;
    }
    box.append(metricRow([
      ["账号", ag.total || list.length, "accent"],
      ["可用", ag.active || 0],
      ["冷却中模型", ag.cooling || 0],
      ["每账号模型", ag.modelCount || 0],
    ]));

    // 1. 各 Group 全局综合限额（所有账号总和与平均）
    const aggGroups = ag.aggregateGroups || [];
    if (aggGroups.length) {
      const aggBox = el("div", "gw-ag-agg");
      aggBox.append(el("div", "gw-ag-section-title", "各分组总体限额（所有账号综合）"));
      const aggList = el("div", "gw-quota-list");
      for (const g of aggGroups) {
        const row = el("div", "gw-quota-row");
        row.append(el("span", "gw-quota-name", g.name));
        const track = el("div", "gw-qbar");
        const fill = el("div", "gw-qbar-fill");
        // 以 5 小时限额为主要显示，若无 5 小时则以周限额
        const pct = g.fiveHourAvg !== null ? g.fiveHourAvg : (g.weeklyAvg || 0);
        fill.style.width = pct + "%";
        fill.dataset.level = pct <= 5 ? "empty" : pct <= 25 ? "low" : "ok";
        track.append(fill);
        row.append(track);
        const metaTxt = [];
        if (g.fiveHourAvg !== null) metaTxt.push(`5h: ${g.fiveHourAvg}%`);
        if (g.weeklyAvg !== null) metaTxt.push(`周: ${g.weeklyAvg}%`);
        row.append(el("span", "gw-quota-num", metaTxt.join(" · ")));
        aggList.append(row);
      }
      aggBox.append(aggList);
      box.append(aggBox);
    }

    // 2. 账号明细列表（包含各账号独立 Group 配额与冷却状态）
    const table = el("div", "gw-ag-list");
    for (const a of list) {
      const cardItem = el("div", "gw-ag-item");
      const row = el("div", "gw-ag-row");
      const head = el("div", "gw-ag-head");
      const dot = el("i", "gw-ag-dot");
      dot.dataset.state = a.unavailable ? "bad" : a.status === "active" ? "ok" : "idle";
      head.append(dot);
      head.append(el("span", "gw-ag-mail", a.email));
      row.append(head);
      row.append(el("span", "gw-ag-stat",
        `${a.modelCount || 0} 模型 · ${a.success} 成功${a.windowFailed ? ` / ${a.windowFailed} 失败` : ""}`));
      const cd = el("div", "gw-ag-cd");
      if (!a.cooldowns.length) {
        cd.append(el("span", "gw-ag-ok", "无冷却"));
      } else {
        for (const c of a.cooldowns) {
          const chip = el("span", "gw-ag-chip");
          chip.append(el("b", "", c.model || "模型"));
          const left = fmtDuration(c.seconds);
          chip.append(document.createTextNode(`${left ? ` · ${left}后恢复` : ""}`));
          cd.append(chip);
        }
      }
      row.append(cd);
      cardItem.append(row);

      // 单账号各 Group 进度条
      if (Array.isArray(a.groups) && a.groups.length) {
        const acctQuotaList = el("div", "gw-quota-list gw-ag-quota-sub");
        for (const g of a.groups) {
          const qrow = el("div", "gw-quota-row");
          qrow.append(el("span", "gw-quota-name", g.name));
          const track = el("div", "gw-qbar");
          const fill = el("div", "gw-qbar-fill");
          const pct = g.fiveHour ? g.fiveHour.percent : (g.weekly ? g.weekly.percent : 0);
          fill.style.width = pct + "%";
          fill.dataset.level = pct <= 5 ? "empty" : pct <= 25 ? "low" : "ok";
          track.append(fill);
          qrow.append(track);
          const mParts = [];
          if (g.fiveHour) mParts.push(`5h: ${g.fiveHour.percent}%`);
          if (g.weekly) mParts.push(`周: ${g.weekly.percent}%`);
          qrow.append(el("span", "gw-quota-num", mParts.join(" · ")));
          acctQuotaList.append(qrow);
        }
        cardItem.append(acctQuotaList);
      }

      table.append(cardItem);
    }
    box.append(table);
    return box;
  }

  // Clash 出口：选哪个节点/组给 Google 域用
  function egressCard() {
    const d = state.data || {};
    const e = d.egress || {};
    const nodes = e.nodes || [];
    const groups = e.groups || [];
    const box = card("Clash 出口", { wide: true, badge: nodes.length });

    if (!e.profile) {
      box.append(el("p", "gw-hint", "没找到 Clash 订阅（已扫描常见安装位置）"));
      return box;
    }

    const row = el("div", "gw-eg-row");
    row.append(el("span", "gw-eg-label", "出口"));

    const sel = el("select", "gw-eg-select");
    const current = state.egressPick || e.selected || "";
    const addGroup = (title, items) => {
      if (!items.length) return;
      const og = document.createElement("optgroup");
      og.label = title;
      for (const it of items) {
        const o = document.createElement("option");
        o.value = it;
        o.textContent = it;
        if (it === current) o.selected = true;
        og.append(o);
      }
      sel.append(og);
    };
    addGroup("代理组", groups);
    addGroup("单个节点", nodes);

    const apply = el("button", "gw-btn gw-btn-primary", state.egressBusy ? "切换中…" : "应用");
    apply.type = "button";
    apply.disabled = Boolean(state.egressBusy);
    apply.addEventListener("click", () => pickEgress(sel.value));

    row.append(sel, apply);
    box.append(row);

    box.append(el("p", "gw-hint", `订阅 ${e.profile}`));
    if (e.binPath) box.append(el("p", "gw-hint", `内核 ${e.binPath}`));

    const st = e.status || {};
    if (st.ok) {
      box.append(el("p", "gw-hint", `运行中：出口「${st.dialer}」，本地端口 ${st.port}，仅 Google/AI 域名走它。`));
    } else if (st.reason) {
      box.append(el("p", "gw-hint", `未启用：${st.reason}`));
    }
    return box;
  }

  function upstreamCard() {
    const d = state.data || {};
    const list = (d.upstreams || []);
    const box = card(T.upstreams, { wide: true, badge: list.length });
    if (!list.length) {
      box.append(el("p", "gw-hint", "没有配置任何上游"));
      return box;
    }
    const table = el("div", "gw-table");
    for (const u of list) {
      const row = el("div", "gw-tr");
      const kind = el("span", "gw-tag", u.kind === "plugin" ? T.plugin : u.kind === "oauth" ? T.oauth : T.compat);
      kind.dataset.kind = u.kind;
      const name = el("div", "gw-td-name");
      name.append(el("b", "", u.name));
      const sub = [];
      if (u.account) sub.push(u.account);
      if (u.version) sub.push(`v${u.version}`);
      if (u.projectId) sub.push(`项目 ${u.projectId}`);
      if (u.detail) sub.push(u.detail);
      if (u.models) sub.push(`${u.models} 个模型`);
      if (u.lastRefresh) sub.push(`刷新于 ${u.lastRefresh.slice(11, 19)}`);
      if (sub.length) name.append(el("span", "gw-td-sub", sub.join(" · ")));

      const stateTag = el("span", "gw-state");
      stateTag.dataset.on = String(Boolean(u.enabled));
      stateTag.textContent = u.enabled ? (u.failed ? `启用（失败 ${u.failed}）` : "启用") : "已停用";

      row.append(kind, name, stateTag);
      table.append(row);
    }
    box.append(table);
    return box;
  }

  function apiKeyCard() {
    const keys = (state.data && state.data.clientKeys) || [];
    const box = card(T.apiKeys, { badge: keys.length });
    if (!keys.length) {
      box.append(el("p", "gw-hint", "没有配置客户端密钥"));
      return box;
    }
    const list = el("div", "gw-keys");
    for (const k of keys) {
      const row = el("div", "gw-key");
      row.append(el("code", "", k.mask));
      row.append(el("span", "gw-key-len", `${k.length} 字符`));
      list.append(row);
    }
    box.append(list);
    box.append(el("p", "gw-hint", "客户端用这些密钥访问 /v1/*，可在管理面板新增或禁用。"));
    return box;
  }

  function creditsCard() {
    const c = (state.data && state.data.credits) || { ok: false };
    const btn = el("button", "gw-btn gw-btn-primary", state.runningCredits ? T.running2 : T.runCredits);
    btn.type = "button";
    btn.disabled = state.runningCredits;
    btn.addEventListener("click", runCredits);

    const box = card(T.credits, { wide: true, action: btn });
    if (!c.ok) {
      box.append(el("p", "gw-hint", c.hint || T.none));
      return box;
    }
    box.append(
      metricRow([
        [T.lastRun, c.lastRunAt ? c.lastRunAt.slice(6) : "—"],
        [T.earned, `+${c.earned}`, c.earned > 0 ? "good" : ""],
        [T.claimed, c.claimed],
      ])
    );

    const acts = el("div", "gw-acts");
    acts.append(el("span", "gw-acts-title", T.actions));
    if (!c.recent || !c.recent.length) {
      acts.append(el("span", "gw-hint", T.noActions));
    } else {
      const ul = el("ul", "gw-act-list");
      for (const a of c.recent) {
        const li = el("li", "gw-act");
        li.append(el("span", "gw-act-time", a.at.slice(6)));
        li.append(el("span", "gw-act-text", a.text));
        ul.append(li);
      }
      acts.append(ul);
    }
    box.append(acts);
    box.append(el("p", "gw-hint", "定时 09:00 / 21:00 自动执行；按钮会插队跑一轮。"));
    return box;
  }

  function modelsCard() {
    const m = state.data && state.data.models;
    const groups = (m && m.groups) || {};
    const box = card(T.models, { wide: true, badge: m ? m.total : 0 });
    for (const [owner, ids] of Object.entries(groups)) {
      const g = el("div", "gw-group");
      const title = el("div", "gw-group-title");
      title.append(el("span", "gw-owner", owner), el("span", "gw-count", String(ids.length)));
      g.append(title);
      const chips = el("div", "gw-models");
      for (const id of ids) chips.append(el("code", "gw-model", id));
      g.append(chips);
      box.append(g);
    }
    if (!Object.keys(groups).length) box.append(el("p", "gw-hint", "没有模型数据"));
    return box;
  }

  function render() {
    const host = root();
    if (!host) return;
    host.querySelectorAll(".gw-body").forEach(n => n.remove());

    const body = el("div", "gw-body");
    if (state.flash) {
      const ok = el("div", "gw-flash", state.flash);
      body.append(ok);
    }
    if (state.error) {
      const err = el("div", "opt-error");
      err.textContent = state.error;
      body.append(err);
    }
    for (const msg of (state.data && state.data.errors) || []) {
      const w = el("div", "gw-warn", msg);
      body.append(w);
    }

    body.append(statusBar());

    const top = el("div", "gw-top");
    top.append(protocolCard(), quotaCard());
    body.append(top);
    body.append(upstreamCard());

    body.append(egressCard());
    body.append(antigravityCard());
    body.append(apiKeyCard());
    body.append(creditsCard());
    body.append(modelsCard());

    host.append(body);
  }

  // ------------------------------------------------------------- 动作

  async function load(manual) {
    if (state.busy) return;
    state.busy = true;
    const host = root();
    if (manual && host) host.dataset.loading = "true";
    try {
      const [status, data] = await Promise.all([
        invoke("gateway.status").catch(e => ({ ok: false, error: String(e) })),
        invoke("gateway.overview").catch(e => ({ ok: false, errors: [String(e)] })),
      ]);
      state.status = status;
      state.data = data;
      state.error = "";
    } catch (error) {
      state.error = `${T.loadFail}：${(error && error.message) || error}`;
    } finally {
      state.busy = false;
      if (host) delete host.dataset.loading;
      render();
    }
  }

  async function restart() {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await invoke("gateway.restart");
      state.flash = "重启已下发，正在等待端口就绪…";
    } catch (error) {
      state.error = `重启失败：${(error && error.message) || error}`;
    } finally {
      state.busy = false;
      const timer = setTimeout(() => {
        state.flash = "";
        load(true);
      }, 4500);
    }
  }

  async function runCredits() {
    state.runningCredits = true;
    render();
    try {
      const res = await invoke("gateway.runCredits");
      if (!res || !res.ok) throw new Error((res && res.error) || "触发失败");
      state.flash = "已排队，最多 20 秒后完成；下面会自动刷新结果。";
      state.error = "";
    } catch (error) {
      state.error = `触发积分失败：${(error && error.message) || error}`;
      state.runningCredits = false;
      render();
      return;
    }
    setTimeout(async () => {
      await load(false);
      state.runningCredits = false;
      render();
    }, 22000);
  }
  // 完整复检出海通道：真起一次内核确认能穿出去
  // 切换出口：写偏好 → 重建配置 → 重启网关
  async function pickEgress(name) {
    if (!name || state.egressBusy) return;
    state.egressBusy = true;
    state.egressPick = name;
    state.flash = "";
    state.error = "";
    render();
    try {
      const res = await invoke("gateway.egressPick", { dialer: name });
      const st = (res && res.status) || {};
      if (st.ok) {
        state.flash = `已切到「${st.dialer}」，网关正在重启。`;
      } else {
        state.error = `切换失败：${st.reason || "未知原因"}`;
      }
    } catch (error) {
      state.error = `切换失败：${(error && error.message) || error}`;
    } finally {
      state.egressBusy = false;
      setTimeout(async () => {
        await load(false);
        render();
      }, 3000);
    }
  }

  function boot() {
    if (state.booted) return;
    state.booted = true;
    load(true);
    state.timer = setInterval(() => {
      const host = root();
      if (host && !host.hidden) load(false);
    }, 45000);
  }

  window.PiOptGateway = { boot, _state: state, _load: load };
})();
