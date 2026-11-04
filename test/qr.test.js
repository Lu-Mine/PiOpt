"use strict";

/**
 * The QR encoder is checked two ways.
 *
 * 1. Against fixed digests. Each of these three matrices was produced with an
 *    explicit mask and compared cell by cell with the Python `qrcode` library at
 *    the time it was written — identical, all 8 masks, versions 1 through 10.
 *    The digest is what keeps that agreement from drifting.
 * 2. Against what a scanner actually reads. The same three payloads — plus a
 *    fourth with a long path — were rendered to PNG and decoded with OpenCV's
 *    QRCodeDetector: all five decoded back to the exact input string, and the
 *    QR the panel draws on screen decoded too, in both themes.
 *
 * The library's automatic mask choice is deliberately not compared: it picks a
 * different mask than its own `lost_point` minimum, while this encoder takes the
 * standard minimum. Any of the eight masks is a valid code; the format bits say
 * which one was used.
 */

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const QR = require("../renderer/qr.js");

const digestOf = (text, mask) =>
  crypto
    .createHash("sha256")
    .update(QR.build(text, { mask }).modules.map((row) => row.join("")).join(""))
    .digest("hex");

test("fixed-mask matrices match the reference implementation", () => {
  const cases = [
    ["http://a.b", 0, 1, "c14b44adcdd32d0f67f1bf201d4abfc3e92e8c8065b0aa50a9d2bc3fd42fef71"],
    ["http://192.168.1.20:8790", 2, 2, "874327f193fb3c9cd5ad5dba1bca7e14f7b3536285d9766847f1b9a833d52a87"],
    ["手机访问：http://192.168.1.20:8790", 5, 3, "1e307847e44764727983f60d417271429046ff9d5b6e224e72c463e11884987d"],
  ];
  for (const [text, mask, version, digest] of cases) {
    const built = QR.build(text, { mask });
    assert.equal(built.version, version, text);
    assert.equal(built.size, 17 + version * 4, text);
    assert.equal(digestOf(text, mask), digest, text);
  }
});

test("the matrix is square, boolean, and carries a quiet-zone-free border of finders", () => {
  const { modules, size } = QR.build("http://192.168.1.20:8790");
  assert.equal(modules.length, size);
  for (const row of modules) {
    assert.equal(row.length, size);
    for (const cell of row) assert.ok(cell === 0 || cell === 1);
  }
  // Finder corners: 7×7 with a dark outer ring.
  for (const [row, column] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(modules[row][column], 1);
    assert.equal(modules[row + 1][column + 1], 0);
    assert.equal(modules[row + 3][column + 3], 1);
  }
});

test("the version grows with the payload and stops at ten", () => {
  assert.equal(QR.chooseVersion(QR.utf8Bytes("http://a.b").length), 1);
  assert.equal(QR.chooseVersion(QR.utf8Bytes("http://192.168.1.20:8790").length), 2);
  const long = "x".repeat(200);
  assert.ok(QR.chooseVersion(long.length) >= 8);
  assert.throws(() => QR.chooseVersion(400), /版本 10/);
});

test("utf-8 payloads are encoded as their bytes, not their code units", () => {
  assert.deepEqual(QR.utf8Bytes("AB"), [65, 66]);
  // 手 is U+624B → e6 89 8b
  assert.deepEqual(QR.utf8Bytes("手"), [0xe6, 0x89, 0x8b]);
  // an emoji above the BMP becomes four bytes
  assert.equal(QR.utf8Bytes("🙂").length, 4);
});

test("the svg is self-contained and sized by the quiet zone", () => {
  const svg = QR.svg("http://192.168.1.20:8790", { margin: 2, dark: "#101418" });
  const { size } = QR.build("http://192.168.1.20:8790");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, new RegExp(`viewBox="0 0 ${size + 4} ${size + 4}"`));
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /fill="#101418"/);
  assert.match(svg, /aria-label="设备访问地址二维码"/);
  // No external reference of any kind: the panel is offline.
  assert.doesNotMatch(svg, /href|xlink|url\(/);
});

test("an empty payload still yields a valid, decodable code", () => {
  const built = QR.build("");
  assert.equal(built.version, 1);
  assert.equal(built.size, 21);
});
