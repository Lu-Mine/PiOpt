"use strict";

/**
 * Move the gateway from the legacy ~/ai-gateway into <plugin data>/gateway.
 *
 * It is a copy, never a move: the source is left untouched, so pointing
 * gatewayRoot back at it undoes everything. Files go into a staging folder
 * first and every one is sha256-checked against its source; only a fully
 * verified copy is renamed into place, so a half-finished migration can never
 * be picked up as a gateway root.
 *
 * Only what the gateway needs at runtime is copied. Logs, backups, the example
 * config and the retired cliproxy/plugins DLLs stay behind.
 */

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const SKIP_DIRS = new Set(["__pycache__", "logs"]);

function listTree(base, rel, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(base, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listTree(base, child, out);
    } else if (entry.isFile() && !entry.name.endsWith(".log")) {
      out.push(child);
    }
  }
}

/** Relative paths to copy, with sizes. Throws when the source is not a gateway. */
function planFiles(src) {
  const files = [path.join("cliproxy", "cli-proxy-api.exe"), path.join("cliproxy", "config.yaml")];
  for (const file of files) {
    if (!fs.existsSync(path.join(src, file))) throw new Error(`源目录缺少 ${file}`);
  }
  listTree(src, path.join("cliproxy", "static"), files);
  try {
    for (const name of fs.readdirSync(path.join(src, "auth"))) {
      const rel = path.join("auth", name);
      if (name.endsWith(".json") && fs.statSync(path.join(src, rel)).isFile()) files.push(rel);
    }
  } catch {
    /* no auth yet is fine */
  }
  listTree(src, "workbuddy", files);
  return files.map(rel => ({ rel, size: fs.statSync(path.join(src, rel)).size }));
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", chunk => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Point config.yaml's auth-dir at the new auth folder. */
function rewriteAuthDir(text, authDir) {
  const value = authDir.split(path.sep).join("/");
  const pattern = /^([ \t]*auth-dir:[ \t]*).*$/m;
  if (!pattern.test(text)) return text;
  return text.replace(pattern, (_, head) => `${head}${value}`);
}

async function migrate({ src, dest, onProgress = () => {} }) {
  const source = path.resolve(src);
  const target = path.resolve(dest);
  if (source === target) throw new Error("源目录与目标目录相同");
  if (fs.existsSync(target)) throw new Error(`目标已存在：${target}，不覆盖`);

  const files = planFiles(source);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const staging = `${target}.partial`;
  await fsp.rm(staging, { recursive: true, force: true });

  let done = 0;
  onProgress({ phase: "copy", done, total, files: files.length });
  try {
    for (const file of files) {
      const from = path.join(source, file.rel);
      const to = path.join(staging, file.rel);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
      const [a, b] = await Promise.all([sha256(from), sha256(to)]);
      if (a !== b) throw new Error(`校验失败：${file.rel}`);
      done += file.size;
      onProgress({ phase: "copy", done, total, files: files.length, current: file.rel });
    }

    const config = path.join(staging, "cliproxy", "config.yaml");
    const text = await fsp.readFile(config, "utf8");
    await fsp.writeFile(config, rewriteAuthDir(text, path.join(target, "auth")));

    await fsp.rename(staging, target);
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  onProgress({ phase: "done", done: total, total, files: files.length });
  return { ok: true, root: target, files: files.length, bytes: total };
}

module.exports = { planFiles, rewriteAuthDir, migrate };
