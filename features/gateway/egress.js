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
// 面板里填的订阅链接落盘的位置：网关自己拉节点，不再依赖 Clash 客户端
const SUB_URL_FILE = path.join(DEV_DIR, "subscription-url.txt");
const SUB_CACHE = path.join(DEV_DIR, "subscription.yaml");

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



/**
 * 出网要走物理网卡，不能落进系统 Clash 的 TUN。
 *
 * TUN 装的是 0.0.0.0/0 → 198.18.0.2 的默认路由，网关进程的流量会被它整包劫走，
 * 于是内核拿着 198.18.x.x 这种 fake-ip 去连节点，永远连不上。绑死物理网卡后
 * 这条路径就独立了：用户怎么开关 Clash、切什么模式，都不再影响网关。
 */
const PHYSICAL_INTERFACE = "以太网";

/**
 * 自带 DNS，不继承系统那份（fake-ip + TUN 劫持 53）。
 * proxy-server-nameserver 专门管「解析节点域名」，必须走真实解析，
 * 否则节点域名又会被换成 fake-ip。
 */
const DNS_BLOCK = [
  "dns:",
  "  enable: true",
  "  ipv6: false",
  "  enhanced-mode: normal",
  "  use-hosts: false",
  "  use-system-hosts: false",
  "  respect-rules: false",
  "  default-nameserver:",
  "  - 223.5.5.5",
  "  - 119.29.29.29",
  "  nameserver:",
  "  - 223.5.5.5",
  "  - 119.29.29.29",
  "  proxy-server-nameserver:",
  "  - 223.5.5.5",
  "  - 119.29.29.29",
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

/**
 * 订阅支持
 *
 * 面板上可以直接填订阅地址，网关自己拉 YAML 拿节点，不再依赖本机的 Clash 客户端。
 * 拉下来的原文缓存在 dev/subscription.yaml，之后选线路、重建运行时配置都从缓存走，
 * 所以断网或订阅临时抽风时，上一次的节点还能继续用。
 */

function readSubscriptionUrl() {
  try {
    return fs.readFileSync(SUB_URL_FILE, "utf8").trim();
  } catch (error) {
    return "";
  }
}

function writeSubscriptionUrl(url) {
  try {
    fs.mkdirSync(DEV_DIR, { recursive: true });
    fs.writeFileSync(SUB_URL_FILE, String(url || "").trim(), "utf8");
    return true;
  } catch (error) {
    return false;
  }
}

/** 回显时只留协议与主机，避免订阅 token 在面板上明文铺开 */
function maskSubscription(url) {
  const text = String(url || "").trim();
  if (!text) return "";
  try {
    const u = new URL(text);
    const tail = u.pathname.split("/").filter(Boolean).pop() || "";
    const short = tail.length > 8 ? tail.slice(0, 4) + "…" + tail.slice(-2) : tail;
    return `${u.protocol}//${u.host}/${short}`;
  } catch (error) {
    return "（地址格式无法解析）";
  }
}

/** 拉订阅：跟随重定向、带超时，并确认拿回来的确实是 Clash 订阅 */
function fetchSubscription(url, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      resolve({ ok: false, reason: "订阅地址不是合法的 URL" });
      return;
    }
    if (!/^https?:$/.test(target.protocol)) {
      resolve({ ok: false, reason: "订阅地址必须以 http:// 或 https:// 开头" });
      return;
    }

    const go = (current, depth) => {
      if (depth > 5) {
        resolve({ ok: false, reason: "重定向次数过多" });
        return;
      }
      const module = current.protocol === "https:" ? require("https") : http;
      const req = module.request(
        {
          host: current.hostname,
          port: current.port || (current.protocol === "https:" ? 443 : 80),
          path: current.pathname + current.search,
          method: "GET",
          timeout: timeoutMs,
          headers: {
            "User-Agent": "clash-verge/v2.5.8 mihomo/v1.19",
            Accept: "application/yaml, text/yaml, text/plain, */*",
          },
        },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            try {
              go(new URL(res.headers.location, current), depth + 1);
            } catch (error) {
              resolve({ ok: false, reason: "订阅重定向地址无法解析" });
            }
            return;
          }
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              resolve({ ok: false, reason: `订阅服务器返回 HTTP ${res.statusCode}` });
              return;
            }
            const body = Buffer.concat(chunks).toString("utf8");
            if (!/^\s*proxies:/m.test(body)) {
              resolve({ ok: false, reason: "返回内容不是 Clash 订阅（找不到 proxies 段）" });
              return;
            }
            resolve({ ok: true, body });
          });
          res.on("error", (error) => resolve({ ok: false, reason: "读取订阅响应失败：" + error.message }));
        }
      );
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, reason: "订阅拉取超时" });
      });
      req.on("error", (error) => resolve({ ok: false, reason: "订阅拉取失败：" + error.message }));
      req.end();
    };

    go(target, 0);
  });
}

