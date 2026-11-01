"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const remote = require("../features/remote/index.js");
const { createRemoteServer, originAllowed, ASSETS } = require("../features/remote/server.js");

const internals = remote._internals;

function freePort() {
  return 18000 + Math.floor(Math.random() * 2000);
}

async function withServer(overrides = {}) {
  const calls = [];
  const port = overrides.port || freePort();
  const auth = overrides.auth || {
    checkCode: (code) => code === "123456",
    register: (name) => ({ token: "tok-abc", name, createdAt: "2026-01-01T00:00:00.000Z" }),
    verify: (token) => (token === "tok-abc" ? { token, name: "测试机" } : null),
  };
  const api = overrides.api || {
    sessions: async () => [{ id: "s1", title: "会话一", running: false }],
    session: async (id) => (id === "s1" ? { session: { id, title: "会话一" }, messages: [], running: false } : null),
    prompt: async (id, content) => {
      calls.push(["prompt", id, content]);
      return {};
    },
    abort: async (id) => {
      calls.push(["abort", id]);
      return {};
    },
    snapshot: async () => ({ sessions: [] }),
  };
  const server = createRemoteServer({ host: "127.0.0.1", port, auth, api, log: () => {} });
  await server.start({ port });
  return {
    port,
    calls,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await server.stop();
    },
  };
}

// ------------------------------------------------------------------ pure bits

test("a session row is normalized across the shapes the host has used", () => {
  assert.equal(internals.normalizeSessionRow(null), null);
  assert.equal(internals.normalizeSessionRow({ title: "无 id" }), null);

  const row = internals.normalizeSessionRow({
    sessionId: "abc",
    title: "  写一个功能  ",
    projectPath: "E:\\AgentProjects\\PiOpt",
    updatedAt: "2026-10-30T10:00:00.000Z",
    running: true,
  });
  assert.equal(row.id, "abc");
  assert.equal(row.title, "写一个功能");
  assert.equal(row.projectName, "PiOpt");
  assert.equal(row.running, true);

  const untitled = internals.normalizeSessionRow({ id: "x", isRunning: true });
  assert.equal(untitled.title, "未命名会话");
  assert.equal(untitled.running, true);
});

test("a transcript keeps user and assistant text and drops system rows", () => {
  const messages = internals.normalizeMessages([
    { role: "user", blocks: [{ type: "text", text: "你好" }] },
    { role: "system", blocks: [{ type: "text", text: "运行时提示" }] },
    {
      role: "assistant",
      blocks: [
        { type: "text", text: "先看一下" },
        { type: "tool-call", name: "Read" },
      ],
    },
    { role: "user", blocks: [{ type: "text", text: "   " }] },
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].text, "你好");
  assert.equal(messages[1].text, "先看一下\n〔Read〕");
});

test("an overlong block is truncated instead of shipped whole", () => {
  const long = "x".repeat(9000);
  const [message] = internals.normalizeMessages([{ role: "assistant", content: long }]);
  assert.equal(message.text.endsWith("…"), true);
  assert.ok(message.text.length <= 8001);
});

test("only private IPv4 ranges are offered as the phone address", () => {
  assert.equal(internals.isPrivateV4("192.168.1.20"), true);
  assert.equal(internals.isPrivateV4("10.0.4.7"), true);
  assert.equal(internals.isPrivateV4("172.20.1.1"), true);
  assert.equal(internals.isPrivateV4("172.32.1.1"), false);
  assert.equal(internals.isPrivateV4("8.8.8.8"), false);
  assert.equal(internals.isPrivateV4("nope"), false);
});

test("the pairing code is six digits", () => {
  for (let index = 0; index < 50; index += 1) {
    assert.match(internals.randomCode(), /^\d{6}$/);
  }
});

test("an origin from another host on the LAN is refused", () => {
  const request = (origin, hostHeader) => originAllowed({ headers: { origin, host: hostHeader } }, 8790);
  assert.equal(request(undefined, "192.168.1.5:8790"), true);
  assert.equal(request("http://192.168.1.5:8790", "192.168.1.5:8790"), true);
  assert.equal(request("http://localhost:8790", "192.168.1.5:8790"), true);
  assert.equal(request("http://192.168.1.99:8790", "192.168.1.5:8790"), false);
  assert.equal(request("http://192.168.1.5:9999", "192.168.1.5:8790"), false);
  assert.equal(request("https://192.168.1.5:8790", "192.168.1.5:8790"), false);
});

// --------------------------------------------------------------- HTTP surface

