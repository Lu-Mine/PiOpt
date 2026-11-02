"use strict";

/**
 * Remote feature: lets a phone on the same LAN drive this PI-Desktop.
 *
 * The phone gets a small page served by features/remote/server.js. That page
 * only ever sees what this file decides to expose:
 *
 *   - the session list and one session's transcript (read);
 *   - a prompt sent to a session (write);
 *   - aborting a running turn (write).
 *
 * Everything reaches PI-Desktop through `pi.desktop.invoke` — the same desktop
 * channel the panel uses — because the plugin session API is scoped to sessions
 * the plugin created (`session.read.own`), and this plugin creates none. The
 * phone therefore holds no path into the host that the panel could not take.
 * Approvals (permission prompts, pending plans) are deliberately absent: those
 * are `dangerous` operations the host confirms on screen, and a phone that
 * cannot show the screen must not be able to answer them.
 *
 * The server is off until the user turns it on. `remoteAutostart` remembers
 * that choice so a plugin reload (a development install hot-reloads on every
 * file save) does not silently drop the phone mid-conversation.
 */

const os = require("os");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createRemoteServer } = require("./server.js");

const DEFAULT_PORT = 8790;
const MAX_DEVICES = 10;
const TOOL_NAMES = ["remote_status", "remote_control"];

const state = {
  server: null,
  running: false,
  port: DEFAULT_PORT,
  code: "",
  startedAt: 0,
  lastError: "",
  booted: false,
  dataDir: "",
  // One array is the truth while the plugin runs; the file below is how it
  // survives a reload.
  devices: [],
};

function randomCode() {
  // Six digits, shown in the panel and typed once on the phone. The gateway
  // rate limits pairing, so this is a door code, not a secret key.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function readSettings() {
  try {
    const settings = await pi.plugin.getSettings();
    return settings && typeof settings === "object" ? settings : {};
  } catch {
    return {};
  }
}

async function writeSettings(patch) {
  return pi.plugin.setSettings(patch);
}

function portFrom(settings) {
  const raw = Number(settings && settings.remotePort);
  if (!Number.isInteger(raw) || raw < 1024 || raw > 65535) return DEFAULT_PORT;
  return raw;
}

// Every non-loopback IPv4 address this machine answers on. The panel shows the
// private ones first because those are the addresses a phone can actually use.
function lanAddresses() {
  const found = [];
  const interfaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      found.push({ name, address: entry.address, isPrivate: isPrivateV4(entry.address) });
    }
  }
  found.sort((a, b) => Number(b.isPrivate) - Number(a.isPrivate) || a.name.localeCompare(b.name));
  return found;
}

function isPrivateV4(address) {
  const parts = String(address).split(".").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value))) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

// ---------------------------------------------------------------- host bridge

function desktopInvoke(operation, args, options) {
  if (!pi || !pi.desktop || typeof pi.desktop.invoke !== "function") {
    throw new Error("宿主没有提供 desktop.invoke");
  }
  return pi.desktop.invoke({
    operation,
    args: args === undefined ? [] : args,
    ...(options && options.confirm ? { confirm: true } : {}),
  });
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.sessions)) return value.sessions;
  if (value && Array.isArray(value.items)) return value.items;
  return [];
}

function textOfBlocks(blocks) {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" || block.type === "markdown" || typeof block.text === "string") {
      if (typeof block.text === "string" && block.text.trim()) parts.push(block.text);
      continue;
    }
    if (block.type === "tool-call" || block.type === "tool_use" || block.type === "tool") {
      const name = block.name || block.toolName || "工具";
      parts.push(`〔${name}〕`);
    }
  }
  return parts.join("\n").trim();
}

function normalizeSessionRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || raw.sessionId || "").trim();
  if (!id) return null;
  const title = String(raw.title || raw.name || "").trim();
  const updatedAt = raw.updatedAt || raw.lastMessageAt || raw.createdAt || null;
  return {
    id,
    title: title || "未命名会话",
    projectPath: typeof raw.projectPath === "string" ? raw.projectPath : "",
    projectName: typeof raw.projectPath === "string" && raw.projectPath
      ? raw.projectPath.split(/[\\/]/).filter(Boolean).pop()
      : "",
    createdAt: raw.createdAt || null,
    updatedAt,
    running: Boolean(raw.running || raw.isRunning || raw.status === "running"),
    preview: typeof raw.preview === "string" ? raw.preview : typeof raw.lastMessage === "string" ? raw.lastMessage : "",
  };
}

