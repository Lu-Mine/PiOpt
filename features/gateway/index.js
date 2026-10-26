"use strict";

/**
 * Gateway feature: owns the lifecycle of the local AI gateway.
 *
 * Model: PI-Desktop starts -> this plugin host process starts -> we spawn the
 * supervisor -> the supervisor spawns workbuddy + cli-proxy-api and holds the
 * *parent* process handle open.
 *
 * Why a supervisor instead of spawning the gateway directly:
 *   - The host may stop waiting on `onUnload` (it bounds plugin shutdown so a
 *     wedged plugin cannot hang app quit), so teardown cannot rely on us alone.
 *   - The supervisor waits on the parent handle with WaitForSingleObject, which
 *     fires the moment this process dies for ANY reason, and then kills the
 *     gateway tree. That also covers crashes and force-quit.
 *
 * Everything here is best effort: a missing binary or a refused spawn must
 * degrade to "tools report not running", never to a broken plugin load.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const GATEWAY_DIR = "C:/Users/Avencess/ai-gateway";
const BIN = path.join(GATEWAY_DIR, "bin", "ai-gateway-mcp.exe");
const LOG_DIR = path.join(GATEWAY_DIR, "bin", "logs");
const SUPERVISOR_LOG = path.join(LOG_DIR, "supervisor.log");

const TOOL_NAMES = ["gateway_status", "gateway_restart", "gateway_logs"];

let child = null;
let lastError = "";
let startedAt = 0;

function readTail(file, lines) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const rows = raw.replace(/\r/g, "").trimEnd().split("\n");
    return rows.slice(Math.max(0, rows.length - lines)).join("\n");
  } catch (error) {
    return `读不到 ${file}: ${error && error.message ? error.message : error}`;
  }
}

function parseSupervisorLog() {
  const tail = readTail(SUPERVISOR_LOG, 200);
  const ports = {};
  let manager = null;
  for (const line of tail.split("\n")) {
    const ready = line.match(/(\w+) 端口 (\d+) 就绪/);
    if (ready) ports[ready[1]] = true;
    if (/本进程为管理者/.test(line)) manager = true;
    if (/已有管理者实例/.test(line)) manager = false;
  }
  return { ports, manager, tail };
}

function alive() {
  return Boolean(child && child.exitCode === null && !child.killed);
}

function startSupervisor() {
  if (alive()) return { ok: true, already: true };
  if (!fs.existsSync(BIN)) {
    lastError = `找不到 ${BIN}`;
    return { ok: false, error: lastError };
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    child = spawn(BIN, ["--parent-pid", String(process.pid)], {
      cwd: path.dirname(BIN),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    startedAt = Date.now();
    lastError = "";
    child.on("error", error => {
      lastError = error && error.message ? error.message : String(error);
    });
    child.on("exit", () => {
      child = null;
    });
    child.stdin.on("error", () => {
      /* the supervisor may exit first; nothing to do */
    });
    return { ok: true, pid: child.pid };
  } catch (error) {
    lastError = error && error.message ? error.message : String(error);
    child = null;
    return { ok: false, error: lastError };
  }
}

function stopSupervisor() {
  const running = child;
  child = null;
  if (!running) return false;
  try {
    running.kill();
  } catch {
    /* already gone */
  }
  return true;
}

function statusPayload() {
  const { ports, manager, tail } = parseSupervisorLog();
  return {
    ok: alive(),
    supervisor: alive() ? { pid: child.pid, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) } : null,
    manager,
    components: {
      workbuddy: { port: 8788, ready: Boolean(ports.workbuddy) },
      gateway: { port: 8317, ready: Boolean(ports.gateway) },
    },
    lastError: lastError || null,
    logTail: tail.split("\n").slice(-12),
  };
}

