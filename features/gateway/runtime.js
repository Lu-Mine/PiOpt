"use strict";

/**
 * Gateway runtime: the plugin itself starts and stops the two gateway processes.
 *
 * Nothing outside the plugin is involved: no supervisor, no supervisor.json, no
 * autostart script. The trade-off is crash cleanup. Windows does not kill
 * children when their parent dies, and Node has no Job Object, so a crashed or
 * force-killed plugin host leaves the children running. Every spawn is therefore
 * recorded in <data>/gateway/run.json, and the next load reaps those pids, but
 * only after the live process is checked against what we would have started.
 */

const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const probe = require("./probe.js");

const RUN_FILE = "run.json";
const LOG_NAMES = ["runtime", "gateway", "wb2api"];
const LOG_ALIASES = { supervisor: "runtime", workbuddy: "wb2api" };

function msg(error) {
  return error && error.message ? error.message : String(error);
}

function norm(value) {
  return path.resolve(String(value || "")).toLowerCase();
}

function specsFor(root, ports = {}) {
  const wbPort = ports.workbuddy || probe.WORKBUDDY_PORT;
  const gwPort = ports.gateway || probe.GATEWAY_PORT;
  return [
    {
      name: "wb2api",
      key: "workbuddy",
      cmd: "python",
      args: ["wb_proxy.py", "--port", String(wbPort), "--accounts-dir", path.join(root, "workbuddy", "accounts")],
      cwd: path.join(root, "workbuddy"),
      entry: path.join(root, "workbuddy", "wb_proxy.py"),
      port: wbPort,
    },
    {
      name: "gateway",
      key: "gateway",
      cmd: path.join(root, "cliproxy", "cli-proxy-api.exe"),
      args: ["-config", "config.yaml"],
      cwd: path.join(root, "cliproxy"),
      entry: path.join(root, "cliproxy", "cli-proxy-api.exe"),
      port: gwPort,
    },
  ];
}

// Is this live process the one a spec would have started?
function matchesSpec(info, spec) {
  if (!info || !info.exe) return false;
  const exe = norm(info.exe);
  if (spec.name === "gateway") return exe === norm(spec.cmd);
  const cmdline = String(info.cmdline || "").toLowerCase();
  return path.basename(exe).startsWith("python") && cmdline.includes("wb_proxy.py");
}

function isLegacySupervisor(info, root) {
  if (!info || !info.exe) return false;
  const exe = norm(info.exe);
  return path.basename(exe) === "ai-gateway-mcp.exe" && exe.startsWith(norm(root) + path.sep);
}

function resolveLogFile(component, logDir) {
  const name = LOG_ALIASES[component] || component;
  if (!LOG_NAMES.includes(name) || !logDir) return null;
  const base = path.resolve(logDir);
  const file = path.resolve(base, `${name}.log`);
  return file.startsWith(base + path.sep) ? file : null;
}

// ---------------------------------------------------------------------------
// Windows process helpers (system tools only: powershell, taskkill)
// ---------------------------------------------------------------------------

function powershell(script, timeoutMs = 8000) {
  return new Promise(resolve => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: timeoutMs },
      (error, stdout) => resolve(error ? "" : String(stdout || "")),
    );
  });
}

function parseJsonList(text) {
  try {
    const value = JSON.parse(String(text || "").trim());
    return Array.isArray(value) ? value : value ? [value] : [];
  } catch {
    return [];
  }
}

async function inspectPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const out = await powershell(
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [pscustomobject]@{ exe = $p.ExecutablePath; cmdline = $p.CommandLine } | ConvertTo-Json -Compress }`,
  );
  const [row] = parseJsonList(out);
  return row ? { pid, exe: String(row.exe || ""), cmdline: String(row.cmdline || "") } : null;
}

async function portOwners(port) {
  const out = await powershell(
    `Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
  );
  return out.split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0);
}

async function legacySupervisors(root) {
  const out = await powershell(
    `Get-CimInstance Win32_Process -Filter "Name='ai-gateway-mcp.exe'" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; exe = $_.ExecutablePath; cmdline = $_.CommandLine } } | ConvertTo-Json -Compress`,
  );
  return parseJsonList(out)
    .map(row => ({ pid: Number(row.pid), exe: String(row.exe || ""), cmdline: String(row.cmdline || "") }))
    .filter(info => Number.isInteger(info.pid) && isLegacySupervisor(info, root));
}