const BLOCK_TEXT_LIMIT = 4000;
const TOOL_TEXT_LIMIT = 1500;

function clipText(value, limit) {
  const text = typeof value === "string" ? value : "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function toolResultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const parts = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item && typeof item.text === "string") parts.push(item.text);
      else if (item && typeof item.type === "string") parts.push(`〔${item.type}〕`);
    }
  }
  if (!parts.length && typeof result.text === "string") parts.push(result.text);
  if (!parts.length) {
    try {
      parts.push(JSON.stringify(result, null, 2));
    } catch {
      /* a circular result is not worth a page error */
    }
  }
  return parts.join("\n");
}

// The single line a collapsed tool row shows: what the call was aimed at.
function toolSummary(args) {
  if (!args || typeof args !== "object") return "";
  const keys = ["path", "file_path", "command", "query", "pattern", "url", "task", "description", "name"];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return clipText(value.trim().replace(/\s+/g, " "), 72);
  }
  const first = Object.values(args).find((value) => typeof value === "string" && value.trim());
  return typeof first === "string" ? clipText(first.trim().replace(/\s+/g, " "), 72) : "";
}

// The transcript is rendered from blocks, not from a flattened string: thinking,
// tool calls and attachments each get their own shape on the phone exactly as
// they do in the host window.
function normalizeBlocks(blocks) {
  if (typeof blocks === "string") {
    return blocks.trim() ? [{ kind: "text", text: clipText(blocks, BLOCK_TEXT_LIMIT) }] : [];
  }
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const type = String(block.type || "");
    if ((type === "text" || type === "markdown") && typeof block.text === "string" && block.text.trim()) {
      out.push({ kind: "text", text: clipText(block.text, BLOCK_TEXT_LIMIT) });
      continue;
    }
    if (type === "thinking" && typeof block.text === "string" && block.text.trim()) {
      out.push({ kind: "thinking", text: clipText(block.text, BLOCK_TEXT_LIMIT) });
      continue;
    }
    if (type === "tool_call" || type === "tool-call" || type === "tool_use") {
      const args = block.args !== undefined ? block.args : block.input;
      let argsText = "";
      try {
        argsText = clipText(JSON.stringify(args === undefined ? null : args, null, 2), TOOL_TEXT_LIMIT);
      } catch {
        argsText = "";
      }
      out.push({
        kind: "tool",
        id: String(block.callId || block.id || ""),
        name: String(block.name || block.toolName || "工具"),
        status: String(block.status || ""),
        isError: block.isError === true,
        durationMs: Number.isFinite(block.durationMs) ? block.durationMs : null,
        summary: toolSummary(args),
        args: argsText,
        result: clipText(toolResultText(block.result !== undefined ? block.result : block.output), TOOL_TEXT_LIMIT),
      });
      continue;
    }
    if (type === "attachment") {
      out.push({
        kind: "attachment",
        name: String(block.name || "附件"),
        mediaKind: String(block.kind || ""),
        mime: String(block.mimeType || ""),
      });
    }
  }
  return out;
}

function normalizeMessages(raw) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw && raw.messages) ? raw.messages : [];
  const messages = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const role = String(row.role || row.type || "").toLowerCase();
    if (!["user", "assistant", "tool"].includes(role)) continue;
    const blocks = normalizeBlocks(row.blocks !== undefined ? row.blocks : row.content);
    if (!blocks.length) continue;
    const text = blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    const meta = row.meta && typeof row.meta === "object" ? row.meta : {};
    messages.push({
      id: String(row.id || ""),
      role,
      blocks,
      // Flat text stays for the list preview and any reader that wants a body.
      text: clipText(text, BLOCK_TEXT_LIMIT),
      createdAt: row.createdAt || null,
      status: meta.status ? String(meta.status) : "",
      agentName: meta.agentName ? String(meta.agentName) : "",
      parentToolCallId: meta.parentToolCallId ? String(meta.parentToolCallId) : "",
      durationMs: Number.isFinite(meta.responseDurationMs) ? meta.responseDurationMs : null,
    });
  }
  return messages;
}

