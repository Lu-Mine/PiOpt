'use strict';

/**
 * Pure, host-free logic: where the files live, how versions compare, what the
 * market snapshot looks like, and how a failure is named.
 *
 * Everything here runs in plain Node so it can be unit-tested outside the app.
 * Nothing in this file touches the network.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ID = 'local.pimarket';
const DOWNLOADS_DIRNAME = 'downloads';
const PACKAGE_SUFFIX = '.piplug';
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024; // the host refuses anything larger

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

/**
 * ~/.pi-desktop — the app data root. An explicit override wins, then the
 * host's own variable if it happens to be visible to the plugin process.
 */
function appRoot(override) {
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  const fromEnv = process.env.PI_DESKTOP_DATA_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(homeDir(), '.pi-desktop');
}

function pluginsRoot(override) {
  return path.join(appRoot(override), 'plugins');
}

function registryPath(override) {
  return path.join(pluginsRoot(override), 'registry.json');
}

function catalogPath(override) {
  return path.join(pluginsRoot(override), 'market', 'catalog.json');
}

/** This plugin's own data folder. `dataDir` is a full path, not a root. */
function ownDataDir(settings = {}) {
  const custom = typeof settings?.dataDir === 'string' ? settings.dataDir.trim() : '';
  if (custom) return path.resolve(custom);
  const fromEnv = process.env.PI_DESKTOP_DATA_DIR;
  const root = fromEnv && fromEnv.trim() ? path.resolve(fromEnv.trim()) : path.join(homeDir(), '.pi-desktop');
  return path.join(root, 'plugins', 'data', PLUGIN_ID);
}

function downloadsDir(settings = {}) {
  return path.join(ownDataDir(settings), DOWNLOADS_DIRNAME);
}

function packageFileName(id, version) {
  return `${id}-${version}${PACKAGE_SUFFIX}`;
}

function packagePath(settings, id, version) {
  return path.join(downloadsDir(settings), packageFileName(id, version));
}

// ---------------------------------------------------------------------------
// Small guards
// ---------------------------------------------------------------------------

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Plugin ids and versions become file names, so they get the same guard. */
function isSafeId(value) {
  return typeof value === 'string' && value.length <= 120 && ID_RE.test(value);
}

function isSafeVersion(value) {
  return typeof value === 'string' && value.length <= 64 && /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(value);
}

function isSafeRepo(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && value.length <= 120;
}

function isSafeRef(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._\/-]{1,120}$/.test(value) && !value.includes('..');
}

// ---------------------------------------------------------------------------
// Version comparison (semver subset: major.minor.patch[-pre][+build])
// ---------------------------------------------------------------------------

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] || null };
}

/** Lexical order of pre-release identifiers, per semver: numeric < alphanumeric. */
function comparePre(a, b) {
  if (a === b) return 0;
  if (a === null) return 1; // a release outranks a pre-release
  if (b === null) return -1;
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** -1 / 0 / 1; an unparseable version sorts below a parseable one. */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return String(a) === String(b) ? 0 : String(a) < String(b) ? -1 : 1;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePre(pa.pre, pb.pre);
}

// ---------------------------------------------------------------------------
// Catalog + registry
// ---------------------------------------------------------------------------

function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { ok: true, value: JSON.parse(text), bytes: Buffer.byteLength(text), mtimeMs: statMtime(file) };
  } catch (error) {
    return { ok: false, error: `${error?.code || 'READ_FAILED'}: ${error?.message || error}`, path: file };
  }
}

function statMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** registry.json is an array of installed plugins; older or broken shapes degrade to []. */
function loadRegistry(rootOverride) {
  const file = registryPath(rootOverride);
  const read = readJsonFile(file);
  if (!read.ok) return { ok: false, path: file, entries: [], error: read.error };
  const raw = read.value;
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.plugins) ? raw.plugins : [];
  const entries = list.filter(item => item && typeof item.id === 'string');
  return { ok: true, path: file, entries, mtimeMs: read.mtimeMs };
}

function loadCatalog(rootOverride) {
  return loadCatalogFile(catalogPath(rootOverride));
}

