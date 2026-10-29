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

test("gateway_logs only reads whitelisted component logs inside LOG_DIR", async () => {
  const gateway = require("../features/gateway/index.js");
  const { resolveLogFile } = gateway._internals;
  const dir = path.join(root, "tmp-logs");
  assert.equal(resolveLogFile("supervisor", dir), path.join(dir, "supervisor.log"));
  for (const bad of ["../../x", "..\\..\\x", "gateway/../../x", "C:/Windows/win", "", "other"]) {
    assert.equal(resolveLogFile(bad, dir), null, bad);
  }
  const result = await gateway.tools.gateway_logs.execute({ component: "../../x" });
  assert.equal(result.ok, false);
  assert.equal(result.text, undefined);
});