// --------------------------------------------------------------- what it asks

// A session waiting on a question looks exactly like one that is working, so the
// phone needs the pending list to tell them apart. Reading it needs no
// confirmation — both channels are `read`; answering it does, which is why this
// only ever renders and never resolves.
const WAITING_PROBE_LIMIT = 5;
const PENDING_ITEM_LIMIT = 4;

function firstText(source, keys) {
  if (!source || typeof source !== "object") return "";
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeAsks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const text = firstText(entry, ["question", "prompt", "message", "text", "title"]);
    const options = Array.isArray(entry && entry.options)
      ? entry.options
          .map((item) => (typeof item === "string" ? item : firstText(item, ["label", "title", "text"])))
          .filter(Boolean)
      : [];
    return { kind: "ask", text: text || "Agent 在等你回答一个问题", options };
  });
}

function normalizePermissions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => ({
    kind: "permission",
    text: firstText(entry, ["description", "reason", "summary", "toolName", "tool"]) || "有一个工具权限在等确认",
  }));
}

function normalizePlans(raw) {
  const rows = Array.isArray(raw)
    ? raw
    : raw && Array.isArray(raw.proposals)
      ? raw.proposals
      : raw && Array.isArray(raw.plans)
        ? raw.plans
        : raw && Array.isArray(raw.pending)
          ? raw.pending
          : [];
  return rows.map((entry) => ({
    kind: "plan",
    text: firstText(entry, ["title", "summary", "name"]) || "有一份计划在等批准",
  }));
}

async function readPending(sessionId) {
  const items = [];
  try {
    const interactive = await desktopInvoke("agent/pendingInteractive", [{ sessionId }]);
    items.push(...normalizeAsks(interactive && interactive.asks));
    items.push(...normalizePermissions(interactive && interactive.permissions));
  } catch {
    /* a host that does not answer has nothing pending */
  }
  try {
    items.push(...normalizePlans(await desktopInvoke("plans/pending", [{ sessionId }])));
  } catch {
    /* same */
  }
  return { count: items.length, items: items.slice(0, PENDING_ITEM_LIMIT) };
}

// ---------------------------------------------------------------- projects