const tools = {
  gateway_status: {
    description:
      "Report whether the local AI gateway is running: supervisor pid, which component ports are up, and the tail of its log. Read-only.",
    risk: "low",
    schema: { type: "object", properties: {} },
    execute: async () => statusPayload(),
  },

  gateway_restart: {
    description:
      "Restart the local AI gateway by stopping the supervisor (which kills its children) and starting a fresh one. Blocks until the new supervisor is spawned, not until the ports are ready.",
    risk: "medium",
    schema: { type: "object", properties: {} },
    execute: async () => {
      const stopped = stopSupervisor();
      await new Promise(resolve => setTimeout(resolve, 1200));
      const started = startSupervisor();
      return {
        ok: Boolean(started.ok),
        stopped,
        started,
        hint: "端口就绪要几秒，随后用 gateway_status 复核。",
      };
    },
  },

  gateway_logs: {
    description: "Read the tail of a gateway component log. Use component=supervisor|gateway|workbuddy.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        component: { type: "string", description: "supervisor (default), gateway or workbuddy." },
        lines: { type: "number", description: "How many trailing lines, default 40." },
      },
    },
    execute: async args => {
      const component = typeof args?.component === "string" && args.component.trim() ? args.component.trim() : "supervisor";
      const lines = Number.isFinite(args?.lines) && args.lines > 0 ? Math.min(400, Math.floor(args.lines)) : 40;
      const file = path.join(LOG_DIR, `${component}.log`);
      return { component, path: file, text: readTail(file, lines) };
    },
  },
};

async function onLoad() {
  startSupervisor();
  for (const name of TOOL_NAMES) {
    try {
      await pi.agent.registerTool({ name, ...tools[name] });
    } catch (error) {
      lastError = `注册工具 ${name} 失败: ${error && error.message ? error.message : error}`;
    }
  }
}

async function onUnload() {
  for (const name of TOOL_NAMES) {
    try {
      await pi.agent.unregisterTool(name);
    } catch {
      /* already gone */
    }
  }
  stopSupervisor();
}

// ---------------- 管理 API 数据聚合 ----------------

const MGMT_BASE = "http://127.0.0.1:8317";
// 管理面板密码（config.yaml 里已被服务端写成 bcrypt 哈希，这里必须用明文）
const MGMT_KEY = "Avencess777";
const CREDITS_LOG = path.join(GATEWAY_DIR, "dev", "credits.log");
const QUOTA_FILE = path.join(GATEWAY_DIR, "dev", "quota.json");

// 插件每 5 分钟把真实余额写成快照，这里只读结构化结论
function readQuota() {
  try {
    const snap = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8"));
    if (!snap || snap.ok !== true) {
      return { ok: false, hint: (snap && snap.error) || "余额快照暂不可用" };
    }
    return {
      ok: true,
      updatedAt: snap.updated_at || "",
      tier: snap.tier || "",
      paid: Boolean(snap.paid),
      unit: snap.unit || "credits",
      remain: Number(snap.total_remain) || 0,
      capacity: Number(snap.total_capacity) || 0,
      used: Number(snap.used) || 0,
      groups: Array.isArray(snap.groups) ? snap.groups : [],
      checkin: snap.checkin || null,
    };
  } catch (error) {
    return { ok: false, hint: "插件还没有写出余额快照" };
  }
}

async function mgmt(pathname) {
  const res = await fetch(MGMT_BASE + pathname, {
    headers: { "X-Management-Key": MGMT_KEY },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status}`);
  return res.json();
}

// 协议能力：由插件的 executor 声明 + 内置 provider 推导
const PROTOCOLS = [
  { id: "openai", label: "OpenAI", path: "/v1/chat/completions", note: "标准 OpenAI 客户端" },
  { id: "claude", label: "Claude", path: "/v1/messages", note: "Anthropic SDK / Claude Code" },
  { id: "codex", label: "Codex", path: "/v1/responses", note: "OpenAI Responses API" },
  { id: "gemini", label: "Gemini", path: "/v1beta/models/*", note: "Gemini 原生协议" },
];

async function fetchModels() {
  const res = await fetch(MGMT_BASE + "/v1/models", {
    headers: { Authorization: `Bearer ${gatewayApiKey()}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data.data) ? data.data : [];
  const groups = {};
  for (const m of list) {
    const owner = m.owned_by || "unknown";
    (groups[owner] = groups[owner] || []).push(m.id);
  }
  for (const k of Object.keys(groups)) groups[k].sort();
  return { total: list.length, groups };
}

// 把积分日志解析成结构化结果（面板只看结论，不铺原始行）
function parseCredits() {
  let raw = "";
  try {
    raw = fs.readFileSync(CREDITS_LOG, "utf8");
  } catch {
    return { ok: false, hint: "还没有积分记录" };
  }
  const rows = raw.replace(/\r/g, "").trimEnd().split("\n");
  let lastRunAt = "";
  let earned = 0;
  let claimed = 0;
  const actions = [];
  for (const line of rows) {
    const m = line.match(/^(\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.*)$/);
    if (!m) continue;
    const [, ts, text] = m;
    if (text.includes("本轮结束")) {
      lastRunAt = ts;
      const e = text.match(/获得 (\d+) 积分/);
      const c = text.match(/领取 (\d+) 个任务/);
      earned = e ? Number(e[1]) : 0;
      claimed = c ? Number(c[1]) : 0;
      continue;
    }
    if (/^[✓🐱📅🎁🏅🎰]/.test(text.trim()) || text.includes("领奖") || text.includes("兑换") || text.includes("抽奖")) {
      actions.push({ at: ts, text: text.trim() });
    }
  }
  return {
    ok: true,
    lastRunAt: lastRunAt || null,
    earned,
    claimed,
    recent: actions.slice(-6).reverse(),
  };
}

