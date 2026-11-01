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
 * Everything reaches PI-Desktop through the plugin APIs the host already
 * grants (`pi.session.*` for reads, `pi.desktop.invoke` for the two writes),
 * so the phone holds no path into the host that the panel could not take.
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

function normalizeMessages(raw) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw && raw.messages) ? raw.messages : [];
  const messages = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const role = String(row.role || row.type || "").toLowerCase();
    if (!["user", "assistant", "system"].includes(role)) continue;
    if (role === "system") continue;
    const text = textOfBlocks(row.blocks !== undefined ? row.blocks : row.content);
    if (!text) continue;
    messages.push({
      id: String(row.id || ""),
      role,
      text: text.length > 8000 ? `${text.slice(0, 8000)}…` : text,
      createdAt: row.createdAt || null,
      status: row.meta && row.meta.status ? String(row.meta.status) : "",
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

async function listSessions(options) {
  const limit = options && Number.isFinite(options.limit) ? options.limit : 60;
  let raw;
  try {
    raw = await pi.session.list();
  } catch (error) {
    throw new Error(`读不到会话列表: ${error && error.message ? error.message : error}`);
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
  const targets = sessions.filter((row) => row.running).slice(0, WAITING_PROBE_LIMIT);
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

async function readSession(sessionId, options) {
  const limit = options && Number.isFinite(options.limit) ? options.limit : 80;
  let bundle;
  try {
    bundle = await pi.session.get(sessionId);
  } catch {
    bundle = null;
  }
  // The host may hang the transcript on the bundle, on `bundle.session`, or only
  // hand it out through listMessages, and those calls have taken different
  // argument shapes over time. Try them in order and keep whatever arrives: a
  // phone that shows the header with no messages beats an error page.
  let messages = [];
  for (const container of [bundle, bundle && bundle.session]) {
    messages = normalizeMessages(container);
    if (messages.length) break;
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
  const pending = await readPending(sessionId);
  return {
    session: meta,
    messages: messages.slice(-limit),
    running: Boolean(meta.running),
    truncated: messages.length > limit,
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

// ------------------------------------------------------------- pairing state

function deviceList(settings) {
  const devices = Array.isArray(settings && settings.remoteDevices) ? settings.remoteDevices : [];
  return devices.filter((item) => item && typeof item.token === "string" && item.token);
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
    devices: deviceList(settings),
  };
}

function createAuth(settingsRef) {
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
      const next = [device, ...settingsRef.devices].slice(0, MAX_DEVICES);
      settingsRef.devices = next;
      persistDevices(next).catch(() => {});
      return device;
    },
    verify(token) {
      const match = settingsRef.devices.find((item) => item.token === token);
      if (!match) return null;
      match.lastSeenAt = new Date().toISOString();
      return match;
    },
  };
}

let deviceWriteTimer = null;

async function persistDevices(devices) {
  // Pairing happens once per phone; a debounce keeps a burst of `verify`
  // timestamps from writing settings on every request.
  if (deviceWriteTimer) clearTimeout(deviceWriteTimer);
  deviceWriteTimer = setTimeout(() => {
    deviceWriteTimer = null;
    writeSettings({ remoteDevices: devices }).catch(() => {});
  }, 1500);
  if (typeof deviceWriteTimer.unref === "function") deviceWriteTimer.unref();
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
  const settingsRef = { devices: deviceList(settings) };
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
    auth: createAuth(settingsRef),
    api: {
      sessions: (options) => listSessions(options),
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
  for (const name of TOOL_NAMES) {
    try {
      await pi.agent.registerTool({ name, ...tools[name] });
    } catch (error) {
      state.lastError = `注册工具 ${name} 失败: ${error && error.message ? error.message : error}`;
    }
  }
  const settings = await readSettings();
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
      const settings = await readSettings();
      const devices = deviceList(settings);
      if (token === "*") {
        await writeSettings({ remoteDevices: [] });
      } else {
        // The panel only ever sees a masked token, so revocation names the
        // device by name + creation time instead.
        const next = devices.filter((item) => !(item.name === payload.name && item.createdAt === payload.createdAt));
        await writeSettings({ remoteDevices: next });
      }
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
    isPrivateV4,
    normalizeSessionRow,
    normalizeMessages,
    textOfBlocks,
    normalizeAsks,
    normalizePermissions,
    normalizePlans,
    readPending,
    listSessions,
    readSession,
    startServer,
    stopServer,
    rotateCode,
    statusPayload,
  },
};
