"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const data = require("../features/gateway/data.js");
const root = path.join(__dirname, "..");

function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// Load services.js against a local mock instead of the real gateway: the two
// base URLs are rewritten, and relative requires resolve from the feature dir.
async function mockServices(t, handler) {
  const server = await listen(handler);
  const port = server.address().port;
  const file = require.resolve("../features/gateway/services.js");
  const source = fs.readFileSync(file, "utf8")
    .replace("http://127.0.0.1:8317", `http://127.0.0.1:${port}`)
    .replace("http://127.0.0.1:8318", `http://127.0.0.1:${port}`);
  const module = { exports: {} };
  const moduleDir = path.dirname(file);
  const localRequire = id => require(id.startsWith(".") ? path.join(moduleDir, id) : id);
  new Function("require", "module", "exports", source)(localRequire, module, module.exports);
  t.after(() => server.close());
  return module.exports;
}

async function readBody(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
}

function json(response, value, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

test("gateway transforms keep secrets out of account and credential views", () => {
  const accounts = data.accountRows({ accounts: [{
    uid: "u1", nickname: "主账号", enabled: true, tokenExpired: false,
    dailyTokensToday: 1200, credits: { remain: 75, size: 100, used: 25 },
    accessToken: "must-not-leak", refreshToken: "must-not-leak",
  }] });
  assert.deepEqual(accounts, [{
    uid: "u1", name: "主账号", realm: "", enabled: true, available: true,
    remain: 75, total: 100, used: 25, tokens: 1200, error: "",
  }]);
  assert.equal(JSON.stringify(accounts).includes("must-not-leak"), false);
  assert.deepEqual(data.poolSummary(accounts), { remain: 75, total: 100, used: 25, tokens: 1200, available: 1 });
  assert.equal(data.accountAvailable({ enabled: true, inCooldown: true }), false);
  assert.equal(data.accountAvailable({ enabled: false }), false);
});

test("Antigravity percentages use five-hour buckets and the three requested groups", () => {
  const groups = [
    { displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0.8 }] },
    { displayName: "Claude and GPT", buckets: [{ window: "weekly", remainingFraction: 0.65 }] },
    { displayName: "Argon 4", buckets: [{ window: "5h", remainingFraction: 0.4 }] },
  ];
  const result = data.aggregateAntigravity(
    [{ email: "one@example.com" }, { email: "two@example.com" }],
    [
      { email: "one@example.com", summary: { groups } },
      { email: "two@example.com", summary: { groups } },
    ],
  );
  assert.deepEqual(result.map(group => [group.id, group.percent, group.accounts]), [
    ["gemini", 80, 2], ["claude-gpt", 65, 2], ["argon", 40, 2],
  ]);
});

test("API keys support add, label and delete with hashed ids", async t => {
  let keys = ["sk-original-123456"];
  const writes = [];
  const copied = [];
  global.pi = {
    clipboard: { async writeText(text) { copied.push(text); } },
    plugin: {
      settings: { gatewayManagementKey: "test-management-key" },
      async getSettings() { return this.settings; },
      async setSettings(patch) { Object.assign(this.settings, patch); },
    },
  };
  const service = await mockServices(t, async (request, response) => {
    if (request.url === "/v8/management/config/access/api-keys") {
      if (request.method === "PUT") {
        keys = await readBody(request);
        writes.push(keys.slice());
      }
      return json(response, keys);
    }
    if (request.url === "/v8/management/credentials") return json(response, { files: [] });
    if (request.url === "/v1/models") return json(response, { data: [] });
    if (request.url === "/panel/login") return json(response, { token: "panel" });
    if (request.url.startsWith("/accounts")) return json(response, { accounts: [] });
    json(response, {}, 404);
  });
  t.after(() => { delete global.pi; });

  const added = await service.keyAction({ action: "add", key: "sk-new-key-123456", label: "工作机" });
  assert.equal(added.ok, true);
  assert.equal(keys.length, 2);
  assert.equal(pi.plugin.settings.gatewayKeyLabels[added.id], "工作机");
  await service.keyAction({ action: "label", id: added.id, label: "笔记本" });
  const overview = await service.overview();
  const view = overview.keys.find(key => key.id === added.id);
  assert.equal(view.label, "笔记本");
  assert.equal(view.key, undefined);
  assert.ok(!JSON.stringify(overview.keys).includes("sk-new-key-123456"));
  assert.match(view.mask, /…/);
  await service.keyAction({ action: "copy", id: added.id });
  assert.deepEqual(copied, ["sk-new-key-123456"]);
  await service.keyAction({ action: "delete", id: added.id });
  assert.deepEqual(keys, ["sk-original-123456"]);
  assert.equal(writes.length, 2);
  assert.equal(overview.accounts.length, 0);
  assert.deepEqual(overview.pool, { remain: 0, total: 0, used: 0, tokens: 0, available: 0 });
});