/** Same reader, but for the refreshed copy this plugin keeps in its own data folder. */
function loadCatalogFile(file) {
  const read = readJsonFile(file);
  if (!read.ok) return { ok: false, path: file, plugins: [], error: read.error };
  const data = read.value;
  if (!data || !Array.isArray(data.plugins)) {
    return { ok: false, path: file, plugins: [], error: 'catalog.json has no plugins array' };
  }
  const plugins = data.plugins.filter(item => item && typeof item.id === 'string');
  return {
    ok: true,
    path: file,
    plugins,
    bytes: read.bytes,
    mtimeMs: read.mtimeMs,
    meta: {
      name: typeof data.name === 'string' ? data.name : null,
      updatedAt: typeof data.updated_at === 'string' ? data.updated_at : null,
      generatedAt: typeof data.generated_at === 'string' ? data.generated_at : null,
      schemaVersion: data.schema_version ?? null,
    },
  };
}

function catalogIndex(catalog) {
  const map = new Map();
  for (const plugin of catalog?.plugins || []) if (!map.has(plugin.id)) map.set(plugin.id, plugin);
  return map;
}

/** Highest non-yanked version of one catalog plugin, or null. */
function latestVersion(plugin) {
  if (!plugin) return null;
  const versions = (Array.isArray(plugin.versions) ? plugin.versions : [])
    .filter(entry => entry && isSafeVersion(entry.version) && entry.yanked !== true);
  if (!versions.length) {
    if (isSafeVersion(plugin.version)) {
      return { version: plugin.version, shasum: plugin.shasum ?? null, sizeBytes: plugin.sizeBytes ?? null, url: plugin.url ?? null };
    }
    return null;
  }
  versions.sort((a, b) => compareVersions(b.version, a.version));
  return versions[0];
}

