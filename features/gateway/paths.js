"use strict";

/**
 * Where the gateway lives. Nothing here is hard-coded to one machine:
 *   1. the gatewayRoot setting, when the user points it somewhere;
 *   2. <plugin data>/gateway, once the files have been moved in;
 *   3. ~/ai-gateway, the legacy install, until then.
 * Runtime state (logs, run.json) always sits in the plugin data folder.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const LEGACY_DIRNAME = "ai-gateway";
const GATEWAY_EXE = path.join("cliproxy", "cli-proxy-api.exe");

function legacyRoot(home = os.homedir()) {
  return path.join(home, LEGACY_DIRNAME);
}

function hasGateway(root) {
  try {
    return fs.statSync(path.join(root, GATEWAY_EXE)).isFile();
  } catch {
    return false;
  }
}

/** Pure resolution, so tests can drive every branch. */
function pickRoot({ setting, dataDir, home } = {}) {
  const configured = typeof setting === "string" ? setting.trim() : "";
  if (configured) return { root: path.resolve(configured), source: "setting" };
  if (dataDir) {
    const own = path.join(dataDir, "gateway");
    if (hasGateway(own)) return { root: own, source: "data" };
  }
  return { root: legacyRoot(home), source: "legacy" };
}

function stateDir(dataDir) {
  return path.join(dataDir || path.join(os.tmpdir(), "piopt"), "gateway-runtime");
}

module.exports = { GATEWAY_EXE, legacyRoot, hasGateway, pickRoot, stateDir };