test("the phone page and its assets are served without a token", async () => {
  const server = await withServer();
  try {
    const page = await fetch(`${server.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /配对/);

    for (const asset of ["/app.js", "/style.css"]) {
      assert.ok(ASSETS.has(asset), asset);
      const response = await fetch(`${server.base}${asset}`);
      assert.equal(response.status, 200, asset);
    }
  } finally {
    await server.close();
  }
});

test("every API route but pairing needs the device token", async () => {
  const server = await withServer();
  try {
    for (const route of ["/api/bootstrap", "/api/session/s1", "/api/stream"]) {
      const response = await fetch(`${server.base}${route}`);
      assert.equal(response.status, 401, route);
    }
  } finally {
    await server.close();
  }
});

test("pairing takes the right code once and hands back a token", async () => {
  const server = await withServer();
  try {
    const wrong = await fetch(`${server.base}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "000000" }),
    });
    assert.equal(wrong.status, 401);

    const right = await fetch(`${server.base}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123456", name: "我的手机" }),
    });
    assert.equal(right.status, 200);
    const body = await right.json();
    assert.equal(body.token, "tok-abc");
    assert.equal(body.name, "我的手机");

    const bootstrap = await fetch(`${server.base}/api/bootstrap`, {
      headers: { "x-pi-device": body.token },
    });
    assert.equal(bootstrap.status, 200);
    const payload = await bootstrap.json();
    assert.equal(payload.sessions[0].id, "s1");
    assert.equal(payload.device.name, "测试机");
  } finally {
    await server.close();
  }
});

test("five wrong codes from one address lock pairing for a minute", async () => {
  const server = await withServer();
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${server.base}/api/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "111111" }),
      });
      assert.equal(response.status, 401);
    }
    const locked = await fetch(`${server.base}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    assert.equal(locked.status, 429);
  } finally {
    await server.close();
  }
});

test("a paired phone reads one session and drives prompt and abort", async () => {
  const server = await withServer();
  const headers = { "x-pi-device": "tok-abc", "Content-Type": "application/json" };
  try {
    const read = await fetch(`${server.base}/api/session/s1`, { headers });
    assert.equal(read.status, 200);
    const payload = await read.json();
    assert.equal(payload.session.title, "会话一");

    const missing = await fetch(`${server.base}/api/session/nope`, { headers });
    assert.equal(missing.status, 404);

    const prompt = await fetch(`${server.base}/api/session/s1/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "继续" }),
    });
    assert.equal(prompt.status, 200);
    assert.deepEqual(server.calls.at(-1), ["prompt", "s1", "继续"]);

    const empty = await fetch(`${server.base}/api/session/s1/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "   " }),
    });
    assert.equal(empty.status, 400);

    const abort = await fetch(`${server.base}/api/session/s1/abort`, { method: "POST", headers, body: "{}" });
    assert.equal(abort.status, 200);
    assert.deepEqual(server.calls.at(-1), ["abort", "s1"]);
  } finally {
    await server.close();
  }
});

test("a session id with path characters is rejected before it reaches the host", async () => {
  const server = await withServer();
  try {
    const response = await fetch(`${server.base}/api/session/..%2Fetc%2Fpasswd`, {
      headers: { "x-pi-device": "tok-abc" },
    });
    assert.equal(response.status, 400);
  } finally {
    await server.close();
  }
});

test("an unrecognised route is a 404, not a stack trace", async () => {
  const server = await withServer();
  try {
    const response = await fetch(`${server.base}/api/nope`, { headers: { "x-pi-device": "tok-abc" } });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(typeof body.error, "string");
  } finally {
    await server.close();
  }
});

test("the stream sends the first frame and then tracks the snapshot", async () => {
  let snapshot = { sessions: [] };
  const server = await withServer({
    api: {
      sessions: async () => [],
      session: async () => null,
      prompt: async () => ({}),
      abort: async () => ({}),
      snapshot: async () => snapshot,
    },
  });
  const controller = new AbortController();
  try {
    const response = await fetch(`${server.base}/api/stream?token=tok-abc`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const first = await reader.read();
    text += decoder.decode(first.value);
    assert.match(text, /event: hello/);

    snapshot = { sessions: [{ id: "s2", title: "新会话", running: true }] };
    // The interval is 2.5s; one tick is enough to see the frame.
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !/新会话/.test(text)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    assert.match(text, /event: sessions/);
    assert.match(text, /新会话/);
    await reader.cancel();
  } finally {
    controller.abort();
    await server.close();
  }
});

test("the port guard rejects anything a phone could not open", async () => {
  const server = createRemoteServer({
    host: "127.0.0.1",
    auth: { checkCode: () => false, register: () => ({}), verify: () => null },
    api: {},
  });
  await assert.rejects(() => server.start({ port: 80 }), /1024/);
  await assert.rejects(() => server.start({ port: 70000 }), /1024/);
});
