'use strict';

/**
 * Pimarket — market panel and update preparer.
 *
 * What this plugin deliberately does NOT do: install, uninstall, enable or
 * disable anything. The host owns `registry.json`; writing it behind the host's
 * back corrupts the plugin list on the next start. So this plugin stops one
 * honest step earlier: it produces a package whose bytes match the official
 * catalog, tells you where it is, and directs you to Plugins → Install plugin
 * package.
 *
 * Reading local state uses this process's Node fs on purpose: registry.json and
 * market/catalog.json sit under the app data directory, which the host's fs
 * gateway refuses by design. Downloading uses node:https rather than the host
 * gateway for the same reason a 30-second host fetch cannot carry a 7 MB file;
 * the four allowed hosts are hard-coded in lib/downloader.js and every redirect
 * is re-checked against that list.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const core = require('./core.js');
const permissions = require('./permissions.js');
const downloader = require('./downloader.js');
const manifest = require('../../manifest.json');

const OPEN_COMMAND = 'pimarket.open';
const PREPARE_ALL_COMMAND = 'pimarket.prepare-updates';
const CATALOG_URL = 'https://plugins.aiuo.net/catalog.json';
const DEFAULT_REPO = 'AIUO-Net/pi-desktop-plugins';
const DEFAULT_REF = 'main';

/** In-memory job table; the panel polls market.jobs while something runs. */
const jobs = new Map();
let lastCatalogRefresh = null;
/** Serializes "prepare all" so a batch never opens several transfers at once. */
let batchChain = Promise.resolve();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function appLocale() {
  try {
    const value = await pi.app.getLocale();
    return typeof value === 'string' && value ? value : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

function t(locale, zh, en) {
  return String(locale).toLowerCase().startsWith('zh') ? zh : en;
}

async function readSettings() {
  try {
    const value = await pi.plugin.getSettings();
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function mirrorOf(settings) {
  const repo = typeof settings.mirrorRepo === 'string' && core.isSafeRepo(settings.mirrorRepo.trim())
    ? settings.mirrorRepo.trim()
    : DEFAULT_REPO;
  const ref = typeof settings.mirrorRef === 'string' && core.isSafeRef(settings.mirrorRef.trim())
    ? settings.mirrorRef.trim()
    : DEFAULT_REF;
  return { repo, ref };
}

/**
 * Prefer the copy this plugin refreshed itself when it is newer than the host's
 * cached one; both are plain catalog documents.
 */
function pickCatalog(settings) {
  const host = core.loadCatalog();
  let fresh = null;
  try {
    fresh = core.loadCatalogFile(path.join(core.ownDataDir(settings), 'catalog.json'));
  } catch {
    fresh = null;
  }
  if (fresh?.ok && (!host.ok || (fresh.mtimeMs || 0) >= (host.mtimeMs || 0))) {
    fresh.source = 'refreshed';
    return fresh;
  }
  host.source = 'host';
  return host;
}

function jobView(job) {
  return {
    key: job.key,
    id: job.id,
    version: job.version,
    status: job.status,
    phase: job.phase,
    source: job.source,
    sourceLabel: job.sourceLabel || null,
    received: job.received || 0,
    total: job.total || null,
    percent: job.total ? Math.min(100, Math.round(((job.received || 0) / job.total) * 100)) : null,
    attempt: job.attempt || null,
    code: job.code || null,
    error: job.error || null,
    lastError: job.lastError || null,
    path: job.path || null,
    sha256: job.sha256 || null,
    sizeBytes: job.sizeBytes || null,
    verified: job.verified ?? null,
    already: job.already ?? null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    attempts: (job.attempts || []).slice(-40),
  };
}

function pruneJobs() {
  const now = Date.now();
  for (const [key, job] of jobs) {
    if (job.status !== 'running' && job.finishedAt && now - job.finishedAt > 30 * 60_000) jobs.delete(key);
  }
  while (jobs.size > 40) {
    const oldest = [...jobs.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))[0];
    if (!oldest) break;
    jobs.delete(oldest.key);
  }
}

async function snapshot() {
  const settings = await readSettings();
  const catalog = pickCatalog(settings);
  const registry = core.loadRegistry();
  const snap = core.buildSnapshot({ registry, catalog, settings });
  const { repo, ref } = mirrorOf(settings);
  snap.catalog.source = catalog.source;
  snap.mirror = { repo, ref, allowedHosts: downloader.ALLOWED_HOSTS };
  snap.locale = await appLocale();
  snap.lastCatalogRefresh = lastCatalogRefresh;
  snap.jobs = [...jobs.values()].map(jobView);
  snap.hostVersion = manifest.version;
  return snap;
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

function readError(error, locale) {
  const code = Object.values(core.FAILURE).includes(error?.code) ? error.code : core.classifyFailure(error);
  return {
    code,
    message: String(error?.message || error).slice(0, 700),
    hint: core.failureHint(code, locale),
    attempts: Array.isArray(error?.attempts) ? error.attempts.slice(-40) : [],
  };
}

/**
 * Download one package. Never throws for an expected failure: the panel and the
 * agent tool both want a structured answer that keeps the original error text.
 */
async function prepareOne({ id, version, force = false, locale = 'zh-CN' }) {
  const settings = await readSettings();
  const { repo, ref } = mirrorOf(settings);
  const catalog = pickCatalog(settings);

  if (!catalog.ok) {
    return {
      ok: false,
      code: 'NO_CATALOG',
      message: catalog.error || 'catalog.json is missing or unreadable',
      hint: t(locale, '先刷新目录，或确认已装过市场插件。', 'Refresh the catalog, or make sure the market has been opened once.'),
    };
  }
  if (!core.isSafeId(id)) {
    return { ok: false, code: core.FAILURE.BAD_REQUEST, message: `invalid plugin id: ${String(id)}`, hint: core.failureHint(core.FAILURE.BAD_REQUEST, locale) };
  }

  const plugin = catalog.plugins.find(item => item.id === id);
  if (!plugin) {
    return {
      ok: false,
      code: 'NOT_IN_CATALOG',
      message: `${id} is not in the catalog`,
      hint: t(locale, 'catalog 里没有这个插件 id。', 'The catalog has no such plugin id.'),
    };
  }

  const entry = version ? core.findVersion(plugin, version) : core.latestVersion(plugin);
  if (!entry) {
    return {
      ok: false,
      code: 'NO_VERSION',
      message: `${id}@${version || '(latest)'} is not in the catalog`,
      hint: t(locale, 'catalog 没有这个版本。', 'The catalog does not carry that version.'),
    };
  }
  if (entry.yanked === true) {
    return {
      ok: false,
      code: 'YANKED',
      message: `${id}@${entry.version} is marked yanked in the catalog`,
      hint: t(locale, '该版本已被撤回，换用最新版本。', 'That version was yanked; use the newest one instead.'),
    };
  }

  const key = `${id}@${entry.version}`;
  const existing = jobs.get(key);
  if (existing?.status === 'running') {
    return { ok: false, code: 'BUSY', message: `${key} is already downloading`, hint: t(locale, '这个包已经在下载。', 'That package is already downloading.') };
  }

  const job = {
    key,
    id,
    version: entry.version,
    status: 'running',
    phase: 'queued',
    received: 0,
    total: typeof entry.sizeBytes === 'number' ? entry.sizeBytes : null,
    startedAt: Date.now(),
    attempts: [],
    source: null,
    code: null,
    error: null,
    lastError: null,
  };
  jobs.set(key, job);
  pruneJobs();

  try {
    const result = await downloader.preparePackage({
      id,
      version: entry.version,
      entry,
      settings,
      repo,
      ref,
      force,
      onProgress: progress => {
        job.phase = progress.phase;
        if (progress.source) job.source = progress.source;
        if (progress.sourceLabel) job.sourceLabel = progress.sourceLabel;
        if (typeof progress.received === 'number') job.received = progress.received;
        if (typeof progress.total === 'number' && progress.total > 0) job.total = progress.total;
        if (progress.attempt) job.attempt = progress.attempt;
        if (progress.phase === 'failed-attempt') {
          job.lastError = `${progress.sourceLabel || progress.source}: ${progress.message}`;
          job.attempts.push({ source: progress.source, attempt: progress.attempt, code: progress.code, message: progress.message });
        }
      },
    });

    if (result.verified !== true) {
      throw new downloader.DownloadError(core.FAILURE.INTEGRITY, result.verifyDetail || 'package was not verified against the catalog');
    }

    Object.assign(job, {
      status: 'ready',
      lastError: null,
      phase: 'done',
      path: result.path,
      sha256: result.sha256,
      sizeBytes: result.sizeBytes,
      verified: result.verified,
      already: result.already,
      source: result.source,
      sourceLabel: result.sourceLabel || result.source,
      received: result.sizeBytes,
      total: result.sizeBytes,
      finishedAt: Date.now(),
      attempts: result.attempts || [],
    });

    return {
      ok: true,
      jobKey: key,
      id,
      version: entry.version,
      path: result.path,
      sha256: result.sha256,
      sizeBytes: result.sizeBytes,
      source: result.sourceLabel || result.source,
      already: result.already,
      verified: result.verified,
      verifyDetail: result.verifyDetail,
      attempts: result.attempts || [],
      install: t(
        locale,
        `在 Plugins 页选择 Install plugin package，指向 ${result.path}`,
        `In the Plugins page choose Install plugin package and point it at ${result.path}`,
      ),
    };
  } catch (error) {
    const info = readError(error, locale);
    Object.assign(job, {
      status: info.code === core.FAILURE.CANCELLED ? 'cancelled' : 'failed',
      phase: 'failed',
      code: info.code,
      error: info.message,
      finishedAt: Date.now(),
      attempts: info.attempts,
    });
    return { ok: false, jobKey: key, id, version: entry.version, ...info };
  }
}

async function prepareAll({ force = false } = {}) {
  const settings = await readSettings();
  const catalog = pickCatalog(settings);
  const registry = core.loadRegistry();
  const snap = core.buildSnapshot({ registry, catalog, settings });
  const locale = await appLocale();
  const results = [];
  for (const item of snap.updates) {
    const latest = item.latest?.version;
    if (!latest) continue;
    results.push(await prepareOne({ id: item.id, version: latest, force, locale }));
  }
  return {
    total: results.length,
    ready: results.filter(item => item.ok).length,
    failed: results.filter(item => !item.ok).length,
    results,
  };
}

// ---------------------------------------------------------------------------
// Catalog refresh
// ---------------------------------------------------------------------------

async function refreshCatalog() {
  const settings = await readSettings();
  const locale = await appLocale();
  const response = await pi.net.fetch({
    url: CATALOG_URL,
    method: 'GET',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    timeoutMs: 30_000,
  });
  if (!response || typeof response.status !== 'number') {
    throw new Error(t(locale, '目录请求没有得到响应', 'the catalog request returned no response'));
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`catalog.json: HTTP ${response.status}`);
  }
  const text = typeof response.bodyText === 'string' ? response.bodyText : '';
  if (text.length < 64) throw new Error(`catalog.json: response was only ${text.length} bytes`);
  if (/^\s*<!doctype html/i.test(text)) throw new Error('catalog.json: the server answered with HTML');

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`catalog.json is not valid JSON: ${error?.message || error}`);
  }
  if (!data || !Array.isArray(data.plugins)) throw new Error('catalog.json carries no plugins array');

  const dir = core.ownDataDir(settings);
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'catalog.json');
  const temp = `${target}.tmp`;
  await fsp.writeFile(temp, text, 'utf8');
  await fsp.rename(temp, target);
  lastCatalogRefresh = { at: Date.now(), bytes: Buffer.byteLength(text), plugins: data.plugins.length };

  return {
    ok: true,
    path: target,
    bytes: lastCatalogRefresh.bytes,
    plugins: data.plugins.length,
    updatedAt: typeof data.updated_at === 'string' ? data.updated_at : null,
  };
}

