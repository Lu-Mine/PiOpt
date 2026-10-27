/**
 * 出海通道（egress）
 *
 * Antigravity 的模型与配额接口都在 Google 域上，国内直连不通。
 * 这里从本机已有的 Clash 配置里取节点，用同一份安装里的 mihomo 内核静默起一个
 * 只监听本地端口的实例，规则里只有 Google/AI 域名走代理，其余一律直连。
 *
 * 明确不做的事：不改系统代理、不开 TUN、不启动 Clash 客户端界面、
 * 只监听 127.0.0.1、不接管任何非本网关进程的流量。
 *
 * 配置目录与内核都是扫描发现的，不写死某一个安装位置。
 * mihomo 由 supervisor 托管，随 PI-Desktop 启停。
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
const PREFS_FILE = path.join(DEV_DIR, "egress-prefs.json");
const EGRESS_LOG = path.join(DEV_DIR, "egress.log");

const EGRESS_PORT = 8319;
const PROBE_PORT = 8318;

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

function homeDir() {
  return process.env.USERPROFILE || os.homedir();
}

function roamingDir() {
  return process.env.APPDATA || path.join(homeDir(), "AppData", "Roaming");
}

function localDir() {
  return process.env.LOCALAPPDATA || path.join(homeDir(), "AppData", "Local");
}

/**
 * 扫描所有可能放 Clash/mihomo 配置的位置，找出带订阅的目录。
 * 返回按"看起来最像当前在用"排序的候选，不做写死假设。
 */
function discoverClashDirs() {
  const bases = [roamingDir(), localDir(), path.join(homeDir(), ".config"), homeDir()];
  const names = [
    "io.github.clash-verge-rev.clash-verge-rev", // Clash Verge Rev
    "clash-verge",
    "clash-verge-rev",
    "Clash for Windows",
    "clash-meta",
    "mihomo",
    "clash",
    ".clash",
  ];

  const found = [];
  const seen = new Set();
  for (const base of bases) {
    for (const name of names) {
      const dir = path.join(base, name);
      if (seen.has(dir)) continue;
      seen.add(dir);
      try {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      } catch (error) {
        continue;
      }
      const profilesDir = path.join(dir, "profiles");
      const hasProfiles = fs.existsSync(profilesDir);
      const yamlHere = safeListYaml(dir);
      if (hasProfiles || yamlHere.length) {
        found.push({ dir, profilesDir: hasProfiles ? profilesDir : "", direct: yamlHere.length > 0 });
      }
    }
  }
  return found;
}

function safeListYaml(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"))
      .map((n) => path.join(dir, n));
  } catch (error) {
    return [];
  }
}

/** 在候选目录里挑出真正的订阅文件：优先 profiles.yaml 的 current，其次最大的配置 */
function findClashProfile() {
  for (const cand of discoverClashDirs()) {
    if (cand.profilesDir) {
      let uid = "";
      try {
        const index = fs.readFileSync(path.join(cand.dir, "profiles.yaml"), "utf8");
        const m = index.match(/^current:\s*(\S+)/m);
        if (m) uid = m[1].trim();
      } catch (error) {
        // 没有索引就退化
      }
      if (uid) {
        for (const ext of [".yaml", ".yml"]) {
          const p = path.join(cand.profilesDir, `${uid}${ext}`);
          if (fs.existsSync(p)) return p;
        }
      }
      // 退化：profiles 目录里最大的 yaml
      let best = "";
      let bestSize = 0;
      for (const p of safeListYaml(cand.profilesDir)) {
        try {
          const size = fs.statSync(p).size;
          if (size > bestSize) {
            bestSize = size;
            best = p;
          }
        } catch (error) {
          // 跳过
        }
      }
      if (best && bestSize > 4096) return best;
    }
    // 目录本身就是配置（没有 profiles 子目录）
    let best = "";
    let bestSize = 0;
    for (const p of safeListYaml(cand.dir)) {
      try {
        const size = fs.statSync(p).size;
        if (size > bestSize && size > 4096) {
          bestSize = size;
          best = p;
        }
      } catch (error) {
        // 跳过
      }
    }
    if (best) return best;
  }
  return "";
}