/** 面板点「应用」：拉一次订阅 → 落缓存 → 按缓存重建运行时配置 */
async function applySubscription(url, options = {}) {
  const text = String(url || "").trim();
  if (!text) return { ok: false, reason: "订阅地址不能为空" };

  const fetched = await fetchSubscription(text);
  if (!fetched.ok) {
    log(`订阅拉取失败：${fetched.reason}`);
    return fetched;
  }

  try {
    fs.mkdirSync(DEV_DIR, { recursive: true });
    fs.writeFileSync(SUB_CACHE, fetched.body, "utf8");
  } catch (error) {
    return { ok: false, reason: "订阅缓存写入失败" };
  }
  writeSubscriptionUrl(text);

  const outlets = listOutlets(SUB_CACHE);
  if (!outlets.groups.length && !outlets.nodes.length) {
    return { ok: false, reason: "订阅里没有解析出任何节点" };
  }

  // 换了订阅，旧出口多半不在新列表里，清掉偏好让它重新挑一个
  writePrefs({ dialer: "" });
  log(`订阅已更新：${outlets.groups.length} 个组 / ${outlets.nodes.length} 个节点`);

  // 订阅一落地就先测一遍，把连不通的节点筛掉；测不到也不阻止保存，
  // 只是面板会显示「未检测」，用户可以手动重测
  let health = null;
  if (options.skipHealth !== true) {
    health = await probeNodes(SUB_CACHE, { timeout: options.probeTimeout || 5000 });
    if (!health.ok) log(`节点检测没跑成：${health.reason}`);
  }

  const prepared = await prepare(options);
  // 一个能用的都没有时，把话说明白，而不是给一句含糊的「未启用」
  if (health && health.ok && health.usable.length === 0) {
    return {
      ...prepared,
      ok: false,
      reason: `订阅里 ${health.tested} 个节点全部连不通（可能是订阅过期、设备被限，或本机网络无法直连这些节点）`,
    };
  }
  return prepared;
}

