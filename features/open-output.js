"use strict";

// Open only ordinary output files from the active temporary session. The host
// file gateway does not currently treat that session's scratch directory as a
// workspace; this explicit user action uses the operating system instead.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { fileURLToPath } = require("node:url");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const EXTENSIONS = new Set(".pdf .txt .md .csv .tsv .json .xml .html .htm .png .jpg .jpeg .gif .webp .bmp .svg .docx .doc .xlsx .xls .pptx .ppt .odt .ods .odp .zip .mp3 .mp4 .wav .webm".split(" "));

function parsePath(value) {
  if (typeof value !== "string" || !value || value.length > 8192 || value.includes("\0")) throw new Error("文件路径无效");
  let result = value;
  if (/^file:/i.test(result)) result = fileURLToPath(result);
  else {
    try { result = decodeURIComponent(result); } catch { throw new Error("文件路径编码无效"); }
  }
  // Agent links can include editor line/column suffixes.
  result = result.replace(/:\d+(?::\d+)?$/, "");
  if (process.platform === "win32" && /^\/[a-z]:[\\/]/i.test(result)) result = result.slice(1);
  if (!path.isAbsolute(result)) throw new Error("只支持绝对路径");
  if (!EXTENSIONS.has(path.extname(result).toLowerCase())) throw new Error("不支持打开此文件类型");
  return result;
}

async function resolveOutput(value, sessionId, home = os.homedir(), projectPath = null) {
  if (typeof sessionId !== "string" || !/^[a-z0-9-]{1,128}$/i.test(sessionId)) throw new Error("无法确定当前会话");
  const candidate = parsePath(value);
  let real;
  try {
    real = await fs.realpath(candidate);
  } catch (error) {
    // Markdown can consume the backslash before `.pi-desktop` in Windows links.
    const brokenPrefix = `${home}.pi-desktop${path.sep}scratch${path.sep}${sessionId}${path.sep}`;
    if (process.platform !== "win32" || error.code !== "ENOENT" || !candidate.toLowerCase().startsWith(brokenPrefix.toLowerCase())) throw error;
    const fixed = path.join(home, ".pi-desktop", "scratch", sessionId, candidate.slice(brokenPrefix.length));
    real = await fs.realpath(fixed);
  }
  const roots = [path.join(home, ".pi-desktop", "scratch", sessionId)];
  if (typeof projectPath === "string" && path.isAbsolute(projectPath)) roots.push(projectPath);
  let allowed = false;
  for (const root of roots) {
    let resolvedRoot;
    try { resolvedRoot = await fs.realpath(root); } catch { continue; }
    const relative = path.relative(resolvedRoot, real);
    if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) { allowed = true; break; }
  }
  if (!allowed) throw new Error("文件不在当前会话临时目录或当前项目中");
  if (!EXTENSIONS.has(path.extname(real).toLowerCase()) || !(await fs.stat(real)).isFile()) throw new Error("文件类型不受支持");
  return real;
}

async function openOutput(args = {}) {
  const active = await pi.session.getActive();
  const sessionId = active?.sessionId;
  const file = await resolveOutput(args.path, sessionId, os.homedir(), active?.projectPath);
  const latest = await pi.session.getActive();
  if (latest?.sessionId !== sessionId || latest?.projectPath !== active?.projectPath) throw new Error("当前会话已切换，请重试");
  if (process.platform === "win32") {
    // Encoded script and encoded filename keep paths out of PowerShell syntax.
    const encodedPath = Buffer.from(file, "utf8").toString("base64");
    const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $i=[Diagnostics.ProcessStartInfo]::new(); $i.FileName=$p; $i.UseShellExecute=$true; [Diagnostics.Process]::Start($i) | Out-Null`;
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000 });
  } else {
    await exec(process.platform === "darwin" ? "open" : "xdg-open", [file], { timeout: 15000 });
  }
  return { opened: true };
}

module.exports = { openOutput, parsePath, resolveOutput };
