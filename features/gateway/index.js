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
const services = require("./services.js");
const probe = require("./probe.js");

const GATEWAY_DIR = "C:/Users/Avencess/ai-gateway";
const BIN = path.join(GATEWAY_DIR, "bin", "ai-gateway-mcp.exe");
const LOG_DIR = path.join(GATEWAY_DIR, "bin", "logs");
const SUPERVISOR_LOG = path.join(LOG_DIR, "supervisor.log");

const TOOL_NAMES = ["gateway_status", "gateway_restart", "gateway_logs"];
const LOG_COMPONENTS = ["supervisor", "gateway", "workbuddy"];

// Only the known component logs, and only inside LOG_DIR. Returns null otherwise.
function resolveLogFile(component, logDir = LOG_DIR) {
  if (!LOG_COMPONENTS.includes(component)) return null;
  const base = path.resolve(logDir);
  const file = path.resolve(base, `${component}.log`);
  return file.startsWith(base + path.sep) ? file : null;
}

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

async function probeEnabled() {
  const settings = await services.readSettings();
  return settings.gatewayProbeEnabled !== false;
}

// Probe first: if 8317/8318 already answer, someone else (start-gateway.vbs, an
// earlier PI-Desktop) runs the gateway, and a second supervisor would only fail
// to bind. Reuse it instead. The probe can be bypassed via gatewayProbeEnabled.
async function startSupervisor({ bin = BIN, ports, skipProbe } = {}) {
  if (alive()) return { ok: true, already: true };
  if (!skipProbe && (await probeEnabled())) {
    const listening = await probe.probeGateway(ports);
    if (listening.gateway || listening.workbuddy) {
      lastError = "";
      return { ok: true, reused: true, listening };
    }
  }
  if (!fs.existsSync(bin)) {
    lastError = `找不到 ${bin}`;
    return { ok: false, error: lastError };
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    child = spawn(bin, ["--parent-pid", String(process.pid)], {
      cwd: path.dirname(bin),
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

// owned: we spawned the supervisor. reused: the ports answer but the process is
// not ours. stopped: nothing listens.
async function statusPayload({ ports } = {}) {
  const { manager, tail } = parseSupervisorLog();
  const listening = await probe.probeGateway(ports);
  const owned = alive();
  const mode = owned ? "owned" : listening.gateway || listening.workbuddy ? "reused" : "stopped";
  return {
    ok: mode !== "stopped",
    mode,
    supervisor: owned ? { pid: child.pid, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) } : null,
    manager,
    components: {
      workbuddy: { port: probe.WORKBUDDY_PORT, ready: listening.workbuddy },
      gateway: { port: probe.GATEWAY_PORT, ready: listening.gateway },
    },
    lastError: lastError || null,
    logTail: tail.split("\n").slice(-12),
  };
}

// Only a supervisor we spawned can be restarted. For a reused instance we say so
// instead of killing a process we do not own.
async function restartGateway({ bin, ports } = {}) {
  if (!alive()) {
    const listening = await probe.probeGateway(ports);
    if (listening.gateway || listening.workbuddy) {
      return { ok: false, stopped: false, reused: true, error: "网关由外部进程启动（复用已有实例），插件无法重启它；请先关掉外部实例。" };
    }
    return { stopped: false, ...(await startSupervisor({ bin, ports })) };
  }
  stopSupervisor();
  const closed = await probe.waitPortsClosed(ports);
  if (!closed) return { ok: false, stopped: true, error: "旧实例的端口未在 8 秒内释放，未重新启动。" };
  return { stopped: true, ...(await startSupervisor({ bin, ports, skipProbe: true })) };
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
      const result = await restartGateway();
      return { ...result, ok: Boolean(result.ok), hint: "端口就绪要几秒，随后用 gateway_status 复核。" };
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
      const file = resolveLogFile(component);
      if (!file) return { ok: false, component, error: `component 只能是 ${LOG_COMPONENTS.join("|")}` };
      return { component, path: file, text: readTail(file, lines) };
    },
  },
};

async function onLoad() {
  startSupervisor().catch(error => {
    lastError = error && error.message ? error.message : String(error);
  });
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
function localHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}



function oauthUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function onPanelInvoke(channel, payload = {}) {
  switch (channel) {
    case "gateway.status":
      return statusPayload();
    case "gateway.overview":
      return services.overview();
    case "gateway.usage":
      return services.usage(payload.range);
    case "gateway.quota":
      return services.antigravity();
    case "gateway.open":
      if (payload.kind === "panel") {
        const url = localHttpUrl(payload.url);
        if (!url) throw new Error("只允许打开本机面板");
        await pi.shell.openExternal(url);
        return { ok: true };
      }
      if (payload.kind === "oauth") {
        const url = oauthUrl(payload.url);
        if (!url) throw new Error("OAuth 地址无效");
        await pi.shell.openExternal(url);
        return { ok: true };
      }
      throw new Error("不支持的打开方式");
    case "gateway.keys":
      return services.keyAction(payload);
    case "gateway.credentials":
      return services.cpAction(payload);
    case "gateway.accounts":
      return services.wbAction(payload);
    case "gateway.restart":
      return restartGateway();
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
  _internals: { startSupervisor, stopSupervisor, restartGateway, statusPayload, parseSupervisorLog, resolveLogFile, BIN },
};
