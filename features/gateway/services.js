"use strict";

const fs = require("fs");
const path = require("path");
const data = require("./data.js");
const paths = require("./paths.js");

const CP_BASE = "http://127.0.0.1:8317";
const WB_BASE = "http://127.0.0.1:8318";
const MGMT = "/v8/management";
const CP_PROVIDERS = ["antigravity", "claude", "codex", "gemini"];
const WB_PROVIDERS = ["intl", "cn"];
const quotaCache = new Map();
let wbSession = null;

async function readSettings() {
  try {
    const settings = await pi.plugin.getSettings();
    return settings && typeof settings === "object" ? settings : {};
  } catch {
    return {};
  }
}

// Same resolution as the lifecycle: setting > <data>/gateway > ~/ai-gateway.
async function gatewayRoot() {
  const settings = await readSettings();
  let dataDir = "";
  try { dataDir = await pi.plugin.getDataPath(); } catch { /* none */ }
  return paths.pickRoot({ setting: settings.gatewayRoot, dataDir }).root;
}

const BCRYPT_KEY = /^\$2[aby]\$/;

// CLIProxyAPI 启动时会把 config.yaml 里的明文管理密钥哈希后回写，哈希无法反推明文，
// 直接拿去请求必然 401；连续失败会让管理接口按 IP 临时封禁，所以绝不能把哈希当密钥发出去。
async function localManagementKey() {
  const settings = await readSettings();
  const configured = typeof settings.gatewayManagementKey === "string" ? settings.gatewayManagementKey.trim() : "";
  if (configured) return configured;
  try {
    const yaml = fs.readFileSync(path.join(await gatewayRoot(), "cliproxy", "config.yaml"), "utf8");
    const block = yaml.match(/^management:\s*\n((?:[ \t]+.*\n?)*)/m);
    const match = block && block[1].match(/^[ \t]+secret-key:[ \t]*["']?([^\s"']+)/m);
    const value = match ? match[1] : "";
    return BCRYPT_KEY.test(value) ? "" : value;
  } catch {
    return "";
  }
}

// 取密钥顺序：插件设置里的明文 > config.yaml 里尚未被哈希的明文。
async function cpAuth() {
  return { managementKey: await localManagementKey() };
}

function missingKeyError() {
  const error = new Error("CLIProxyAPI: 缺少管理密钥。config.yaml 的 secret-key 是 bcrypt 哈希，无法用于认证；请在 PiOpt 设置里填写「网关管理密钥」明文，或把 config.yaml 改回明文后重启网关。");
  error.status = 0;
  return error;
}


async function cpRequest(pathname, options = {}) {
  const auth = await cpAuth();
  if (!auth.managementKey) throw missingKeyError();
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  headers.Authorization = `Bearer ${auth.managementKey}`;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(CP_BASE + MGMT + pathname, {
    method: options.method || "GET",
    headers,
    body,
    signal: AbortSignal.timeout(options.timeout || 10000),
  });
  if (response.status === 204) return { ok: true };
  const text = await response.text();
  let result = {};
  try { result = text ? JSON.parse(text) : {}; } catch { result = { error: text }; }
  if (!response.ok) {
    const message = result.error && (result.error.message || result.error) || result.message || `HTTP ${response.status}`;
    const error = new Error(`CLIProxyAPI: ${message}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function clientKeys() {
  const keys = await cpRequest("/config/access/api-keys");
  return Array.isArray(keys) ? keys.map(String) : [];
}

async function keyOverview() {
  const [keys, settings] = await Promise.all([clientKeys(), readSettings()]);
  const labels = settings.gatewayKeyLabels && typeof settings.gatewayKeyLabels === "object"
    ? settings.gatewayKeyLabels
    : {};
  return keys.map(key => ({
    id: data.keyId(key),
    mask: data.maskKey(key),
    label: String(labels[data.keyId(key)] || ""),
  }));
}

async function saveKeyLabel(id, label) {
  if (!/^[a-f0-9]{16}$/.test(String(id))) throw new Error("密钥标识无效");
  const settings = await readSettings();
  const current = settings.gatewayKeyLabels && typeof settings.gatewayKeyLabels === "object"
    ? settings.gatewayKeyLabels
    : {};
  const next = { ...current };
  if (String(label || "").trim()) next[id] = String(label).trim().slice(0, 60);
  else delete next[id];
  await pi.plugin.setSettings({ gatewayKeyLabels: next });
}

async function keyAction(payload) {
  const action = String(payload.action || "");
  if (action === "label") {
    const keys = await clientKeys();
    if (!keys.some(key => data.keyId(key) === payload.id)) throw new Error("密钥已不存在");
    await saveKeyLabel(payload.id, payload.label);
    return { ok: true };
  }
  if (action === "add") {
    const value = String(payload.key || "").trim();
    if (!/^[\x21-\x7e]{12,256}$/.test(value)) throw new Error("API Key 需为 12–256 位可见 ASCII 字符");
    const keys = await clientKeys();
    if (keys.includes(value)) throw new Error("这个 API Key 已存在");
    await cpRequest("/config/access/api-keys", { method: "PUT", body: [...keys, value] });
    await saveKeyLabel(data.keyId(value), payload.label);
    return { ok: true, id: data.keyId(value) };
  }
  if (action === "copy") {
    const keys = await clientKeys();
    const key = keys.find(item => data.keyId(item) === payload.id);
    if (!key) throw new Error("密钥已不存在");
    await pi.clipboard.writeText(key);
    return { ok: true };
  }
  if (action === "delete") {
    const keys = await clientKeys();
    const next = keys.filter(key => data.keyId(key) !== payload.id);
    if (next.length === keys.length) throw new Error("密钥已不存在");
    await cpRequest("/config/access/api-keys", { method: "PUT", body: next });
    await saveKeyLabel(payload.id, "");
    return { ok: true };
  }
  throw new Error("不支持的 API Key 操作");
}

async function cpModels() {
  const keys = await clientKeys();
  const response = await fetch(CP_BASE + "/v1/models", {
    headers: keys[0] ? { Authorization: `Bearer ${keys[0]}` } : {},
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`模型列表 HTTP ${response.status}`);
  return data.modelRows(await response.json());
}

function readAuthFiles(authDir) {
  let names = [];
  try { names = fs.readdirSync(authDir).filter(name => name.endsWith(".json")); } catch { return []; }
  return names.map(name => {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(authDir, name), "utf8"));
      return {
        name,
        email: String(doc.email || name.replace(/\.json$/, "")),
        accessToken: String(doc.access_token || ""),
      };
    } catch { return null; }
  }).filter(Boolean);
}

async function antigravityQuota(force = false) {
  const now = Date.now();
  return Promise.all(readAuthFiles(path.join(await gatewayRoot(), "auth")).map(async account => {
    const cached = quotaCache.get(account.email);
    if (!force && cached && now - cached.at < 60000) return { email: account.email, summary: cached.summary };
    let summary = cached ? cached.summary : null;
    if (account.accessToken) {
      try {
        const response = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${account.accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": "antigravity/hub/2.23.0 darwin/arm64",
          },
          body: "{}",
          signal: AbortSignal.timeout(ANTIGRAVITY_TIMEOUT),
        });
        if (response.ok) summary = await response.json();
      } catch { /* 保留上一份成功快照 */ }
    }
    quotaCache.set(account.email, { at: now, summary });
    return { email: account.email, summary };
  }));
}

// wb2api 的口令不需要用户填：先试默认口令，失败再试历史保存的那一个。
async function wbCandidates() {
  const settings = await readSettings();
  const saved = settings.gatewayConnections && settings.gatewayConnections.wb || {};
  return [...new Set(["admin", String(saved.password || "")].filter(Boolean))];
}

async function wbAuth() {
  if (wbSession) return wbSession;
  let lastError = null;
  for (const password of await wbCandidates()) {
    const response = await fetch(WB_BASE + "/panel/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.token) {
      wbSession = result.token;
      return wbSession;
    }
    lastError = new Error(result.error && result.error.message || "wb2api 面板口令不匹配或服务未就绪");
    lastError.status = response.status;
    if (response.status !== 401) break;
  }
  throw lastError || new Error("wb2api 面板登录失败");
}

async function wbRequest(pathname, options = {}, retry = true) {
  const token = await wbAuth();
  const headers = { Accept: "application/json", "X-Panel-Token": token, ...(options.headers || {}) };
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(WB_BASE + pathname, {
    method: options.method || "GET",
    headers,
    body,
    signal: AbortSignal.timeout(options.timeout || 15000),
  });
  if (response.status === 401 && retry) {
    wbSession = null;
    return wbRequest(pathname, options, false);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`wb2api: ${result.error && result.error.message || result.message || `HTTP ${response.status}`}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

// 面板状态只报「能不能连上」，不暴露口令也不要求填写。
function wbConnection() {
  return { auth: "panel-session" };
}

async function cpConnection() {
  return { auth: (await localManagementKey()) ? "settings-or-config" : "missing-key" };
}

function publicError(error) {
  return error && error.message ? error.message : String(error);
}

async function overview() {
  const out = {
    ok: true,
    generatedAt: Date.now(),
    baseUrl: CP_BASE,
    panels: {
      cp: { name: "CLIProxyAPI", url: CP_BASE + "/management.html", connection: await cpConnection() },
      wb: { name: "wb2api", url: WB_BASE + "/", connection: wbConnection() },
    },
    protocols: [
      { id: "openai", label: "OpenAI", url: CP_BASE + "/v1" },
      { id: "claude", label: "Claude", url: CP_BASE + "/v1/messages" },
      { id: "codex", label: "Codex", url: CP_BASE + "/v1/responses" },
      { id: "gemini", label: "Gemini", url: CP_BASE + "/v1beta/models" },
    ],
    providers: { cp: CP_PROVIDERS, wb: WB_PROVIDERS },
    errors: {},
  };
  const jobs = {
    keys: keyOverview(),
    models: cpModels(),
    credentials: cpRequest("/credentials"),
    accounts: wbRequest("/accounts?realm=all"),
    wbModels: wbRequest("/v1/models"),
  };
  await Promise.all(Object.entries(jobs).map(async ([key, job]) => {
    try { out[key] = await job; } catch (error) { out.errors[key] = publicError(error); }
  }));
  out.credentials = data.credentialRows(out.credentials);
  out.accounts = data.accountRows(out.accounts);
  out.wbModels = data.modelRows(out.wbModels);
  out.pool = data.poolSummary(out.accounts || []);
  return out;
}

// Antigravity 的配额接口要走 Google 域，慢且常不可达；单独一条通道，页面先出结构。
async function antigravity() {
  try {
    return { ok: true, groups: data.aggregateAntigravity(readAuthFiles(path.join(await gatewayRoot(), "auth")), await antigravityQuota()) };
  } catch (error) {
    return { ok: false, groups: [], error: publicError(error) };
  }
}

const ANTIGRAVITY_TIMEOUT = 5000;

function rangeQuery(range) {
  const now = Math.floor(Date.now() / 1000);
  if (range === "d3") return `range=custom&since=${now - 3 * 86400}&until=${now}`;
  if (range === "d30") return `range=custom&since=${now - 30 * 86400}&until=${now}`;
  if (range === "all") return `range=custom&since=${now - 365 * 86400}&until=${now}`;
  return `range=${range}`;
}

async function usage(range) {
  const allowed = new Set(["today", "d3", "week", "month", "d30", "all"]);
  const selected = allowed.has(range) ? range : "today";
  const query = rangeQuery(selected);
  const [analytics, series, recent] = await Promise.all([
    wbRequest(`/usage/analytics?realm=all&${query}`),
    wbRequest(`/usage/timeseries?realm=all&${query}`),
    wbRequest("/usage/recent?limit=12"),
  ]);
  return { range: selected, analytics, series, recent };
}

async function cpAction(payload) {
  const action = String(payload.action || "");
  if (action === "refresh") {
    const body = payload.all ? { all: true } : { name: String(payload.name || ""), auth_index: String(payload.authIndex || "") };
    if (!body.all && !body.name) throw new Error("缺少凭证名称");
    return cpRequest("/credentials/refresh", { method: "POST", body, timeout: payload.all ? 310000 : 60000 });
  }
  if (action === "delete") {
    if (!payload.name) throw new Error("缺少凭证名称");
    return cpRequest("/credentials", { method: "DELETE", body: { names: [String(payload.name)] } });
  }
  if (action === "oauthStart") {
    const provider = String(payload.provider || "");
    if (!CP_PROVIDERS.includes(provider)) throw new Error("不支持的 OAuth 提供方");
    return cpRequest(`/oauth/auth-url?provider=${encodeURIComponent(provider)}&is_webui=true`);
  }
  if (action === "oauthPoll") {
    return cpRequest(`/oauth/status?state=${encodeURIComponent(String(payload.state || ""))}`);
  }
  if (action === "oauthCallback") {
    const provider = String(payload.provider || "");
    if (!CP_PROVIDERS.includes(provider)) throw new Error("不支持的 OAuth 提供方");
    return cpRequest("/oauth/callback", { method: "POST", body: { provider, redirect_url: String(payload.url || "") } });
  }
  if (action === "oauthCancel") {
    return cpRequest(`/oauth/session?state=${encodeURIComponent(String(payload.state || ""))}`, { method: "DELETE" });
  }
  throw new Error("不支持的凭证操作");
}

async function wbAction(payload) {
  const action = String(payload.action || "");
  const routes = {
    checkin: "/accounts/checkin",
    credits: "/accounts/credits/fetch",
    refresh: "/accounts/refresh",
    delete: "/accounts/delete",
  };
  if (action === "oauthStart") {
    const realm = String(payload.realm || "");
    if (!WB_PROVIDERS.includes(realm)) throw new Error("请选择国际版或国内版");
    return wbRequest("/accounts/login/start", { method: "POST", body: { platform: "CLI", realm }, timeout: 30000 });
  }
  if (action === "oauthPoll") {
    return wbRequest(`/accounts/login/poll?state=${encodeURIComponent(String(payload.state || ""))}`);
  }
  if (action === "oauthCancel") {
    return wbRequest("/accounts/login/cancel", { method: "POST", body: { state: String(payload.state || "") } });
  }
  if (action === "toggle") {
    if (!payload.uid) throw new Error("缺少账号标识");
    return wbRequest("/accounts/set", { method: "POST", body: { uid: payload.uid, enabled: Boolean(payload.enabled) } });
  }
  if (!routes[action]) throw new Error("不支持的账号操作");
  if (action === "delete" && !payload.uid) throw new Error("缺少账号标识");
  const body = payload.uid ? { uid: payload.uid } : {};
  return wbRequest(routes[action], { method: "POST", body, timeout: action === "refresh" || action === "credits" ? 310000 : 120000 });
}

module.exports = {
  CP_BASE,
  WB_BASE,
  readSettings,
  overview,
  usage,
  keyAction,
  cpAction,
  wbAction,
  antigravity,
  cpRequest,
  wbRequest,
};