/** 节点来源：面板填过订阅就用订阅缓存，否则退回 Clash 客户端里的那份 */
function activeProfile() {
  if (readSubscriptionUrl() && fs.existsSync(SUB_CACHE)) return SUB_CACHE;
  return findClashProfile();
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

/**
 * 节点健康检测
 *
 * 订阅里几十个节点常常大半是死的，全列出来只会让人选到连不通的那个。
 * 这里用同一个内核起一个临时实例（带控制口、不绑网卡也不需要），
 * 逐节点问一次延迟，只把真正能出网的留下。
 *
 * 用 mihomo 自己的 /proxies/<name>/delay 而不是自己开 socket：
 * 节点的协议（hysteria2 / anytls / vless）各不相同，只有内核知道怎么握手。
 */

const PROBE_CTRL_PORT = 8326;
const PROBE_MIXED_PORT = 8329;

/** 结果缓存：同一份订阅在 TTL 内不重复测，避免每次开面板都等十几秒 */
function healthFile() {
  return path.join(DEV_DIR, "node-health.json");
}

function readHealth() {
  const doc = readJsonSafe(healthFile());
  if (!doc || !doc.updatedAt || !Array.isArray(doc.usable)) return null;
  return doc;
}

function isHealthFresh(doc, ttlMs = 10 * 60 * 1000) {
  if (!doc || !doc.updatedAt) return false;
  return Date.now() - new Date(doc.updatedAt).getTime() < ttlMs;
}

/** 订阅内容变了（同样的地址重新拉过）也要作废旧的检测结果 */
function subscriptionFingerprint() {
  try {
    const st = fs.statSync(SUB_CACHE);
    return `${st.size}-${Math.round(st.mtimeMs)}`;
  } catch (error) {
    return "";
  }
}

function delayOf(port, name, url, timeoutMs) {
  return new Promise((resolve) => {
    const q = `url=${encodeURIComponent(url)}&timeout=${timeoutMs}`;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/proxies/${encodeURIComponent(name)}/delay?${q}`,
        headers: { Authorization: "Bearer probe" },
        timeout: timeoutMs + 3000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(typeof body.delay === "number" && body.delay > 0 ? body.delay : 0);
          } catch (error) {
            resolve(0);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

/**
 * 逐节点测一遍，返回 [{ name, delay }]（只含可用的）与全量结果。
 * 探测实例用一个临时端口，测完立刻收掉，不影响正在跑的 8319。
 */
async function probeNodes(profilePath, options = {}) {
  const binPath = findMihomo();
  if (!binPath) return { ok: false, reason: "没找到 mihomo 内核", usable: [], dead: [] };

  const outlets = listOutlets(profilePath);
  const targets = outlets.nodes.length ? outlets.nodes : [];
  if (!targets.length) return { ok: false, reason: "订阅里没有单个节点可测", usable: [], dead: [] };

  const raw = fs.readFileSync(profilePath, "utf8").replace(/\r/g, "");
  const rulesIdx = raw.split("\n").findIndex((l) => /^rules:\s*$/.test(l));
  const lines = raw.split("\n");
  const body = rulesIdx > 0 ? lines.slice(0, rulesIdx) : lines;

  // 探测实例：不绑网卡（要借用系统当前的出网路径去连节点），只留控制口
  const DROP = /^(port|socks-port|redir-port|tproxy-port|mixed-port|allow-lan|mode|log-level|ipv6|unified-delay|tcp-concurrent|external-controller|external-ui|external-ui-name|external-ui-url|secret|tun|sniffer|experimental|profile|interface-name|dns):/;
  const keep = [];
  let skipping = false;
  for (const line of body) {
    if (/^---\s*$/.test(line)) continue;
    const isTop = /^[a-zA-Z][\w-]*:/.test(line);
    if (isTop) {
      skipping = DROP.test(line);
      if (skipping) continue;
      keep.push(line);
      continue;
    }
    if (skipping) continue;
    keep.push(line);
  }

  const yaml = [
    `mixed-port: ${PROBE_MIXED_PORT}`,
    "allow-lan: false",
    "mode: global",
    "log-level: silent",
    "ipv6: false",
    `external-controller: 127.0.0.1:${PROBE_CTRL_PORT}`,
    "secret: probe",
    `interface-name: ${options.interfaceName || PHYSICAL_INTERFACE}`,
  ]
    .concat(DNS_BLOCK, keep, ["rules:", "  - MATCH,DIRECT"])
    .join("\n");

  const cfgPath = path.join(BIN_DIR, "mihomo-health.yaml");
  try {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.writeFileSync(cfgPath, yaml + "\n", "utf8");
  } catch (error) {
    return { ok: false, reason: "写探测配置失败", usable: [], dead: [] };
  }

  let child;
  try {
    child = spawn(binPath, ["-f", cfgPath], { cwd: BIN_DIR, windowsHide: true, stdio: "ignore" });
    child.on("error", () => {});

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await portOpen(PROBE_CTRL_PORT)) break;
      await sleep(300);
    }
    if (!(await portOpen(PROBE_CTRL_PORT))) {
      return { ok: false, reason: "探测内核没起来", usable: [], dead: [] };
    }

    const url = options.url || "https://www.gstatic.com/generate_204";
    const timeout = options.timeout || 5000;
    const results = [];

    // 并发测，太快会让本机代理端口堆积，分四路
    const lanes = 4;
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const name = targets[cursor];
        cursor += 1;
        const delay = await delayOf(PROBE_CTRL_PORT, name, url, timeout);
        results.push({ name, delay });
      }
    };
    await Promise.all(Array.from({ length: lanes }, worker));

    const usable = results.filter((r) => r.delay > 0).sort((a, b) => a.delay - b.delay);
    const dead = results.filter((r) => !r.delay).map((r) => r.name);

    const doc = {
      ok: true,
      updatedAt: new Date().toISOString(),
      fingerprint: subscriptionFingerprint(),
      profile: profilePath,
      usable,
      dead,
      tested: results.length,
    };
    try {
      fs.mkdirSync(DEV_DIR, { recursive: true });
      fs.writeFileSync(healthFile(), JSON.stringify(doc, null, 2), "utf8");
    } catch (error) {
      // 缓存写不进去不影响返回值
    }
    log(`节点检测完成：可用 ${usable.length} / 共 ${results.length}`);
    return doc;
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error), usable: [], dead: [] };
  } finally {
    if (child && child.pid) killTree(child.pid);
    try {
      fs.unlinkSync(cfgPath);
    } catch (error) {
      // 忽略
    }
  }
}

/** 有缓存且没过期就直接用，否则返回 null（由调用方决定要不要重新测） */
function cachedHealthy(profilePath, ttlMs) {
  const doc = readHealth();
  if (!doc) return null;
  if (path.resolve(doc.profile || "") !== path.resolve(profilePath || "")) return null;
  if (doc.fingerprint !== subscriptionFingerprint()) return null;
  return isHealthFresh(doc, ttlMs) ? doc : null;
}

/**
 * 插件自建的「自动切换」组名。
 *
 * 订阅里通常已经有一个「自动选择」，但那是订阅方定义的，候选集和服务商
 * 绑死，选到死的节点也没人管。这里另外造一个只认实测可用节点的 group，
 * 由内核按 url-test 每 60 秒重排，最快的那个自动上位；某个节点挂了，
 * 下一次健康检查就把它从候选里摘掉，流量自动落到下一个。
 */
const AUTO_NAME = "⚡ 自动切换（最快可用）";

function isAutoDialer(name) {
  return String(name || "") === AUTO_NAME;
}

/** 订阅里叫「自动选择」的那个组——用户选它时仍然按订阅方定义走 */
function subscriptionAutoGroup(outlets) {
  return outlets.groups.find((g) => /自动选择|自动|auto/i.test(g)) || "";
}

/** 默认出口：有可用节点时首选自建自动切换；用户显式选了某一项且该项在当前候选里则尊重；其次才是订阅自带的组/节点 */
function pickDialer(outlets, preferred, options = {}) {
  const all = [...outlets.groups, ...outlets.nodes];
  if (preferred && (all.includes(preferred) || isAutoDialer(preferred))) return preferred;
  if (options.autoAvailable) return AUTO_NAME;
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
function buildRuntimeConfig(profilePath, preferredDialer, options = {}) {
  const raw = fs.readFileSync(profilePath, "utf8").replace(/\r/g, "");
  const lines = raw.split("\n");

  const rulesIdx = lines.findIndex((l) => /^rules:\s*$/.test(l));
  const body = rulesIdx > 0 ? lines.slice(0, rulesIdx) : lines;

  const outlets = listOutlets(profilePath);

  // 「自动切换」组：候选只放实测可用的节点，交给内核按延迟排序。
  // 没有健康数据时不注入，免得把整份配置搞成没有候选的空组。
  const healthy = options.healthy || cachedHealthy(profilePath);
  const usableNames = healthy ? healthy.usable.map((u) => u.name) : [];
  const autoAvailable = Boolean(usableNames.length);

  const dialer = pickDialer(outlets, preferredDialer, { autoAvailable });
  if (!dialer && !isAutoDialer(preferredDialer)) throw new Error("订阅里找不到可用的代理组或节点");

  // 这些键由下方 header 统一给出，原文里的必须丢掉，否则 YAML 重复顶层键会被内核拒绝
  const DROP_TOP =
    /^(port|socks-port|redir-port|tproxy-port|mixed-port|allow-lan|mode|log-level|ipv6|unified-delay|tcp-concurrent|external-controller|external-ui|external-ui-name|external-ui-url|secret|tun|sniffer|experimental|profile):/;
  const DROP_BLOCK = /^(dns|tun|sniffer|experimental|profile):/;

  const keep = [];
  let skipping = false;
  for (const line of body) {
    if (/^---\s*$/.test(line)) continue;
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
    `interface-name: ${options.interfaceName || PHYSICAL_INTERFACE}`,
  ].concat(DNS_BLOCK);

  const extraGroups = [];
  if (usableNames.length) {
    const q = (s) => `"${s.replace(/"/g, '\\"')}"`;
    extraGroups.push(
      [
        `- name: ${q(AUTO_NAME)}`,
        "  type: url-test",
        '  url: https://www.gstatic.com/generate_204',
        "  interval: 60",
        "  tolerance: 30",
        "  lazy: false",
        "  proxies:",
        ...usableNames.map((n) => `  - ${q(n)}`),
      ].join("\n")
    );
  }

  // 出口名可能带 emoji 与空格，整条规则用双引号包起来最稳
  const effectiveDialer = isAutoDialer(dialer) && usableNames.length ? AUTO_NAME : dialer;
  const rules = ["rules:"];
  for (const s of PROXY_SUFFIXES) rules.push(`  - "DOMAIN-SUFFIX,${s},${effectiveDialer}"`);
  rules.push("  - MATCH,DIRECT");

  // 自建组要插在 proxy-groups 之后、rules 之前
  const text = header.concat(keep, extraGroups, rules).join("\n") + "\n";
  return { yaml: text, dialer: effectiveDialer, outlets, autoAvailable: Boolean(usableNames.length) };
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
  const profile = activeProfile();
  const binPath = findMihomo();
  const outlets = profile ? listOutlets(profile) : { groups: [], nodes: [] };
  const prefs = readPrefs();
  const status = readStatus();
  const subUrl = readSubscriptionUrl();

  // 节点列表只给可用的：没测过就先用缓存，缓存也没有就原样返回（面板会提示去测一次）
  const health = profile ? cachedHealthy(profile, 30 * 60 * 1000) : null;
  const usable = health ? health.usable : [];
  const visibleNodes = health ? usable.map((u) => u.name) : outlets.nodes;
  const delayOf = (name) => {
    const hit = usable.find((u) => u.name === name);
    return hit ? hit.delay : 0;
  };

  return {
    profile,
    binPath,
    clashDirs: discoverClashDirs().map((c) => c.dir),
    groups: outlets.groups,
    nodes: visibleNodes,
    nodeDelays: visibleNodes.map((n) => ({ name: n, delay: delayOf(n) })),
    hiddenNodes: health ? health.dead.length : 0,
    health: health
      ? { updatedAt: health.updatedAt, tested: health.tested, usable: usable.length, dead: health.dead.length }
      : null,
    // 插件自建的自动切换：候选来自实测可用节点，不是订阅里的组
    autoName: AUTO_NAME,
    autoAvailable: Boolean(usable.length),
    selected: pickDialer({ groups: outlets.groups, nodes: visibleNodes }, prefs.dialer, {
      autoAvailable: Boolean(usable.length),
    }),
    prefsDialer: prefs.dialer || "",
    status,
    port: EGRESS_PORT,
    // 面板的订阅输入框：填过就把地址（脱敏）回显出来，并标出节点是不是从订阅来的
    subscriptionUrl: subUrl ? maskSubscription(subUrl) : "",
    subscriptionSet: Boolean(subUrl),
    subscriptionSource: subUrl && fs.existsSync(SUB_CACHE) ? "subscription" : profile ? "clash" : "",
  };
}

/**
 * 主入口：准备出海通道。
 * 成功则 mihomo 交给 supervisor 托管、网关指向它；失败则清掉配置退回直连。
 */
async function prepare(options = {}) {
  const profile = activeProfile();
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
    built = buildRuntimeConfig(profile, prefs.dialer || options.dialer, options);
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
  const outlets = listOutlets(activeProfile());
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
  applySubscription,
  readSubscriptionUrl,
  maskSubscription,
  activeProfile,
  probeNodes,
  readHealth,
  cachedHealthy,
  AUTO_NAME,
  isAutoDialer,
  EGRESS_PORT,
  PROXY_SUFFIXES,
  _internals: {
    applyProxyUrl,
    applySupervisorConfig,
    probe,
    portOpen,
    discoverClashDirs,
    readPrefs,
    fetchSubscription,
  },
};
