"use strict";

/**
 * Port probe for the local gateway. A plain TCP connect: cross-platform, needs no
 * permissions and does not depend on netstat output formats.
 */

const net = require("net");

const GATEWAY_PORT = 8317;
const WORKBUDDY_PORT = 8318;
const PROBE_TIMEOUT_MS = 300;

function isListening(port, { host = "127.0.0.1", timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function probeGateway({ gateway = GATEWAY_PORT, workbuddy = WORKBUDDY_PORT, timeoutMs } = {}) {
  const [g, w] = await Promise.all([isListening(gateway, { timeoutMs }), isListening(workbuddy, { timeoutMs })]);
  return { gateway: g, workbuddy: w };
}

/** Poll until neither port answers, or the deadline passes. Returns true when both are closed. */
async function waitPortsClosed(ports = {}, { deadlineMs = 8000, intervalMs = 250 } = {}) {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const state = await probeGateway(ports);
    if (!state.gateway && !state.workbuddy) return true;
    if (Date.now() >= end) return false;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

module.exports = { GATEWAY_PORT, WORKBUDDY_PORT, PROBE_TIMEOUT_MS, isListening, probeGateway, waitPortsClosed };
