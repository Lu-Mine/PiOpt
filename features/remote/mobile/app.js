/*
 * The phone page. It talks to one origin (the gateway that served it) and does
 * three things: pair once, list sessions, and read or nudge one session.
 *
 * Everything is textContent, never innerHTML: the transcript is model output
 * and a phone has no way to inspect it.
 */
(function () {
  "use strict";

  const TOKEN_KEY = "piopt.remote.token";
  const NAME_KEY = "piopt.remote.device";

  const el = {
    back: document.getElementById("back"),
    refresh: document.getElementById("refresh"),
    newSession: document.getElementById("new-session"),
    scrim: document.getElementById("scrim"),
    sheet: document.getElementById("sheet"),
    sheetList: document.getElementById("sheet-list"),
    sheetClose: document.getElementById("sheet-close"),
    actions: document.getElementById("actions"),
    actRerun: document.getElementById("act-rerun"),
    actCopy: document.getElementById("act-copy"),
    actCancel: document.getElementById("act-cancel"),
    title: document.getElementById("title"),
    gate: document.getElementById("gate"),
    gateForm: document.getElementById("pair-form"),
    gateError: document.getElementById("gate-error"),
    code: document.getElementById("code"),
    device: document.getElementById("device"),
    list: document.getElementById("list"),
    listError: document.getElementById("list-error"),
    sessions: document.getElementById("sessions"),
    empty: document.getElementById("sessions-empty"),
    main: document.getElementById("main"),
    detail: document.getElementById("detail"),
    placeholder: document.getElementById("placeholder"),
    messages: document.getElementById("messages"),
    pending: document.getElementById("pending"),
    composer: document.getElementById("composer"),
    input: document.getElementById("input"),
    stop: document.getElementById("stop"),
  };

  const state = {
    // Which view is on screen ("gate" / "list" / "detail"), whether the waiting
    // banner has something to say, and whether a flash currently owns the title.
    view: "list",
    pendingVisible: false,
    flashing: false,
    token: "",
    sessions: [],
    sessionId: "",
    sessionTitle: "",
    running: false,
    poll: null,
    stream: null,
    busy: false,
    scrollPinned: true,
    messages: [],
    actionMessage: null,
    sessionProjectPath: "",
    // Which folded blocks the reader opened, keyed by transcript position.
    open: new Set(),
  };

  function readToken() {
    try {
      return window.localStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  }

  function saveToken(token) {
    state.token = token;
    try {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private mode: the session lives in memory only */
    }
  }

  async function call(path, options) {
    const opts = options || {};
    const headers = { Accept: "application/json" };
    if (state.token) headers["x-pi-device"] = state.token;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(path, {
      method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.status === 401) {
      saveToken("");
      showGate("这台设备的授权已失效，请重新配对。");
      throw Object.assign(new Error("unauthorized"), { handled: true });
    }
    if (!response.ok) {
      const message = (payload && (payload.error || payload.message)) || `请求失败 (${response.status})`;
      throw new Error(message);
    }
    return payload || {};
  }

  // ------------------------------------------------------------------ views

  // One place decides what is on screen. A narrow window shows the gate, the
  // list or the transcript one at a time; past 900px the list keeps its column
  // and the transcript fills the rest, so both are visible at once.
  const wideQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(min-width: 900px)")
    : null;

  function isWide() {
    return Boolean(wideQuery && wideQuery.matches);
  }

  function paint() {
    const wideLayout = isWide();
    const view = state.view;
    const inDetail = view === "detail";
    el.gate.hidden = view !== "gate";
    el.list.hidden = view === "gate" || (inDetail && !wideLayout);
    el.main.hidden = view === "gate" || (!wideLayout && !inDetail);
    el.detail.hidden = !inDetail;
    // Only the wide, list-only state has an empty right column; the gate takes
    // the whole window.
    el.placeholder.hidden = !(wideLayout && view === "list");
    el.composer.hidden = !inDetail;
    el.pending.hidden = !(inDetail && state.pendingVisible);
    el.back.hidden = wideLayout || !inDetail;
    // The list never leaves a wide window, so its two buttons stay reachable
    // while a conversation is open; on a phone they belong to the list alone.
    el.refresh.hidden = view === "gate" || (!wideLayout && inDetail);
    el.newSession.hidden = el.refresh.hidden;
    if (!state.flashing) {
      el.title.textContent = view === "gate" ? "PiOpt" : inDetail ? state.sessionTitle || "会话" : "会话";
    }
    markCurrent();
  }

  function markCurrent() {
    for (const button of el.sessions.querySelectorAll("button[data-session-id]")) {
      if (button.dataset.sessionId === state.sessionId) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  }

  function showGate(message) {
    closeStream();
    stopPolling();
    state.view = "gate";
    state.pendingVisible = false;
    paint();
    if (message) {
      el.gateError.textContent = message;
      el.gateError.hidden = false;
    } else {
      el.gateError.hidden = true;
    }
  }

  function showList() {
    state.view = "list";
    state.pendingVisible = false;
    el.listError.hidden = true;
    paint();
  }

  function showDetail() {
    state.view = "detail";
    paint();
  }

  // ------------------------------------------------------------------- list

  function relative(iso) {
    if (!iso) return "";
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return "";
    const diff = Date.now() - time;
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    const date = new Date(time);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function renderSessions(rows) {
    // The stream's snapshots skip the pending probe (it costs a host call per
    // session), so a row that already knew it was waiting keeps that knowledge
    // until the next full load.
    const previous = new Map(state.sessions.map((row) => [row.id, row]));
    state.sessions = rows.map((row) => {
      const old = previous.get(row.id);
      if (!old || row.waiting !== undefined) return row;
      return { ...row, waiting: old.waiting, waitingText: old.waitingText };
    });
    rows = state.sessions;
    el.sessions.replaceChildren();
    if (!rows.length) {
      el.empty.hidden = false;
      return;
    }
    el.empty.hidden = true;
    for (const row of rows) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.addEventListener("click", () => openSession(row.id, row.title));
      button.dataset.sessionId = row.id;

      const head = document.createElement("span");
      head.className = "row-head";
      const title = document.createElement("span");
      title.className = "row-title";
      title.textContent = row.title || "未命名会话";
      head.append(title);
      if (row.waiting) {
        const waiting = document.createElement("span");
        waiting.className = "row-waiting";
        waiting.textContent = "等你回答";
        head.append(waiting);
      } else if (row.running) {
        const running = document.createElement("span");
        running.className = "row-running";
        running.textContent = "运行中";
        head.append(running);
      } else {
        const time = document.createElement("span");
        time.className = "row-time";
        time.textContent = relative(row.updatedAt);
        head.append(time);
      }
      button.append(head);

      if (row.preview) {
        const preview = document.createElement("span");
        preview.className = "row-preview";
        preview.textContent = row.preview;
        button.append(preview);
      }
      if (row.projectName) {
        const project = document.createElement("span");
        project.className = "row-project";
        project.textContent = row.projectName;
        button.append(project);
      }

      li.append(button);
      el.sessions.append(li);
    }
    // The left column stays on screen in a wide window, so the row that is open
    // has to say so.
    markCurrent();
  }

  async function loadSessions() {
    const payload = await call("/api/bootstrap");
    el.listError.hidden = true;
    renderSessions(payload.sessions || []);
  }

  // A phone that paired successfully but cannot read anything is not unpaired:
  // it stays on the list and says what went wrong, so the next attempt is a
  // refresh rather than another round of pairing.
  function showListError(message) {
    showList();
    el.sessions.replaceChildren();
    el.empty.hidden = true;
    el.listError.textContent = message;
    el.listError.hidden = false;
  }

  // A stream keeps the list honest while the phone sits on it: a turn that
  // finishes on the desktop stops saying 运行中 without a manual refresh.
  function openStream() {
    if (state.stream || typeof window.EventSource !== "function") return;
    const source = new EventSource(`/api/stream?token=${encodeURIComponent(state.token)}`);
    source.addEventListener("sessions", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (Array.isArray(payload.sessions)) renderSessions(payload.sessions);
      } catch {
        /* a malformed frame is not worth a page error */
      }
    });
    source.addEventListener("error", () => {
      // EventSource reconnects on its own; a hard 401 is caught by the poll.
      if (source.readyState === 2) closeStream();
    });
    state.stream = source;
  }

  function closeStream() {
    if (state.stream) {
      state.stream.close();
      state.stream = null;
    }
  }

  // ----------------------------------------------------------------- detail

  // The host window draws only the user's message as a bubble; the agent's side
  // is the page itself. The phone does the same: `.bubble` on the right for the
  // user, full-width blocks for everything the agent produced.
  function renderMessages(messages, omitted) {
    const nearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 90;
    el.messages.replaceChildren();
    state.messages = messages;
    // The view always starts at the question the conversation opened with; what it
    // jumped over on the way there is stated once, at the top.
    if (omitted > 0) el.messages.append(mk("div", "omitted", `省略了 ${omitted} 条更早的消息`));
    for (const message of messages) {
      el.messages.append(message.role === "user" ? userTurn(message) : agentTurn(message));
    }
    if (nearBottom || state.scrollPinned) el.messages.scrollTop = el.messages.scrollHeight;
  }

  // `el` above is the element cache; this is the factory the renderers use.
  function mk(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function markdownNode(text) {
    const host = mk("div", "md");
    if (window.PiOptMd) host.append(window.PiOptMd.render(text));
    else host.textContent = text;
    return host;
  }

  function attachmentChip(block) {
    const label = block.mediaKind === "image" ? "图片" : block.mediaKind === "file" ? "文件" : "附件";
    return mk("span", "chip-attachment", `${label} · ${block.name || ""}`);
  }

  function userTurn(message) {
    const bubble = mk("div", "bubble");
    if (message.id) bubble.dataset.messageId = message.id;
    for (const block of message.blocks || []) {
      if (block.kind === "text") bubble.append(markdownNode(block.text));
      else if (block.kind === "attachment") bubble.append(attachmentChip(block));
    }
    if (!bubble.childNodes.length && message.text) bubble.append(markdownNode(message.text));
    return bubble;
  }

  function durationLabel(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
    return `${Math.round(ms / 60_000)} min`;
  }

  // A reply carries the moment it landed, in the reader's own clock: time alone
  // for today, one word for yesterday, a date once it is older than that.
  function timeLabel(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return "";
    const pad = (value) => String(value).padStart(2, "0");
    const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return clock;
    const yesterday = new Date(now.getTime() - 86_400_000);
    if (date.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`;
    const day = `${date.getMonth() + 1}月${date.getDate()}日`;
    return date.getFullYear() === now.getFullYear() ? `${day} ${clock}` : `${date.getFullYear()}年${day} ${clock}`;
  }

  function firstLine(text) {
    const line = String(text || "").trim().split("\n")[0].replace(/\s+/g, " ");
    return line.length > 64 ? `${line.slice(0, 64)}…` : line;
  }

  // Collapsed panels keep their state across the 3 s refresh, keyed by position
  // in the transcript: a re-render must not close what the reader opened.
  function fold(className, key, summaryParts, buildBody) {
    const details = document.createElement("details");
    details.className = `fold ${className}`;
    details.open = state.open.has(key);
    const summary = document.createElement("summary");
    for (const part of summaryParts) summary.append(part);
    details.append(summary);
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.setAttribute("aria-hidden", "true");
    summary.prepend(chevron);
    details.addEventListener("toggle", () => {
      if (details.open) state.open.add(key);
      else state.open.delete(key);
    });
    details.append(buildBody());
    return details;
  }

  function thinkingBlock(block, key) {
    const summary = [
      mk("span", "fold-label", "思考"),
      mk("span", "fold-preview", firstLine(block.text)),
    ];
    return fold("fold-thinking", key, summary, () => {
      const body = mk("div", "fold-body");
      body.append(mk("div", "thinking-text", block.text));
      return body;
    });
  }

  function toolBlock(block, key) {
    const summary = [
      mk("span", "tool-name", block.name || "工具"),
      mk("span", "tool-target", block.summary || ""),
    ];
    const stateLabel = block.isError ? "失败" : durationLabel(block.durationMs);
    if (stateLabel) summary.push(mk("span", `tool-state${block.isError ? " is-error" : ""}`, stateLabel));
    return fold("fold-tool", key, summary, () => {
      const body = mk("div", "fold-body");
      const addPre = (caption, text) => {
        if (!text) return;
        body.append(mk("div", "fold-caption", caption));
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = text;
        pre.append(code);
        body.append(pre);
      };
      addPre("参数", block.args && block.args !== "null" ? block.args : "");
      addPre(block.isError ? "错误" : "结果", block.result || "");
      if (!body.childNodes.length) body.append(mk("div", "fold-empty", "没有可展开的内容"));
      return body;
    });
  }

  function agentTurn(message) {
    const turn = mk("div", "turn");
    if (message.agentName) turn.append(mk("div", "turn-agent", message.agentName));
    (message.blocks || []).forEach((block, index) => {
      const key = `${message.id || message.createdAt || "m"}:${index}`;
      if (block.kind === "text") turn.append(markdownNode(block.text));
      else if (block.kind === "thinking") turn.append(thinkingBlock(block, key));
      else if (block.kind === "tool") turn.append(toolBlock(block, key));
      else if (block.kind === "attachment") turn.append(attachmentChip(block));
    });
    if (!turn.childNodes.length && message.text) turn.append(markdownNode(message.text));
    // Only a reply is stamped; a tool row already carries its duration.
    if (message.role === "assistant") {
      const stamp = timeLabel(message.createdAt);
      if (stamp) turn.append(mk("div", "turn-time", stamp));
    }
    return turn;
  }

  // A turn that stopped to ask something is the one state the phone cannot
  // resolve, so it says so plainly instead of letting the conversation look busy.
  function renderPending(pending) {
    const items = pending && Array.isArray(pending.items) ? pending.items : [];
    el.pending.replaceChildren();
    if (!items.length) {
      state.pendingVisible = false;
      el.pending.hidden = true;
      return;
    }
    const kindName = { ask: "在等你回答", permission: "在等权限确认", plan: "在等批准计划" };
    for (const item of items) {
      const line = document.createElement("p");
      line.className = "pending-line";
      const label = document.createElement("span");
      label.className = "pending-kind";
      label.textContent = kindName[item.kind] || "在等你";
      line.append(label, document.createTextNode(item.text));
      if (Array.isArray(item.options) && item.options.length) {
        const options = document.createElement("span");
        options.className = "pending-options";
        options.textContent = item.options.join(" / ");
        line.append(options);
      }
      el.pending.append(line);
    }
    const hint = document.createElement("p");
    hint.className = "pending-hint";
    hint.textContent = "要在这台电脑上回答。";
    el.pending.append(hint);
    state.pendingVisible = true;
    el.pending.hidden = state.view !== "detail";
  }

  function setRunning(running) {
    state.running = Boolean(running);
    el.stop.hidden = !state.running;
    document.getElementById("input").placeholder = state.running ? "运行中，可以继续追加指令" : "给这个会话发指令";
  }

  async function loadSession() {
    if (!state.sessionId) return;
    const payload = await call(`/api/session/${encodeURIComponent(state.sessionId)}?limit=80`);
    // The list already knows a better title than the single-session call does
    // (that one reports the user-set title, which is usually empty).
    if (payload.session) state.sessionProjectPath = payload.session.projectPath || "";
    if (payload.session && payload.session.title && !state.sessionTitle) {
      state.sessionTitle = payload.session.title;
    }
    if (state.view === "detail" && !state.flashing) el.title.textContent = state.sessionTitle || "会话";
    renderMessages(payload.messages || [], Number(payload.omitted) || 0);
    renderPending(payload.pending);
    setRunning(payload.running);
  }

  function startPolling() {
    stopPolling();
    state.poll = setInterval(() => {
      loadSession().catch((error) => {
        if (error && error.handled) return;
        // A failed poll is not a page failure; the next tick retries.
      });
    }, 3000);
  }

  function stopPolling() {
    if (state.poll) clearInterval(state.poll);
    state.poll = null;
  }

  // ------------------------------------------------------------ new session

  // The host keys a project by its folder, so the choice is a folder or nothing.
  // "临时聊天" is not a special mode: it is the same call without a path.
  function closeOverlays() {
    el.sheet.hidden = true;
    el.actions.hidden = true;
    el.scrim.hidden = true;
    delete document.body.dataset.sheet;
    state.actionMessage = null;
  }

  function sheetRow(name, detail, projectPath) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.append(mk("span", "sheet-name", name));
    if (detail) button.append(mk("span", "sheet-detail", detail));
    button.addEventListener("click", () => {
      createSession(projectPath);
    });
    li.append(button);
    return li;
  }

  // ------------------------------------------------------- message actions

  // Long press a message on a phone; right click is the same thing in a desktop
  // browser. Only the user's own messages have a bubble, so only they get this.
  function messageFromNode(node) {
    const bubble = node && node.closest ? node.closest(".bubble") : null;
    if (!bubble || !bubble.dataset.messageId) return null;
    return state.messages.find((row) => row.id === bubble.dataset.messageId) || null;
  }

  function openActions(message) {
    if (!message || !message.id || state.busy) return;
    state.actionMessage = message;
    el.sheet.hidden = true;
    el.actions.hidden = false;
    el.scrim.hidden = false;
    document.body.dataset.sheet = "open";
  }

  // The whole text of one message: the flat body when the host sent one, else the
  // text blocks it was built from.
  function messageText(message) {
    if (!message) return "";
    if (typeof message.text === "string" && message.text.trim()) return message.text.trim();
    return (message.blocks || [])
      .filter((block) => block.kind === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }

  function forkTitle(title) {
    return `${String(title || "会话").slice(0, 40)} · 重问`;
  }

  // A tool call id is a valid message id, but the host has been picky about cut
  // points; falling back to the nearest non-tool message keeps the same place.
  function lastTextMessage(messages, index) {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const row = messages[cursor];
      if (row.role !== "tool" && row.id) return row;
    }
    return null;
  }

  // 从这里重新问: fork up to the message before this one, then put this one's text
  // back in the composer. The fork keeps the project; the original is untouched.
  async function rerunFrom(message) {
    if (!message || state.busy) return;
    const text = messageText(message);
    const index = state.messages.findIndex((row) => row.id === message.id);
    const before = index > 0 ? state.messages[index - 1] : null;
    closeOverlays();
    state.busy = true;
    el.title.textContent = "正在分叉…";
    try {
      let session = null;
      if (before && before.id) {
        try {
          const payload = await call(`/api/session/${encodeURIComponent(state.sessionId)}/fork`, {
            body: { throughMessageId: before.id, title: forkTitle(state.sessionTitle) },
          });
          session = payload.session;
        } catch (error) {
          if (error && error.handled) return;
          const fallback = lastTextMessage(state.messages, index);
          if (!fallback) throw error;
          const payload = await call(`/api/session/${encodeURIComponent(state.sessionId)}/fork`, {
            body: { throughMessageId: fallback.id, title: forkTitle(state.sessionTitle) },
          });
          session = payload.session;
        }
      } else {
        // Nothing before the opening question: an empty session is the cut.
        const payload = await call("/api/sessions", { body: { projectPath: state.sessionProjectPath || "" } });
        session = payload.session;
      }
      if (!session || !session.id) throw new Error("宿主没有返回会话");
      await loadSessions().catch(() => {});
      await openSession(session.id, session.title || "重问");
      el.input.value = text;
      el.input.dispatchEvent(new Event("input"));
      el.input.focus();
      flash("已回到这条之前，改完发送");
    } catch (error) {
      if (!error.handled) {
        showDetail();
        flash(error && error.message ? error.message : "分叉失败");
      }
    } finally {
      state.busy = false;
    }
  }

  // The page is served over plain http on the LAN — not a secure context — so the
  // clipboard API is usually absent: fall back to the selection copy.
  async function copyMessage(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async function openSheet() {
    if (state.busy) return;
    el.sheetList.replaceChildren();
    el.sheet.hidden = false;
    el.scrim.hidden = false;
    document.body.dataset.sheet = "open";
    el.sheetList.append(sheetRow("临时聊天", "不绑定项目", ""));
    const loading = document.createElement("li");
    loading.className = "sheet-loading";
    loading.textContent = "正在读项目…";
    el.sheetList.append(loading);
    try {
      const payload = await call("/api/projects");
      loading.remove();
      const projects = payload.projects || [];
      if (!projects.length) {
        const empty = document.createElement("li");
        empty.className = "sheet-loading";
        empty.textContent = "这台电脑上还没有项目";
        el.sheetList.append(empty);
      }
      for (const project of projects) {
        el.sheetList.append(sheetRow(project.name, project.path, project.path));
      }
    } catch (error) {
      loading.remove();
      const failed = document.createElement("li");
      failed.className = "sheet-loading";
      failed.textContent = error && error.message ? error.message : "读不到项目列表";
      el.sheetList.append(failed);
    }
  }

  async function createSession(projectPath) {
    if (state.busy) return;
    state.busy = true;
    closeOverlays();
    el.title.textContent = "正在新建…";
    try {
      const payload = await call("/api/sessions", { body: { projectPath } });
      const session = payload.session || {};
      if (!session.id) throw new Error("宿主没有返回会话");
      await loadSessions().catch(() => {});
      await openSession(session.id, session.title || "新会话");
    } catch (error) {
      if (!error.handled) {
        showList();
        showListError(error && error.message ? error.message : "新建会话失败");
      }
    } finally {
      state.busy = false;
    }
  }

  async function openSession(id, title) {
    state.sessionId = id;
    state.sessionTitle = title || "会话";
    state.scrollPinned = true;
    showDetail();
    // The previous session's "waiting on an answer" banner must not survive the
    // switch for the one round trip it takes to load the new one.
    renderPending(null);
    el.messages.replaceChildren();
    await loadSession();
    startPolling();
  }

  async function send() {
    const content = el.input.value.trim();
    if (!content || state.busy) return;
    state.busy = true;
    el.input.value = "";
    el.input.style.height = "";
    try {
      await call(`/api/session/${encodeURIComponent(state.sessionId)}/prompt`, { body: { content } });
      await loadSession();
      // A prompt sent while a turn is active is queued by the host, not dropped.
      if (state.running) flash("已排队，等这一轮结束");
    } catch (error) {
      if (!error.handled) {
        el.input.value = content;
        flash(error.message);
      }
    } finally {
      state.busy = false;
      el.input.focus();
    }
  }

  let flashTimer = null;
  function flash(text) {
    // A flash owns the title bar until it expires; the 3 s poll must not steal
    // it back halfway through the sentence.
    state.flashing = true;
    el.title.textContent = text;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      state.flashing = false;
      el.title.textContent = state.view === "detail" ? state.sessionTitle || "会话" : "会话";
    }, 3200);
  }

  // ------------------------------------------------------------------ wiring

  el.gateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = el.code.value.replace(/\D/g, "");
    if (code.length !== 6) {
      el.gateError.textContent = "配对码是六位数字。";
      el.gateError.hidden = false;
      return;
    }
    const button = el.gateForm.querySelector("button");
    button.disabled = true;
    try {
      const device = el.device.value.trim();
      const payload = await fetch("/api/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name: device }),
      }).then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "配对失败");
        return body;
      });
      saveToken(payload.token);
      try {
        window.localStorage.setItem(NAME_KEY, payload.name || "");
      } catch {
        /* ignore */
      }
      await enterApp();
    } catch (error) {
      el.gateError.textContent = error && error.message ? error.message : "配对失败";
      el.gateError.hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  el.back.addEventListener("click", () => {
    stopPolling();
    state.sessionId = "";
    showList();
    loadSessions().catch(() => {});
  });

  el.newSession.addEventListener("click", () => {
    openSheet();
  });

  el.sheetClose.addEventListener("click", closeOverlays);

  el.actRerun.addEventListener("click", () => {
    rerunFrom(state.actionMessage);
  });

  el.actCopy.addEventListener("click", async () => {
    const message = state.actionMessage;
    closeOverlays();
    if (!message) return;
    const ok = await copyMessage(messageText(message));
    flash(ok ? "已复制" : "复制失败，请手动选择");
  });

  el.actCancel.addEventListener("click", closeOverlays);

  let pressTimer = null;
  const cancelPress = () => {
    if (!pressTimer) return;
    clearTimeout(pressTimer);
    pressTimer = null;
  };
  el.messages.addEventListener(
    "touchstart",
    (event) => {
      const message = messageFromNode(event.target);
      if (!message) return;
      cancelPress();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        openActions(message);
      }, 450);
    },
    { passive: true }
  );
  el.messages.addEventListener("touchend", cancelPress);
  el.messages.addEventListener("touchmove", cancelPress);
  el.messages.addEventListener("touchcancel", cancelPress);
  el.messages.addEventListener("contextmenu", (event) => {
    const message = messageFromNode(event.target);
    if (!message) return;
    event.preventDefault();
    openActions(message);
  });
  el.scrim.addEventListener("click", closeOverlays);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.sheet.hidden) closeOverlays();
  });

  el.refresh.addEventListener("click", () => {
    loadSessions().catch((error) => {
      if (!error.handled) flash(error.message);
    });
  });

  el.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });

  el.input.addEventListener("input", () => {
    el.input.style.height = "auto";
    el.input.style.height = `${Math.min(132, el.input.scrollHeight)}px`;
  });

  el.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });

  el.messages.addEventListener("scroll", () => {
    state.scrollPinned = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80;
  });

  el.stop.addEventListener("click", async () => {
    if (!state.sessionId) return;
    el.stop.disabled = true;
    try {
      await call(`/api/session/${encodeURIComponent(state.sessionId)}/abort`, { body: {} });
      await loadSession();
    } catch (error) {
      if (!error.handled) flash(error.message);
    } finally {
      el.stop.disabled = false;
    }
  });

  async function enterApp() {
    showList();
    await loadSessions();
    openStream();
  }

  // Dragging the window across the 900px line re-lays out both panes without a
  // reload: the same media query that the stylesheet uses decides it.
  if (wideQuery && typeof wideQuery.addEventListener === "function") {
    wideQuery.addEventListener("change", paint);
  }

  async function boot() {
    try {
      state.token = readToken();
    } catch {
      state.token = "";
    }
    if (!state.token) {
      showGate();
      return;
    }
    try {
      await enterApp();
    } catch (error) {
      if (error && error.handled) return;
      showListError(error && error.message ? error.message : "连不上这台电脑");
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
    } else if (state.sessionId) {
      loadSession().catch(() => {});
      startPolling();
    }
  });

  boot();
})();
