"use strict";

/**
 * Gateway feature: owns the lifecycle of the local AI gateway.
 *
 * The plugin process itself spawns the two gateway children (wb2api on 8318,
 * cli-proxy-api on 8317). Nothing outside the plugin starts or watches them.
 *
 *   - onLoad: reap what a crashed previous load left behind (pids recorded in
 *     <data>/gateway-runtime/run.json, killed only when the live process still
 *     matches), probe the ports, then spawn whatever is not already listening.
 *   - onUnload: kill both process trees.
 *   - A crash of the plugin process leaves the children running until the
 *     next load reaps them. That window is the accepted trade-off for keeping
 *     every moving part inside the plugin.
 *
 * Everything here is best effort: a missing binary or a refused spawn must
 * degrade to "tools report not running", never to a broken plugin load.
 */

const fs = require("fs");
const path = require("path");
const migration = require("./migrate.js");
const services = require("./services.js");
const probe = require("./probe.js");
const paths = require("./paths.js");
const runtime = require("./runtime.js");

const TOOL_NAMES = ["gateway_status", "gateway_restart", "gateway_logs"];

const rt = runtime.createRuntime();
services.setOwnership(() => rt.alive("gateway"));

// The management key goes to cli-proxy-api as MANAGEMENT_PASSWORD, so it never
// lands in config.yaml and is never hashed there. Measured on 2026-10-30: with
// an empty secret-key the env key alone enables the management routes.
async function childEnv() {
  try {
    return { gateway: { MANAGEMENT_PASSWORD: await services.secretStore.getOrCreate("managementKey") } };
  } catch (error) {
    lastError = `管理密钥不可用: ${error && error.message ? error.message : error}`;
    return {};
  }
}
let lastError = "";

async function context() {
  const settings = await services.readSettings();
  let dataDir = "";
  try {
    dataDir = await pi.plugin.getDataPath();
  } catch {
    /* no data dir: state falls back to a temp folder */
  }
  const picked = paths.pickRoot({ setting: settings.gatewayRoot, dataDir });
  const stateDir = paths.stateDir(dataDir);
  return {
    root: picked.root,
    rootSource: picked.source,
    dataDir,
    // After a migration the old install may still be running; its processes
    // count as ours for takeover.
    altRoots: picked.source === "legacy" ? [] : [paths.legacyRoot()],
    stateDir,
    logDir: stateDir,
    probeEnabled: settings.gatewayProbeEnabled !== false,
    childEnv: await childEnv(),
    ports: undefined,
  };
}

function readTail(file, lines) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const rows = raw.replace(/\r/g, "").trimEnd().split("\n");
    return rows.slice(Math.max(0, rows.length - lines)).join("\n");
  } catch (error) {
    return `读不到 ${file}: ${error && error.message ? error.message : error}`;
  }
}

async function startGateway(ctx) {
  const c = ctx || (await context());
  const result = await rt.start(c);
  lastError = result.error || "";
  return result;
}

// owned: we spawned it. reused: the port answers but the process is not ours
// (the old supervisor or autostart script). stopped: nothing listens.
async function statusPayload(ctx) {
  const c = ctx || (await context());
  const state = await rt.status(c);
  const gateway = state.components.gateway;
  const tail = readTail(runtime.resolveLogFile("runtime", c.logDir), 12);
  return {
    ok: state.mode !== "stopped",
    mode: state.mode,
    root: c.root,
    rootSource: c.rootSource,
    process: gateway && gateway.pid ? { pid: gateway.pid, uptimeSeconds: gateway.uptimeSeconds } : null,
    components: state.components,
    lastError: state.lastError || lastError || null,
    logTail: tail.split("\n"),
  };
}

async function restartGateway(ctx) {
  const c = ctx || (await context());
  const result = await rt.restart(c);
  lastError = result.error || "";
  return result;
}

// Copy the gateway into <data>/gateway once. The old install is never
// touched: stop it, copy and verify, start from the copy. Any failure starts
// the old install again so the gateway never stays down.
let migrationJob = null;

function migrationState() {
  return migrationJob ? { ...migrationJob } : { phase: "idle" };
}

async function startMigration() {
  if (migrationJob && ["stopping", "copy", "starting"].includes(migrationJob.phase)) return { ok: true, ...migrationState() };
  const ctx = await context();
  if (ctx.rootSource !== "legacy") return { ok: false, error: "网关已不在旧目录，无需迁移。" };
  if (!ctx.dataDir) return { ok: false, error: "拿不到插件数据目录，无法迁移。" };
  const src = ctx.root;
  const dest = path.join(ctx.dataDir, "gateway");
  migrationJob = { phase: "stopping", done: 0, total: 0, startedAt: Date.now() };
  (async () => {
    const released = await rt.release(ctx);
    if (!released.ok) throw new Error(released.error);
    await migration.migrate({ src, dest, onProgress: info => Object.assign(migrationJob, info) });
    migrationJob.phase = "starting";
    const next = await context();
    const started = await startGateway(next);
    if (!started.ok) throw new Error(started.error || "新目录启动失败");
    migrationJob = { ...migrationJob, phase: "done", root: next.root, finishedAt: Date.now() };
  })().catch(async error => {
    const text = error && error.message ? error.message : String(error);
    rt.log(ctx, `迁移失败: ${text}`);
    migrationJob = { ...migrationJob, phase: "failed", error: text, finishedAt: Date.now() };
    try {
      await startGateway(await context());
    } catch {
      /* status shows what is still down */
    }
  });
  return { ok: true, ...migrationState() };
}

const tools = {
  gateway_status: {
    description:
      "Report whether the local AI gateway is running: mode (owned/reused/stopped), per-component pid and port state, and the tail of the runtime log. Read-only.",
    risk: "low",
    schema: { type: "object", properties: {} },
    execute: async () => statusPayload(),
  },

  gateway_restart: {
    description:
      "Restart the local AI gateway. Our own children are stopped and respawned; an instance started outside the plugin is verified and taken over. Returns once the processes are spawned, not when the ports are ready.",
    risk: "medium",
    schema: { type: "object", properties: {} },
    execute: async () => {
      const result = await restartGateway();
      return { ...result, ok: Boolean(result.ok), hint: "端口就绪要几秒，随后用 gateway_status 复核。" };
    },
  },

  gateway_logs: {
    description: "Read the tail of a gateway log. Use component=runtime|gateway|wb2api.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        component: { type: "string", description: "runtime (default), gateway or wb2api." },
        lines: { type: "number", description: "How many trailing lines, default 40." },
      },
    },
    execute: async args => {
      const component = typeof args?.component === "string" && args.component.trim() ? args.component.trim() : "runtime";
      const lines = Number.isFinite(args?.lines) && args.lines > 0 ? Math.min(400, Math.floor(args.lines)) : 40;
      const ctx = await context();
      const file = runtime.resolveLogFile(component, ctx.logDir);
      if (!file) return { ok: false, component, error: `component 只能是 ${runtime.LOG_NAMES.join("|")}` };
      return { component, path: file, text: readTail(file, lines) };
    },
  },
};

async function onLoad() {
  startGateway().catch(error => {
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
  try {
    await rt.stop(await context());
  } catch {
    /* the next load reaps anything left */
  }
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
    case "gateway.migrate":
      return startMigration();
    case "gateway.migrateStatus":
      return migrationState();
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
  _internals: { rt, context, startGateway, statusPayload, restartGateway, startMigration, migrationState },
};
