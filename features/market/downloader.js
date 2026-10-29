'use strict';

/**
 * Package downloader.
 *
 * Three facts shape this file:
 *   1. plugins.aiuo.net/packages/* answers HTTP 200 with a 1626-byte SPA page,
 *      so "the server said OK" is not evidence of a package.
 *   2. raw.githubusercontent.com starts large transfers and then drops them,
 *      so a truncated response has to be treated as a link failure, not a
 *      short file.
 *   3. cnb.cool has no packages/ directory at all.
 *
 * Therefore every candidate is streamed into a .part file while its sha256 is
 * computed, and the file is renamed into place only after sizeBytes and sha256
 * match the catalog. Nothing is ever "roughly right".
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');

const core = require('./core.js');

/** Hard-coded egress allow-list; redirects are re-checked against the same list. */
const ALLOWED_HOSTS = Object.freeze([
  'cdn.jsdelivr.net',
  'raw.githubusercontent.com',
  'api.github.com',
  'plugins.aiuo.net',
]);

const USER_AGENT = 'pimarket/0.1.0 (+PI-Desktop plugin)';
const ATTEMPTS_PER_SOURCE = 3;
const BACKOFF_MS = [500, 1500, 3500];
const IDLE_TIMEOUT_MS = 30_000;
const DEADLINE_MS = 6 * 60_000;
const HTML_SNIFF_BYTES = 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

/** Failures that retrying cannot fix. */
const TERMINAL = new Set([
  core.FAILURE.MIRROR_404,
  core.FAILURE.RATE_LIMIT,
  core.FAILURE.SERVER_HTML,
  core.FAILURE.TOO_LARGE,
  core.FAILURE.BAD_REQUEST,
  core.FAILURE.CANCELLED,
  core.FAILURE.WRITE_FAILED,
]);

class DownloadError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function isAllowedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALLOWED_HOSTS.some(allowed => host === allowed);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DownloadError(core.FAILURE.CANCELLED, 'cancelled'));
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DownloadError(core.FAILURE.CANCELLED, 'cancelled'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/**
 * Open a response stream, following up to `maxRedirects` same-allow-list hops.
 * Resolves with the still-unconsumed response so callers can decide whether to
 * write it to disk, JSON-parse it, or hang up after a few bytes.
 */
function openStream(url, options = {}) {
  const {
    headers = {},
    signal,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
    maxRedirects = 5,
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const attempt = (current, hops) => {
      let parsed;
      try {
        parsed = new URL(current);
      } catch {
        return finish(reject, new DownloadError(core.FAILURE.BAD_REQUEST, `not a URL: ${current}`));
      }
      if (parsed.protocol !== 'https:') {
        return finish(reject, new DownloadError(core.FAILURE.BAD_REQUEST, `refused non-https url: ${current}`));
      }
      if (!isAllowedHost(parsed.hostname)) {
        return finish(reject, new DownloadError(core.FAILURE.BAD_REQUEST, `refused host: ${parsed.hostname}`));
      }

      const request = https.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            'Accept-Encoding': 'identity',
            Connection: 'keep-alive',
            ...headers,
          },
        },
        response => {
          const status = Number(response.statusCode) || 0;
          const location = response.headers?.location;
          if (status >= 300 && status < 400 && location) {
            response.resume();
            if (hops >= maxRedirects) {
              return finish(reject, new DownloadError(core.FAILURE.HTTP_ERROR, `too many redirects (${url})`, { statusCode: status }));
            }
            let next;
            try {
              next = new URL(location, current).toString();
            } catch {
              return finish(reject, new DownloadError(core.FAILURE.HTTP_ERROR, `bad redirect target: ${location}`));
            }
            return attempt(next, hops + 1);
          }
          finish(resolve, { response, url: current, status });
        },
      );

      request.setTimeout(idleTimeoutMs, () => {
        request.destroy(new DownloadError(core.FAILURE.TIMEOUT, `no data for ${Math.round(idleTimeoutMs / 1000)}s from ${parsed.hostname}`));
      });
      request.on('error', error => finish(reject, error));

      const onAbort = () => request.destroy(new DownloadError(core.FAILURE.CANCELLED, 'cancelled'));
      if (signal) {
        if (signal.aborted) return finish(reject, new DownloadError(core.FAILURE.CANCELLED, 'cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
        request.on('close', () => signal.removeEventListener('abort', onAbort));
      }

      request.end();
    };

    attempt(url, 0);
  });
}