// ---------------------------------------------------------------------------
// Panel RPC
// ---------------------------------------------------------------------------

async function onPanelInvoke(channel, payload = {}) {
  switch (channel) {
    case 'market.snapshot':
      return snapshot();

    case 'market.detail': {
      const locale = await appLocale();
      const settings = await readSettings();
      const catalog = pickCatalog(settings);
      const id = typeof payload?.id === 'string' ? payload.id : '';
      if (!catalog.ok) return { ok: false, message: catalog.error || 'catalog.json is unreadable' };
      const plugin = catalog.plugins.find(item => item.id === id);
      if (!plugin) return { ok: false, message: `${id} is not in the catalog` };

      const lang = String(locale).toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
      const i18n = plugin.i18n?.[lang] || plugin.i18n?.['zh-CN'] || {};
      const registry = core.loadRegistry();
      const installed = registry.entries.find(entry => entry.id === id) || null;
      const files = core.listDownloads(settings).files.filter(file => file.id === id);
      const latest = core.latestVersion(plugin);

      const versions = (Array.isArray(plugin.versions) ? plugin.versions : [])
        .slice()
        .sort((a, b) => core.compareVersions(b.version, a.version))
        .map(entry => {
          const file = files.find(item => item.version === entry.version) || null;
          const expected = typeof entry.sizeBytes === 'number' ? entry.sizeBytes : null;
          return {
            version: entry.version,
            publishedAt: entry.publishedAt ?? null,
            sizeBytes: expected,
            sha256: typeof entry.shasum === 'string' ? entry.shasum : null,
            changelog: typeof entry.changelog === 'string' ? entry.changelog : '',
            minPiDesktop: entry.minPiDesktop ?? null,
            yanked: entry.yanked === true,
            permissions: permissions.groupPermissions(entry.permissions, locale),
            provenance: entry.provenance ?? null,
            downloaded: file
              ? { path: file.path, sizeBytes: file.sizeBytes, sizeMatches: expected === null ? null : expected === file.sizeBytes }
              : null,
          };
        });

      return {
        ok: true,
        locale,
        plugin: {
          id: plugin.id,
          name: i18n.name || plugin.name || plugin.id,
          description: i18n.description || plugin.description || '',
          author: typeof plugin.author === 'string' && plugin.author ? plugin.author : null,
          homepage: typeof plugin.homepage === 'string' ? plugin.homepage : null,
          repository: typeof plugin.repository === 'string' ? plugin.repository : null,
          verified: plugin.verified === true,
          trust: plugin.trust ?? null,
          downloads: typeof plugin.downloads === 'number' ? plugin.downloads : null,
          categories: Array.isArray(plugin.categories) ? plugin.categories : [],
          safetyNotes: i18n.safetyNotes || plugin.safety_notes || plugin.safetyNotes || null,
          readme: typeof plugin.readme_markdown === 'string' && plugin.readme_markdown ? plugin.readme_markdown : null,
          latestVersion: latest?.version ?? null,
        },
        installed: installed
          ? {
            version: installed.version,
            enabled: installed.enabled !== false,
            bundled: installed.bundled === true,
            source: installed.source ?? null,
          }
          : null,
        versions,
        downloadsDir: core.downloadsDir(settings),
      };
    }
      return snapshot();

    case 'market.jobs':
      return { jobs: [...jobs.values()].map(jobView) };

    case 'market.startPrepare': {
      const id = payload?.id;
      const version = typeof payload?.version === 'string' ? payload.version : undefined;
      const locale = await appLocale();
      const settings = await readSettings();
      const catalog = pickCatalog(settings);
      if (!catalog.ok) return { ok: false, message: catalog.error || 'catalog.json is unreadable' };
      const plugin = catalog.plugins.find(item => item.id === id);
      const entry = version ? core.findVersion(plugin, version) : core.latestVersion(plugin);
      if (!plugin || !entry) return { ok: false, message: 'no catalog entry for that id/version' };
      const jobKey = `${id}@${entry.version}`;
      if (jobs.get(jobKey)?.status === 'running') return { ok: true, jobKey, version: entry.version, running: true };
      // Fire and forget: a 7 MB transfer must not sit inside one panel RPC.
      prepareOne({ id, version: entry.version, force: payload?.force === true, locale }).catch(() => {});
      return { ok: true, jobKey, version: entry.version, running: false };
    }

    case 'market.startPrepareAll': {
      const locale = await appLocale();
      const settings = await readSettings();
      const snap = core.buildSnapshot({ registry: core.loadRegistry(), catalog: pickCatalog(settings), settings });
      const started = [];
      for (const item of snap.updates) {
        const version = item.latest?.version;
        if (!version) continue;
        const jobKey = `${item.id}@${version}`;
        if (jobs.get(jobKey)?.status === 'running') continue;
        started.push(jobKey);
      }
      // One at a time: several parallel transfers on a flaky link only make it worse.
      batchChain = batchChain
        .then(async () => {
          for (const key of started) {
            const [id, version] = key.split('@');
            await prepareOne({ id, version, force: payload?.force === true, locale });
          }
        })
        .catch(() => {});
      return { ok: true, started, total: snap.updates.length };
    }

    case 'market.prepare':
      return prepareOne({
        id: payload?.id,
        version: typeof payload?.version === 'string' ? payload.version : undefined,
        force: payload?.force === true,
        locale: await appLocale(),
      });

    case 'market.prepareAll': {
      const summary = await prepareAll({ force: payload?.force === true });
      const locale = await appLocale();
      for (const item of summary.results) {
        if (!item.ok) continue;
        try {
          await pi.ui.showToast(t(
            locale,
            item.already ? `${item.id} 已有校验通过的包` : `${item.id}@${item.version} 已下载并校验`,
            item.already ? `${item.id}: a verified package is already here` : `${item.id}@${item.version} downloaded and verified`,
          ));
        } catch {
          /* a toast failing must not abort the batch */
        }
      }
      return summary;
    }

    case 'market.cancel': {
      const key = typeof payload?.key === 'string' ? payload.key : `${payload?.id}@${payload?.version}`;
      const cancelled = downloader.cancelJob(key);
      const job = jobs.get(key);
      if (job && job.status === 'running') {
        job.status = 'cancelled';
        job.phase = 'cancelled';
        job.finishedAt = Date.now();
      }
      return { cancelled };
    }

    case 'market.cancelAll':
      return { cancelled: downloader.cancelAll() };

    case 'market.refreshCatalog':
      try {
        return await refreshCatalog();
      } catch (error) {
        return { ok: false, message: String(error?.message || error).slice(0, 500) };
      }

    case 'market.probe': {
      const settings = await readSettings();
      const { repo, ref } = mirrorOf(settings);
      const catalog = pickCatalog(settings);
      const plugin = catalog.plugins?.find(item => item.id === payload?.id);
      const entry = payload?.version ? core.findVersion(plugin, payload.version) : core.latestVersion(plugin);
      if (!plugin || !entry) return { ok: false, message: 'no catalog entry for that id/version' };
      try {
        const results = await downloader.probeSources({ id: plugin.id, version: entry.version, entry, repo, ref });
        return { ok: true, id: plugin.id, version: entry.version, results };
      } catch (error) {
        return { ok: false, message: String(error?.message || error).slice(0, 500) };
      }
    }

    case 'market.verify': {
      const settings = await readSettings();
      const catalog = pickCatalog(settings);
      const plugin = catalog.plugins?.find(item => item.id === payload?.id);
      const entry = payload?.version ? core.findVersion(plugin, payload.version) : core.latestVersion(plugin);
      if (!entry) return { ok: false, message: 'no catalog entry for that id/version' };
      const file = core.packagePath(settings, payload.id, entry.version);
      try {
        const result = await downloader.verifyFile(file, entry);
        return { ok: result.ok === true, path: file, sha256: result.sha256, sizeBytes: result.sizeBytes, match: result.ok, detail: result.detail };
      } catch (error) {
        return { ok: false, message: String(error?.message || error), path: file };
      }
    }

    case 'market.removeDownload': {
      const settings = await readSettings();
      const id = payload?.id;
      const version = payload?.version;
      if (!core.isSafeId(id) || !core.isSafeVersion(version)) return { ok: false, message: 'invalid id or version' };
      const file = core.packagePath(settings, id, version);
      const dir = path.resolve(core.downloadsDir(settings));
      if (!path.resolve(file).startsWith(dir + path.sep)) return { ok: false, message: 'refusing to delete outside the downloads folder' };
      await fsp.rm(file, { force: true });
      jobs.delete(`${id}@${version}`);
      return { ok: true, path: file };
    }

    case 'market.settings':
      return { ...mirrorOf(await readSettings()), dataDir: core.ownDataDir(await readSettings()) };

    case 'market.copyPath': {
      const text = typeof payload?.text === 'string' ? payload.text : '';
      if (!text) return { ok: false, message: 'nothing to copy' };
      try {
        await pi.clipboard.writeText(text);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: String(error?.message || error).slice(0, 300) };
      }
    }

    case 'market.openDataDir':
      return { path: core.ownDataDir(await readSettings()), downloads: core.downloadsDir(await readSettings()) };

    default:
      throw new Error(`Unsupported panel action: ${channel}`);
  }
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

