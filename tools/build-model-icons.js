#!/usr/bin/env node
"use strict";

/**
 * 把 lobe-icons 的静态 SVG 收进一个随包模块，宿主窗口才能把图标画进模型浮窗。
 *
 * 用法：
 *   node tools/build-model-icons.js <icons-dir>
 *
 * <icons-dir> 是 @lobehub/icons-static-svg 的 icons/ 目录，例如：
 *   curl -L -o icons.tgz https://registry.npmmirror.com/@lobehub/icons-static-svg/-/icons-static-svg-1.101.0.tgz
 *   tar -xzf icons.tgz
 *   node tools/build-model-icons.js package/icons
 *
 * 每个品牌一行：`<id>` 是渲染模块里用的键，`<file>` 是 lobe 的文件名。有
 * `-color` 变体的优先用彩色原图；没有的（Anthropic、OpenAI、xAI、Ollama）用单色
 * 图形配品牌色，色值写在这一行里。单色图标不给颜色时保留 currentColor，跟随界面
 * 文字色（xAI 与 Ollama 的官方标识本来就是黑白，纯黑在深色界面上看不见）。
 *
 * 输出只含 ICONS（id → SVG 字符串）。SVG 里的 id（渐变、裁切）在这里一次性按品牌
 * 重写成 `piopt-<id>-<n>`：同一份图标在一屏里出现多次也不会互相串。
 */

const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const path = require("node:path");

const BRANDS = [
  // 彩色原图
  // Claude 用自家那朵菊花，不是 Anthropic 的 A 标；两个都收着，名字里带 claude、
  // sonnet、opus、haiku 的一律先吃到菊花。
  { id: "claude", file: "claude-color.svg" },
  { id: "gemini", file: "gemini-color.svg" },
  { id: "deepseek", file: "deepseek-color.svg" },
  { id: "zhipu", file: "zhipu-color.svg" },
  { id: "qwen", file: "qwen-color.svg" },
  { id: "kimi", file: "kimi-color.svg" },
  { id: "minimax", file: "minimax-color.svg" },
  { id: "mistral", file: "mistral-color.svg" },
  { id: "meta", file: "meta-color.svg" },
  { id: "cohere", file: "cohere-color.svg" },
  { id: "openrouter", file: "openrouter-color.svg" },
  { id: "together", file: "together-color.svg" },
  { id: "perplexity", file: "perplexity-color.svg" },
  { id: "doubao", file: "doubao-color.svg" },
  { id: "baidu", file: "baidu-color.svg" },
  { id: "hunyuan", file: "hunyuan-color.svg" },
  { id: "stepfun", file: "stepfun-color.svg" },
  { id: "huggingface", file: "huggingface-color.svg" },
  { id: "nvidia", file: "nvidia-color.svg" },
  { id: "yi", file: "yi-color.svg" },
  { id: "cerebras", file: "cerebras-color.svg" },
  { id: "azure", file: "azure-color.svg" },
  { id: "aws", file: "aws-color.svg" },
  // 只有单色图形：用品牌色填，或者跟随 currentColor
  { id: "anthropic", file: "anthropic.svg", color: "#D97757" },
  { id: "openai", file: "openai.svg", color: "#10A37F" },
  { id: "xai", file: "grok.svg" },
  { id: "ollama", file: "ollama.svg" },
];

const iconsDir = process.argv[2];
if (!iconsDir) {
  console.error("用法: node tools/build-model-icons.js <lobe-icons 的 icons 目录>");
  process.exit(1);
}

/** 去掉 title / 内联尺寸 / style，留给 CSS 决定大小。 */
function stripSvg(svg) {
  return svg
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/\s(viewBox="[^"]*")/, " $1")
    .replace(/\s(?:height|width)="[^"]*"/g, "")
    .replace(/\sstyle="[^"]*"/g, "")
    .replace(/\sfill-rule="evenodd"/g, "")
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
}

/** 渐变/裁切的 id 加品牌前缀，`url(#…)` 与 `href="#…"` 一起改。 */
function prefixIds(svg, brand) {
  const ids = [...new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]))];
  let out = svg;
  ids.forEach((id, index) => {
    const next = `piopt-${brand}-${index + 1}`;
    const quoted = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out
      .replace(new RegExp(`\\sid="${quoted}"`, "g"), ` id="${next}"`)
      .replace(new RegExp(`url\\(#${quoted}\\)`, "g"), `url(#${next})`)
      .replace(new RegExp(`href="#${quoted}"`, "g"), `href="#${next}"`);
  });
  return out;
}

function colorize(svg, color) {
  if (!color) return svg;
  return svg.replace(/fill="currentColor"/g, `fill="${color}"`);
}

const entries = [];
for (const brand of BRANDS) {
  const file = path.join(iconsDir, brand.file);
  if (!existsSync(file)) {
    console.error(`缺少图标文件：${file}`);
    process.exit(1);
  }
  const raw = readFileSync(file, "utf8");
  const svg = prefixIds(colorize(stripSvg(raw), brand.color), brand.id);
  if (!svg.startsWith("<svg")) {
    console.error(`${brand.file} 不是一个裸 SVG`);
    process.exit(1);
  }
  entries.push({ id: brand.id, svg });
}

const out = `// 模型品牌图标：@lobehub/icons-static-svg 的静态 SVG（MIT，随包内联，不联网）。
//
// 这个文件由 tools/build-model-icons.mjs 生成 —— 要加品牌就改那张表再重新生成，
// 不要手改这里。每个图标都是 24×24 的 viewBox，尺寸交给渲染模块的 CSS；渐变与
// 裁切的 id 已经按品牌重写过，同一份图标在一屏里出现多次也不会互相串。

export const ICON_SOURCE = "@lobehub/icons-static-svg";

export const ICONS = Object.freeze({
${entries.map((entry) => `  ${entry.id}: ${JSON.stringify(entry.svg)},`).join("\n")}
});
`;

const target = path.join(__dirname, "..", "renderer", "model-logos", "icons.mjs");
writeFileSync(target, out, "utf8");
console.log(`写出 ${entries.length} 个图标 -> ${path.relative(process.cwd(), target)}（${out.length} 字节）`);