function killTree(pid) {
  return new Promise(resolve => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

function createRuntime(deps = {}) {
  const d = {
    spawn,
    inspectPid,
    portOwners,
    legacySupervisors,
    killTree,
    probeGateway: probe.probeGateway,
    waitPortsClosed: probe.waitPortsClosed,
    now: () => Date.now(),
    ...deps,
  };
  const children = new Map(); // name -> { child, pid, startedAt, spec, exited }
  let lastError = "";

  function log(ctx, text) {
    try {
      fs.mkdirSync(ctx.logDir, { recursive: true });
      fs.appendFileSync(path.join(ctx.logDir, "runtime.log"), `${new Date().toISOString()} ${text}\n`);
    } catch {
      /* logging must never break the lifecycle */
    }
  }

  function runFile(ctx) {
    return path.join(ctx.stateDir, RUN_FILE);
  }

  function readRun(ctx) {
    try {
      const doc = JSON.parse(fs.readFileSync(runFile(ctx), "utf8"));
      return doc && typeof doc === "object" && doc.children && typeof doc.children === "object" ? doc : { children: {} };
    } catch {
      return { children: {} };
    }
  }

  function writeRun(ctx) {
    const doc = { root: ctx.root, children: {} };
    for (const [name, entry] of children) {
      if (entry.pid) doc.children[name] = { pid: entry.pid, cmd: entry.spec.cmd, startedAt: entry.startedAt };
    }
    try {
      fs.mkdirSync(ctx.stateDir, { recursive: true });
      fs.writeFileSync(runFile(ctx), JSON.stringify(doc, null, 2));
    } catch (error) {
      log(ctx, `写 run.json 失败: ${msg(error)}`);
    }
  }

  function alive(name) {
    const entry = children.get(name);
    return Boolean(entry && !entry.exited && entry.child && entry.child.exitCode === null);
  }

  // Kill what a previous, crashed load left behind. A recorded pid is only
  // killed when the live process still matches the spec it was started from,
  // so a recycled pid is never touched.
  async function reap(ctx) {
    const run = readRun(ctx);
    const reaped = [];
    for (const spec of specsFor(run.root || ctx.root, ctx.ports)) {
      const record = run.children[spec.name];
      if (!record || alive(spec.name)) continue;
      const pid = Number(record.pid);
      const info = await d.inspectPid(pid);
      if (!matchesSpec(info, spec)) continue;
      log(ctx, `收回上次残留的 ${spec.name} pid=${pid}`);
      await d.killTree(pid);
      reaped.push(spec.name);
    }
    if (reaped.length) await d.waitPortsClosed(ctx.ports);
    return reaped;
  }

  function spawnOne(ctx, spec) {
    let fd = null;
    try {
      fs.mkdirSync(ctx.logDir, { recursive: true });
      fd = fs.openSync(path.join(ctx.logDir, `${spec.name}.log`), "a");
      const child = d.spawn(spec.cmd, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...((ctx.childEnv && ctx.childEnv[spec.name]) || {}) },
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      });
      const entry = { child, pid: child.pid, startedAt: d.now(), spec, exited: false };
      children.set(spec.name, entry);
      const forget = () => {
        entry.exited = true;
        if (children.get(spec.name) === entry) children.delete(spec.name);
        writeRun(ctx);
      };
      child.on("error", error => {
        lastError = `${spec.name}: ${msg(error)}`;
        log(ctx, `启动 ${spec.name} 失败: ${msg(error)}`);
        forget();
      });
      child.on("exit", (code, signal) => {
        log(ctx, `${spec.name} 退出 code=${code} signal=${signal}`);
        forget();
      });
      log(ctx, `启动 ${spec.name} pid=${child.pid}`);
      return { ok: true, pid: child.pid };
    } catch (error) {
      const text = `${spec.name}: ${msg(error)}`;
      log(ctx, `启动失败 ${text}`);
      return { ok: false, error: text };
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* the child holds its own handle */
        }
      }
    }
  }

  async function start(ctx, { skipProbe = false } = {}) {
    const reaped = await reap(ctx);
    const listening = skipProbe || !ctx.probeEnabled
      ? { gateway: false, workbuddy: false }
      : await d.probeGateway(ctx.ports);
    const result = { ok: true, reaped, started: [], reused: [], already: [], errors: [] };
    for (const spec of specsFor(ctx.root, ctx.ports)) {
      if (alive(spec.name)) {
        result.already.push(spec.name);
        continue;
      }
      if (listening[spec.key]) {
        result.reused.push(spec.name);
        log(ctx, `${spec.name} 端口 ${spec.port} 已有实例在监听，复用，不另起`);
        continue;
      }
      if (!fs.existsSync(spec.entry)) {
        const text = `找不到 ${spec.entry}`;
        result.errors.push(text);
        log(ctx, text);
        continue;
      }
      const spawned = spawnOne(ctx, spec);
      if (spawned.ok) result.started.push(spec.name);
      else result.errors.push(spawned.error);
    }
    writeRun(ctx);
    if (result.errors.length) {
      result.ok = false;
      result.error = result.errors.join("；");
    }
    lastError = result.error || "";
    return result;
  }

  async function stop(ctx) {
    const list = [...children.values()];
    children.clear();
    await Promise.all(list.map(async entry => {
      entry.exited = true;
      log(ctx, `停止 ${entry.spec.name} pid=${entry.pid}`);
      if (entry.pid) await d.killTree(entry.pid);
    }));
    writeRun(ctx);
    return list.map(entry => entry.spec.name);
  }

  async function status(ctx) {
    const listening = await d.probeGateway(ctx.ports);
    const components = {};
    for (const spec of specsFor(ctx.root, ctx.ports)) {
      const owned = alive(spec.name);
      const entry = children.get(spec.name);
      components[spec.key] = {
        name: spec.name,
        port: spec.port,
        ready: Boolean(listening[spec.key]),
        mode: owned ? "owned" : listening[spec.key] ? "reused" : "stopped",
        pid: owned ? entry.pid : null,
        uptimeSeconds: owned ? Math.round((d.now() - entry.startedAt) / 1000) : null,
      };
    }
    const modes = Object.values(components).map(item => item.mode);
    const mode = modes.includes("reused") ? "reused" : modes.includes("owned") ? "owned" : "stopped";
    return { mode, components, lastError: lastError || null };
  }

  // Every root an occupant may legitimately come from: the current one plus,
  // during a migration, the one we are moving away from.
  function rootsOf(ctx) {
    return [ctx.root, ...(Array.isArray(ctx.altRoots) ? ctx.altRoots : [])].filter(Boolean);
  }

  // Stop everything that is this gateway: our own children, verified foreign
  // occupants of the ports, and any old supervisor under a known root. Every
  // port owner is checked first; one unknown process aborts before anything
  // is killed.
  async function release(ctx) {
    const listening = await d.probeGateway(ctx.ports);
    const roots = rootsOf(ctx);
    const targets = [];
    for (const spec of specsFor(ctx.root, ctx.ports)) {
      if (alive(spec.name) || !listening[spec.key]) continue;
      const pids = await d.portOwners(spec.port);
      if (!pids.length) return { ok: false, error: `查不到占用端口 ${spec.port} 的进程，未接管。` };
      for (const pid of pids) {
        const info = await d.inspectPid(pid);
        const known = roots.some(root => matchesSpec(info, specsFor(root, ctx.ports).find(item => item.name === spec.name)));
        if (!known) {
          const who = info && info.exe ? info.exe : `pid ${pid}`;
          return { ok: false, error: `端口 ${spec.port} 被其他程序占用（${who}），不是这套网关，未接管。` };
        }
        targets.push({ name: spec.name, pid });
      }
    }
    const legacy = [];
    for (const root of roots) legacy.push(...(await d.legacySupervisors(root)));
    for (const sup of legacy) {
      log(ctx, `结束旧 supervisor pid=${sup.pid}`);
      await d.killTree(sup.pid);
    }
    for (const target of targets) {
      log(ctx, `接管：结束外部启动的 ${target.name} pid=${target.pid}`);
      await d.killTree(target.pid);
    }
    const stopped = await stop(ctx);
    if (!(await d.waitPortsClosed(ctx.ports))) {
      return { ok: false, error: "网关端口未在 8 秒内释放。" };
    }
    return { ok: true, stopped, takenOver: targets.map(target => target.name), legacyStopped: legacy.map(sup => sup.pid) };
  }

  // Replace instances someone else started (the old supervisor, the autostart
  // script) with our own.
  async function takeover(ctx) {
    const released = await release(ctx);
    if (!released.ok) return released;
    const started = await start(ctx, { skipProbe: true });
    return { ...started, takenOver: released.takenOver, legacyStopped: released.legacyStopped };
  }

  async function restart(ctx) {
    const current = await status(ctx);
    if (current.mode === "reused") return takeover(ctx);
    const stopped = await stop(ctx);
    if (stopped.length && !(await d.waitPortsClosed(ctx.ports))) {
      return { ok: false, stopped, error: "旧实例的端口未在 8 秒内释放，未重新启动。" };
    }
    return { stopped, ...(await start(ctx, { skipProbe: true })) };
  }

  return { start, stop, status, restart, takeover, release, reap, alive, log, _children: children };
}

module.exports = {
  RUN_FILE,
  LOG_NAMES,
  LOG_ALIASES,
  specsFor,
  matchesSpec,
  isLegacySupervisor,
  resolveLogFile,
  createRuntime,
};