function findVersion(plugin, version) {
  if (!plugin) return null;
  const versions = Array.isArray(plugin.versions) ? plugin.versions : [];
  const hit = versions.find(entry => entry && entry.version === version);
  if (hit) return hit.yanked === true ? { ...hit, yanked: true } : hit;
  if (plugin.version === version) {
    return { version: plugin.version, shasum: plugin.shasum ?? null, sizeBytes: plugin.sizeBytes ?? null, url: plugin.url ?? null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Downloads on disk
// ---------------------------------------------------------------------------

function listDownloads(settings = {}) {
  const dir = downloadsDir(settings);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { dir, files: [] };
  }
  const files = [];
  for (const name of names) {
    if (!name.endsWith(PACKAGE_SUFFIX)) continue;
    const stem = name.slice(0, -PACKAGE_SUFFIX.length);
    const match = stem.match(/^(.+)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
    if (!match) continue;
    const full = path.join(dir, name);
    let sizeBytes = null;
    let mtimeMs = null;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      sizeBytes = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    files.push({ id: match[1], version: match[2], path: full, fileName: name, sizeBytes, mtimeMs });
  }
  files.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return { dir, files };
}

function findDownload(settings, id, version) {
  return listDownloads(settings).files.find(file => file.id === id && file.version === version) || null;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

const CHANGELOG_LIMIT = 4000;

function trimText(value, limit = CHANGELOG_LIMIT) {
  if (typeof value !== 'string') return '';
  return value.length > limit ? `${value.slice(0, limit)}\n… (${value.length - limit} more characters)` : value;
}

function packageView(entry) {
  if (!entry) return null;
  return {
    version: entry.version,
    sizeBytes: typeof entry.sizeBytes === 'number' ? entry.sizeBytes : null,
    sha256: typeof entry.shasum === 'string' ? entry.shasum : null,
    url: typeof entry.url === 'string' ? entry.url : null,
    publishedAt: entry.publishedAt ?? null,
    changelog: trimText(entry.changelog),
    permissions: Array.isArray(entry.permissions) ? entry.permissions : null,
    provenance: entry.provenance ?? null,
    yanked: entry.yanked === true,
  };
}

function downloadView(file, entry) {
  if (!file) return null;
  const expected = typeof entry?.sizeBytes === 'number' ? entry.sizeBytes : null;
  return {
    path: file.path,
    fileName: file.fileName,
    sizeBytes: file.sizeBytes,
    expectedSizeBytes: expected,
    sizeMatches: expected === null ? null : expected === file.sizeBytes,
    mtimeMs: file.mtimeMs,
  };
}

/**
 * The single payload the panel draws from.
 * `lookups` lets a caller inject already-loaded files (tests, or a refreshed read).
 */
function buildSnapshot({ registry, catalog, downloads, settings = {}, rootOverride }) {
  const reg = registry || loadRegistry(rootOverride);
  const cat = catalog || loadCatalog(rootOverride);
  const files = downloads || listDownloads(settings);
  const index = catalogIndex(cat.ok ? cat : null);

  const installed = (reg.entries || []).map(entry => {
    const plugin = index.get(entry.id) || null;
    const latest = latestVersion(plugin);
    const current = typeof entry.version === 'string' ? entry.version : '';
    const newer = latest && compareVersions(latest.version, current) > 0;
    const sameVersion = latest && compareVersions(latest.version, current) === 0;
    const downloaded = findDownload(settings, entry.id, latest?.version || current) ||
      files.files.find(file => file.id === entry.id && file.version === current) || null;
    return {
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
      version: current,
      enabled: entry.enabled !== false,
      status: entry.status ?? null,
      bundled: entry.bundled === true,
      source: entry.source ?? null,
      autoUpdate: entry.autoUpdate === true,
      path: entry.path ?? null,
      localName: plugin ? localizedName(plugin) : null,
      catalogVersion: latest?.version || null,
      updateAvailable: Boolean(newer),
      isCurrent: Boolean(sameVersion),
      inCatalog: Boolean(plugin),
      latest: packageView(latest),
      installedSha256: entry.marketplace?.shasum ?? null,
      downloaded: newer ? downloadView(downloaded, latest) : downloadView(downloaded, findVersion(plugin, current)),
    };
  });

  installed.sort((a, b) => {
    if (a.updateAvailable !== b.updateAvailable) return a.updateAvailable ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  const updates = installed.filter(item => item.updateAvailable);
  const installedIds = new Set(installed.map(item => item.id));

  const available = [];
  for (const plugin of cat.ok ? cat.plugins : []) {
    if (installedIds.has(plugin.id)) continue;
    const latest = latestVersion(plugin);
    if (!latest) continue;
    available.push({
      id: plugin.id,
      name: localizedName(plugin),
      description: trimText(localizedDescription(plugin), 220),
      author: typeof plugin.author === 'string' ? plugin.author : null,
      trust: plugin.trust ?? null,
      verified: plugin.verified === true,
      downloads: typeof plugin.downloads === 'number' ? plugin.downloads : null,
      latest: packageView(latest),
      downloaded: downloadView(files.files.find(file => file.id === plugin.id && file.version === latest.version), latest),
    });
  }
  available.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));

  const updateBytes = updates.reduce((sum, item) => sum + (item.latest?.sizeBytes || 0), 0);

  return {
    now: Date.now(),
    pluginId: PLUGIN_ID,
    catalog: {
      ok: cat.ok,
      path: cat.path,
      error: cat.error || null,
      bytes: cat.bytes ?? null,
      mtimeMs: cat.mtimeMs ?? null,
      ...(cat.meta || {}),
      pluginCount: cat.ok ? cat.plugins.length : 0,
    },
    registry: { ok: reg.ok, path: reg.path, error: reg.error || null, mtimeMs: reg.mtimeMs ?? null },
    dataDir: ownDataDir(settings),
    downloadsDir: files.dir,
    downloads: files.files.slice(0, 100),
    installed,
    updates,
    available,
    stats: {
      installed: installed.length,
      updates: updates.length,
      available: available.length,
      downloaded: files.files.length,
      updateBytes,
    },
  };
}

function localizedName(plugin) {
  if (!plugin) return null;
  const zh = plugin.i18n?.['zh-CN']?.name;
  return typeof zh === 'string' && zh ? zh : (typeof plugin.name === 'string' ? plugin.name : plugin.id);
}

function localizedDescription(plugin) {
  if (!plugin) return '';
  const zh = plugin.i18n?.['zh-CN']?.description;
  return typeof zh === 'string' && zh ? zh : (typeof plugin.description === 'string' ? plugin.description : '');
}

// ---------------------------------------------------------------------------
// Failure names
//
// The host's three failure modes look nothing alike, and telling the user
// "package corrupt" when the server answered with its SPA is actively wrong.
// Every failure therefore carries a stable code plus the untouched original text.
// ---------------------------------------------------------------------------

const FAILURE = Object.freeze({
  SERVER_HTML: 'SERVER_HTML',
  LINK_RESET: 'LINK_RESET',
  MIRROR_404: 'MIRROR_404',
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  DNS: 'DNS',
  HTTP_ERROR: 'HTTP_ERROR',
  INTEGRITY: 'INTEGRITY',
  TOO_LARGE: 'TOO_LARGE',
  CANCELLED: 'CANCELLED',
  NO_SOURCE: 'NO_SOURCE',
  BAD_REQUEST: 'BAD_REQUEST',
  WRITE_FAILED: 'WRITE_FAILED',
  UNKNOWN: 'UNKNOWN',
});

/** Best-effort label for a raw error coming out of node:https. */
function classifyFailure(error) {
  const text = String(error?.message || error || '');
  if (error?.code === 'ABORT_ERR' || /aborted|cancel/i.test(text)) return FAILURE.CANCELLED;
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timed? ?out|timeout/i.test(text)) return FAILURE.TIMEOUT;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return FAILURE.DNS;
  if (/ECONNRESET|EPIPE|socket hang up|ECONNABORTED|missing close_notify|schannel|TLS|SSL/i.test(text)) return FAILURE.LINK_RESET;
  if (/ENOSPC|EACCES|EPERM|EROFS/i.test(text)) return FAILURE.WRITE_FAILED;
  const status = Number(error?.statusCode);
  if (status === 404) return FAILURE.MIRROR_404;
  if (status === 403 || status === 429) return FAILURE.RATE_LIMIT;
  if (status >= 400) return FAILURE.HTTP_ERROR;
  return FAILURE.UNKNOWN;
}

/** Short bilingual hint shown next to the untouched error text. */
function failureHint(code, locale = 'zh-CN') {
  const zh = {
    SERVER_HTML: '服务端包路由返回了 HTML（SPA 回落），不是包损坏。',
    LINK_RESET: '到该主机的链路被中断（TLS 重置 / 连接被掐），大文件尤其明显。',
    MIRROR_404: '该镜像没有这个文件。',
    RATE_LIMIT: 'GitHub API 限流或拒绝访问，稍后再试。',
    TIMEOUT: '连接或下载超时。',
    DNS: '域名解析失败，检查网络或代理。',
    HTTP_ERROR: 'HTTP 状态码不是 200。',
    INTEGRITY: '大小或 sha256 与 catalog 不一致，包已被丢弃。',
    TOO_LARGE: '包超过 50 MB，宿主不会接受。',
    CANCELLED: '已取消。',
    NO_SOURCE: '所有下载通道都失败了。',
    BAD_REQUEST: '参数不合法。',
    WRITE_FAILED: '写盘失败，检查数据目录权限与剩余空间。',
    UNKNOWN: '未知错误。',
  };
  const en = {
    SERVER_HTML: 'The package route answered with HTML (SPA fallback); the package is not corrupt.',
    LINK_RESET: 'The link to that host was cut (TLS reset / connection dropped); large files suffer most.',
    MIRROR_404: 'That mirror does not have this file.',
    RATE_LIMIT: 'GitHub API rate limit or refusal; try again later.',
    TIMEOUT: 'Connection or download timed out.',
    DNS: 'DNS lookup failed; check the network or proxy.',
    HTTP_ERROR: 'The HTTP status was not 200.',
    INTEGRITY: 'Size or sha256 does not match the catalog; the package was discarded.',
    TOO_LARGE: 'The package exceeds 50 MB, which the host refuses.',
    CANCELLED: 'Cancelled.',
    NO_SOURCE: 'Every download channel failed.',
    BAD_REQUEST: 'Invalid argument.',
    WRITE_FAILED: 'Could not write; check the data folder permissions and free space.',
    UNKNOWN: 'Unknown error.',
  };
  const table = String(locale).toLowerCase().startsWith('zh') ? zh : en;
  return table[code] || table.UNKNOWN;
}

function humanBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

module.exports = {
  PLUGIN_ID,
  PACKAGE_SUFFIX,
  MAX_PACKAGE_BYTES,
  FAILURE,
  appRoot,
  pluginsRoot,
  registryPath,
  catalogPath,
  ownDataDir,
  downloadsDir,
  packageFileName,
  packagePath,
  isSafeId,
  isSafeVersion,
  isSafeRepo,
  isSafeRef,
  parseVersion,
  compareVersions,
  loadRegistry,
  loadCatalog,
  loadCatalogFile,
  catalogIndex,
  latestVersion,
  findVersion,
  listDownloads,
  findDownload,
  buildSnapshot,
  classifyFailure,
  failureHint,
  humanBytes,
  trimText,
  localizedName,
};