test("credential and account actions preserve upstream request contracts", async t => {
  const calls = [];
  global.pi = { plugin: { getSettings: async () => ({ gatewayManagementKey: "test-management-key" }) } };
  const service = await mockServices(t, async (request, response) => {
    const payload = await readBody(request);
    calls.push({ method: request.method, url: request.url, payload, panel: request.headers["x-panel-token"] });
    if (request.url === "/panel/login") return json(response, { token: "session" });
    json(response, { ok: true, state: "oauth-state", authUrl: "https://example.com/oauth" });
  });
  t.after(() => { delete global.pi; });

  await service.cpAction({ action: "refresh", all: true });
  await service.cpAction({ action: "refresh", name: "a.json", authIndex: "4" });
  await service.cpAction({ action: "delete", name: "a.json" });
  await service.cpAction({ action: "oauthStart", provider: "antigravity" });
  await service.cpAction({ action: "oauthCallback", provider: "antigravity", url: "http://localhost/callback?code=x" });
  await service.wbAction({ action: "checkin" });
  await service.wbAction({ action: "credits" });
  await service.wbAction({ action: "refresh" });
  await service.wbAction({ action: "toggle", uid: "u1", enabled: false });
  await service.wbAction({ action: "delete", uid: "u1" });
  await service.wbAction({ action: "oauthStart", realm: "cn" });

  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ["POST", "/v8/management/credentials/refresh"],
    ["POST", "/v8/management/credentials/refresh"],
    ["DELETE", "/v8/management/credentials"],
    ["GET", "/v8/management/oauth/auth-url?provider=antigravity&is_webui=true"],
    ["POST", "/v8/management/oauth/callback"],
    ["POST", "/panel/login"],
    ["POST", "/accounts/checkin"],
    ["POST", "/accounts/credits/fetch"],
    ["POST", "/accounts/refresh"],
    ["POST", "/accounts/set"],
    ["POST", "/accounts/delete"],
    ["POST", "/accounts/login/start"],
  ]);
  assert.deepEqual(calls[0].payload, { all: true });
  assert.deepEqual(calls[1].payload, { name: "a.json", auth_index: "4" });
  assert.deepEqual(calls[2].payload, { names: ["a.json"] });
  assert.deepEqual(calls[9].payload, { uid: "u1", enabled: false });
  assert.deepEqual(calls[10].payload, { uid: "u1" });
  assert.deepEqual(calls[11].payload, { platform: "CLI", realm: "cn" });
  assert.equal(calls[6].panel, "session");
  await assert.rejects(() => service.cpAction({ action: "oauthStart", provider: "unknown" }), /不支持/);
});

// 回归：config.yaml 的 secret-key 被 CLIProxyAPI 哈希回写后，若还把它当明文发出去，
// 每次 401 都会累计失败次数，最终把本机 IP 封禁 30 分钟（曾真实发生）。
test("bcrypt management key is never sent, so no request can trip the IP ban", async t => {
  const hits = [];
  global.pi = { plugin: { getSettings: async () => ({}) } };
  const service = await mockServices(t, async (request, response) => {
    hits.push(request.url);
    if (request.url === "/v1/models") return json(response, { data: [] });
    if (request.url === "/panel/login") return json(response, { token: "panel" });
    if (request.url.startsWith("/accounts")) return json(response, { accounts: [] });
    json(response, { files: [] });
  });
  t.after(() => { delete global.pi; });

  await assert.rejects(() => service.cpAction({ action: "refresh", all: true }), /缺少管理密钥/);
  await service.overview();
  assert.deepEqual(hits.filter(url => url.includes("/v8/management")), []);
});

