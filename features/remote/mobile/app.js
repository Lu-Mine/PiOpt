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
    title: document.getElementById("title"),
    gate: document.getElementById("gate"),
    gateForm: document.getElementById("pair-form"),
    gateError: document.getElementById("gate-error"),
    code: document.getElementById("code"),
    device: document.getElementById("device"),
    list: document.getElementById("list"),
    sessions: document.getElementById("sessions"),
    empty: document.getElementById("sessions-empty"),
    detail: document.getElementById("detail"),
    messages: document.getElementById("messages"),
    pending: document.getElementById("pending"),
    composer: document.getElementById("composer"),
    input: document.getElementById("input"),
    stop: document.getElementById("stop"),
  };

  const state = {
    token: "",
    sessions: [],
    sessionId: "",
    sessionTitle: "",
    running: false,
    poll: null,
    stream: null,
    busy: false,
    scrollPinned: true,
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
      showGate("这台手机的授权已失效，请重新配对。");
      throw Object.assign(new Error("unauthorized"), { handled: true });
    }
    if (!response.ok) {
      const message = (payload && (payload.error || payload.message)) || `请求失败 (${response.status})`;
      throw new Error(message);
    }
    return payload || {};
  }

  // ------------------------------------------------------------------ views

  function showGate(message) {
    closeStream();
    stopPolling();
    el.gate.hidden = false;
    el.list.hidden = true;
    el.detail.hidden = true;
    el.composer.hidden = true;
    el.back.hidden = true;
    el.refresh.hidden = true;
    el.title.textContent = "PiOpt";
    if (message) {
      el.gateError.textContent = message;
      el.gateError.hidden = false;
    } else {
      el.gateError.hidden = true;
    }
  }

  function showList() {
    el.gate.hidden = true;
    el.list.hidden = false;
    el.detail.hidden = true;
    el.composer.hidden = true;
    el.pending.hidden = true;
    el.back.hidden = true;
    el.refresh.hidden = false;
    el.title.textContent = "会话";
  }

  function showDetail() {
    el.gate.hidden = true;
    el.list.hidden = true;
    el.detail.hidden = false;
    el.composer.hidden = false;
    el.back.hidden = false;
    el.refresh.hidden = true;
    el.title.textContent = state.sessionTitle || "会话";
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
  }

  async function loadSessions() {
    const payload = await call("/api/bootstrap");
    renderSessions(payload.sessions || []);
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

  function renderMessages(messages) {
    const atBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80;
    el.messages.replaceChildren();
    for (const message of messages) {
      const node = document.createElement("div");
      node.className = `msg ${message.role === "user" ? "user" : "assistant"}`;
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = message.role === "user" ? "我" : "Agent";
      node.append(who);
      node.append(document.createTextNode(message.text));
      el.messages.append(node);
    }
    if (atBottom || state.scrollPinned) {
      el.messages.scrollTop = el.messages.scrollHeight;
    }
  }

  // A turn that stopped to ask something is the one state the phone cannot
  // resolve, so it says so plainly instead of letting the conversation look busy.
  function renderPending(pending) {
    const items = pending && Array.isArray(pending.items) ? pending.items : [];
    el.pending.replaceChildren();
    if (!items.length) {
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
    el.pending.hidden = false;
  }

  function setRunning(running) {
    state.running = Boolean(running);
    el.stop.hidden = !state.running;
    document.getElementById("input").placeholder = state.running ? "运行中，可以继续追加指令" : "给这个会话发指令";
  }

  async function loadSession() {
    if (!state.sessionId) return;
    const payload = await call(`/api/session/${encodeURIComponent(state.sessionId)}?limit=80`);
    if (payload.session && payload.session.title) state.sessionTitle = payload.session.title;
    if (!el.detail.hidden) el.title.textContent = state.sessionTitle || "会话";
    renderMessages(payload.messages || []);
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

  async function openSession(id, title) {
    state.sessionId = id;
    state.sessionTitle = title || "会话";
    state.scrollPinned = true;
    showDetail();
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
    el.title.textContent = text;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      el.title.textContent = state.sessionId ? state.sessionTitle || "会话" : "会话";
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
      showGate(error && error.message ? error.message : "连不上这台电脑");
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
