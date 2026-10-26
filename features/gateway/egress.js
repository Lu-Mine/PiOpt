/**
 * 出海通道（egress）
 *
 * 解决的问题：Antigravity 的模型与配额接口都在 Google 域上，国内直连不通。
 * 做法：从本机 Clash 的订阅文件里取节点，用 Clash 自带的 mihomo 内核静默起一个
 * 只监听本地端口的实例；规则里只有 Google/AI 域名走代理，其余一律直连。
 *
 * 明确不做的事：
 *   - 不改系统代理、不开 TUN、不启动 Clash 客户端界面
 *   - 只监听 127.0.0.1，不对外暴露
 *   - 不接管任何非本网关进程的流量
 *
 * 生命周期：mihomo 由 supervisor 托管（bin/supervisor.json 的第一个 child），
 * 随 PI-Desktop 启停，父进程消失即被 killTree 清掉。
 */

const fs = require("fs");
const path = require("path");
const net = require("net");
const http = require("http");
const os = require("os");
const { spawn } = require("child_process");

const GATEWAY_DIR = "C:/Users/Avencess/ai-gateway";
const BIN_DIR = path.join(GATEWAY_DIR, "bin");
const DEV_DIR = path.join(GATEWAY_DIR, "dev");
const RUNTIME_CFG = path.join(BIN_DIR, "mihomo-runtime.yaml");
const PROBE_CFG = path.join(BIN_DIR, "mihomo-probe.yaml");
const CLIPROXY_CFG = path.join(GATEWAY_DIR, "cliproxy", "config.yaml");
const SUPERVISOR_JSON = path.join(BIN_DIR, "supervisor.json");
const STATUS_FILE = path.join(DEV_DIR, "egress.json");
const EGRESS_LOG = path.join(DEV_DIR, "egress.log");

const EGRESS_PORT = 8319;
const PROBE_PORT = 8318;

// Clash Verge 把订阅与状态放在这里；两家历史目录名都试
// 插件进程里 APPDATA 不一定存在，用 USERPROFILE 兜底
const ROAMING =
  process.env.APPDATA ||
  path.join(process.env.USERPROFILE || os.homedir(), "AppData", "Roaming");

const CLASH_DIRS = [
  path.join(ROAMING, "io.github.clash-verge-rev.clash-verge-rev"),
  path.join(ROAMING, "clash-verge"),
];

const MIHOMO_CANDIDATES = [
  "D:/Clash Verge/verge-mihomo.exe",
  "C:/Program Files/Clash Verge/verge-mihomo.exe",
  "C:/Program Files (x86)/Clash Verge/verge-mihomo.exe",
  path.join(process.env.LOCALAPPDATA || "", "Programs/Clash Verge/verge-mihomo.exe"),
];

// 只有这些域名走代理；其余（含 WorkBuddy 的腾讯域）走直连
const PROXY_SUFFIXES = [
  "googleapis.com",
  "google.com",
  "gstatic.com",
  "googleusercontent.com",
  "withgoogle.com",
  "gvt1.com",
  "gvt2.com",
  "anthropic.com",
  "claude.ai",
  "openai.com",
  "chatgpt.com",
];

function log(message) {
  try {
    fs.mkdirSync(DEV_DIR, { recursive: true });
    fs.appendFileSync(EGRESS_LOG, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch (error) {
    // 日志失败不影响功能
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 找到 Clash 的当前订阅：先读 profiles.yaml 的 current，再退化为最大的配置 */
function findClashProfile() {
  for (const dir of CLASH_DIRS) {
    const profilesDir = path.join(dir, "profiles");
    if (!fs.existsSync(profilesDir)) continue;

    let uid = "";
    try {
      const index = fs.readFileSync(path.join(dir, "profiles.yaml"), "utf8");
      const m = index.match(/^current:\s*(\S+)/m);
      if (m) uid = m[1].trim();
    } catch (error) {
      // profiles.yaml 缺失就退化
    }
    if (uid) {
      const candidate = path.join(profilesDir, `${uid}.yaml`);
      if (fs.existsSync(candidate)) return candidate;
    }

    let best = "";
    let bestSize = 0;
    for (const name of fs.readdirSync(profilesDir)) {
      if (!name.endsWith(".yaml")) continue;
      const full = path.join(profilesDir, name);
      try {
        const size = fs.statSync(full).size;
        if (size > bestSize) {
          bestSize = size;
          best = full;
        }
      } catch (error) {
        // 读不到就跳过
      }
    }
    if (best && bestSize > 4096) return best;
  }
  return "";
}

function findMihomo() {
  for (const p of MIHOMO_CANDIDATES) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024) return p;
    } catch (error) {
      // 忽略
    }
  }
  return "";
}

/** 从订阅里挑出口：优先「自动选择」组，取不到就用第一个节点 */
function pickDialer(text) {
  if (/^- name:\s*"?♻️ 自动选择"?/m.test(text)) return "♻️ 自动选择";
  const group = text.match(/^- name:\s*"?([^\n"]+)"?\s*\n\s*type:\s*(?:url-test|fallback|select)/m);
  if (group) return group[1].trim();
  const node = text.match(/^- name:\s*"?(.+?)"?\s*\n\s*type:/m);
  return node ? node[1].trim() : "";
}