test("usage supports all six ranges and returns real analytics shapes", async t => {
  const urls = [];
  global.pi = { plugin: { getSettings: async () => ({}) } };
  const service = await mockServices(t, async (request, response) => {
    urls.push(request.url);
    if (request.url === "/panel/login") return json(response, { token: "session" });
    if (request.url.startsWith("/usage/analytics")) return json(response, { summary: { window: { total_tokens: 42 } } });
    if (request.url.startsWith("/usage/timeseries")) return json(response, { series: [], bucket_seconds: 60 });
    if (request.url.startsWith("/usage/recent")) return json(response, { rows: [], total: 0 });
    json(response, {}, 404);
  });
  t.after(() => { delete global.pi; });

  for (const range of ["today", "d3", "week", "month", "d30", "all"]) {
    const result = await service.usage(range);
    assert.equal(result.range, range);
    assert.equal(result.analytics.summary.window.total_tokens, 42);
  }
  assert.equal(urls.filter(url => url.includes("range=custom")).length, 6);
  assert.equal(urls.some(url => url.includes("range=week")), true);
  assert.equal(urls.some(url => url.includes("range=month")), true);
});

test("gateway page keeps only the requested sections and sticky process status", () => {
  const script = fs.readFileSync(path.join(root, "renderer/gateway.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "renderer/gateway.css"), "utf8");
  for (const text of [
    "连接", "上游", "用量", "重启", "全部签到",
    "刷新积分", "刷新凭证", "OAuth 授权", "近 30 天",
  ]) {
    assert.ok(script.includes(text), text);
  }
  for (const removed of ["egress", "runCredits", "creditsCard", "Clash 出口", "发送到已停用", "保存连接", "gw-connection-fields", "管理密钥（"]) {
    assert.equal(script.includes(removed), false, removed);
  }
  assert.match(css, /\.gw-statusbar\s*\{[^}]*position:\s*sticky/s);
  assert.match(css, /\.gw-statusbar\s*\{[^}]*top:\s*0/s);
  assert.ok(fs.existsSync(path.join(root, "renderer/model-logos/deepseek.svg")));
  assert.ok(fs.existsSync(path.join(root, "renderer/model-logos/gemini.svg")));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("shell.openExternal"));
  assert.equal(new Set(manifest.permissions).size, manifest.permissions.length);
});

test("gateway_logs only reads whitelisted component logs inside the runtime dir", async t => {
  const runtime = require("../features/gateway/runtime.js");
  const dir = path.join(root, "tmp-logs");
  assert.equal(runtime.resolveLogFile("runtime", dir), path.join(dir, "runtime.log"));
  assert.equal(runtime.resolveLogFile("supervisor", dir), path.join(dir, "runtime.log"));
  assert.equal(runtime.resolveLogFile("workbuddy", dir), path.join(dir, "wb2api.log"));
  for (const bad of ["../../x", "..\\..\\x", "gateway/../../x", "C:/Windows/win", "", "other"]) {
    assert.equal(runtime.resolveLogFile(bad, dir), null, bad);
  }
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "piopt-logs-"));
  global.pi = { plugin: { getSettings: async () => ({}), getDataPath: async () => tmp } };
  t.after(() => { delete global.pi; fs.rmSync(tmp, { recursive: true, force: true }); });
  const gateway = require("../features/gateway/index.js");
  const result = await gateway.tools.gateway_logs.execute({ component: "../../x" });
  assert.equal(result.ok, false);
  assert.equal(result.text, undefined);
});

