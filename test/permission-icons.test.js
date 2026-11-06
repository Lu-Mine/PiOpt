"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const motion = require("../features/appearance/motion.js");

test("权限模式标记跟随宿主文本变化并可清理", async () => {
  const module = await import("../renderer/permission-icons.mjs");
  let label = '全自动', value = null;
  const button = { querySelector: () => ({ textContent: label }), getAttribute: () => value,
    hasAttribute: () => value !== null, setAttribute: (_, next) => { value = next; }, removeAttribute: () => { value = null; } };
  const previous = global.document;
  global.document = { querySelectorAll: () => [button] };
  try {
    for (const [text, expected] of [['全自动', 'auto'], ['允许编辑', 'edit'], ['每次询问', 'ask'], ['Auto', 'auto'], ['unknown', null]]) {
      label = text;
      module.__internals.scan();
      assert.equal(value, expected);
    }
    label = '全自动'; module.__internals.scan(); module.unmountPermissionIcons();
    assert.equal(value, null);
  } finally { global.document = previous; }
});

test("权限图标只在动效优化启用时输出尺寸", async () => {
  const enabled = motion.buildThemeCss({ override: true });
  const disabled = motion.buildThemeCss({ override: false });
  const { PERMISSION_ICON_CSS } = await import('../renderer/permission-icons.mjs');
  for (const mode of ['ask', 'edit', 'auto']) assert.ok(PERMISSION_ICON_CSS.includes(`data-piopt-permission-icon="${mode}"`));
  assert.ok(enabled.includes('--piopt-permission-icon-size:14px'));
  assert.ok(!disabled.includes('--piopt-permission-icon-size'));
});
