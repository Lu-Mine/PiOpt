"use strict";

/**
 * The LAN gateway for the 手机 view: one HTTP server that serves the phone page
 * and a tiny JSON API on top of it.
 *
 * Boundary: this file knows nothing about PI-Desktop. Every answer comes from
 * the `api` handed in by features/remote/index.js, so the phone never reaches
 * a host channel this plugin could not reach itself, and the panel can be
 * tested with a fake api.
 *
 * Security shape, in order of what actually protects the machine:
 *   - the server is off until the user turns it on in the panel;
 *   - every request but the page itself needs a device token minted by pairing
 *     with the six-digit code shown in the panel, and that code can be rotated;
 *   - the pairing endpoint is rate limited, so a code is not brute-forceable
 *     from the sofa (six digits, five tries a minute);
 *   - the API is read-mostly: it lists sessions, reads transcripts, sends a
 *     prompt and stops a turn. Nothing here deletes, configures or approves.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const MOBILE_DIR = path.join(__dirname, "mobile");
const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "application/javascript; charset=utf-8"]],
  ["/markdown.js", ["markdown.js", "application/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

const MAX_BODY_BYTES = 64 * 1024;
const PAIR_WINDOW_MS = 60_000;
const PAIR_MAX_FAILURES = 5;
const STREAM_INTERVAL_MS = 2_500;
const SESSION_LIST_LIMIT = 60;
const MESSAGE_LIMIT = 80;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("请求体过大"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("请求体不是 JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function bearerOf(req) {
  const header = req.headers["x-pi-device"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice(7).trim();
  }
  return "";
}

// Requests from a browser carry an Origin; the page is served by this same
// server, so the only origins that belong here are the addresses it listens on
// and the loopback names. Anything else is a page somewhere else on the LAN
// trying to drive this machine with a token it should not have.
function originAllowed(req, port) {
  const raw = req.headers.origin;
  if (!raw) return true;
  let origin;
  try {
    origin = new URL(raw);
  } catch {
    return false;
  }
  if (origin.protocol !== "http:") return false;
  const host = origin.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  const portText = origin.port || "80";
  if (String(port) !== portText) return false;
  // A LAN address: the request must come from the same host that serves it.
  const self = req.headers.host ? String(req.headers.host).split(":")[0] : "";
  return Boolean(self) && host === self;
}

function pairLimiter() {
  const attempts = new Map();
  return {
    // `key` is the caller's address: one phone burning its five tries must not
    // lock out the other phone in the house.
    blocked(key) {
      const entry = attempts.get(key);
      if (!entry) return false;
      if (Date.now() - entry.since > PAIR_WINDOW_MS) {
        attempts.delete(key);
        return false;
      }
      return entry.count >= PAIR_MAX_FAILURES;
    },
    fail(key) {
      const entry = attempts.get(key);
      if (!entry || Date.now() - entry.since > PAIR_WINDOW_MS) {
        attempts.set(key, { count: 1, since: Date.now() });
        return;
      }
      entry.count += 1;
    },
    reset(key) {
      attempts.delete(key);
    },
  };
}

function clientKey(req) {
  const address = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
  return String(address).replace(/^::ffff:/, "");
}

function createRemoteServer(options) {
  const api = options.api;
  const auth = options.auth;
  const log = typeof options.log === "function" ? options.log : () => {};
  const limiter = pairLimiter();

  let server = null;
  let port = null;
  let host = options.host || "0.0.0.0";
  let startedAt = 0;
  let streams = new Set();
  let streamTimer = null;
  let lastSnapshot = "";

  function authorized(req) {
    const token = bearerOf(req);
    if (!token) return null;
    return auth.verify(token);
  }

  async function handlePair(req, res) {
    const key = clientKey(req);
    if (limiter.blocked(key)) {
      json(res, 429, { error: "尝试次数过多，请一分钟后再试" });
      return;
    }
    const body = await readBody(req);
    const code = typeof body.code === "string" ? body.code.replace(/\s+/g, "") : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
    if (!code) {
      json(res, 400, { error: "请输入配对码" });
      return;
    }
    if (!auth.checkCode(code)) {
      limiter.fail(key);
      json(res, 401, { error: "配对码不对" });
      return;
    }
    limiter.reset(key);
    const device = auth.register(name || "手机");
    json(res, 200, { token: device.token, name: device.name, createdAt: device.createdAt });
  }

  async function handleBootstrap(req, res, device) {
    const window = Number(new URL(req.url, "http://lan").searchParams.get("window")) || SESSION_LIST_LIMIT;
    const sessions = await api.sessions({ limit: Math.min(200, Math.max(1, window)), probe: true });
    json(res, 200, { device: { name: device.name, createdAt: device.createdAt }, sessions });
  }

  function parseSessionId(raw) {
    const value = String(raw || "").trim();
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) return "";
    return value;
  }

  async function handleSession(req, res, device, sessionId, url) {
    const limit = Number(url.searchParams.get("limit")) || MESSAGE_LIMIT;
    const payload = await api.session(sessionId, { limit: Math.min(200, Math.max(1, limit)) });
    if (!payload) {
      json(res, 404, { error: "找不到这个会话" });
      return;
    }
    json(res, 200, payload);
  }

  async function handleRoute(req, res) {
    const url = new URL(req.url, "http://lan");
    const pathname = url.pathname;

    if (ASSETS.has(pathname)) {
      const [file, type] = ASSETS.get(pathname);
      try {
        const body = fs.readFileSync(path.join(MOBILE_DIR, file));
        res.writeHead(200, {
          "Content-Type": type,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(body);
      } catch (error) {
        json(res, 500, { error: `手机页面缺失: ${error && error.message ? error.message : error}` });
      }
      return;
    }

    // The browser asks for this on its own; answering 204 keeps an unpaired
    // phone from logging a 401 it did nothing to cause.
    if (pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }

    if (pathname === "/api/pair" && req.method === "POST") {
      await handlePair(req, res);
      return;
    }

    // EventSource cannot set headers, so this one route also accepts the device
    // token as a query parameter. Every other route needs the header.
    if (pathname === "/api/stream" && req.method === "GET") {
      const streamDevice = authorized(req) || auth.verify(url.searchParams.get("token") || "");
      if (!streamDevice) {
        json(res, 401, { error: "这台手机还没有配对" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ device: streamDevice.name })}\n\n`);
      streams.add(res);
      req.on("close", () => {
        streams.delete(res);
      });
      return;
    }

    const device = authorized(req);
    if (!device) {
      json(res, 401, { error: "这台手机还没有配对" });
      return;
    }

    if (pathname === "/api/bootstrap" && req.method === "GET") {
      await handleBootstrap(req, res, device);
      return;
    }

    if (pathname === "/api/projects" && req.method === "GET") {
      json(res, 200, { projects: await api.projects() });
      return;
    }

    // Creating a session is a write, so it is POST and it carries only the folder
    // (or nothing, for a chat with no project).
    if (pathname === "/api/sessions" && req.method === "POST") {
      const body = await readBody(req);
      const projectPath = typeof body.projectPath === "string" ? body.projectPath.trim() : "";
      if (projectPath && (!projectPath.includes("/") && !projectPath.includes("\\"))) {
        json(res, 400, { error: "项目路径不合法" });
        return;
      }
      const session = await api.createSession({ projectPath, title: typeof body.title === "string" ? body.title : "" });
      json(res, 200, { session });
      return;
    }

    const sessionMatch = pathname.match(/^\/api\/session\/([^/]+)(?:\/(prompt|abort|fork))?$/);
    if (sessionMatch) {
      const sessionId = parseSessionId(sessionMatch[1]);
      if (!sessionId) {
        json(res, 400, { error: "会话 id 不合法" });
        return;
      }
      const action = sessionMatch[2];
      if (!action) {
        await handleSession(req, res, device, sessionId, url);
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { error: "请用 POST" });
        return;
      }
      if (action === "prompt") {
        const body = await readBody(req);
        const content = typeof body.content === "string" ? body.content.trim() : "";
        if (!content) {
          json(res, 400, { error: "内容为空" });
          return;
        }
        const result = await api.prompt(sessionId, content.slice(0, 20000));
        json(res, 200, { ok: true, ...result });
        return;
      }
      if (action === "fork") {
        const body = await readBody(req);
        const throughMessageId = typeof body.throughMessageId === "string" ? body.throughMessageId.trim() : "";
        const session = await api.fork(sessionId, { throughMessageId, title: typeof body.title === "string" ? body.title : "" });
        json(res, 200, { session });
        return;
      }
      const result = await api.abort(sessionId);
      json(res, 200, { ok: true, ...result });
      return;
    }

    json(res, 404, { error: "没有这个接口" });
  }

  async function broadcast() {
    if (!streams.size) return;
    let snapshot;
    try {
      snapshot = await api.snapshot();
    } catch {
      return;
    }
    const text = JSON.stringify(snapshot);
    if (text === lastSnapshot) return;
    lastSnapshot = text;
    const frame = `event: sessions\ndata: ${text}\n\n`;
    for (const res of streams) {
      try {
        res.write(frame);
      } catch {
        streams.delete(res);
      }
    }
  }

  async function start({ port: requestedPort }) {
    if (server) return status();
    if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) {
      throw new Error("端口需在 1024–65535 之间");
    }
    host = options.host || "0.0.0.0";
    server = http.createServer((req, res) => {
      if (!originAllowed(req, port || requestedPort)) {
        json(res, 403, { error: "来源不被允许" });
        return;
      }
      handleRoute(req, res).catch((error) => {
        const status = Number(error && error.status) || 500;
        if (status >= 500) log(`${req.method} ${req.url} 失败: ${error && error.message ? error.message : error}`);
        json(res, status, { error: error && error.message ? error.message : "内部错误" });
      });
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(requestedPort, host);
    }).catch((error) => {
      server = null;
      const message = error && error.code === "EADDRINUSE" ? `端口 ${requestedPort} 已被占用` : error.message;
      throw new Error(message);
    });
    const address = server.address();
    port = address && typeof address === "object" ? address.port : requestedPort;
    startedAt = Date.now();
    lastSnapshot = "";
    streamTimer = setInterval(() => {
      void broadcast();
    }, STREAM_INTERVAL_MS);
    log(`网关已监听 ${host}:${port}`);
    return status();
  }

  async function stop() {
    if (streamTimer) clearInterval(streamTimer);
    streamTimer = null;
    for (const res of streams) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    streams = new Set();
    const current = server;
    server = null;
    port = null;
    startedAt = 0;
    if (current) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        current.close(() => {
          clearTimeout(timer);
          resolve();
        });
        if (typeof current.closeAllConnections === "function") current.closeAllConnections();
      });
    }
  }

  function status() {
    return {
      running: Boolean(server && port),
      port,
      host,
      startedAt: startedAt || null,
      streams: streams.size,
    };
  }

  return { start, stop, status, _broadcast: broadcast };
}

module.exports = { createRemoteServer, originAllowed, pairLimiter, MOBILE_DIR, ASSETS, STREAM_INTERVAL_MS };
