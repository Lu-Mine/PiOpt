"use strict";

/**
 * Behavior feature: one rail row, nothing behind it yet.
 *
 * It exists so the console reads in the order the user works in — 外观 / 行为 /
 * AI 网关 / 插件市场 — and so whatever behaviour work comes next has an owner of
 * its own instead of growing inside appearance. The view is deliberately empty:
 * no commands, no agent tools, no panel channels until something real lands here,
 * and the unrouted channel below is what keeps that promise honest.
 */

async function onLoad() {
  /* no commands, tools or processes yet */
}

async function onUnload() {
  /* nothing to release */
}

async function onPanelInvoke(channel) {
  throw new Error(`Unsupported panel action: ${channel}`);
}

module.exports = { onLoad, onUnload, onPanelInvoke };
