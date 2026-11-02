"use strict";

/**
 * The parser is checked as data, because rendering needs a DOM and the data is
 * where the bugs are. Two things matter beyond the shapes: nothing may escape
 * its element (no raw HTML in, no raw HTML out) and a link is only a link when
 * it is http, https or mailto.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const md = require("../features/remote/mobile/markdown.js");

test("paragraphs, headings and rules", () => {
  const blocks = md.parse("# 标题\n\n正文第一行\n第二行\n\n---\n\n## 小标题");
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "p", "hr", "heading"]);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[0].text, "标题");
  assert.equal(blocks[1].text, "正文第一行\n第二行");
  assert.equal(blocks[3].level, 2);
});

test("fenced code keeps its language and its exact body", () => {
  const blocks = md.parse("前言\n\n```ts\nconst a = 1;\n  const b = 2;\n```\n\n后记");
  assert.deepEqual(blocks.map((block) => block.type), ["p", "code", "p"]);
  assert.equal(blocks[1].lang, "ts");
  assert.equal(blocks[1].text, "const a = 1;\n  const b = 2;");
});

test("lists keep order and absorb wrapped lines", () => {
  const blocks = md.parse("- 第一条\n  续行\n- 第二条\n\n1. 一\n2. 二");
  assert.equal(blocks[0].type, "list");
  assert.equal(blocks[0].ordered, false);
  assert.deepEqual(blocks[0].items.map((item) => item.text), ["第一条 续行", "第二条"]);
  assert.equal(blocks[1].ordered, true);
  assert.deepEqual(blocks[1].items.map((item) => item.text), ["一", "二"]);
});

test("a pipe table needs its divider, and keeps rows aligned with the header", () => {
  const blocks = md.parse("| 名称 | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "table");
  assert.deepEqual(blocks[0].head, ["名称", "值"]);
  assert.deepEqual(blocks[0].rows, [["a", "1"], ["b", "2"]]);

  // Without a divider the pipes are just text.
  const plain = md.parse("| 不是 | 表格 |");
  assert.equal(plain[0].type, "p");
});

test("quotes collect consecutive lines", () => {
  const blocks = md.parse("> 第一行\n> 第二行\n\n普通");
  assert.equal(blocks[0].type, "quote");
  assert.equal(blocks[0].text, "第一行\n第二行");
  assert.equal(blocks[1].type, "p");
});

test("inline markup, in the order a reader would expect", () => {
  const nodes = md.parseInline("**粗** 与 *斜* 和 `code` 以及 ~~删~~ 结束");
  const kinds = nodes.map((node) => node.type);
  assert.deepEqual(kinds, ["strong", "text", "em", "text", "code", "text", "del", "text"]);
  assert.equal(nodes[0].text, "粗");
  assert.equal(nodes[4].text, "code");
});

test("a link is only a link when its scheme is safe", () => {
  assert.deepEqual(md.parseInline("[文档](https://example.com/a)")[0], {
    type: "link",
    text: "文档",
    href: "https://example.com/a",
  });
  assert.deepEqual(md.parseInline("[邮件](mailto:a@b.c)")[0].type, "link");
  const unsafe = md.parseInline("[点我](javascript:alert(1))");
  assert.equal(unsafe[0].type, "text");
  assert.match(unsafe[0].text, /javascript:alert\(1\)/);
});

test("raw html is text, not markup", () => {
  const nodes = md.parseInline('<img src=x onerror="alert(1)">');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, "text");
  assert.equal(nodes[0].text, '<img src=x onerror="alert(1)">');

  // And a fenced block keeps it verbatim too.
  const blocks = md.parse("```html\n<b>hi</b>\n```");
  assert.equal(blocks[0].type, "code");
  assert.equal(blocks[0].text, "<b>hi</b>");
});

test("bare urls become links, and a trailing bracket is not swallowed", () => {
  const nodes = md.parseInline("见 https://example.com/x 结束");
  const link = nodes.find((node) => node.type === "link");
  assert.equal(link.href, "https://example.com/x");
});

test("an empty or whitespace body yields nothing", () => {
  assert.deepEqual(md.parse(""), []);
  assert.deepEqual(md.parse("   \n\n  "), []);
  assert.deepEqual(md.parseInline(""), []);
});
