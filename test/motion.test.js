"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CSS_LIMIT_BYTES,
  DEFAULT_CONFIG,
  PRESETS,
  buildPreviewCss,
  buildThemeCss,
  motionTokens,
  normalizeConfig,
  resolveBase,
} = require("../features/motion/motion.js");

test("exposes the four approved presets", () => {
  assert.deepEqual(Object.keys(PRESETS), ["agile", "balanced", "gentle", "reduced"]);
});

test("normalizes invalid values and clamps numeric ranges", () => {
  assert.deepEqual(normalizeConfig({ preset: "unknown", mode: "neon", intensity: 9, speed: 0 }), {
    ...DEFAULT_CONFIG,
    intensity: 1.5,
    speed: 0.6,
  });
  assert.equal(normalizeConfig({ intensity: "0.51", speed: "1.39", followReducedMotion: false }).intensity, 0.51);
  assert.equal(normalizeConfig({ followReducedMotion: false }).followReducedMotion, false);
});

test("speed changes durations without changing distance or scale", () => {
  const slow = motionTokens({ preset: "balanced", speed: 0.7, intensity: 1 });
  const fast = motionTokens({ preset: "balanced", speed: 1.4, intensity: 1 });
  assert.ok(slow.base > fast.base);
  assert.equal(slow.distanceMd, fast.distanceMd);
  assert.equal(slow.scaleFrom, fast.scaleFrom);
});

test("intensity changes distance and scale without changing durations", () => {
  const restrained = motionTokens({ preset: "balanced", speed: 1, intensity: 0.5 });
  const clear = motionTokens({ preset: "balanced", speed: 1, intensity: 1.25 });
  assert.equal(restrained.base, clear.base);
  assert.equal(restrained.slow, clear.slow);
  assert.ok(restrained.distanceMd < clear.distanceMd);
  assert.ok(restrained.scaleFrom > clear.scaleFrom);
});

test("reduced preset removes spatial movement and continuous motion", () => {
  const tokens = motionTokens({ preset: "reduced", intensity: 1.25, speed: 1 });
  assert.equal(tokens.distanceSm, 0);
  assert.equal(tokens.distanceMd, 0);
  assert.equal(tokens.scaleFrom, 1);
  assert.equal(tokens.continuous, false);
  const css = buildThemeCss({ preset: "reduced" }, "dark");
  assert.match(css, /\.spinner[^{}]*\{animation:none\}/);
  assert.match(css, /\.streaming-indicator[^{}]*\{animation:none/);
});

test("generates equivalent light and dark motion layers without color overrides", () => {
  const light = buildThemeCss(DEFAULT_CONFIG, "light");
  const dark = buildThemeCss(DEFAULT_CONFIG, "dark");
  assert.match(light, /Pi Modify Motion Lab: light motion layer/);
  assert.match(dark, /Pi Modify Motion Lab: dark motion layer/);
  assert.equal(light.replace("light motion layer", "dark motion layer"), dark);
  assert.doesNotMatch(light, /--ds-(?:bg|text|accent|border)/);
});

test("generated CSS includes complete reduced-motion protection", () => {
  const css = buildThemeCss(DEFAULT_CONFIG, "dark");
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /--pm-distance-md:0px/);
  assert.match(css, /--pm-scale-from:1/);
  assert.match(css, /animation:none/);
  assert.match(css, /animation-duration:80ms/);
});

test("generated CSS stays within host safety and performance boundaries", () => {
  const css = buildThemeCss({ preset: "gentle", intensity: 1.25, speed: 0.65 }, "dark");
  assert.ok(Buffer.byteLength(css, "utf8") < CSS_LIMIT_BYTES);
  assert.doesNotMatch(css, /transition\s*:\s*all/i);
  assert.doesNotMatch(css, /@import|javascript\s*:|expression\s*\(/i);
  assert.doesNotMatch(css, /url\s*\(/i);
  assert.doesNotMatch(css, /animation[^;{}]*filter|@keyframes[^{}]*filter/i);
  assert.doesNotMatch(css, /will-change/i);
});

test("preview CSS scopes tokens to the preview stage", () => {
  const css = buildPreviewCss(DEFAULT_CONFIG);
  assert.match(css, /^#motion-preview\{/);
  assert.match(css, /--pm-base:190ms/);
});

test("resolves automatic base from host appearance", () => {
  assert.equal(resolveBase("light", { base: "dark" }), "light");
  assert.equal(resolveBase("auto", { base: "light" }), "light");
  assert.equal(resolveBase("auto", { theme: "dark" }), "dark");
  assert.equal(resolveBase("auto", {}), "dark");
});