// The host keys a project by its folder, not by an id: `session/create` takes a
// `projectPath`, and leaving it out is exactly how the host makes a session with
// no project (临时聊天).
function normalizeProjects(raw) {
  const rows = Array.isArray(raw)
    ? raw
    : raw && Array.isArray(raw.projects)
      ? raw.projects
      : raw && Array.isArray(raw.items)
        ? raw.items
        : [];
  const seen = new Set();
  const projects = [];
  for (const row of rows) {
    if (row && typeof row === "string") {
      const path = row.trim();
      if (!path || seen.has(path)) continue;
      seen.add(path);
      projects.push({ path, name: path.split(/[\/]/).filter(Boolean).pop() || path });
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const value = String(row.path || row.projectPath || row.root || row.folder || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    projects.push({
      path: value,
      name: String(row.name || row.title || value.split(/[\/]/).filter(Boolean).pop() || value),
      lastOpenedAt: row.lastOpenedAt || row.updatedAt || null,
    });
  }
  // The host reports the stamp as epoch milliseconds in one place and as an ISO
  // string in another; normalise before sorting so both order correctly.
  const stamp = (row) => {
    const value = row && row.lastOpenedAt;
    if (typeof value === "number") return value;
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  projects.sort((a, b) => stamp(b) - stamp(a));
  return projects;
}

// The host refuses to fork a session with an active turn unless it is told where
// to cut, which is exactly the case 从这里重新问 runs in: fork up to a message
// while the session is still working.
async function forkSession(sessionId, options) {
  const input = { sessionId };
  const through = options && typeof options.throughMessageId === "string" ? options.throughMessageId.trim() : "";
  const title = options && typeof options.title === "string" ? options.title.trim() : "";
  if (through) input.throughMessageId = through;
  if (title) input.title = title;
  let result = null;
  try {
    result = await desktopInvoke("session/fork", [input]);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    // The host refuses to cut a session whose turn is still active.
    if (/cannot fork a running session/i.test(message)) {
      throw new Error("这个会话正在运行，等这一轮结束再重问");
    }
    throw error;
  }
  const session = (result && (result.session || result)) || {};
  const id = String(session.id || session.sessionId || "").trim();
  if (!id) throw new Error("分叉没有返回会话");
  transcriptCache.delete(id);
  return {
    id,
    title: String(session.title || title || ""),
    projectPath: String(session.projectPath || ""),
  };
}

// `agent/getStatus` is the only honest answer to "is this session busy": the
// `running` flag on a session row does not follow an active turn.
async function readAgentStatus(sessionId) {
  try {
    const status = await desktopInvoke("agent/getStatus", [{ sessionId }]);
    return {
      isRunning: Boolean(status && status.isRunning),
      currentTurnId: status && status.currentTurnId ? String(status.currentTurnId) : "",
      pendingConfirmations:
        status && Array.isArray(status.pendingToolConfirmations) ? status.pendingToolConfirmations.length : 0,
    };
  } catch {
    return { isRunning: false, currentTurnId: "", pendingConfirmations: 0 };
  }
}

async function listProjects() {
  let raw = null;
  let failure = null;
  try {
    raw = await desktopInvoke("project/list", []);
  } catch (error) {
    failure = error;
  }
  // A host that cannot list projects still has sessions that name one; deriving
  // the list from them keeps 新建会话 usable for projects already in use.
  if (!raw) {
    try {
      const sessions = await listSessions({ limit: 200 });
      return normalizeProjects(sessions.filter((row) => row.projectPath).map((row) => ({ path: row.projectPath })));
    } catch {
      throw new Error(`读不到项目列表: ${failure && failure.message ? failure.message : "宿主没有回答"}`);
    }
  }
  return normalizeProjects(raw);
}

// A new session carries the project folder, or nothing at all for a chat with no
// project. Everything else (mode, permission mode, provider, model) is left to
// the host's own defaults so the phone creates the same session the desktop
// would.
async function createNewSession(options) {
  const projectPath = options && typeof options.projectPath === "string" ? options.projectPath.trim() : "";
  const title = options && typeof options.title === "string" ? options.title.trim() : "";
  const input = {};
  if (projectPath) input.projectPath = projectPath;
  if (title) input.title = title;
  let result = null;
  try {
    result = await desktopInvoke("session/create", [input]);
  } catch (error) {
    throw new Error(`新建会话失败: ${error && error.message ? error.message : error}`);
  }
  const session = (result && (result.session || result)) || {};
  const id = String(session.id || session.sessionId || "").trim();
  if (!id) throw new Error("新建会话没有返回 id");
  // A fresh id has no transcript yet; a stale cache entry would be a bug.
  transcriptCache.delete(id);
  return {
    id,
    title: String(session.title || ""),
    projectPath: String(session.projectPath || projectPath || ""),
  };
}

async function listSessions(options) {
  const limit = options && Number.isFinite(options.limit) ? options.limit : 60;
  // `pi.session.list` is gated on `session.read.own` — sessions this plugin
  // created, of which there are none — so the phone reads the user's sessions
  // through the same desktop channel the panel uses. That costs desktop.control,
  // which this feature already holds to send prompts.
  let raw = null;
  let failure = null;
  try {
    raw = await desktopInvoke("session/list", []);
  } catch (error) {
    failure = error;
  }
  if (!raw) {
    try {
      raw = await pi.session.list();
    } catch (error) {
      failure = failure || error;
    }
  }
  if (!raw) {
    throw new Error(`读不到会话列表: ${failure && failure.message ? failure.message : failure || "未知原因"}`);
  }
  const sessions = asArray(raw).map(normalizeSessionRow).filter(Boolean);
  sessions.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const page = sessions.slice(0, limit);
  // Only the phone's own list asks for this. The stream skips it: probing every
  // running session on every push would cost two host calls per session.
  if (options && options.probe) await attachWaiting(page);
  return page;
}

async function attachWaiting(sessions) {
  // `running` from the desktop channel does not track an active turn, so probe
  // the most recently touched sessions instead of only the "running" ones.
  const targets = sessions.slice(0, WAITING_PROBE_LIMIT);
  await Promise.all(
    targets.map(async (row) => {
      const pending = await readPending(row.id).catch(() => null);
      if (pending && pending.count) {
        row.waiting = pending.count;
        row.waitingText = pending.items[0] ? pending.items[0].text : "";
      }
    })
  );
}

// ----------------------------------------------------------------- transcript

// The desktop channel returns a session's metadata but not its messages — the
// host keeps transcripts out of that surface on purpose. The transcript is the
// session's own jsonl in the data folder, so this reads it with Node fs, the
// same way the market feature reads the plugin registry: no host API is asked
// for it and no new permission is claimed. Only the tail is read (the last
// 256 KB, cached until the file's size changes) because a long session runs to
// megabytes and the phone shows a few dozen turns.
// A session's jsonl is its transcript. Reading it is incremental: the cache
// holds the byte offset already parsed plus the tail of a line that was not
// complete yet, so a poll after one new message parses one line, not the file.
//
// The read starts at byte 0 rather than at a tail window: the first message is
// the question the conversation is about, and a phone that jumped in at the last
// 256 KB showed a transcript with no opening question at all.
const TRANSCRIPT_CACHE_LIMIT = 40;
const TRANSCRIPT_KEEP = 900;
const transcriptCache = new Map();

function transcriptPaths(sessionId) {
  const paths = [];
  const base = String(state.transcriptDir || "").trim();
  if (base) paths.push(path.join(base, `${sessionId}.jsonl`));
  const fromEnv = String(process.env.PI_DESKTOP_DATA_DIR || "").trim();
  if (fromEnv) paths.push(path.join(fromEnv, "sessions", `${sessionId}.jsonl`));
  paths.push(path.join(os.homedir(), ".pi-desktop", "sessions", `${sessionId}.jsonl`));
  return paths;
}

function transcriptFile(sessionId) {
  for (const file of transcriptPaths(sessionId)) {
    try {
      fs.statSync(file);
      return file;
    } catch {
      continue;
    }
  }
  return "";
}

function appendLines(entry, bytes) {
  const joined = entry.pending && entry.pending.length ? Buffer.concat([entry.pending, bytes]) : bytes;
  let from = 0;
  let index;
  while ((index = joined.indexOf(0x0a, from)) !== -1) {
    const line = joined.subarray(from, index).toString("utf8").trim();
    from = index + 1;
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const [message] = normalizeMessages([row]);
    if (message) entry.messages.push(message);
  }
  entry.pending = Buffer.from(joined.subarray(from));
}

function trimTranscript(entry) {
  if (entry.messages.length <= TRANSCRIPT_KEEP) return;
  const firstUser = entry.messages.findIndex((message) => message.role === "user");
  const keepHead = firstUser >= 0 && firstUser < entry.messages.length - TRANSCRIPT_KEEP;
  const head = keepHead ? entry.messages[firstUser] : null;
  const tail = entry.messages.slice(-TRANSCRIPT_KEEP);
  entry.dropped += entry.messages.length - tail.length - (head ? 1 : 0);
  entry.messages = head ? [head, ...tail] : tail;
}

function readTranscript(sessionId) {
  const file = transcriptFile(sessionId);
  if (!file) return null;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  const cached = transcriptCache.get(sessionId);
  if (cached && cached.size === size) return cached;
  if (!cached && transcriptCache.size >= TRANSCRIPT_CACHE_LIMIT) transcriptCache.clear();

  const entry = cached || { size: 0, messages: [], pending: Buffer.alloc(0), dropped: 0 };
  const from = cached ? cached.size : 0;
  if (size > from) {
    let bytes = null;
    try {
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(size - from);
        bytes = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, from));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      bytes = null;
    }
    if (bytes) appendLines(entry, bytes);
  }
  entry.size = size;
  trimTranscript(entry);
  transcriptCache.set(sessionId, entry);
  return entry;
}

// The last `limit` messages, always including the opening question, plus how
// many messages were skipped between that question and the window.
function transcriptView(entry, limit) {
  if (!entry) return { messages: [], omitted: 0 };
  const all = entry.messages;
  const start = Math.max(0, all.length - limit);
  if (start === 0) return { messages: all.slice(), omitted: entry.dropped };
  const firstUser = all.findIndex((message) => message.role === "user");
  if (firstUser >= 0 && firstUser < start) {
    return {
      messages: [all[firstUser], ...all.slice(start)],
      omitted: start - firstUser - 1 + entry.dropped,
    };
  }
  return { messages: all.slice(start), omitted: entry.dropped + start };
}

async function readSession(sessionId, options) {
  const limit = options && Number.isFinite(options.limit) ? options.limit : 80;
  let bundle = null;
  try {
    bundle = await desktopInvoke("session/get", [{ sessionId }]);
  } catch {
    bundle = null;
  }
  if (!bundle) {
    try {
      bundle = await pi.session.get(sessionId);
    } catch {
      bundle = null;
    }
  }
  // The host may hang the transcript on the bundle, on `bundle.session`, or only
  // hand it out through listMessages, and those calls have taken different
  // argument shapes over time. Try them in order and keep whatever arrives: a
  // phone that shows the header with no messages beats an error page.
  let messages = [];
  let omitted = 0;
  try {
    const view = transcriptView(readTranscript(sessionId), limit);
    messages = view.messages;
    omitted = view.omitted;
  } catch {
    messages = [];
    omitted = 0;
  }
  for (const container of [bundle, bundle && bundle.session]) {
    if (messages.length) break;
    messages = normalizeMessages(container);
  }
  if (!messages.length) {
    for (const shape of [{ sessionId, limit }, { sessionId }, { id: sessionId, limit }]) {
      try {
        messages = normalizeMessages(await pi.session.listMessages(shape));
      } catch {
        continue;
      }
      if (messages.length) break;
    }
  }
  const meta = normalizeSessionRow((bundle && (bundle.session || bundle)) || { id: sessionId }) || {
    id: sessionId,
    title: "会话",
  };
  // `session/get` reports the user-set title, which is usually empty; the list
  // shows the derived one. Fall back to the first line of the preview so the
  // phone's header says what the conversation is about.
  if (!meta.title || meta.title === "未命名会话") {
    meta.title = meta.preview ? meta.preview.slice(0, 40) : `会话 ${sessionId.slice(0, 8)}`;
  }
  const [pending, status] = await Promise.all([readPending(sessionId), readAgentStatus(sessionId)]);
  return {
    session: meta,
    messages,
    omitted,
    running: status.isRunning,
    currentTurnId: status.currentTurnId,
    pending,
  };
}

async function sendPrompt(sessionId, content) {
  // The host names this field `content`; a host that answers INVALID_PARAMS is
  // retried once with `text` so a channel rename does not take the phone down.
  const attempts = [{ sessionId, content }, { sessionId, text: content }];
  let lastError = null;
  for (const args of attempts) {
    try {
      await desktopInvoke("agent/prompt", [args]);
      return {};
    } catch (error) {
      lastError = error;
      const code = error && (error.code || error.errorCode);
      if (code !== "INVALID_PARAMS" && code !== "INVALID_ARGUMENT") break;
    }
  }
  throw new Error(`发送失败: ${lastError && lastError.message ? lastError.message : lastError}`);
}

async function abortSession(sessionId) {
  await desktopInvoke("agent/abort", [{ sessionId }]);
  return {};
}

// ------------------------------------------------------------- device store

// Devices live in the plugin's own data folder, not in settings. A development
// install restarts the plugin process on every file save, and an array in
// settings is rewritten wholesale by whoever last called setSettings — either
// one silently un-pairs every phone. The file is written atomically (temp +
// rename) and, for pairing and removal, immediately.
function devicesFile() {
  return state.dataDir ? path.join(state.dataDir, "remote-devices.json") : "";
}

function sanitizeDevices(value) {
  if (!Array.isArray(value)) return null;
  return value
    .filter((item) => item && typeof item.token === "string" && item.token)
    .slice(0, MAX_DEVICES)
    .map((item) => ({
      token: item.token,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 40) : "手机",
      createdAt: item.createdAt || new Date().toISOString(),
      lastSeenAt: item.lastSeenAt || item.createdAt || null,
    }));
}