/**
 * 用订阅原文拼运行时配置：
 * 保留 proxies / proxy-groups，丢掉端口、外部控制器、DNS、TUN 段，
 * 规则换成"只给 Google/AI 域名走代理，其余直连"。
 */
function buildRuntimeConfig(profilePath) {
  const raw = fs.readFileSync(profilePath, "utf8").replace(/\r/g, "");
  const lines = raw.split("\n");

  const rulesIdx = lines.findIndex((l) => /^rules:\s*$/.test(l));
  const body = rulesIdx > 0 ? lines.slice(0, rulesIdx) : lines;

  const dialer = pickDialer(raw);
  if (!dialer) throw new Error("订阅里找不到可用的代理组或节点");

  // 这些键由下方 header 统一给出，原文里的必须丢掉，否则 YAML 重复顶层键会被内核拒绝
  const DROP_TOP = /^(port|socks-port|redir-port|tproxy-port|mixed-port|allow-lan|mode|log-level|ipv6|unified-delay|tcp-concurrent|external-controller|external-ui|external-ui-name|external-ui-url|secret|tun|sniffer|experimental|profile):/;
  const DROP_BLOCK = /^(dns|tun|sniffer|experimental|profile):/;

  const keep = [];
  let skipping = false;
  for (const line of body) {
    const isTop = /^[a-zA-Z][\w-]*:/.test(line);
    if (isTop) {
      if (DROP_TOP.test(line)) {
        skipping = true;
        continue;
      }
      skipping = DROP_BLOCK.test(line);
      if (skipping) continue;
      keep.push(line);
      continue;
    }
    if (skipping) continue;
    keep.push(line);
  }
  const header = [
    `mixed-port: ${EGRESS_PORT}`,
    "allow-lan: false",
    "mode: rule",
    "log-level: warning",
    "ipv6: false",
    "unified-delay: true",
  ];

  const rules = ["rules:"];
  for (const s of PROXY_SUFFIXES) rules.push(`  - DOMAIN-SUFFIX,${s},${dialer}`);
  rules.push("  - MATCH,DIRECT");

  return { yaml: header.concat(keep, rules).join("\n") + "\n", dialer };
}

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.setTimeout(600, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/** 通过本地代理开一条到 Google 的隧道，能开出来就说明真能穿出去 */
function tunnelToGoogle(port, host) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "CONNECT",
      path: `${host}:443`,
      timeout: 8000,
    });
    req.on("connect", (res) => {
      res.destroy();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

function killTree(pid) {
  try {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } catch (error) {
    // 清理失败不影响主流程
  }
}

/** 起一个临时实例验证配置可用：能监听、且能穿到 Google */
async function probe(binPath, yamlText) {
  fs.writeFileSync(PROBE_CFG, yamlText.replace(/^mixed-port:.*$/m, `mixed-port: ${PROBE_PORT}`), "utf8");

  let child;
  try {
    child = spawn(binPath, ["-f", PROBE_CFG], {
      cwd: BIN_DIR,
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", () => {});

    const listenDeadline = Date.now() + 15000;
    while (Date.now() < listenDeadline) {
      if (await portOpen(PROBE_PORT)) break;
      await sleep(300);
    }
    if (!(await portOpen(PROBE_PORT))) {
      return { ok: false, reason: "内核没起来（端口未监听）" };
    }

    // url-test 组首次要测速，给它几轮机会
    for (let i = 0; i < 6; i += 1) {
      await sleep(1500);
      if (await tunnelToGoogle(PROBE_PORT, "daily-cloudcode-pa.googleapis.com")) {
        return { ok: true };
      }
    }
    return { ok: false, reason: "代理端口通了，但穿不到 Google（节点可能全不可用）" };
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) };
  } finally {
    if (child && child.pid) killTree(child.pid);
    try {
      fs.unlinkSync(PROBE_CFG);
    } catch (error) {
      // 忽略
    }
  }
}

/** 把 proxy-url 写进（或从）cli-proxy-api 的配置里 */
function applyProxyUrl(enable, port = EGRESS_PORT) {
  let raw;
  try {
    raw = fs.readFileSync(CLIPROXY_CFG, "utf8");
  } catch (error) {
    return { ok: false, reason: "读不到 cli-proxy-api 配置" };
  }
  const lines = raw.replace(/\r/g, "").split("\n").filter((l) => !/^proxy-url:/.test(l));

  if (enable) {
    const serverIdx = lines.findIndex((l) => /^server:\s*$/.test(l));
    let insertAt = lines.length;
    if (serverIdx >= 0) {
      insertAt = serverIdx + 1;
      while (insertAt < lines.length && !/^[a-zA-Z][\w-]*:/.test(lines[insertAt])) insertAt += 1;
    }
    lines.splice(insertAt, 0, `proxy-url: http://127.0.0.1:${port}`);
  }

  const next = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  if (next === raw) return { ok: true, changed: false };
  try {
    const backup = CLIPROXY_CFG + ".bak-egress";
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw, "utf8");
    fs.writeFileSync(CLIPROXY_CFG, next, "utf8");
    log(enable ? `已写入 proxy-url -> 127.0.0.1:${port}` : "已移除 proxy-url（直连）");
    return { ok: true, changed: true };
  } catch (error) {
    return { ok: false, reason: "写 cli-proxy-api 配置失败" };
  }
}

/** supervisor 启动顺序：mihomo 先起来（等端口），再起网关 */
function applySupervisorConfig(enable, binPath) {
  const doc = readJsonSafe(SUPERVISOR_JSON) || { children: [] };
  const rest = (doc.children || []).filter((c) => c.name !== "mihomo");

  const children = enable
    ? [
        {
          name: "mihomo",
          cmd: binPath,
          args: ["-f", RUNTIME_CFG],
          cwd: BIN_DIR,
          port: EGRESS_PORT,
          waitMs: 20000,
        },
        ...rest,
      ]
    : rest;

  try {
    fs.writeFileSync(SUPERVISOR_JSON, JSON.stringify({ children }, null, 2), "utf8");
    return true;
  } catch (error) {
    return false;
  }
}

function writeStatus(payload) {
  try {
    fs.mkdirSync(DEV_DIR, { recursive: true });
    fs.writeFileSync(
      STATUS_FILE,
      JSON.stringify({ ...payload, updated_at: new Date().toISOString() }, null, 2),
      "utf8"
    );
  } catch (error) {
    // 状态文件只是给面板看的
  }
}

function readStatus() {
  return readJsonSafe(STATUS_FILE) || { ok: false, reason: "尚未检测" };
}

/**
 * 主入口：准备出海通道。
 * 成功则 mihomo 交给 supervisor 托管、网关指向它；失败则清掉配置退回直连。
 */
async function prepare(options = {}) {
  const profile = findClashProfile();
  const binPath = findMihomo();

  const fallback = (reason) => {
    applyProxyUrl(false);
    applySupervisorConfig(false, "");
    const status = { ok: false, mode: "direct", reason };
    writeStatus(status);
    log(`出海通道未启用：${reason}`);
    return status;
  };

  if (!profile) return fallback("没找到 Clash 订阅文件");
  if (!binPath) return fallback("没找到 verge-mihomo.exe");

  let built;
  try {
    built = buildRuntimeConfig(profile);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.writeFileSync(RUNTIME_CFG, built.yaml, "utf8");
  } catch (error) {
    return fallback("解析订阅失败：" + String(error && error.message ? error.message : error));
  }

  // 只有真能穿出去才启用，避免代理端口挂了把整个网关拖死
  if (options.skipProbe !== true) {
    const probed = await probe(binPath, built.yaml);
    if (!probed.ok) return fallback(probed.reason);
  }

  applyProxyUrl(true);
  applySupervisorConfig(true, binPath);
  const status = {
    ok: true,
    mode: "proxy",
    port: EGRESS_PORT,
    dialer: built.dialer,
    profile,
    binPath,
    suffixes: PROXY_SUFFIXES.length,
  };
  writeStatus(status);
  log(`出海通道已启用：出口「${built.dialer}」，端口 ${EGRESS_PORT}`);
  return status;
}

/** 关闭通道：恢复直连配置 */
function disable() {
  applyProxyUrl(false);
  applySupervisorConfig(false, "");
  const status = { ok: false, mode: "direct", reason: "已手动关闭" };
  writeStatus(status);
  log("出海通道已手动关闭");
  return status;
}

module.exports = {
  prepare,
  disable,
  readStatus,
  findClashProfile,
  findMihomo,
  buildRuntimeConfig,
  EGRESS_PORT,
  PROXY_SUFFIXES,
  _internals: { applyProxyUrl, applySupervisorConfig, probe, portOpen },
};