// ---- stage 1/3: probe + in-plugin lifecycle --------------------------------
// Real ports come from local servers; processes are fakes, so no test can
// spawn or kill anything real.
async function freePort() {
  const server = await listen(() => {});
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function tmpRoot(t, withFiles) {
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piopt-gw-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rootDir = path.join(dir, "root");
  if (withFiles) {
    fs.mkdirSync(path.join(rootDir, "cliproxy"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "workbuddy"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "cliproxy", "cli-proxy-api.exe"), "");
    fs.writeFileSync(path.join(rootDir, "workbuddy", "wb_proxy.py"), "");
  }
  const stateDir = path.join(dir, "state");
  return { root: rootDir, stateDir, logDir: stateDir };
}

function fakeProcesses() {
  const { EventEmitter } = require("node:events");
  let next = 5000;
  const spawned = [];
  const killed = [];
  return {
    spawned,
    killed,
    spawn(cmd, args, options) {
      const child = new EventEmitter();
      child.pid = next++;
      child.exitCode = null;
      spawned.push({ cmd, args, cwd: options.cwd, pid: child.pid });
      return child;
    },
    async killTree(pid) { killed.push(pid); },
    async waitPortsClosed() { return true; },
    async legacySupervisors() { return []; },
  };
}

test("probe tells a listening port from a closed one", async t => {
  const probe = require("../features/gateway/probe.js");
  const server = await listen(() => {});
  t.after(() => server.close());
  const open = server.address().port;
  const closed = await freePort();
  assert.equal(await probe.isListening(open), true);
  assert.equal(await probe.isListening(closed), false);
  assert.deepEqual(await probe.probeGateway({ gateway: open, workbuddy: closed }), { gateway: true, workbuddy: false });
});

test("start reuses a listening component and only spawns what is missing", async t => {
  const runtime = require("../features/gateway/runtime.js");
  const server = await listen(() => {});
  t.after(() => server.close());
  const ports = { gateway: server.address().port, workbuddy: await freePort() };
  const fake = fakeProcesses();
  const rt = runtime.createRuntime({ ...fake, inspectPid: async () => null, portOwners: async () => [] });
  const ctx = { ...tmpRoot(t, true), probeEnabled: true, ports };

  const started = await rt.start(ctx);
  assert.equal(started.ok, true);
  assert.deepEqual(started.reused, ["gateway"]);
  assert.deepEqual(started.started, ["wb2api"]);
  assert.equal(fake.spawned.length, 1);
  assert.equal(fake.spawned[0].cmd, "python");

  const state = await rt.status(ctx);
  assert.equal(state.mode, "reused");
  assert.equal(state.components.gateway.mode, "reused");
  assert.equal(state.components.workbuddy.mode, "owned");

  await rt.stop(ctx);
  assert.deepEqual(fake.killed, [fake.spawned[0].pid]);
});

test("probe bypass spawns both, and a missing install reports instead of throwing", async t => {
  const runtime = require("../features/gateway/runtime.js");
  const server = await listen(() => {});
  t.after(() => server.close());
  const ports = { gateway: server.address().port, workbuddy: await freePort() };

  const fake = fakeProcesses();
  const rt = runtime.createRuntime({ ...fake, inspectPid: async () => null, portOwners: async () => [] });
  const bypassed = await rt.start({ ...tmpRoot(t, true), probeEnabled: false, ports });
  assert.deepEqual(bypassed.started.sort(), ["gateway", "wb2api"]);
  assert.deepEqual(bypassed.reused, []);

  const empty = runtime.createRuntime({ ...fakeProcesses(), inspectPid: async () => null, portOwners: async () => [] });
  const closedPorts = { gateway: await freePort(), workbuddy: await freePort() };
  const ctx = { ...tmpRoot(t, false), probeEnabled: true, ports: closedPorts };
  const missing = await empty.start(ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /找不到/);
  assert.equal((await empty.status(ctx)).mode, "stopped");
});

test("reap after a crash kills only recorded pids that still match their spec", async t => {
  const runtime = require("../features/gateway/runtime.js");
  const ports = { gateway: await freePort(), workbuddy: await freePort() };
  const base = { ...tmpRoot(t, true), probeEnabled: false, ports };

  const first = fakeProcesses();
  const crashed = runtime.createRuntime({ ...first, inspectPid: async () => null, portOwners: async () => [] });
  await crashed.start(base);
  const run = JSON.parse(fs.readFileSync(path.join(base.stateDir, runtime.RUN_FILE), "utf8"));
  const gwPid = run.children.gateway.pid;
  const wbPid = run.children.wb2api.pid;
  assert.ok(gwPid && wbPid);

  // New load: the gateway pid is still our exe, the wb2api pid was recycled.
  const second = fakeProcesses();
  const reloaded = runtime.createRuntime({
    ...second,
    portOwners: async () => [],
    inspectPid: async pid => pid === gwPid
      ? { exe: path.join(base.root, "cliproxy", "cli-proxy-api.exe"), cmdline: "" }
      : { exe: "C:/Windows/System32/notepad.exe", cmdline: "notepad" },
  });
  const reaped = await reloaded.reap(base);
  assert.deepEqual(reaped, ["gateway"]);
  assert.deepEqual(second.killed, [gwPid]);
});

test("takeover refuses an unknown port owner and replaces a verified one", async t => {
  const runtime = require("../features/gateway/runtime.js");
  const server = await listen(() => {});
  t.after(() => server.close());
  const ports = { gateway: server.address().port, workbuddy: await freePort() };
  const ctx = { ...tmpRoot(t, true), probeEnabled: true, ports };

  const strangerFake = fakeProcesses();
  const stranger = runtime.createRuntime({
    ...strangerFake,
    portOwners: async () => [4242],
    inspectPid: async () => ({ exe: "C:/Program Files/Other/server.exe", cmdline: "" }),
  });
  const refused = await stranger.takeover(ctx);
  assert.equal(refused.ok, false);
  assert.deepEqual(strangerFake.killed, []);
  assert.deepEqual(strangerFake.spawned, []);

  const oursFake = fakeProcesses();
  const ours = runtime.createRuntime({
    ...oursFake,
    portOwners: async () => [4343],
    inspectPid: async () => ({ exe: path.join(ctx.root, "cliproxy", "cli-proxy-api.exe"), cmdline: "" }),
  });
  const taken = await ours.takeover(ctx);
  assert.equal(taken.ok, true);
  assert.ok(oursFake.killed.includes(4343));
  assert.ok(oursFake.spawned.some(item => item.cmd.endsWith("cli-proxy-api.exe")));
});

// ---- stage 3: migration --------------------------------------------------
function fakeGateway(base) {
  const put = (rel, text) => {
    const file = path.join(base, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  put("cliproxy/cli-proxy-api.exe", "exe-bytes");
  put("cliproxy/config.yaml", "remote-management:\n  auth-dir: C:/old/ai-gateway/auth\nport: 8317\n");
  put("cliproxy/config.example.yaml", "example");
  put("cliproxy/gateway.log", "log");
  put("cliproxy/static/management.html", "<html></html>");
  put("cliproxy/plugins/windows/amd64/workbuddy.dll", "dead");
  put("auth/a.json", "{}");
  put("auth/logs/big.log", "log");
  put("workbuddy/wb_proxy.py", "print(1)");
  put("workbuddy/accounts/x.json", "{}");
  put("workbuddy/__pycache__/wb.pyc", "cache");
  put("bin/ai-gateway-mcp.exe", "old");
}

test("migration copies only runtime files, verifies them and rewrites auth-dir", async t => {
  const os = require("node:os");
  const migrate = require("../features/gateway/migrate.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piopt-migrate-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const src = path.join(tmp, "ai-gateway");
  const dest = path.join(tmp, "data", "gateway");
  fakeGateway(src);

  const rels = migrate.planFiles(src).map(file => file.rel.split(path.sep).join("/")).sort();
  assert.deepEqual(rels, [
    "auth/a.json",
    "cliproxy/cli-proxy-api.exe",
    "cliproxy/config.yaml",
    "cliproxy/static/management.html",
    "workbuddy/accounts/x.json",
    "workbuddy/wb_proxy.py",
  ]);

  const phases = [];
  const result = await migrate.migrate({ src, dest, onProgress: p => phases.push(p.phase) });
  assert.equal(result.ok, true);
  assert.equal(result.files, 6);
  assert.equal(phases[0], "copy");
  assert.equal(phases[phases.length - 1], "done");
  assert.equal(fs.existsSync(`${dest}.partial`), false);
  assert.equal(fs.readFileSync(path.join(dest, "cliproxy", "cli-proxy-api.exe"), "utf8"), "exe-bytes");
  const config = fs.readFileSync(path.join(dest, "cliproxy", "config.yaml"), "utf8");
  assert.ok(config.includes(`auth-dir: ${path.join(dest, "auth").split(path.sep).join("/")}`), config);
  assert.ok(config.includes("port: 8317"));
  // the source is a copy source, never touched
  assert.ok(fs.readFileSync(path.join(src, "cliproxy", "config.yaml"), "utf8").includes("C:/old/ai-gateway/auth"));

  await assert.rejects(migrate.migrate({ src, dest }), /不覆盖/);
  await assert.rejects(migrate.migrate({ src: path.join(tmp, "nowhere"), dest: path.join(tmp, "d2") }), /缺少/);
  assert.equal(fs.existsSync(path.join(tmp, "d2.partial")), false);
});

test("release accepts occupants from the old root during a migration", async () => {
  const runtime = require("../features/gateway/runtime.js");
  const killed = [];
  const oldRoot = path.join(root, "old-root");
  const newRoot = path.join(root, "new-root");
  const rt = runtime.createRuntime({
    probeGateway: async () => ({ gateway: true, workbuddy: false }),
    portOwners: async () => [4242],
    inspectPid: async () => ({ exe: path.join(oldRoot, "cliproxy", "cli-proxy-api.exe"), cmdline: "" }),
    legacySupervisors: async () => [],
    killTree: async pid => { killed.push(pid); },
    waitPortsClosed: async () => true,
  });
  const tmpState = path.join(root, "tmp-release-state");
  const ctx = { root: newRoot, stateDir: tmpState, logDir: tmpState, probeEnabled: true };
  try {
    const refused = await rt.release(ctx);
    assert.equal(refused.ok, false);
    assert.deepEqual(killed, []);
    const released = await rt.release({ ...ctx, altRoots: [oldRoot] });
    assert.equal(released.ok, true);
    assert.deepEqual(killed, [4242]);
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

// ---- stage 2: self-bootstrapped credentials --------------------------------

test("secret store seals values and never writes plaintext", async t => {
  const secrets = require("../features/gateway/secrets.js");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piopt-sec-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = secrets.createStore({
    dataDir: async () => dir,
    protect: async text => Buffer.from(text).toString("base64").split("").reverse().join(""),
    unprotect: async sealed => Buffer.from(sealed.split("").reverse().join(""), "base64").toString(),
    random: () => "r".repeat(64),
  });
  assert.equal(await store.get("managementKey"), null);
  assert.equal(await store.getOrCreate("managementKey"), "r".repeat(64));
  await store.set("wbPanelPassword", "plain-secret-value");
  const raw = fs.readdirSync(dir, { recursive: true })
    .map(name => path.join(dir, String(name)))
    .filter(file => fs.statSync(file).isFile())
    .map(file => fs.readFileSync(file, "utf8"))
    .join("\n");
  assert.equal(raw.includes("plain-secret-value"), false);
  assert.equal(raw.includes("r".repeat(64)), false);

  const reopened = secrets.createStore({
    dataDir: async () => dir,
    unprotect: async sealed => Buffer.from(sealed.split("").reverse().join(""), "base64").toString(),
  });
  assert.equal(await reopened.get("wbPanelPassword"), "plain-secret-value");
});

test("wb2api rotates off the factory password once, then only the sealed one is tried", { skip: process.platform !== "win32" }, async t => {
  const os = require("node:os");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "piopt-wb-"));
  const gatewayRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piopt-root-"));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(gatewayRoot, { recursive: true, force: true });
    delete global.pi;
  });
  global.pi = {
    plugin: {
      getSettings: async () => ({ gatewayRoot }),
      getDataPath: async () => dataDir,
    },
  };
  let current = "admin";
  const tried = [];
  let lastAuth = "";
  const handler = async (request, response) => {
    const body = request.method === "POST" ? await readBody(request) : {};
    if (request.url === "/panel/login") {
      tried.push(body.password);
      return body.password === current ? json(response, { ok: true, token: `t-${current}` }) : json(response, { error: { message: "bad" } }, 401);
    }
    if (request.url === "/panel/password") {
      if (body.current !== current || String(body.new).length < 4) return json(response, {}, 401);
      current = body.new;
      return json(response, { ok: true, token: `t-${current}` });
    }
    if (request.url === "/v8/management/config") {
      lastAuth = request.headers.authorization || "";
      return json(response, {});
    }
    return json(response, { ok: true });
  };

  const first = await mockServices(t, handler);
  await first.wbRequest("/accounts");
  assert.deepEqual(tried, ["admin"]);
  assert.notEqual(current, "admin");
  assert.match(current, /^[0-9a-f]{64}$/);
  const sealedFile = fs.readFileSync(path.join(dataDir, "gateway-runtime", "secrets.json"), "utf8");
  assert.equal(sealedFile.includes(current), false);

  // A fresh load (new process) must log in with the sealed password only.
  tried.length = 0;
  const second = await mockServices(t, handler);
  await second.wbRequest("/accounts");
  assert.deepEqual(tried, [current]);

  // The generated management key is only sent to a gateway we own.
  await second.secretStore.set("managementKey", "k-generated-123456");
  second.setOwnership(() => true);
  await second.cpRequest("/config");
  assert.equal(lastAuth, "Bearer k-generated-123456");
  second.setOwnership(() => false);
  await assert.rejects(second.cpRequest("/config"), /缺少管理密钥/);
});

// ---- stage 4: quota through the gateway's own api-call proxy -----------------
test("quota goes through /v0/management/api-call, caches 5 min and keeps last good data", async t => {
  global.pi = { plugin: { getSettings: async () => ({ gatewayManagementKey: "test-management-key" }) } };
  let calls = 0;
  let failB = false;
  const bodies = [];
  const groups = [
    { displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 1 }, { window: "weekly", remainingFraction: 0.9 }] },
    { displayName: "Claude and GPT models", buckets: [{ window: "5h", remainingFraction: 0.5 }] },
    { displayName: "Gemini 4 Argon", buckets: [{ window: "weekly", remainingFraction: 0.2 }] },
  ];
  const service = await mockServices(t, async (request, response) => {
    if (request.url === "/v0/management/auth-files") {
      return json(response, { files: [
        { provider: "antigravity", email: "a@example.com", auth_index: 1, project_id: "p-a" },
        { provider: "antigravity", email: "b@example.com", auth_index: 2, project_id: "p-b" },
        { provider: "antigravity", email: "off@example.com", auth_index: 3, disabled: true },
        { provider: "codex", email: "c@example.com", auth_index: 4 },
      ] });
    }
    if (request.url === "/v0/management/api-call") {
      calls += 1;
      const body = await readBody(request);
      bodies.push(body);
      if (failB && body.authIndex === "2") return json(response, { status_code: 500, body: "" });
      return json(response, { status_code: 200, body: JSON.stringify({ groups }) });
    }
    json(response, {}, 404);
  });
  t.after(() => { delete global.pi; });

  const first = await service.antigravity({ force: true });
  assert.equal(first.ok, true);
  assert.equal(first.failed, 0);
  assert.ok(first.updatedAt > 0);
  assert.deepEqual(first.groups.map(group => [group.id, group.percent, group.accounts]), [
    ["gemini", 100, 2], ["claude-gpt", 50, 2], ["argon", 20, 2],
  ]);
  assert.equal(calls, 2, "one request per enabled antigravity account");
  for (const body of bodies) {
    assert.equal(body.header.Authorization, "Bearer $TOKEN$", "the gateway substitutes the token");
    assert.match(body.url, /retrieveUserQuotaSummary$/);
  }

  const cached = await service.antigravity();
  assert.equal(calls, 2, "a fresh round is reused instead of asking Google again");
  assert.equal(cached.updatedAt, first.updatedAt);

  failB = true;
  const partial = await service.antigravity({ force: true });
  assert.equal(partial.ok, true);
  assert.equal(partial.failed, 1);
  assert.deepEqual(partial.groups.map(group => group.accounts), [2, 2, 2], "a failed account keeps its last good summary");
});

test("services.js no longer reads auth files or calls Google itself", () => {
  const source = fs.readFileSync(path.join(root, "features/gateway/services.js"), "utf8");
  assert.equal(/readAuthFiles|access_token|accessToken/.test(source), false);
  assert.equal(/fetch\(\s*["'`]https:\/\/[^"'`]*googleapis/.test(source), false);
});

test("opening the wb2api panel carries the sealed password, other panels do not", async t => {
  global.pi = { plugin: { getSettings: async () => ({}) } };
  t.after(() => { delete global.pi; });
  const service = await mockServices(t, (request, response) => json(response, {}));
  service.secretStore._cache.set("wbPanelPassword", "rotated-secret");
  const wb = new URL(await service.panelUrl(service.WB_BASE + "/"));
  assert.equal(wb.searchParams.get("pwd"), "rotated-secret");
  // mockServices points both bases at one port, so use the real 8317 origin here.
  const cp = "http://127.0.0.1:8317/management.html";
  assert.equal(await service.panelUrl(cp), cp);
  service.secretStore._cache.delete("wbPanelPassword");
});
