"use strict";

/**
 * Reads an image's intrinsic size from its header, without decoding pixels.
 *
 * The one caller is `scale-down`: `background-size` cannot express "shrink if
 * too big, but never enlarge", because CSS has no access to an image's natural
 * size. Knowing the size lets the glass layer size a centred box to
 * `min(100%, natural)` and then `contain` inside it, which is exactly
 * `object-fit: scale-down`.
 *
 * Only the formats the host accepts as a theme asset are handled, and AVIF is
 * deliberately skipped: its `ispe` box needs a full box parser, and falling back
 * to `contain` for it degrades to "shrink but may enlarge" rather than breaking.
 */

const { closeSync, openSync, readSync, statSync } = require("node:fs");

// Every header we care about sits in the first few KB; 64 KB also covers a JPEG
// with a large EXIF block before its first SOF marker.
const HEAD_BYTES = 64 * 1024;

function readHead(path, bytes = HEAD_BYTES) {
  const total = statSync(path).size;
  const length = Math.min(total, bytes);
  if (length < 12) return null;
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, 0);
  } finally {
    closeSync(fd);
  }
  return buffer;
}

function pngSize(buffer) {
  if (buffer.length < 24) return null;
  // \x89 P N G
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    // SOF0…SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buffer.toString("ascii", 12, 16);

  if (chunk === "VP8X") {
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return { width, height };
  }
  if (chunk === "VP8 ") {
    // The lossy bitstream starts after a 0x9d 0x01 0x2a sync code.
    const limit = Math.min(buffer.length, 40) + 0;
    for (let index = Math.max(20, limit - 20); index + 9 < buffer.length; index += 1) {
      if (buffer[index] === 0x9d && buffer[index + 1] === 0x01 && buffer[index + 2] === 0x2a) {
        const width = buffer.readUInt16LE(index + 3) & 0x3fff;
        const height = buffer.readUInt16LE(index + 5) & 0x3fff;
        if (width > 0 && height > 0) return { width, height };
      }
    }
    return null;
  }
  if (chunk === "VP8L") {
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function svgNumber(value) {
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(String(value ?? ""));
  if (!match) return 0;
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function svgSize(buffer) {
  const text = buffer.toString("utf8");
  const tag = /<svg\b[^>]*>/i.exec(text);
  if (!tag) return null;
  const attribute = (name) => {
    const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag[0]);
    return match ? match[1] : "";
  };

  const width = svgNumber(attribute("width"));
  const height = svgNumber(attribute("height"));
  if (width > 0 && height > 0) return { width, height };

  const viewBox = attribute("viewBox") || attribute("viewbox");
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: Math.round(parts[2]), height: Math.round(parts[3]) };
    }
  }
  return null;
}

function extensionOf(path) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(path ?? ""));
  return match ? match[1].toLowerCase() : "";
}

/** `{ width, height }`, or null when the format or the file cannot be read. */
function readImageSize(path) {
  const target = String(path ?? "").trim();
  if (!target) return null;
  let head;
  try {
    head = readHead(target);
  } catch {
    return null;
  }
  if (!head) return null;

  const extension = extensionOf(target);
  let size = null;
  try {
    if (extension === "svg") size = svgSize(head);
    else size = pngSize(head) || jpegSize(head) || webpSize(head);
  } catch {
    // A truncated or unusual file must not take the theme down with it.
    return null;
  }
  if (!size || !(size.width > 0) || !(size.height > 0)) return null;
  if (size.width > 100000 || size.height > 100000) return null;
  return size;
}

module.exports = { readImageSize };
