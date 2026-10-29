"use strict";

/**
 * Credentials the plugin generates and owns: the CLIProxyAPI management key and
 * the wb2api panel password.
 *
 * The host offers no encrypted store to plugins, so values are sealed with
 * Windows DPAPI (CurrentUser scope) through the system PowerShell and kept in
 * <plugin data>/gateway-runtime/secrets.json. Plaintext only ever travels over
 * stdin/stdout of that PowerShell process, never on a command line, and only
 * the sealed base64 touches the disk. Another Windows account, or the same
 * file copied to another machine, cannot open it.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const paths = require("./paths.js");

const FILE = "secrets.json";

function runPowershell(script, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())),
    );
    child.stdin.end(input);
  });
}

const PROTECT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$t=[Console]::In.ReadToEnd()",
  "$b=[Text.Encoding]::UTF8.GetBytes($t)",
  "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser')",
  "[Console]::Out.Write([Convert]::ToBase64String($p))",
].join(";");

const UNPROTECT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$t=[Console]::In.ReadToEnd().Trim()",
  "$p=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($t),$null,'CurrentUser')",
  "[Console]::Out.Write([Convert]::ToBase64String($p))",
].join(";");

async function dpapiProtect(text) {
  return runPowershell(PROTECT, text);
}

// The plaintext comes back base64-wrapped so console encoding cannot mangle it.
async function dpapiUnprotect(sealed) {
  return Buffer.from(await runPowershell(UNPROTECT, sealed), "base64").toString("utf8");
}

function createStore(deps = {}) {
  const d = {
    protect: dpapiProtect,
    unprotect: dpapiUnprotect,
    dataDir: async () => pi.plugin.getDataPath(),
    random: () => crypto.randomBytes(32).toString("hex"),
    ...deps,
  };
  const cache = new Map();

  async function file() {
    const dir = await d.dataDir();
    if (!dir) throw new Error("没有插件数据目录，无法保存凭据");
    return path.join(paths.stateDir(dir), FILE);
  }

  async function readDoc() {
    try {
      const doc = JSON.parse(fs.readFileSync(await file(), "utf8"));
      return doc && typeof doc === "object" ? doc : {};
    } catch {
      return {};
    }
  }

  /** The stored plaintext, or null when absent or unreadable. Never throws. */
  async function get(name) {
    if (cache.has(name)) return cache.get(name);
    try {
      const sealed = (await readDoc())[name];
      if (typeof sealed !== "string" || !sealed) return null;
      const value = await d.unprotect(sealed);
      cache.set(name, value);
      return value;
    } catch {
      return null;
    }
  }

  async function set(name, value) {
    const target = await file();
    const doc = await readDoc();
    doc[name] = await d.protect(String(value));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, target);
    cache.set(name, String(value));
    return true;
  }

  async function getOrCreate(name) {
    const existing = await get(name);
    if (existing) return existing;
    const value = d.random();
    await set(name, value);
    return value;
  }

  return { get, set, getOrCreate, random: d.random, _cache: cache };
}

module.exports = { FILE, createStore, dpapiProtect, dpapiUnprotect };