function readAll(response, limit = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    response.on('data', chunk => {
      total += chunk.length;
      if (total > limit) {
        response.destroy(new DownloadError(core.FAILURE.TOO_LARGE, `response exceeded ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
  });
}

function looksLikeHtml(buffer, contentType) {
  if (typeof contentType === 'string' && /^text\/html/i.test(contentType)) return true;
  const head = buffer.subarray(0, HTML_SNIFF_BYTES).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head');
}

function snippet(buffer) {
  return buffer.subarray(0, 160).toString('utf8').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function packageFile(id, version) {
  return `${id}-${version}${core.PACKAGE_SUFFIX}`;
}

/**
 * The order is deliberate: jsDelivr is the only channel measured to deliver
 * multi-megabyte files here, raw comes next (small files work), the GitHub
 * Blobs API third (stable but rate-limited), and the official route last so a
 * wrong answer from it is shown as evidence rather than trusted.
 */
function buildSources({ id, version, entry, repo, ref }) {
  const file = packageFile(id, version);
  const sources = [];
  if (repo && ref) {
    sources.push({
      id: 'jsdelivr',
      label: 'jsDelivr',
      kind: 'direct',
      url: `https://cdn.jsdelivr.net/gh/${repo}@${ref}/packages/${file}`,
    });
    sources.push({
      id: 'raw',
      label: 'GitHub raw',
      kind: 'direct',
      url: `https://raw.githubusercontent.com/${repo}/${ref}/packages/${file}`,
    });
    sources.push({
      id: 'github-api',
      label: 'GitHub Blobs API',
      kind: 'github-blobs',
      repo,
      ref,
      file,
    });
  }
  if (typeof entry?.url === 'string' && entry.url.startsWith('https://')) {
    sources.push({
      id: 'official',
      label: '官方包地址',
      kind: 'direct',
      url: entry.url,
    });
  }
  return sources;
}

async function resolveGithubBlob(source, ctx) {
  const metaUrl = `https://api.github.com/repos/${source.repo}/contents/packages/${encodeURIComponent(source.file)}?ref=${encodeURIComponent(source.ref)}`;
  const { response, status } = await openStream(metaUrl, {
    signal: ctx.signal,
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (status === 404) {
    response.resume();
    throw new DownloadError(core.FAILURE.MIRROR_404, `GitHub contents API: 404 for packages/${source.file}`);
  }
  if (status === 403 || status === 429) {
    response.resume();
    throw new DownloadError(core.FAILURE.RATE_LIMIT, `GitHub contents API: HTTP ${status}`);
  }
  if (status < 200 || status >= 300) {
    response.resume();
    throw new DownloadError(core.FAILURE.HTTP_ERROR, `GitHub contents API: HTTP ${status}`, { statusCode: status });
  }
  let meta;
  try {
    meta = JSON.parse((await readAll(response)).toString('utf8'));
  } catch (error) {
    throw new DownloadError(core.FAILURE.HTTP_ERROR, `GitHub contents API returned invalid JSON: ${error?.message || error}`);
  }
  if (!meta || typeof meta.sha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(meta.sha)) {
    throw new DownloadError(core.FAILURE.HTTP_ERROR, 'GitHub contents API returned no blob sha');
  }
  return {
    url: `https://api.github.com/repos/${source.repo}/git/blobs/${meta.sha}`,
    sha: meta.sha,
    sizeBytes: typeof meta.size === 'number' ? meta.size : null,
  };
}

// ---------------------------------------------------------------------------
// One transfer
// ---------------------------------------------------------------------------

function openWriteStream(file) {
  return new Promise((resolve, reject) => {
    fs.mkdir(path.dirname(file), { recursive: true }, error => {
      if (error) return reject(new DownloadError(core.FAILURE.WRITE_FAILED, `mkdir ${path.dirname(file)}: ${error.message}`));
      const stream = fs.createWriteStream(file, { flags: 'w', mode: 0o644 });
      stream.once('open', () => resolve(stream));
      stream.once('error', writeError => reject(new DownloadError(core.FAILURE.WRITE_FAILED, `open ${file}: ${writeError.message}`)));
    });
  });
}

/**
 * Stream one URL into `partFile`, hashing as it goes.
 * Returns { sha256, sizeBytes, contentType, finalUrl, status }.
 */
async function fetchToFile(url, partFile, ctx = {}) {
  const { headers = {}, signal, expectedSize = null, onProgress = null } = ctx;
  const { response, status, url: finalUrl } = await openStream(url, { headers, signal });

  const contentType = response.headers?.['content-type'] || '';
  if (status === 404) {
    response.resume();
    throw new DownloadError(core.FAILURE.MIRROR_404, `HTTP 404 (${finalUrl})`, { statusCode: status });
  }
  if (status === 403 || status === 429) {
    response.resume();
    throw new DownloadError(core.FAILURE.RATE_LIMIT, `HTTP ${status} (${finalUrl})`, { statusCode: status });
  }
  if (status < 200 || status >= 300) {
    response.resume();
    throw new DownloadError(core.FAILURE.HTTP_ERROR, `HTTP ${status} (${finalUrl})`, { statusCode: status });
  }

  const declared = Number(response.headers?.['content-length']);
  const total = Number.isFinite(declared) && declared > 0 ? declared : expectedSize;

  const out = await openWriteStream(partFile);
  const hash = crypto.createHash('sha256');
  let received = 0;
  let head = Buffer.alloc(0);
  let html = false;
  let lastReport = 0;

  try {
    await new Promise((resolve, reject) => {
      const fail = error => {
        response.destroy();
        out.destroy();
        reject(error instanceof DownloadError ? error : new DownloadError(core.FAILURE.UNKNOWN, String(error?.message || error)));
      };

      response.on('data', chunk => {
        if (html) return;
        if (head.length < HTML_SNIFF_BYTES) {
          head = Buffer.concat([head, chunk.subarray(0, HTML_SNIFF_BYTES - head.length)]);
          if (looksLikeHtml(head, contentType)) {
            html = true;
            fail(new DownloadError(
              core.FAILURE.SERVER_HTML,
              `answered with HTML, not a package (${contentType || 'no content-type'}, starts "${snippet(head)}")`,
            ));
            return;
          }
        }
        received += chunk.length;
        if (received > core.MAX_PACKAGE_BYTES) {
          fail(new DownloadError(core.FAILURE.TOO_LARGE, `${core.humanBytes(received)} exceeds the ${core.humanBytes(core.MAX_PACKAGE_BYTES)} host limit`));
          return;
        }
        if (expectedSize !== null && received > expectedSize) {
          fail(new DownloadError(
            core.FAILURE.INTEGRITY,
            `more bytes than the catalog announced (${received} > ${expectedSize})`,
          ));
          return;
        }
        hash.update(chunk);
        if (!out.write(chunk)) {
          response.pause();
          out.once('drain', () => response.resume());
        }
        const now = Date.now();
        if (onProgress && now - lastReport > 120) {
          lastReport = now;
          onProgress({ received, total, contentType });
        }
      });

      response.on('aborted', () => fail(new DownloadError(core.FAILURE.LINK_RESET, 'the connection was aborted before the response finished')));
      response.on('error', error => fail(new DownloadError(
        core.classifyFailure(error),
        `${error?.code ? `${error.code}: ` : ''}${error?.message || error}`,
      )));
      response.on('end', () => {
        if (html) return;
        out.end(resolve);
      });
      out.on('error', error => fail(new DownloadError(core.FAILURE.WRITE_FAILED, `write ${partFile}: ${error.message}`)));
    });
  } catch (error) {
    await fsp.rm(partFile, { force: true }).catch(() => {});
    throw error;
  }

  // A short read is a link failure, not a small package: raw.githubusercontent.com
  // reliably ends multi-megabyte transfers this way.
  if (expectedSize !== null && received !== expectedSize) {
    await fsp.rm(partFile, { force: true }).catch(() => {});
    throw new DownloadError(
      core.FAILURE.LINK_RESET,
      `transfer ended at ${received} of ${expectedSize} bytes (the link dropped, the file is not short)`,
    );
  }
  if (Number.isFinite(declared) && declared > 0 && received !== declared) {
    await fsp.rm(partFile, { force: true }).catch(() => {});
    throw new DownloadError(core.FAILURE.LINK_RESET, `transfer ended at ${received} of ${declared} announced bytes`);
  }

  return {
    sha256: hash.digest('hex'),
    sizeBytes: received,
    contentType: contentType || null,
    finalUrl,
    status,
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  await new Promise((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  const stat = await fsp.stat(file);
  return { sha256: hash.digest('hex'), sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
}

/**
 * Compare a file against catalog metadata.
 * Without a catalog sha256 the package cannot be verified, so `ok` is false.
 */
function verify({ sha256, sizeBytes }, entry) {
  const expectedSha = typeof entry?.shasum === 'string' && /^[0-9a-f]{64}$/i.test(entry.shasum) ? entry.shasum.toLowerCase() : null;
  const expectedSize = typeof entry?.sizeBytes === 'number' ? entry.sizeBytes : null;
  if (expectedSize !== null && sizeBytes !== expectedSize) {
    return { ok: false, code: core.FAILURE.INTEGRITY, detail: `size ${sizeBytes} ≠ catalog ${expectedSize}` };
  }
  if (expectedSha && sha256.toLowerCase() !== expectedSha) {
    return { ok: false, code: core.FAILURE.INTEGRITY, detail: `sha256 ${sha256.slice(0, 12)}… ≠ catalog ${expectedSha.slice(0, 12)}…` };
  }
  if (!expectedSha) {
    return { ok: false, code: core.FAILURE.INTEGRITY, detail: 'the catalog carries no sha256 for this version, so it cannot be verified' };
  }
  return { ok: true, code: null, detail: expectedSize !== null ? 'size and sha256 match the catalog' : 'sha256 matches the catalog' };
}

/** Re-hash an already downloaded package. */
async function verifyFile(file, entry) {
  const stat = await fsp.stat(file);
  const hashed = await hashFile(file);
  const result = verify(hashed, entry);
  return { file, ...hashed, ...result, statSize: stat.size };
}

// ---------------------------------------------------------------------------
// Prepare one package
// ---------------------------------------------------------------------------

const activeJobs = new Map();

function cancelJob(id) {
  const controller = activeJobs.get(id);
  if (!controller) return false;
  controller.abort();
  activeJobs.delete(id);
  return true;
}

function cancelAll() {
  let count = 0;
  for (const [, controller] of activeJobs) {
    controller.abort();
    count += 1;
  }
  activeJobs.clear();
  return count;
}

/**
 * Download and verify one package.
 *
 * Returns { status, path, sha256, sizeBytes, source, already, verified, attempts }.
 * Throws DownloadError(NO_SOURCE) with `.attempts` when every candidate failed.
 */
async function preparePackage(options) {
  const {
    id,
    version,
    entry,
    settings = {},
    signal,
    onProgress = null,
    force = false,
    repo = 'AIUO-Net/pi-desktop-plugins',
    ref = 'main',
  } = options;

  if (!core.isSafeId(id)) throw new DownloadError(core.FAILURE.BAD_REQUEST, `invalid plugin id: ${String(id)}`);
  if (!core.isSafeVersion(version)) throw new DownloadError(core.FAILURE.BAD_REQUEST, `invalid version: ${String(version)}`);
  if (!core.isSafeRepo(repo) || !core.isSafeRef(ref)) {
    throw new DownloadError(core.FAILURE.BAD_REQUEST, `invalid mirror repo/ref: ${repo}@${ref}`);
  }
  if (!entry || typeof entry !== 'object') {
    throw new DownloadError(core.FAILURE.BAD_REQUEST, `${id}@${version} is not in the catalog`);
  }
  const expectedSize = typeof entry.sizeBytes === 'number' ? entry.sizeBytes : null;
  if (expectedSize !== null && expectedSize > core.MAX_PACKAGE_BYTES) {
    throw new DownloadError(core.FAILURE.TOO_LARGE, `catalog size ${core.humanBytes(expectedSize)} exceeds the host limit`);
  }
  if (typeof entry.shasum !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.shasum)) {
    throw new DownloadError(core.FAILURE.INTEGRITY, `${id}@${version} has no sha256 in the catalog; refusing an unverifiable package`);
  }

  const jobId = `${id}@${version}`;
  const internal = new AbortController();
  const onExternalAbort = () => internal.abort();
  if (signal) {
    if (signal.aborted) throw new DownloadError(core.FAILURE.CANCELLED, 'cancelled');
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  activeJobs.set(jobId, internal);

  const deadline = setTimeout(() => internal.abort(), DEADLINE_MS);
  const ctx = { signal: internal.signal, headers: {} };

  const target = core.packagePath(settings, id, version);
  const part = `${target}.part`;
  const attempts = [];

  const report = payload => {
    try {
      onProgress?.({ id, version, ...payload });
    } catch {
      /* a panel callback must never break a transfer */
    }
  };

  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });

    if (!force) {
      try {
        const existing = await verifyFile(target, entry);
        if (existing.ok === true) {
          report({ phase: 'done', source: 'existing', received: existing.sizeBytes, total: existing.sizeBytes });
          return {
            status: 'ready',
            already: true,
            path: target,
            sha256: existing.sha256,
            sizeBytes: existing.sizeBytes,
            source: 'existing',
            verified: true,
            verifyDetail: existing.detail,
            attempts,
          };
        }
        if (existing.ok === false) await fsp.rm(target, { force: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          // A file we cannot hash is not trustworthy; replace it.
          await fsp.rm(target, { force: true }).catch(() => {});
        }
      }
    }

    const sources = buildSources({ id, version, entry, repo, ref });
    if (!sources.length) throw new DownloadError(core.FAILURE.NO_SOURCE, 'no download source is configured');

    for (const source of sources) {
      for (let attempt = 1; attempt <= ATTEMPTS_PER_SOURCE; attempt += 1) {
        if (internal.signal.aborted) throw new DownloadError(core.FAILURE.CANCELLED, 'cancelled');
        report({
          phase: 'source',
          source: source.id,
          sourceLabel: source.label,
          attempt,
          maxAttempts: ATTEMPTS_PER_SOURCE,
          received: 0,
          total: expectedSize,
        });

        try {
          let transfer;
          if (source.kind === 'github-blobs') {
            const blob = await resolveGithubBlob(source, ctx);
            if (typeof blob.sizeBytes === 'number' && expectedSize !== null && blob.sizeBytes !== expectedSize) {
              throw new DownloadError(
                core.FAILURE.INTEGRITY,
                `GitHub blob is ${blob.sizeBytes} bytes, catalog announces ${expectedSize}`,
              );
            }
            transfer = await fetchToFile(blob.url, part, {
              signal: internal.signal,
              headers: { Accept: 'application/vnd.github.raw' },
              expectedSize,
              onProgress: progress => report({ phase: 'download', source: source.id, sourceLabel: source.label, ...progress }),
            });
          } else {
            transfer = await fetchToFile(source.url, part, {
              signal: internal.signal,
              expectedSize,
              onProgress: progress => report({ phase: 'download', source: source.id, sourceLabel: source.label, ...progress }),
            });
          }

          report({ phase: 'verify', source: source.id, sourceLabel: source.label, received: transfer.sizeBytes, total: transfer.sizeBytes });
          const check = verify(transfer, entry);
          if (check.ok === false) {
            await fsp.rm(part, { force: true }).catch(() => {});
            throw new DownloadError(core.FAILURE.INTEGRITY, check.detail);
          }

          await fsp.rename(part, target);
          report({ phase: 'done', source: source.id, sourceLabel: source.label, received: transfer.sizeBytes, total: transfer.sizeBytes });
          return {
            status: 'ready',
            already: false,
            path: target,
            sha256: transfer.sha256,
            sizeBytes: transfer.sizeBytes,
            source: source.id,
            sourceLabel: source.label,
            verified: check.ok === true,
            verifyDetail: check.detail,
            finalUrl: transfer.finalUrl,
            attempts,
          };
        } catch (error) {
          const code = error?.code && Object.values(core.FAILURE).includes(error.code)
            ? error.code
            : core.classifyFailure(error);
          const message = String(error?.message || error).slice(0, 600);
          attempts.push({ source: source.id, sourceLabel: source.label, attempt, code, message });
          report({ phase: 'failed-attempt', source: source.id, sourceLabel: source.label, code, message, attempt });

          if (code === core.FAILURE.CANCELLED) {
            await fsp.rm(part, { force: true }).catch(() => {});
            throw new DownloadError(core.FAILURE.CANCELLED, 'cancelled');
          }
          if (TERMINAL.has(code)) break;
          if (attempt < ATTEMPTS_PER_SOURCE) {
            await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)], internal.signal).catch(() => {});
          }
        }
      }
    }

    throw new DownloadError(
      core.FAILURE.NO_SOURCE,
      `all ${sources.length} source(s) failed for ${packageFile(id, version)}`,
      { attempts },
    );
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener?.('abort', onExternalAbort);
    activeJobs.delete(jobId);
    await fsp.rm(part, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Diagnose
// ---------------------------------------------------------------------------

/**
 * Ask every source for the first kilobyte and report what actually happened.
 * This is what turns "install failed" into "the server sent HTML" / "the link
 * reset" / "the mirror has no such file".
 */
async function probeSources({ id, version, entry, repo, ref, signal }) {
  if (!core.isSafeId(id) || !core.isSafeVersion(version)) {
    throw new DownloadError(core.FAILURE.BAD_REQUEST, 'invalid id or version');
  }
  const sources = buildSources({ id, version, entry, repo, ref });
  const results = [];
  for (const source of sources) {
    const started = Date.now();
    const base = { id: source.id, label: source.label };
    try {
      let url = source.url;
      let headers = {};
      if (source.kind === 'github-blobs') {
        const blob = await resolveGithubBlob(source, { signal });
        url = blob.url;
        headers = { Accept: 'application/vnd.github.raw' };
      }
      const { response, status, url: finalUrl } = await openStream(url, { headers, signal, idleTimeoutMs: 15_000 });
      const contentType = response.headers?.['content-type'] || null;
      const declared = Number(response.headers?.['content-length']);
      const head = await new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        response.on('data', chunk => {
          chunks.push(chunk);
          total += chunk.length;
          if (total >= HTML_SNIFF_BYTES) {
            response.destroy();
            resolve(Buffer.concat(chunks).subarray(0, HTML_SNIFF_BYTES));
          }
        });
        response.on('end', () => resolve(Buffer.concat(chunks).subarray(0, HTML_SNIFF_BYTES)));
        response.on('error', error => {
          if (error?.code === 'ECONNRESET') resolve(Buffer.concat(chunks).subarray(0, HTML_SNIFF_BYTES));
          else reject(error);
        });
      });
      const html = looksLikeHtml(head, contentType);
      results.push({
        ...base,
        ok: !html && status >= 200 && status < 300,
        status,
        contentType,
        contentLength: Number.isFinite(declared) && declared > 0 ? declared : null,
        head: snippet(head),
        finalUrl,
        elapsedMs: Date.now() - started,
        code: html ? core.FAILURE.SERVER_HTML : null,
      });
    } catch (error) {
      const code = error?.code && Object.values(core.FAILURE).includes(error.code) ? error.code : core.classifyFailure(error);
      results.push({
        ...base,
        ok: false,
        status: error?.statusCode ?? null,
        elapsedMs: Date.now() - started,
        code,
        message: String(error?.message || error).slice(0, 400),
      });
    }
  }
  return results;
}

module.exports = {
  ALLOWED_HOSTS,
  ATTEMPTS_PER_SOURCE,
  DownloadError,
  isAllowedHost,
  openStream,
  buildSources,
  fetchToFile,
  hashFile,
  verify,
  verifyFile,
  preparePackage,
  probeSources,
  cancelJob,
  cancelAll,
  activeJobs,
};