function readDevicesFromDisk() {
  const file = devicesFile();
  if (!file) return null;
  try {
    return sanitizeDevices(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function writeDevicesToDisk() {
  const file = devicesFile();
  if (!file) {
    state.lastError = "拿不到插件数据目录，配对无法持久化";
    return;
  }
  const temp = `${file}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state.devices, null, 2)}
`, "utf8");
    fs.renameSync(temp, file);
  } catch (error) {
    state.lastError = `设备列表写入失败: ${error && error.message ? error.message : error}`;
  }
}

let deviceWriteTimer = null;

function scheduleDeviceWrite() {
  // Pairing and removal write at once; this only coalesces the lastSeenAt stamps
  // that arrive with ordinary requests.
  if (deviceWriteTimer) return;
  deviceWriteTimer = setTimeout(() => {
    deviceWriteTimer = null;
    writeDevicesToDisk();
  }, 3000);
  if (typeof deviceWriteTimer.unref === "function") deviceWriteTimer.unref();
}

async function loadDevices(settings) {
  const fromDisk = readDevicesFromDisk();
  if (fromDisk) {
    state.devices = fromDisk;
    return state.devices;
  }
  // First load after this build: adopt whatever the settings-era version stored,
  // then never read that key again.
  const legacy = sanitizeDevices(settings && settings.remoteDevices);
  state.devices = legacy || [];
  if (legacy && legacy.length) writeDevicesToDisk();
  return state.devices;
}

function maskToken(token) {
  const text = String(token || "");
  return text.length <= 8 ? "········" : `${text.slice(0, 4)}······${text.slice(-4)}`;
}

async function currentSettings() {
  const settings = await readSettings();
  return {
    settings,
    port: portFrom(settings),
    autostart: settings.remoteAutostart === true,
    devices: state.devices || [],
  };
}

function createAuth() {
  return {
    checkCode(code) {
      const expected = String(state.code || "");
      if (!expected || !code) return false;
      const left = Buffer.from(code);
      const right = Buffer.from(expected);
      if (left.length !== right.length) return false;
      return crypto.timingSafeEqual(left, right);
    },
    register(name) {
      const device = {
        token: randomToken(),
        name: String(name || "手机").slice(0, 40),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      };
      state.devices = [device, ...(state.devices || [])].slice(0, MAX_DEVICES);
      writeDevicesToDisk();
      return device;
    },
    verify(token) {
      const match = (state.devices || []).find((item) => item.token === token);
      if (!match) return null;
      match.lastSeenAt = new Date().toISOString();
      scheduleDeviceWrite();
      return match;
    },
  };
}

// ------------------------------------------------------------------- surface

async function statusPayload() {
  const { port, autostart, devices } = await currentSettings();
  const addresses = lanAddresses();
  const primary = addresses[0] ? addresses[0].address : "127.0.0.1";
  return {
    running: state.running,
    port: state.port || port,
    configuredPort: port,
    autostart,
    startedAt: state.startedAt || null,
    code: state.code,
    url: `http://${primary}:${state.port || port}`,
    addresses: addresses.map((item) => ({ ...item, url: `http://${item.address}:${state.port || port}` })),
    deviceCount: devices.length,
    devices: devices.map((item) => ({
      name: item.name,
      createdAt: item.createdAt,
      lastSeenAt: item.lastSeenAt,
      token: maskToken(item.token),
    })),
    lastError: state.lastError || "",
  };
}

async function startServer() {
  if (state.running) return statusPayload();
  const { port, settings } = await currentSettings();
  await loadDevices(settings);
  if (!state.code) state.code = randomCode();
  const server = createRemoteServer({
    host: "0.0.0.0",
    port,
    log: (message) => {
      state.lastError = "";
      try {
        console.log(`[PiOpt remote] ${message}`);
      } catch {
        /* logging is best effort */
      }
    },
    auth: createAuth(),
    api: {
      sessions: (options) => listSessions(options),
      projects: () => listProjects(),
      createSession: (input) => createNewSession(input),
      fork: (sessionId, input) => forkSession(sessionId, input),
      agentStatus: (sessionId) => readAgentStatus(sessionId),
      session: (sessionId, options) => readSession(sessionId, options),
      prompt: (sessionId, content) => sendPrompt(sessionId, content),
      abort: (sessionId) => abortSession(sessionId),
      // The stream redraws the list on the phone when the set of sessions or
      // their busy flags change; a single session's transcript is polled.
      snapshot: async () => ({ sessions: await listSessions({ limit: 60 }) }),
    },
  });
  try {
    const info = await server.start({ port });
    state.server = server;
    state.running = true;
    state.port = info.port;
    state.startedAt = Date.now();
    state.lastError = "";
    await writeSettings({ remoteAutostart: true, remotePort: port }).catch(() => {});
  } catch (error) {
    state.running = false;
    state.lastError = error && error.message ? error.message : String(error);
    throw error;
  }
  return statusPayload();
}

async function stopServer(options) {
  const server = state.server;
  state.server = null;
  state.running = false;
  state.startedAt = 0;
  if (server) await server.stop().catch(() => {});
  if (!options || options.remember !== false) {
    await writeSettings({ remoteAutostart: false }).catch(() => {});
  }
  return statusPayload();
}

async function rotateCode() {
  state.code = randomCode();
  return statusPayload();
}

const tools = {
  remote_status: {
    description:
      "Report whether the PiOpt phone gateway is running on this LAN: on/off, port, the addresses a phone can open, the pairing code, and how many devices are paired. Read-only.",
    risk: "low",
    schema: { type: "object", properties: {} },
    execute: async () => statusPayload(),
  },
  remote_control: {
    description:
      "Start or stop the PiOpt phone gateway, or rotate its pairing code. Starting exposes a LAN page that can read sessions and send prompts until it is stopped.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "start | stop | rotate-code" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = args && typeof args.action === "string" ? args.action.trim() : "";
      if (action === "start") return startServer();
      if (action === "stop") return stopServer();
      if (action === "rotate-code") return rotateCode();
      throw new Error("action 只能是 start | stop | rotate-code");
    },
  },
};