const tools = {
  list_plugin_updates: {
    description: 'List installed PI-Desktop plugins that have a newer non-yanked version in the official catalog, with version, size, sha256 and changelog. Reads only local registry/catalog files and returns whether a verified package is already downloaded.',
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        includeInstalled: { type: 'boolean', description: 'Also list installed plugins that are already current or absent from the catalog.' },
      },
    },
    execute: async args => {
      const snap = await snapshot();
      const pick = item => ({
        id: item.id,
        name: item.name,
        installedVersion: item.version,
        catalogVersion: item.catalogVersion,
        updateAvailable: item.updateAvailable,
        sizeBytes: item.latest?.sizeBytes ?? null,
        sha256: item.latest?.sha256 ?? null,
        publishedAt: item.latest?.publishedAt ?? null,
        bundled: item.bundled,
        enabled: item.enabled,
        downloaded: item.downloaded ? { path: item.downloaded.path, sizeMatches: item.downloaded.sizeMatches } : null,
        changelog: (item.latest?.changelog || '').slice(0, 600),
      });
      return {
        catalog: { ok: snap.catalog.ok, path: snap.catalog.path, plugins: snap.catalog.pluginCount, source: snap.catalog.source, error: snap.catalog.error },
        dataDir: snap.downloadsDir,
        updates: snap.updates.map(pick),
        ...(args?.includeInstalled === true ? { installed: snap.installed.map(pick) } : {}),
        next: 'Call prepare_plugin_update with one id to download and verify a package; installing stays a user action in the Plugins page.',
      };
    },
  },

  prepare_plugin_update: {
    description: 'Download one plugin package into this plugin\'s data folder, verify sizeBytes and sha256 against the official catalog, and return the absolute .piplug path for the user to install from the Plugins page. Never installs, never edits registry.json, and never keeps a package that fails verification.',
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Plugin id, e.g. pi.file-manager.' },
        version: { type: 'string', description: 'Exact version to fetch. Defaults to the newest non-yanked catalog version.' },
      },
      required: ['id'],
    },
    execute: async args => {
      const result = await prepareOne({
        id: typeof args?.id === 'string' ? args.id.trim() : '',
        version: typeof args?.version === 'string' ? args.version.trim() : undefined,
        locale: await appLocale(),
      });
      if (!result.ok) {
        return {
          ok: false,
          code: result.code,
          error: result.message,
          explanation: result.hint,
          attempts: result.attempts,
          next: 'Report this to the user with the original error text. Do not retry the same source blindly; market.probe in the panel shows which channel answered and how.',
        };
      }
      return {
        ok: true,
        id: result.id,
        version: result.version,
        path: result.path,
        sha256: result.sha256,
        sizeBytes: result.sizeBytes,
        source: result.source,
        already: result.already,
        verified: result.verified,
        attempts: result.attempts,
        next: `${result.install}. Tell the user the exact path; do not claim it is installed.`,
      };
    },
  },
};

