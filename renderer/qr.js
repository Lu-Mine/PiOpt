/*
 * A QR encoder for the one thing this panel needs a QR code for: the phone's
 * address. Byte mode, error correction level M, versions 1–10 (up to 213 bytes,
 * and a LAN URL is around thirty), automatic mask selection by the standard
 * penalty score.
 *
 * Self-contained on purpose. The panel has no node_modules, the plugin ships as
 * a folder, and adding a dependency for one square matrix would be the largest
 * thing in the package. Every table below is the one in ISO/IEC 18004; the
 * encoder is checked cell by cell against a reference implementation in
 * test/qr.test.js, so a wrong table shows up as a failing test rather than as a
 * code that only half the phones read.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PiOptQr = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ecCodewordsPerBlock, and the two block groups (count, dataCodewordsEach).
  const VERSIONS = [
    null,
    { ec: 10, groups: [[1, 16]] },
    { ec: 16, groups: [[1, 28]] },
    { ec: 26, groups: [[1, 44]] },
    { ec: 18, groups: [[2, 32]] },
    { ec: 24, groups: [[2, 43]] },
    { ec: 16, groups: [[4, 27]] },
    { ec: 18, groups: [[4, 31]] },
    { ec: 22, groups: [[2, 38], [2, 39]] },
    { ec: 22, groups: [[3, 36], [2, 37]] },
    { ec: 26, groups: [[4, 43], [1, 44]] },
  ];

  const ALIGNMENT = [
    null,
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
  ];

  const EC_LEVEL_BITS = 0; // 0b00 = level M, the default this encoder ships.

  // ---------------------------------------------------------------- GF(256)

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function buildTables() {
    let value = 1;
    for (let index = 0; index < 255; index += 1) {
      EXP[index] = value;
      LOG[value] = index;
      value <<= 1;
      if (value & 0x100) value ^= 0x11d;
    }
    for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255];
  })();

  function gfMultiply(left, right) {
    if (left === 0 || right === 0) return 0;
    return EXP[LOG[left] + LOG[right]];
  }

  function generatorPolynomial(degree) {
    let poly = [1];
    for (let index = 0; index < degree; index += 1) {
      const next = new Array(poly.length + 1).fill(0);
      for (let term = 0; term < poly.length; term += 1) {
        next[term] ^= gfMultiply(poly[term], EXP[index]);
        next[term + 1] ^= poly[term];
      }
      poly = next;
    }
    // The loop multiplies in (1 + α^i·x) steps, so it leaves the coefficients
    // lowest-first. Callers index it the standard way — g[0] === 1, then the
    // descending terms — which is what reedSolomon()'s `generator[index + 1]`
    // assumes.
    return poly.reverse();
  }

  function reedSolomon(data, ecLength) {
    const generator = generatorPolynomial(ecLength);
    const remainder = new Array(ecLength).fill(0);
    for (const byte of data) {
      const factor = byte ^ remainder[0];
      remainder.shift();
      remainder.push(0);
      for (let index = 0; index < ecLength; index += 1) {
        remainder[index] ^= gfMultiply(generator[index + 1], factor);
      }
    }
    return remainder;
  }

  // -------------------------------------------------------------- encoding

  function utf8Bytes(text) {
    const bytes = [];
    for (let index = 0; index < text.length; index += 1) {
      let code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        const low = text.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          index += 1;
        }
      }
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      else
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
    }
    return bytes;
  }

  function dataCapacity(version) {
    return VERSIONS[version].groups.reduce((total, [count, size]) => total + count * size, 0);
  }

  function chooseVersion(byteLength) {
    for (let version = 1; version < VERSIONS.length; version += 1) {
      const countBits = version < 10 ? 8 : 16;
      const neededBits = 4 + countBits + byteLength * 8;
      if (neededBits <= dataCapacity(version) * 8) return version;
    }
    throw new Error("内容太长，放不进版本 10 的二维码");
  }

  function buildBitStream(bytes, version) {
    const bits = [];
    const push = (value, length) => {
      for (let index = length - 1; index >= 0; index -= 1) bits.push((value >> index) & 1);
    };
    push(0b0100, 4); // byte mode
    push(bytes.length, version < 10 ? 8 : 16);
    for (const byte of bytes) push(byte, 8);
    const capacity = dataCapacity(version) * 8;
    push(0, Math.min(4, capacity - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    const codewords = [];
    for (let index = 0; index < bits.length; index += 8) {
      let byte = 0;
      for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | bits[index + offset];
      codewords.push(byte);
    }
    const total = dataCapacity(version);
    for (let pad = 0; codewords.length < total; pad += 1) codewords.push(pad % 2 === 0 ? 0xec : 0x11);
    return codewords;
  }

  function interleave(dataCodewords, version) {
    const spec = VERSIONS[version];
    const blocks = [];
    let cursor = 0;
    for (const [count, size] of spec.groups) {
      for (let index = 0; index < count; index += 1) {
        const data = dataCodewords.slice(cursor, cursor + size);
        cursor += size;
        blocks.push({ data, ec: reedSolomon(data, spec.ec) });
      }
    }
    const longest = Math.max(...blocks.map((block) => block.data.length));
    const out = [];
    for (let index = 0; index < longest; index += 1) {
      for (const block of blocks) {
        if (index < block.data.length) out.push(block.data[index]);
      }
    }
    for (let index = 0; index < spec.ec; index += 1) {
      for (const block of blocks) out.push(block.ec[index]);
    }
    return out;
  }

  // ---------------------------------------------------------------- matrix

  function createMatrix(size) {
    const modules = [];
    const reserved = [];
    for (let row = 0; row < size; row += 1) {
      modules.push(new Array(size).fill(0));
      reserved.push(new Array(size).fill(false));
    }
    return { size, modules, reserved };
  }

  function placeFinder(grid, row, column) {
    for (let offsetRow = -1; offsetRow <= 7; offsetRow += 1) {
      for (let offsetColumn = -1; offsetColumn <= 7; offsetColumn += 1) {
        const targetRow = row + offsetRow;
        const targetColumn = column + offsetColumn;
        if (targetRow < 0 || targetRow >= grid.size || targetColumn < 0 || targetColumn >= grid.size) continue;
        const inRing = offsetRow >= 0 && offsetRow <= 6 && offsetColumn >= 0 && offsetColumn <= 6;
        const dark =
          inRing &&
          (offsetRow === 0 ||
            offsetRow === 6 ||
            offsetColumn === 0 ||
            offsetColumn === 6 ||
            (offsetRow >= 2 && offsetRow <= 4 && offsetColumn >= 2 && offsetColumn <= 4));
        grid.modules[targetRow][targetColumn] = dark ? 1 : 0;
        grid.reserved[targetRow][targetColumn] = true;
      }
    }
  }

  function placeAlignment(grid, version) {
    const centers = ALIGNMENT[version];
    for (const row of centers) {
      for (const column of centers) {
        if (grid.reserved[row][column]) continue;
        for (let offsetRow = -2; offsetRow <= 2; offsetRow += 1) {
          for (let offsetColumn = -2; offsetColumn <= 2; offsetColumn += 1) {
            const dark = Math.max(Math.abs(offsetRow), Math.abs(offsetColumn)) !== 1;
            grid.modules[row + offsetRow][column + offsetColumn] = dark ? 1 : 0;
            grid.reserved[row + offsetRow][column + offsetColumn] = true;
          }
        }
      }
    }
  }

  function placeTiming(grid) {
    for (let index = 8; index < grid.size - 8; index += 1) {
      const dark = index % 2 === 0 ? 1 : 0;
      if (!grid.reserved[6][index]) {
        grid.modules[6][index] = dark;
        grid.reserved[6][index] = true;
      }
      if (!grid.reserved[index][6]) {
        grid.modules[index][6] = dark;
        grid.reserved[index][6] = true;
      }
    }
  }

  function placeFormatInfo(grid, mask) {
    const size = grid.size;
    const data = (EC_LEVEL_BITS << 3) | mask;
    let remainder = data << 10;
    for (let index = 14; index >= 10; index -= 1) {
      if ((remainder >> index) & 1) remainder ^= 0x537 << (index - 10);
    }
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bitAt = (index) => (bits >> index) & 1;

    // Bit 14 first, bit 0 last, around the top-left finder and again along the
    // right column and bottom row. Standard order matters: a reader reassembles
    // these fifteen bits MSB-first from these exact positions.
    const ring = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    ];
    ring.forEach(([row, column], offset) => {
      grid.modules[row][column] = bitAt(14 - offset);
      grid.reserved[row][column] = true;
    });

    for (let offset = 0; offset < 7; offset += 1) {
      grid.modules[size - 1 - offset][8] = bitAt(14 - offset);
      grid.reserved[size - 1 - offset][8] = true;
    }
    for (let offset = 0; offset < 8; offset += 1) {
      grid.modules[8][size - 8 + offset] = bitAt(7 - offset);
      grid.reserved[8][size - 8 + offset] = true;
    }

    grid.modules[size - 8][8] = 1;
    grid.reserved[size - 8][8] = true;
  }

  function placeVersionInfo(grid, version) {
    if (version < 7) return;
    let remainder = version << 12;
    for (let index = 17; index >= 12; index -= 1) {
      if ((remainder >> index) & 1) remainder ^= 0x1f25 << (index - 12);
    }
    const bits = (version << 12) | remainder;
    for (let index = 0; index < 18; index += 1) {
      const bit = (bits >> index) & 1;
      const row = Math.floor(index / 3);
      const column = index % 3;
      grid.modules[grid.size - 11 + column][row] = bit;
      grid.reserved[grid.size - 11 + column][row] = true;
      grid.modules[row][grid.size - 11 + column] = bit;
      grid.reserved[row][grid.size - 11 + column] = true;
    }
  }

  function placeData(grid, codewords) {
    const size = grid.size;
    let bitIndex = 0;
    let upward = true;
    for (let column = size - 1; column > 0; column -= 2) {
      if (column === 6) column -= 1; // the vertical timing pattern is not a data column
      for (let step = 0; step < size; step += 1) {
        const row = upward ? size - 1 - step : step;
        for (let offset = 0; offset < 2; offset += 1) {
          const target = column - offset;
          if (grid.reserved[row][target]) continue;
          const byte = codewords[bitIndex >> 3];
          const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
          grid.modules[row][target] = bit;
          bitIndex += 1;
        }
      }
      upward = !upward;
    }
    grid.dataBits = bitIndex;
  }

  const MASKS = [
    (row, column) => (row + column) % 2 === 0,
    (row) => row % 2 === 0,
    (row, column) => column % 3 === 0,
    (row, column) => (row + column) % 3 === 0,
    (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
    (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
    (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
    (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
  ];

  function applyMask(grid, mask) {
    const test = MASKS[mask];
    for (let row = 0; row < grid.size; row += 1) {
      for (let column = 0; column < grid.size; column += 1) {
        if (grid.reserved[row][column]) continue;
        if (test(row, column)) grid.modules[row][column] ^= 1;
      }
    }
  }

  function penalty(grid) {
    const size = grid.size;
    const modules = grid.modules;
    let score = 0;

    // Rule 1: runs of five or more of one colour — 3 points, plus one per extra
    // module. Rule 3: the 1:1:3:1:1 finder-like pattern with four light modules
    // beside it — 40 points. Both are read along rows and along columns.
    const lineScore = (line) => {
      let total = 0;
      let run = 1;
      for (let index = 1; index < line.length; index += 1) {
        if (line[index] === line[index - 1]) run += 1;
        else {
          if (run >= 5) total += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) total += 3 + (run - 5);
      const text = line.join("");
      for (const pattern of ["10111010000", "00001011101"]) {
        let at = text.indexOf(pattern);
        while (at !== -1) {
          total += 40;
          at = text.indexOf(pattern, at + 1);
        }
      }
      return total;
    };
    for (let row = 0; row < size; row += 1) {
      score += lineScore(modules[row]);
      score += lineScore(modules.map((line) => line[row]));
    }

    // Rule 2: every 2×2 block of one colour — 3 points each.
    for (let row = 0; row < size - 1; row += 1) {
      for (let column = 0; column < size - 1; column += 1) {
        const value = modules[row][column];
        if (
          value === modules[row][column + 1] &&
          value === modules[row + 1][column] &&
          value === modules[row + 1][column + 1]
        ) {
          score += 3;
        }
      }
    }

    // Rule 4: how far the dark share sits from half — 10 points per 5%.
    let dark = 0;
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) dark += modules[row][column];
    }
    const ratio = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return score;
  }

  function build(text, options) {
    const forced = options && Number.isInteger(options.mask) ? options.mask : null;
    const bytes = utf8Bytes(String(text == null ? "" : text));
    const version = chooseVersion(bytes.length);
    const codewords = interleave(buildBitStream(bytes, version), version);
    const size = 17 + version * 4;

    let best = null;
    for (let mask = 0; mask < 8; mask += 1) {
      if (forced !== null && mask !== forced) continue;
      const grid = createMatrix(size);
      placeFinder(grid, 0, 0);
      placeFinder(grid, 0, size - 7);
      placeFinder(grid, size - 7, 0);
      placeAlignment(grid, version);
      placeTiming(grid);
      placeVersionInfo(grid, version);
      placeFormatInfo(grid, mask);
      placeData(grid, codewords);
      applyMask(grid, mask);
      const score = penalty(grid);
      if (!best || score < best.score) best = { score, mask, grid };
    }
    return { version, size, mask: best.mask, modules: best.grid.modules };
  }

  function matrix(text, options) {
    return build(text, options).modules;
  }

  function svg(text, options) {
    const opts = options || {};
    const margin = opts.margin === undefined ? 2 : opts.margin;
    const dark = opts.dark || "currentColor";
    const { size, modules, version } = build(text);
    const total = size + margin * 2;
    let path = "";
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        if (!modules[row][column]) continue;
        path += `M${column + margin} ${row + margin}h1v1h-1z`;
      }
    }
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
      `shape-rendering="crispEdges" role="img" aria-label="手机访问地址二维码">` +
      `<rect width="${total}" height="${total}" fill="${opts.light || "transparent"}"/>` +
      `<path d="${path}" fill="${dark}"/>` +
      `<title>版本 ${version} · 掩码 ${build(text).mask}</title>` +
      `</svg>`
    );
  }

  return {
    build,
    matrix,
    svg,
    chooseVersion,
    utf8Bytes,
    VERSIONS,
    ALIGNMENT,
    __test: { buildBitStream, interleave, reedSolomon, dataCapacity, generatorPolynomial, penalty },
    __penaltyOf: (text, mask) => {
      const built = build(text, { mask });
      return penalty({ size: built.size, modules: built.modules, reserved: [] });
    },
  };
});