async function onLoad() {
  if (!state.code) state.code = randomCode();
  if (!state.dataDir) {
    try {
      state.dataDir = await pi.plugin.getDataPath();
    } catch {
      state.dataDir = "";
    }
  }
  for (const name of TOOL_NAMES) {
    try {
      await pi.agent.registerTool({ name, ...tools[name] });
    } catch (error) {
      state.lastError = `注册工具 ${name} 失败: ${error && error.message ? error.message : error}`;
    }
  }
  const settings = await readSettings();
  await loadDevices(settings);
  if (settings.remoteAutostart === true) {
    // A hot reload restarts the plugin process, which drops the listening
    // socket. Coming back on the remembered choice is what keeps the phone
    // page alive across a development save.
    await startServer().catch(() => {});
  }
  state.booted = true;
}

async function onUnload() {
  for (const name of TOOL_NAMES) {
    try {
      await pi.agent.unregisterTool(name);
    } catch {
      /* already gone */
    }
  }
  await stopServer({ remember: false }).catch(() => {});
}

async function onPanelInvoke(channel, payload = {}) {
  switch (channel) {
    case "remote.status":
      return statusPayload();
    case "remote.start":
      return startServer();
    case "remote.stop":
      return stopServer();
    case "remote.rotateCode":
      return rotateCode();
    case "remote.setPort": {
      const port = Number(payload.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("端口需在 1024–65535 之间");
      const wasRunning = state.running;
      if (wasRunning) await stopServer({ remember: false });
      await writeSettings({ remotePort: port });
      if (wasRunning) return startServer();
      return statusPayload();
    }
    case "remote.revoke": {
      const token = typeof payload.token === "string" ? payload.token : "";
      // The panel only ever sees a masked token, so revocation names the device
      // by name + creation time instead.
      state.devices = token === "*"
        ? []
        : (state.devices || []).filter(
            (item) => !(item.name === payload.name && item.createdAt === payload.createdAt)
          );
      writeDevicesToDisk();
      return statusPayload();
    }
    default:
      throw new Error(`Unsupported panel action: ${channel}`);
  }
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  tools,
  _internals: {
    state,
    randomCode,
    lanAddresses,
    createAuth,
    loadDevices,
    sanitizeDevices,
    devicesFile,
    writeDevicesToDisk,
    isPrivateV4,
    normalizeSessionRow,
    normalizeMessages,
    textOfBlocks,
    normalizeAsks,
    normalizePermissions,
    normalizePlans,
    readPending,
    readTranscript,
    transcriptView,
    transcriptCache,
    listSessions,
    normalizeProjects,
    listProjects,
    createNewSession,
    forkSession,
    readAgentStatus,
    readSession,
    startServer,
    stopServer,
    rotateCode,
    statusPayload,
  },
};