/** 扫描 mihomo 内核：常见安装位置 + Clash 客户端同目录 */
function findMihomo() {
  const names = ["verge-mihomo.exe", "verge-mihomo-alpha.exe", "mihomo.exe", "clash-meta.exe", "clash.exe"];
  const dirs = [
    "D:/Clash Verge",
    "C:/Program Files/Clash Verge",
    "C:/Program Files (x86)/Clash Verge",
    path.join(localDir(), "Programs", "Clash Verge"),
    path.join(localDir(), "Programs", "clash-verge"),
    path.join(homeDir(), "Clash Verge"),
    path.join(localDir(), "Programs", "mihomo"),
  ];

  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024) return p;
      } catch (error) {
        // 跳过
      }
    }
  }

  // 再扫一遍 Clash 配置目录的上级，内核常和配置放在一起
  for (const cand of discoverClashDirs()) {
    for (const name of names) {
      const p = path.join(cand.dir, name);
      try {
        if (fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024) return p;
      } catch (error) {
        // 跳过
      }
    }
  }
  return "";
}

/** YAML 双引号里的 \U0001F1ED 这类转义要还原成真字符，否则面板显示乱码 */
function decodeYamlName(raw) {
  let v = String(raw || "").trim();
  let quoted = false;
  if (v.length > 1 && v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1);
    quoted = true;
  }
  if (!quoted) return v;
  return v
    .replace(/\\U([0-9A-Fa-f]{8})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/** 从订阅里列出可选的出口：代理组（含自动选择）与单个节点 */
function listOutlets(profilePath) {
  let raw = "";
  try {
    raw = fs.readFileSync(profilePath, "utf8").replace(/\r/g, "");
  } catch (error) {
    return { groups: [], nodes: [] };
  }
  const lines = raw.split("\n");
  const groupsIdx = lines.findIndex((l) => /^proxy-groups:\s*$/.test(l));
  const proxiesIdx = lines.findIndex((l) => /^proxies:\s*$/.test(l));
  const rulesIdx = lines.findIndex((l) => /^rules:\s*$/.test(l));
  const stop = rulesIdx > 0 ? rulesIdx : lines.length;

  const groups = [];
  const nodes = [];

  const collect = (from, to, sink) => {
    for (let i = from; i < to; i += 1) {
      const m = lines[i].match(/^- name:\s*(.+?)\s*$/);
      if (!m) continue;
      const label = decodeYamlName(m[1]);
      if (label) sink.push(label);
    }
  };

  if (proxiesIdx >= 0) {
    collect(proxiesIdx + 1, groupsIdx > proxiesIdx ? groupsIdx : stop, nodes);
  }
  if (groupsIdx >= 0) {
    collect(groupsIdx + 1, stop, groups);
  }

  // 去重（同名节点不重复列）
  return {
    groups: [...new Set(groups)].sort(),
    nodes: [...new Set(nodes)].sort(),
  };
}

function readPrefs() {
  return readJsonSafe(PREFS_FILE) || {};
}

function writePrefs(patch) {
  const next = { ...readPrefs(), ...patch };
  try {
    fs.mkdirSync(DEV_DIR, { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(next, null, 2), "utf8");
  } catch (error) {
    // 偏好写不进去就退回默认
  }
  return next;
}

/** 默认出口：优先自动选择组，其次任意组，最后第一个节点 */
function pickDialer(outlets, preferred) {
  const all = [...outlets.groups, ...outlets.nodes];
  if (preferred && all.includes(preferred)) return preferred;
  const auto = outlets.groups.find((g) => /自动选择|自动|auto/i.test(g));
  if (auto) return auto;
  if (outlets.groups.length) return outlets.groups[0];
  return outlets.nodes[0] || "";
}

/**
 * 用订阅原文拼运行时配置：
 * 保留 proxies / proxy-groups，丢掉端口、外部控制器、DNS 段，
 * 规则换成"只给 Google/AI 域名走指定出口，其余 MATCH,DIRECT"。
 */
function buildRuntimeConfig(profilePath, preferredDialer) {
  const raw = fs.readFileSync(profilePath, "utf8").replace(/\r/g, "");
  const lines = raw.split("\n");

  const rulesIdx = lines.findIndex((l) => /^rules:\s*$/.test(l));
  const body = rulesIdx > 0 ? lines.slice(0, rulesIdx) : lines;

  const outlets = listOutlets(profilePath);
  const dialer = pickDialer(outlets, preferredDialer);
  if (!dialer) throw new Error("订阅里找不到可用的代理组或节点");

  // 这些键由下方 header 统一给出，原文里的必须丢掉，否则 YAML 重复顶层键会被内核拒绝
  const DROP_TOP =
    /^(port|socks-port|redir-port|tproxy-port|mixed-port|allow-lan|mode|log-level|ipv6|unified-delay|tcp-concurrent|external-controller|external-ui|external-ui-name|external-ui-url|secret|tun|sniffer|experimental|profile):/;
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

  // 出口名可能带 emoji 与空格，整条规则用双引号包起来最稳
  const rules = ["rules:"];
  for (const s of PROXY_SUFFIXES) rules.push(`  - "DOMAIN-SUFFIX,${s},${dialer}"`);
  rules.push("  - MATCH,DIRECT");

  return { yaml: header.concat(keep, rules).join("\n") + "\n", dialer, outlets };
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
async function probe(binPath, yamlText, targetHost = "daily-cloudcode-pa.googleapis.com") {
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

    for (let i = 0; i < 6; i += 1) {
      await sleep(1500);
      if (await tunnelToGoogle(PROBE_PORT, targetHost)) {
        return { ok: true };
      }
    }
    return { ok: false, reason: "代理端口通了，但穿不到 Google（该节点可能不可用）" };
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

/** 供面板展示：发现的路径、可选出口、当前选择 */
function describe() {
  const profile = findClashProfile();
  const binPath = findMihomo();
  const outlets = profile ? listOutlets(profile) : { groups: [], nodes: [] };
  const prefs = readPrefs();
  const status = readStatus();
  return {
    profile,
    binPath,
    clashDirs: discoverClashDirs().map((c) => c.dir),
    groups: outlets.groups,
    nodes: outlets.nodes,
    selected: pickDialer(outlets, prefs.dialer),
    prefsDialer: prefs.dialer || "",
    status,
    port: EGRESS_PORT,
  };
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
    const status = { ok: false, mode: "direct", reason, profile };
    writeStatus(status);
    log(`出海通道未启用：${reason}`);
    return status;
  };

  if (!profile) return fallback("没找到 Clash 订阅文件");
  if (!binPath) return fallback("没找到 mihomo 内核");

  const prefs = readPrefs();
  let built;
  try {
    built = buildRuntimeConfig(profile, prefs.dialer || options.dialer);
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
    groups: built.outlets.groups.length,
    nodes: built.outlets.nodes.length,
    suffixes: PROXY_SUFFIXES.length,
  };
  writeStatus(status);
  log(`出海通道已启用：出口「${built.dialer}」`);
  return status;
}

/** 切换出口：记住选择并立即重建配置（调用方决定何时重启网关） */
async function setDialer(name, options = {}) {
  const outlets = listOutlets(findClashProfile());
  const all = [...outlets.groups, ...outlets.nodes];
  if (name && !all.includes(name)) {
    return { ok: false, reason: `订阅里没有名为「${name}」的出口` };
  }
  writePrefs({ dialer: name || "" });
  log(`出口切换为「${name || "自动"}」`);
  return prepare({ ...options, dialer: name || "" });
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
  describe,
  setDialer,
  readStatus,
  findClashProfile,
  findMihomo,
  listOutlets,
  buildRuntimeConfig,
  EGRESS_PORT,
  PROXY_SUFFIXES,
  _internals: { applyProxyUrl, applySupervisorConfig, probe, portOpen, discoverClashDirs, readPrefs },
};