// 一次拿全，供面板渲染
async function fetchOverview() {
  const out = { ok: true, protocols: PROTOCOLS, errors: [] };
  const jobs = [
    ["config", "/v8/management/config"],
    ["credentials", "/v8/management/credentials"],
    ["plugins", "/v8/management/plugins"],
  ];
  const settled = await Promise.allSettled(jobs.map(([, p]) => mgmt(p)));
  settled.forEach((r, i) => {
    const key = jobs[i][0];
    if (r.status === "fulfilled") out[key] = r.value;
    else out.errors.push(`${key}: ${r.reason && r.reason.message ? r.reason.message : r.reason}`);
  });

  try {
    out.models = await fetchModels();
  } catch (error) {
    out.errors.push(`models: ${error.message || error}`);
  }

  out.credits = parseCredits();
  out.quota = readQuota();

  // 客户端 API Key（脱敏后给前端）
  const keys = (out.config && out.config.access && out.config.access["api-keys"]) || [];
  out.clientKeys = keys.map(k => ({
    mask: k.length > 14 ? `${k.slice(0, 8)}…${k.slice(-4)}` : "…",
    length: k.length,
  }));

  // 上游：插件 + OAuth 凭证 + openai-compatibility
  const upstreams = [];
  const plugins = (out.plugins && out.plugins.plugins) || [];
  for (const p of plugins) {
    upstreams.push({
      kind: "plugin",
      name: p.id,
      version: (p.metadata && p.metadata.version) || "",
      enabled: Boolean(p.effective_enabled),
      detail: p.path,
    });
  }
  const files = (out.credentials && out.credentials.files) || [];
  for (const f of files) {
    upstreams.push({
      kind: "oauth",
      name: f.provider || "oauth",
      account: f.account || f.email || "",
      enabled: !f.disabled,
      failed: f.failed || 0,
      projectId: f.project_id || "",
      lastRefresh: f.last_refresh || "",
      quota: f.quota && f.quota.signals ? Object.keys(f.quota.signals).length : 0,
    });
  }
  const compat = (out.config && out.config["api-keys"] && out.config["api-keys"]["openai-compatibility"]) || [];
  for (const c of compat) {
    upstreams.push({
      kind: "compat",
      name: c.name || "openai-compatibility",
      enabled: !c.disabled,
      detail: c["base-url"] || "",
      models: (c.models || []).length,
    });
  }
  out.upstreams = upstreams;
  return out;
}

function gatewayApiKey() {
  try {
    const raw = fs.readFileSync(CONFIG, "utf8");
    const m = raw.match(/api-keys:\s*\n\s*-\s*"([^"]+)"/) || raw.match(/api-keys:\s*\n\s*-\s*(\S+)/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

const CONFIG = path.join(GATEWAY_DIR, "cliproxy", "config.yaml");

// 让 Go 插件的调度器下一轮立刻执行积分
function triggerCredits() {
  const flag = path.join(path.dirname(CREDITS_LOG), "run-credits.once");
  try {
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, "");
    return { ok: true, hint: "已排队，调度器最多 20 秒内执行" };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

function onPanelInvoke(channel, payload = {}) {
  switch (channel) {
    case "gateway.status":
      return statusPayload();
    case "gateway.overview":
      return fetchOverview();
    case "gateway.credits":
      return parseCredits();
    case "gateway.quota":
      return readQuota();
    case "gateway.runCredits":
      return triggerCredits();
    case "gateway.restart": {
      const stopped = stopSupervisor();
      return new Promise(resolve => {
        setTimeout(() => resolve({ stopped, ...startSupervisor() }), 1200);
      });
    }
    case "gateway.logs":
      return tools.gateway_logs.execute(payload);
    default:
      throw new Error(`Unsupported panel action: ${channel}`);
  }
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  tools,
  _internals: { startSupervisor, stopSupervisor, statusPayload, parseSupervisorLog, BIN },
};