const TOOL_NAMES = Object.keys(tools);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function onLoad() {
  const locale = await appLocale();
  await pi.commands.register({
    id: OPEN_COMMAND,
    title: t(locale, 'Pimarket: 打开市场与更新面板', 'Pimarket: open market panel'),
    keywords: ['pimarket', 'market', 'plugin', 'update', '市场', '插件', '更新'],
    run: async () => {
      await pi.plugin.setSettings({ panelJump: { feature: 'market', at: Date.now() } });
      await pi.ui.openPanel({ title: 'PiOpt' });
    },
  });

  await pi.commands.register({
    id: PREPARE_ALL_COMMAND,
    title: t(locale, 'Pimarket: 准备全部可用更新', 'Pimarket: prepare all updates'),
    keywords: ['pimarket', 'update', '全部', '更新'],
    run: async () => {
      await pi.plugin.setSettings({ panelJump: { feature: 'market', at: Date.now() } });
      await pi.ui.openPanel({ title: 'PiOpt' });
      const summary = await prepareAll();
      const ready = summary.results.filter(item => item.ok);
      const failed = summary.results.filter(item => !item.ok);
      const message = summary.total === 0
        ? t(locale, '没有可用更新', 'No updates available')
        : t(
          locale,
          `${ready.length} 个包已校验，${failed.length} 个失败`,
          `${ready.length} package(s) verified, ${failed.length} failed`,
        );
      try {
        await pi.ui.showToast(message);
      } catch {
        /* best-effort */
      }
    },
  });

  for (const name of TOOL_NAMES) {
    await pi.agent.registerTool({ name, ...tools[name] });
  }
}

async function onUnload() {
  downloader.cancelAll();
  for (const [id] of [[OPEN_COMMAND], [PREPARE_ALL_COMMAND]]) {
    try {
      await pi.commands.unregister(id);
    } catch {
      /* already gone */
    }
  }
  for (const name of TOOL_NAMES) {
    try {
      await pi.agent.unregisterTool(name);
    } catch {
      /* already gone */
    }
  }
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  _internals: { prepareOne, prepareAll, refreshCatalog, snapshot, pickCatalog, jobs },
};
