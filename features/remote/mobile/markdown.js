/*
 * Markdown for the phone transcript.
 *
 * Two halves: `parse` turns a string into plain data, `render` builds DOM from
 * that data. Nothing here ever produces an HTML string, so model output cannot
 * become markup — every text run ends up in a `textContent` assignment and the
 * only attributes ever set are an `href` (http, https, mailto only) and a
 * language class on code blocks.
 *
 * The subset is the one agents actually emit: paragraphs, headings, fenced code,
 * lists, quotes, rules, pipe tables, and inline code / bold / italic / strike /
 * links. Anything else stays literal text, which is the safe direction to be
 * wrong in.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PiOptMd = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
  const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const BULLET = /^(\s*)[-*+]\s+(.*)$/;
  const NUMBERED = /^(\s*)\d{1,3}[.)]\s+(.*)$/;
  const QUOTE = /^\s{0,3}>\s?(.*)$/;
  const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
  const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

  const SAFE_LINK = /^(https?:|mailto:)/i;

  function parse(source) {
    const lines = String(source == null ? "" : source).replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let index = 0;

    const flushParagraph = (buffer) => {
      if (!buffer.length) return;
      blocks.push({ type: "p", text: buffer.join("\n") });
      buffer.length = 0;
    };

    const paragraph = [];
    while (index < lines.length) {
      const line = lines[index];

      const fence = FENCE.exec(line);
      if (fence) {
        flushParagraph(paragraph);
        const marker = fence[1][0];
        const lang = fence[2] || "";
        const body = [];
        index += 1;
        while (index < lines.length) {
          const closing = FENCE.exec(lines[index]);
          if (closing && closing[1][0] === marker) {
            index += 1;
            break;
          }
          body.push(lines[index]);
          index += 1;
        }
        blocks.push({ type: "code", lang, text: body.join("\n") });
        continue;
      }

      const heading = HEADING.exec(line);
      if (heading) {
        flushParagraph(paragraph);
        blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
        index += 1;
        continue;
      }

      if (RULE.test(line)) {
        flushParagraph(paragraph);
        blocks.push({ type: "hr" });
        index += 1;
        continue;
      }

      // A table needs a header row, a divider, then body rows.
      if (
        TABLE_ROW.test(line) &&
        index + 1 < lines.length &&
        TABLE_DIVIDER.test(lines[index + 1]) &&
        lines[index + 1].includes("-")
      ) {
        flushParagraph(paragraph);
        const cells = (row) =>
          TABLE_ROW.exec(row)[1].split("|").map((cell) => cell.trim());
        const head = cells(line);
        index += 2;
        const rows = [];
        while (index < lines.length && TABLE_ROW.test(lines[index])) {
          rows.push(cells(lines[index]));
          index += 1;
        }
        blocks.push({ type: "table", head, rows });
        continue;
      }

      const quote = QUOTE.exec(line);
      if (quote) {
        flushParagraph(paragraph);
        const collected = [quote[1]];
        index += 1;
        while (index < lines.length) {
          const next = QUOTE.exec(lines[index]);
          if (!next) break;
          collected.push(next[1]);
          index += 1;
        }
        blocks.push({ type: "quote", text: collected.join("\n") });
        continue;
      }

      const bullet = BULLET.exec(line);
      const numbered = NUMBERED.exec(line);
      if (bullet || numbered) {
        flushParagraph(paragraph);
        const ordered = Boolean(numbered);
        const items = [];
        while (index < lines.length) {
          const match = ordered ? NUMBERED.exec(lines[index]) : BULLET.exec(lines[index]);
          if (!match) {
            // A wrapped continuation line belongs to the item above it.
            if (items.length && /^\s{2,}\S/.test(lines[index])) {
              items[items.length - 1].text += ` ${lines[index].trim()}`;
              index += 1;
              continue;
            }
            break;
          }
          items.push({ text: match[2].trim() });
          index += 1;
        }
        blocks.push({ type: "list", ordered, items });
        continue;
      }

      if (!line.trim()) {
        flushParagraph(paragraph);
        index += 1;
        continue;
      }

      paragraph.push(line);
      index += 1;
    }
    flushParagraph(paragraph);
    return blocks;
  }

  // Inline: code first, because everything inside a span is literal.
  const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/g;

  function parseInline(text) {
    const nodes = [];
    const source = String(text == null ? "" : text);
    let at = 0;
    INLINE.lastIndex = 0;
    let match;
    while ((match = INLINE.exec(source)) !== null) {
      if (match.index > at) nodes.push({ type: "text", text: source.slice(at, match.index) });
      const [, code, strongA, strongB, strike, emA, emB, label, href, bare] = match;
      if (code !== undefined) nodes.push({ type: "code", text: code });
      else if (strongA !== undefined) nodes.push({ type: "strong", text: strongA });
      else if (strongB !== undefined) nodes.push({ type: "strong", text: strongB });
      else if (strike !== undefined) nodes.push({ type: "del", text: strike });
      else if (emA !== undefined) nodes.push({ type: "em", text: emA });
      else if (emB !== undefined) nodes.push({ type: "em", text: emB });
      else if (label !== undefined) {
        nodes.push(SAFE_LINK.test(href) ? { type: "link", text: label, href } : { type: "text", text: `${label} (${href})` });
      } else if (bare !== undefined) nodes.push({ type: "link", text: bare, href: bare });
      at = match.index + match[0].length;
    }
    if (at < source.length) nodes.push({ type: "text", text: source.slice(at) });
    return nodes;
  }

  function renderInto(parent, blocks, doc) {
    for (const block of blocks) {
      if (block.type === "p") {
        parent.append(inlineParagraph(block.text, doc));
      } else if (block.type === "heading") {
        const heading = doc.createElement(`h${Math.min(6, Math.max(1, block.level))}`);
        appendInline(heading, block.text, doc);
        parent.append(heading);
      } else if (block.type === "code") {
        const pre = doc.createElement("pre");
        const code = doc.createElement("code");
        if (block.lang) code.className = `lang-${block.lang.replace(/[^\w+-]/g, "")}`;
        code.textContent = block.text;
        pre.append(code);
        parent.append(pre);
      } else if (block.type === "list") {
        const list = doc.createElement(block.ordered ? "ol" : "ul");
        for (const item of block.items) {
          const li = doc.createElement("li");
          appendInline(li, item.text, doc);
          list.append(li);
        }
        parent.append(list);
      } else if (block.type === "quote") {
        const quote = doc.createElement("blockquote");
        appendInline(quote, block.text, doc);
        parent.append(quote);
      } else if (block.type === "hr") {
        parent.append(doc.createElement("hr"));
      } else if (block.type === "table") {
        const wrapper = doc.createElement("div");
        wrapper.className = "md-table";
        const table = doc.createElement("table");
        const head = doc.createElement("thead");
        const headRow = doc.createElement("tr");
        for (const cell of block.head) {
          const th = doc.createElement("th");
          appendInline(th, cell, doc);
          headRow.append(th);
        }
        head.append(headRow);
        table.append(head);
        const body = doc.createElement("tbody");
        for (const row of block.rows) {
          const tr = doc.createElement("tr");
          for (let column = 0; column < block.head.length; column += 1) {
            const td = doc.createElement("td");
            appendInline(td, row[column] === undefined ? "" : row[column], doc);
            tr.append(td);
          }
          body.append(tr);
        }
        table.append(body);
        wrapper.append(table);
        parent.append(wrapper);
      }
    }
  }

  function inlineParagraph(text, doc) {
    const lines = String(text).split("\n");
    const fragment = doc.createDocumentFragment();
    lines.forEach((line, index) => {
      if (index) fragment.append(doc.createElement("br"));
      appendInline(fragment, line, doc);
    });
    return fragment;
  }

  function appendInline(parent, text, doc) {
    for (const node of parseInline(text)) {
      if (node.type === "text") {
        parent.append(doc.createTextNode(node.text));
      } else if (node.type === "code") {
        const code = doc.createElement("code");
        code.textContent = node.text;
        parent.append(code);
      } else if (node.type === "strong") {
        const strong = doc.createElement("strong");
        appendInline(strong, node.text, doc);
        parent.append(strong);
      } else if (node.type === "em") {
        const em = doc.createElement("em");
        appendInline(em, node.text, doc);
        parent.append(em);
      } else if (node.type === "del") {
        const del = doc.createElement("del");
        appendInline(del, node.text, doc);
        parent.append(del);
      } else if (node.type === "link") {
        const link = doc.createElement("a");
        link.textContent = node.text;
        link.href = node.href;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        parent.append(link);
      }
    }
  }

  // Paragraphs at the top level become <p> so they get the body's spacing; a
  // fragment keeps callers from having to guess at a wrapper element.
  function render(text, doc) {
    const document_ = doc || (typeof document !== "undefined" ? document : null);
    if (!document_) throw new Error("render needs a document");
    const host = document_.createDocumentFragment();
    const blocks = parse(text);
    let paragraph = null;
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      paragraph = document_.createElement("p");
      paragraph.append(inlineParagraph(buffer.join("\n"), document_));
      host.append(paragraph);
      buffer = [];
    };
    for (const block of blocks) {
      if (block.type === "p") {
        buffer.push(block.text);
        continue;
      }
      flush();
      renderInto(host, [block], document_);
    }
    flush();
    return host;
  }

  return { parse, parseInline, render };
});
