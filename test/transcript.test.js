"use strict";

/**
 * The transcript reader, exercised against real files in a temp folder.
 *
 * Two properties are the point: the opening question is always in the view (a
 * phone that joined at the last 256 KB used to show a conversation with no
 * question at all), and a poll after one new message parses one line instead of
 * the whole file.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const remote = require("../features/remote/index.js");
const internals = remote._internals;

function message(id, role, text, extra) {
  return JSON.stringify({
    type: "message",
    id,
    role,
    blocks: [{ type: "text", text }],
    meta: { status: "complete" },
    createdAt: "2026-11-01T10:00:00.000Z",
    ...extra,
  });
}

function withDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piopt-transcript-"));
  const savedDir = internals.state.transcriptDir;
  internals.state.transcriptDir = dir;
  internals.transcriptCache.clear();
  try {
    run(dir);
  } finally {
    internals.state.transcriptDir = savedDir;
    internals.transcriptCache.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a long transcript keeps the opening question in the view", () => {
  withDir((dir) => {
    const file = path.join(dir, "s1.jsonl");
    const lines = [JSON.stringify({ type: "session", sessionId: "s1", createdAt: "2026-11-01T09:00:00.000Z" })];
    lines.push(message("m0", "user", "首问：把手机端做出来"));
    for (let index = 1; index <= 120; index += 1) {
      lines.push(message(`m${index}`, "assistant", `第 ${index} 段回复`));
    }
    fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

    const entry = internals.readTranscript("s1");
    assert.ok(entry);
    assert.equal(entry.messages.length, 121);
    assert.equal(entry.messages[0].role, "user");

    const view = internals.transcriptView(entry, 20);
    assert.equal(view.messages.length, 21);
    assert.equal(view.messages[0].role, "user");
    assert.match(view.messages[0].text, /首问/);
    assert.equal(view.omitted, 100);
    // The window itself is still the tail, in order.
    assert.equal(view.messages.at(-1).text, "第 120 段回复");
  });
});

test("a short transcript is returned whole with nothing omitted", () => {
  withDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "s2.jsonl"),
      [message("m0", "user", "只有一问"), message("m1", "assistant", "只有一答")].join("\n") + "\n",
      "utf8"
    );
    const entry = internals.readTranscript("s2");
    const view = internals.transcriptView(entry, 80);
    assert.equal(view.messages.length, 2);
    assert.equal(view.omitted, 0);
  });
});

test("an appended message only parses the new line", () => {
  withDir((dir) => {
    const file = path.join(dir, "s3.jsonl");
    fs.writeFileSync(file, `${message("m0", "user", "第一问")}\n`, "utf8");
    const first = internals.readTranscript("s3");
    assert.equal(first.messages.length, 1);

    fs.appendFileSync(file, `${message("m1", "assistant", "第二段")}\n`, "utf8");
    const second = internals.readTranscript("s3");
    assert.equal(second, first, "the same cache entry is reused");
    assert.equal(second.messages.length, 2);
    assert.equal(second.messages[1].text, "第二段");

    // Nothing changed: the same object, no re-parse.
    assert.equal(internals.readTranscript("s3"), second);
  });
});

test("a half-written line waits instead of being dropped or mis-decoded", () => {
  withDir((dir) => {
    const file = path.join(dir, "s4.jsonl");
    const whole = message("m0", "user", "跨块的中文：先写一半", { id: "m0" });
    const cut = Buffer.byteLength(whole, "utf8") - 20;
    const bytes = Buffer.from(whole, "utf8");
    // Cut inside the multibyte text, with no newline yet.
    fs.writeFileSync(file, bytes.subarray(0, cut));
    assert.equal(internals.readTranscript("s4").messages.length, 0);

    fs.appendFileSync(file, Buffer.concat([bytes.subarray(cut), Buffer.from("\n")]));
    const entry = internals.readTranscript("s4");
    assert.equal(entry.messages.length, 1);
    assert.equal(entry.messages[0].text, "跨块的中文：先写一半");
  });
});

test("a missing session file is null, not an error", () => {
  withDir(() => {
    assert.equal(internals.readTranscript("nope"), null);
    assert.deepEqual(internals.transcriptView(null, 20), { messages: [], omitted: 0 });
  });
});

test("over the keep limit the head question survives and the gap is counted", () => {
  withDir((dir) => {
    const lines = [message("m0", "user", "很久以前的第一个问题")];
    for (let index = 1; index <= 1200; index += 1) {
      lines.push(message(`m${index}`, "assistant", `回复 ${index}`));
    }
    fs.writeFileSync(path.join(dir, "s5.jsonl"), lines.join("\n") + "\n", "utf8");

    const entry = internals.readTranscript("s5");
    // 900 kept plus the head question, and the middle counted as dropped.
    assert.ok(entry.messages.length <= 901, String(entry.messages.length));
    assert.equal(entry.messages.length, 901);
    assert.equal(entry.messages[0].role, "user");
    assert.match(entry.messages[0].text, /第一个问题/);
    assert.ok(entry.dropped > 0, "the middle is dropped, not the head");

    const view = internals.transcriptView(entry, 5);
    assert.equal(view.messages[0].role, "user");
    assert.ok(view.omitted >= entry.dropped);
  });
});
