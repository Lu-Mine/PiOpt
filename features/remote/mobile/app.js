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
  const COLLAPSED_KEY = "piopt.remote.collapsed";
  const LIST_WIDTH_KEY = "piopt.remote.listWidth";
  const LIST_WIDTH_MIN = 220;
  const LIST_WIDTH_MAX = 600;
  const LIST_WIDTH_DEFAULT = 316;
  const DETAIL_WIDTH_MIN = 400;

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
    resizer: document.getElementById("list-resizer"),
    sessions: document.getElementById("sessions"),
    empty: document.getElementById("sessions-empty"),
    main: document.getElementById("main"),
    detail: document.getElementById("detail"),
    placeholder: document.getElementById("placeholder"),
    messages: document.getElementById("messages"),
    progress: document.getElementById("progress"),
    progressElapsed: document.getElementById("progress-elapsed"),
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
    // How many earlier messages the reader is skipping, so a redraw can keep
    // saying so.
    omitted: 0,
    // When the turn now being watched started, and the 1 s counter that keeps
    // 正在处理 3s moving without rebuilding the transcript.
    runningSince: 0,
    progressTimer: null,
    // Project groups the reader folded shut, keyed by folder path.
    collapsed: readCollapsed(),
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

  // Keep the preferred width separate from the viewport-clamped width so a
  // temporarily narrow window does not overwrite the reader's choice.
  let preferredListWidth = LIST_WIDTH_DEFAULT;
  try {
    const saved = Number(window.localStorage.getItem(LIST_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= LIST_WIDTH_MIN && saved <= LIST_WIDTH_MAX) preferredListWidth = saved;
  } catch { /* storage may be unavailable */ }

  function listWidthLimit() {
    return Math.max(LIST_WIDTH_MIN, Math.min(LIST_WIDTH_MAX, window.innerWidth - DETAIL_WIDTH_MIN));
  }

  function applyListWidth() {
    const max = listWidthLimit();
    const width = Math.round(Math.max(LIST_WIDTH_MIN, Math.min(max, preferredListWidth)));
    document.documentElement.style.setProperty("--list-w", `${width}px`);
    el.resizer.setAttribute("aria-valuemax", String(max));
    el.resizer.setAttribute("aria-valuenow", String(width));
    el.resizer.setAttribute("aria-valuetext", `${width} 像素`);
    return width;
  }

  function setListWidth(width) {
    preferredListWidth = Math.round(Math.max(LIST_WIDTH_MIN, Math.min(listWidthLimit(), width)));
    applyListWidth();
    try { window.localStorage.setItem(LIST_WIDTH_KEY, String(preferredListWidth)); } catch { /* memory only */ }
  }

  let resizePointer = null;
  el.resizer.addEventListener("pointerdown", (event) => {
    if (!isWide() || event.button !== 0) return;
    event.preventDefault();
    resizePointer = { id: event.pointerId, startX: event.clientX, width: applyListWidth() };
    el.resizer.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-list");
  });
  el.resizer.addEventListener("pointermove", (event) => {
    if (resizePointer && event.pointerId === resizePointer.id) {
      setListWidth(resizePointer.width + event.clientX - resizePointer.startX);
    }
  });
  function finishListResize(event) {
    if (!resizePointer || event.pointerId !== resizePointer.id) return;
    resizePointer = null;
    document.body.classList.remove("resizing-list");
    if (el.resizer.hasPointerCapture(event.pointerId)) el.resizer.releasePointerCapture(event.pointerId);
  }
  el.resizer.addEventListener("pointerup", finishListResize);
  el.resizer.addEventListener("pointercancel", finishListResize);
  el.resizer.addEventListener("lostpointercapture", finishListResize);
  el.resizer.addEventListener("dblclick", () => setListWidth(LIST_WIDTH_DEFAULT));
  el.resizer.addEventListener("keydown", (event) => {
    const current = applyListWidth();
    let next;
    if (event.key === "ArrowLeft") next = current - (event.shiftKey ? 50 : 10);
    else if (event.key === "ArrowRight") next = current + (event.shiftKey ? 50 : 10);
    else if (event.key === "Home") next = LIST_WIDTH_MIN;
    else if (event.key === "End") next = listWidthLimit();
    else return;
    event.preventDefault();
    setListWidth(next);
  });
  window.addEventListener("resize", applyListWidth);
  applyListWidth();

  function paint() {
    const wideLayout = isWide();
    const view = state.view;
    const inDetail = view === "detail";
    el.gate.hidden = view !== "gate";
    el.list.hidden = view === "gate" || (inDetail && !wideLayout);
    el.resizer.hidden = view === "gate" || !wideLayout;
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
    syncProgress();
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

  // ------------------------------------------------------------- the list

  function readCollapsed() {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return new Set(Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : []);
    } catch {
      return new Set();
    }
  }

  function saveCollapsed() {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...state.collapsed]));
    } catch {
      /* private mode: the set lives in memory only */
    }
  }

  // The list is a folder, not a pile: a session belongs to the project it was
  // started in, and everything without one is 临时会话. Groups are ordered by the
  // newest session inside them, which is the order the host already gave the rows.
  const TEMP_GROUP = "~temp";

  function groupSessions(rows) {
    const groups = new Map();
    for (const row of rows) {
      const path = row.projectPath || "";
      const key = path || TEMP_GROUP;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          name: path ? row.projectName || path.split(/[\\/]/).filter(Boolean).pop() || "项目" : "临时会话",
          latest: "",
          rows: [],
        };
        groups.set(key, group);
      }
      group.rows.push(row);
      const stamp = String(row.updatedAt || "");
      if (stamp > group.latest) group.latest = stamp;
    }
    // 临时会话 is not a folder, so it does not compete on recency: it stays on top,
    // where the ＋ button drops a new conversation that belongs to no project.
    return [...groups.values()].sort((a, b) => {
      if (a.key === TEMP_GROUP) return -1;
      if (b.key === TEMP_GROUP) return 1;
      return b.latest.localeCompare(a.latest);
    });
  }

  // Local Lucide icons distinguish temporary conversations from project folders.
  function groupNode(group) {
    const li = mk("li", "session-group");
    const collapsed = state.collapsed.has(group.key);

    const head = mk("button", "group-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(!collapsed));
    head.append(mk("span", group.key === TEMP_GROUP ? "group-mark group-mark--temporary" : "group-mark group-mark--folder"));
    head.append(mk("span", "group-name", group.name));
    head.append(mk("span", "group-arrow"));

    const rows = mk("ul", "group-rows");
    rows.hidden = collapsed;
    for (const row of group.rows) rows.append(sessionItem(row));

    head.addEventListener("click", () => {
      const opening = rows.hidden;
      rows.hidden = !opening;
      head.setAttribute("aria-expanded", String(opening));
      if (opening) state.collapsed.delete(group.key);
      else state.collapsed.add(group.key);
      saveCollapsed();
    });

    li.append(head, rows);
    return li;
  }

  // One session row. The project name is no longer repeated here: the group above
  // it already says which folder this is.
  function sessionItem(row) {
    const li = mk("li", "session-row");
    const button = document.createElement("button");
    button.type = "button";
    button.addEventListener("click", () => openSession(row.id, row.title));
    button.dataset.sessionId = row.id;

    const head = mk("span", "row-head");
    head.append(mk("span", "row-title", row.title || "未命名会话"));
    head.append(rowStatus(row));
    button.append(head);
    if (row.preview) button.append(mk("span", "row-preview", row.preview));
    li.append(button);
    return li;
  }

  // One status per row: a question outranks a running turn, and a quiet session
  // shows when it was last touched.
  function rowStatus(row) {
    if (row.waiting) return mk("span", "row-waiting", "等你回答");
    if (row.running) return mk("span", "row-running", "运行中");
    return mk("span", "row-time", relative(row.updatedAt));
  }

  // The transcript learns about a turn within a second; the list's own snapshot
  // arrives every 2.5 s. The row's lamp follows the transcript instead of waiting
  // for the next snapshot.
  function syncListRunning(sessionId, running) {
    const row = state.sessions.find((item) => item.id === sessionId);
    if (!row || row.waiting === true) return;
    row.running = running;
    for (const button of el.sessions.querySelectorAll("button[data-session-id]")) {
      if (button.dataset.sessionId !== sessionId) continue;
      const head = button.querySelector(".row-head");
      const current = head && head.querySelector(".row-running, .row-waiting, .row-time");
      if (!current) return;
      const next = rowStatus(row);
      if (next.className === current.className) return;
      current.replaceWith(next);
      return;
    }
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
    for (const group of groupSessions(rows)) el.sessions.append(groupNode(group));
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
  function renderMessages(messages, omitted, running) {
    const nearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 90;
    el.messages.replaceChildren();
    state.messages = messages;
    // The view always starts at the question the conversation opened with; what it
    // jumped over on the way there is stated once, at the top.
    if (omitted > 0) el.messages.append(mk("div", "omitted", `省略了 ${omitted} 条更早的消息`));
    state.omitted = omitted;
    for (const [index, message] of messages.entries()) {
      const next = messages[index + 1];
      // A turn ends at the user's next message, or at the end of the transcript
      // once nothing is running. Only that reply carries a clock: stamping every
      // agent message would put a timestamp under each step of one turn.
      const endsTurn = next ? next.role === "user" : !running;
      el.messages.append(message.role === "user" ? userTurn(message) : agentTurn(message, endsTurn));
    }
    // The counter sits at the very end of the transcript, so it has to be put
    // back after every re-render.
    syncProgress();
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

  function agentTurn(message, endsTurn) {
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
    // Only the reply that closes a turn is stamped: a tool row already carries
    // its duration, and the steps in between need no clock of their own.
    if (endsTurn && message.role === "assistant" && turn.childNodes.length) {
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
      syncProgress();
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
    syncProgress();
  }

  function setRunning(running) {
    const busy = Boolean(running);
    const was = state.running;
    if (busy && !state.runningSince) state.runningSince = turnStart();
    if (!busy) state.runningSince = 0;
    state.running = busy;
    el.stop.hidden = !busy;
    document.getElementById("input").placeholder = busy ? "运行中，可以继续追加指令" : "给这个会话发指令";
    if (busy) startProgressTimer();
    else stopProgressTimer();
    // The last reply gains its clock the moment the turn ends, rather than a poll
    // later; nothing else here depends on the redraw.
    if (was !== busy) renderMessages(state.messages, state.omitted, busy);
    syncProgress();
    syncListRunning(state.sessionId, busy);
  }

  // A turn begins at the prompt that started it. That prompt's own timestamp is
  // the closest thing the page has — but only while it is recent: a transcript
  // can still be holding this morning's question.
  function turnStart() {
    const now = Date.now();
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      const message = state.messages[index];
      if (message.role !== "user") continue;
      const stamp = message.createdAt ? Date.parse(message.createdAt) : NaN;
      if (Number.isFinite(stamp) && stamp <= now && now - stamp < 15 * 60_000) return stamp;
      break;
    }
    return now;
  }

  // ------------------------------------------------------- a turn in flight

  function elapsedLabel(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    if (total < 60) return `${total}s`;
    return `${Math.floor(total / 60)}m ${total % 60}s`;
  }

  // The counter belongs at the end of the transcript while a turn runs, and
  // disappears while the turn is stopped on a question — that state has its own
  // banner, and a running clock beside it would be a lie.
  function syncProgress() {
    const visible = state.running && !state.pendingVisible && state.view === "detail";
    if (!visible) {
      el.progress.hidden = true;
      // Keep the node in the document: it comes back with the next turn, but a
      // detached counter could not be found by anything in between.
      if (!el.progress.isConnected) document.body.append(el.progress);
      return;
    }
    paintProgressElapsed();
    el.progress.hidden = false;
    el.messages.append(el.progress);
  }

  function paintProgressElapsed() {
    el.progressElapsed.textContent = elapsedLabel(Date.now() - (state.runningSince || Date.now()));
  }

  function startProgressTimer() {
    if (state.progressTimer) return;
    state.progressTimer = setInterval(paintProgressElapsed, 1000);
  }

  function stopProgressTimer() {
    if (state.progressTimer) clearInterval(state.progressTimer);
    state.progressTimer = null;
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
    renderMessages(payload.messages || [], Number(payload.omitted) || 0, Boolean(payload.running));
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
    // Nothing about the previous session's turn carries over: a new clock, and no
    // counter until this one says it is running.
    state.running = false;
    state.runningSince = 0;
    stopProgressTimer();
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
      // Nobody can read a counter in a background tab.
      stopProgressTimer();
    } else if (state.sessionId) {
      loadSession().catch(() => {});
      startPolling();
      if (state.running) startProgressTimer();
    }
  });

  boot();
})();
