// PiOpt — the chat composer's model popup, rewritten inside the host window.
//
// PI-Desktop 0.22 的浮窗改成「左侧来源栏 + 右侧单组分页」：左栏一行一个供应商，
// 右边一次只渲染那一组，点一下才换一组；分组标题平常也不渲染。原来那种「所有模型
// 一张列表」的用法就没了。这个模块把那份列表拿回来：
//
//   1. 打开浮窗时（内容还藏着），顺着左栏把每一组都点一遍，把每一组的模型连同
//      徽标、上下文读数、选中态一起读出来，拼成一份完整清单，按左栏的顺序缓存；
//   2. 左栏与原生分页整体让位，用读到的清单自建一份视图：
//      · 按默认：左栏顺序原样平铺，一行不重排，也不分组；
//      · 按供应商 / 按厂商：分组与组内都按 A–Z；
//      · 按名称：全部模型平铺成一份按显示名称排序的列表；
//      · 平铺时每行下面另起一行淡色的来源（没有分组抬头，没人写着它属于谁）；
//   3. 点自建行时先切回它所属的分组，再点那枚原生按钮 —— 选中模型仍然完全由宿主
//      自己的 React 逻辑完成，节点一个都没被搬动或删除。
//
// 另外两项由设置决定：选中行的那枚对勾可以换成圈住整行的圆角边框，推理强度滑杆
// 上的档位（off / minimal / low …）可以换成中文。

import { ICONS } from "./model-logos/icons.mjs";

const MENU_SELECTOR = ".composer-model-menu";
const ROOT_SELECTOR = ".composer-menu-root";
const BODY_SELECTOR = ".composer-model-body";
const LIST_SELECTOR = ".composer-model-list";
const PANE_SELECTOR = ".composer-model-pane";
const RAIL_SELECTOR = ".composer-model-rail";
const RAIL_ITEM_SELECTOR = ".composer-model-rail-item";
const RAIL_LABEL_SELECTOR = ".composer-model-rail-label";
const RAIL_COUNT_SELECTOR = ".composer-model-rail-count";
const GROUP_SELECTOR = ".composer-model-group";
const GROUP_LABEL_SELECTOR = ".composer-model-group-label";
const OPTION_SELECTOR = ".composer-model-option";
const OPTION_PROVIDER_SELECTOR = ".composer-model-option-provider";
const CHECK_SLOT_SELECTOR = ".composer-model-check-slot";
const META_SELECTOR = ".composer-model-option-meta";
const LABEL_SELECTOR = ".composer-model-label";
const SEARCH_SELECTOR = ".composer-model-search";
const SEARCH_INPUT_SELECTOR = ".composer-model-search input";
const EMPTY_SELECTOR = ".composer-model-empty";
const READY_ATTR = "data-piopt-mp-ready";
const VIEW_CLASS = "piopt-mp-view";
const MODES_CLASS = "piopt-mp-modes";
const MODE_CLASS = "piopt-mp-mode";
const GROUP_TITLE_CLASS = "piopt-mp-group-title";
const MODE_ATTR = "data-piopt-mp-mode";
const SEARCH_ATTR = "data-piopt-mp-searching";
const EXPANDED_ATTR = "data-piopt-mp-expanded";
const LAYOUT_ATTR = "data-piopt-mp-layout";
const PROVIDER_ATTR = "data-piopt-mp-provider";
const ITEM_ATTR = "data-piopt-mp-item";
const PROBING_ATTR = "data-piopt-mp-probing";
// 选中标记：挂在浮窗上，`frame` 时样式不画对勾、改用一圈圆角矩形边框框住选中行。
const MARKER_ATTR = "data-piopt-mp-marker";
const THINKING_SLIDER_SELECTOR = ".composer-thinking-slider";
const THINKING_TICK_SELECTOR = ".composer-thinking-tick";
const THINKING_RANGE_SELECTOR = ".composer-thinking-range";
// 档位的原文写回这个属性：宿主重渲染之后还能认出这一格是哪一档。
const LEVEL_ATTR = "data-piopt-mp-level";
// 推理强度的中文开关：`zh` 时那一排刻度先藏起来，译完再放出来。观察者回调虽然
// 早于绘制，但滑杆是宿主自己后渲染的，藏一下最稳妥，不会先闪一帧英文。
const LEVELS_ATTR = "data-piopt-mp-levels";
// 发送键左边那枚思考 chip：档位文字在浮窗外面，要单独盯着。
const CHIP_SELECTOR = ".composer-model-thinking-chip";
const CHIP_LEVEL_SELECTOR = ".composer-model-thinking-level";
// 完整清单（含每行的徽标与上下文读数、选中态）按左栏指纹整份缓存：宿主的分页
// 一次只给一组，每次打开都全点一遍太贵。
const ROWS_STORAGE_KEY = "piopt.modelPicker.rows.v1";
const DEFAULT_GROUPING = "provider";
// `default` 是宿主自己的顺序：一个平铺列表，行序一行不动，也不分组。其余三种都重排。
// 按钮的先后就是这里的先后。
const GROUPINGS = ["default", "provider", "vendor", "name"];
// 点一次左栏、等一下宿主的渲染；最多等这么久，超时就按现状继续。
const SECTION_TIMEOUT_MS = 400;
const SYNC_DELAY_MS = 40;
// 宿主的勾是一枚 lucide check（13px）。读不到时用这一枚顶上，形状与它一致。
const CHECK_FALLBACK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="composer-model-check" '
  + 'aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

// 四种排列方式的名字：宿主界面跟随 locale，这里也跟随。
const COPY = {
  zh: { modes: "排列方式", default: "默认", provider: "供应商", vendor: "厂商", name: "名称" },
  en: { modes: "Arrange by", default: "Default", provider: "Provider", vendor: "Vendor", name: "Name" },
};

// 推理强度档位：宿主把档位原名直接写在滑杆的刻度与思考 chip 上（off / minimal /
// low …），中文界面里这几个词混在中文标签中间不好读。`omit` 是「不发送这个参数、
// 由模型自己决定」，中文写成「默认」。
const LEVEL_COPY = {
  off: "关闭",
  omit: "默认",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

// Injected with the entry stylesheet. Every rule is scoped to a menu this module
// has already touched, so an untouched popup keeps the host's own look.
export const MODEL_PICKER_CSS = [
  /* 读各组的时候把内容藏起来（布局不动，浮窗坐标不抖）。 */
  `.composer-model-menu:not([${READY_ATTR}="true"]):not([data-pm-ghost]){opacity:0!important;visibility:hidden!important;pointer-events:none!important;animation:none!important;transition:none!important}`,
  `.composer-model-menu[${READY_ATTR}="true"]{transform-origin:100% 100%;transition:none!important}`,
  `.composer-model-menu[${PROBING_ATTR}]{opacity:0!important;visibility:hidden!important;transition:none!important;animation:none!important}`,
  `.composer-model-menu[${PROBING_ATTR}] .composer-menu-root{visibility:hidden}`,
  /* 左栏是按分组翻页的入口，自建视图一次列出全部：栏与它的分页一起让位。
     宿主在有左栏时把菜单放宽到 420px、列表固定 264px 高，这里收回原来的宽度。 */
  `.composer-model-menu[${EXPANDED_ATTR}] .composer-model-rail{display:none}`,
  `.composer-model-menu[${EXPANDED_ATTR}] .composer-model-body[data-rail]{display:block}`,
  `.composer-model-menu[${EXPANDED_ATTR}] .composer-model-body[data-rail] .composer-model-list{height:auto;padding-left:0}`,
  `.composer-model-menu[${EXPANDED_ATTR}].has-rail{width:min(320px,100vw - 24px)}`,
  /* 原生列表让位给自建视图；搜索时反过来（搜索结果由宿主自己筛）。 */
  `.composer-model-menu[${EXPANDED_ATTR}]:not([${SEARCH_ATTR}="true"]) .composer-model-list:has(>.${VIEW_CLASS}) > *:not(.${VIEW_CLASS}){display:none}`,
  `.composer-model-menu[${EXPANDED_ATTR}][${SEARCH_ATTR}="true"] .${VIEW_CLASS}{display:none}`,
  /* 分组标题平常不压底色：滚动到上面时就是普通的一行小标题。吸顶到列表顶部后，
     滚过去的模型行会从标题底下穿过去，两层文字叠在一起看不见。这时只给文字本身
     罩一枚圆角小块（scroll-state 容器查询），既挡掉压字，又不会拉一条整行的色带。 */
  `.composer-model-menu[${EXPANDED_ATTR}] .${VIEW_CLASS} .composer-model-group-label{background:transparent;background-image:none;-webkit-backdrop-filter:none;backdrop-filter:none;container-type:scroll-state}`,
  `.${VIEW_CLASS} .${GROUP_TITLE_CLASS}{display:inline-block;padding:2px 6px;margin:-2px -6px;border-radius:6px}`,
  `@container scroll-state(stuck: top){.${GROUP_TITLE_CLASS}{background:color-mix(in oklab,var(--ds-bg-elevated-opaque) 96%,transparent);-webkit-backdrop-filter:saturate(1.4) blur(20px);backdrop-filter:saturate(1.4) blur(20px);box-shadow:0 1px 2px color-mix(in oklab,#000000 30%,transparent),0 8px 18px -6px color-mix(in oklab,#000000 42%,transparent)}}`,
  /* 搜索框下面单独一条：四种排列方式，点哪个是哪个。 */
  `.composer-model-menu[${EXPANDED_ATTR}] .${MODES_CLASS}{display:flex;gap:2px;margin:0 3px 6px;padding:2px;border-radius:var(--radius-full);background:color-mix(in oklab,var(--ds-text-primary) 6%,transparent)}`,
  `.composer-model-menu[${EXPANDED_ATTR}] .${MODE_CLASS}{flex:1 1 0;min-width:0;height:20px;padding:0 6px;border:0;border-radius:var(--radius-full);background:transparent;color:var(--ds-text-muted);font:inherit;font-size:var(--text-xs);line-height:1;white-space:nowrap;cursor:pointer;transition:color var(--motion-duration-fast) var(--motion-ease-out),background var(--motion-duration-fast) var(--motion-ease-out)}`,
  `.composer-model-menu[${EXPANDED_ATTR}] .${MODE_CLASS}:hover{color:var(--ds-text-primary);background:color-mix(in oklab,var(--ds-text-primary) 8%,transparent)}`,
  `.composer-model-menu[${EXPANDED_ATTR}] .${MODE_CLASS}[aria-pressed="true"]{background:color-mix(in oklab,var(--ds-text-primary) 15%,transparent);color:var(--ds-text-primary)}`,
  `.composer-model-menu[${EXPANDED_ATTR}] .${MODE_CLASS}:focus-visible{outline:2px solid color-mix(in oklab,var(--ds-focus) 55%,transparent);outline-offset:1px}`,
  /* 搜索框仍要能让输入框收缩。 */
  `.composer-model-menu[${EXPANDED_ATTR}] .composer-model-search input{flex:1 1 auto;min-width:0}`,
  /* 图标与名称贴在一起；认不出品牌时用供应商首字母色块补位。 */
  `.${VIEW_CLASS} .composer-model-option-main{align-items:center}`,
  `.piopt-mp-lead{display:flex;align-items:center;gap:6px;min-width:0}`,
  `.piopt-mp-lead .composer-model-label{flex:0 1 auto;min-width:0}`,
  `.piopt-mp-logo{flex:none;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;color:inherit}`,
  `.piopt-mp-logo svg{width:14px;height:14px;display:block}`,
  `.piopt-mp-logo-letter{border-radius:4px;background:color-mix(in oklab,var(--piopt-logo) 22%,transparent);color:var(--piopt-logo);font-size:9px;font-weight:600;line-height:1}`,
  /* 来源：平铺列表没有分组抬头写着供应商，所以每一行都在名称后面跟一枚淡色小字。
     它跟着名称走、宽度不够就省略，不另起一行 —— 每行两行字会让整份列表又高又挤，
     剩下的空间也会被挤压成看不出层级的一团。 */
  `.piopt-mp-source{flex:0 1 auto;min-width:0;max-width:42%;color:var(--ds-text-faint);font-size:var(--text-2xs);line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
  /* 选中标记：默认还是宿主那枚对勾。换成圆角框时把勾藏掉，改用一圈 2px 内描边
     框住这整行 —— 描边画在行里，圆角由宿主自己给，行高、内边距与滚动位置一律不动。
     勾位（composer-model-check-slot）留在原处，行宽不因此跳动。 */
  `.composer-model-menu[${MARKER_ATTR}="frame"] .composer-model-option[aria-checked="true"]{box-shadow:inset 0 0 0 2px color-mix(in oklab,var(--ds-accent) 64%,transparent)}`,
  `.composer-model-menu[${MARKER_ATTR}="frame"] .composer-model-option[aria-checked="true"] ${CHECK_SLOT_SELECTOR} svg{display:none}`,
  /* 方向键的高亮抄在自建行上：宿主那个类只管它自己那几行，这里同款即可。 */
  `.${VIEW_CLASS} .composer-model-option.kb-active{background:var(--ds-bg-hover)}`,
  /* 推理强度的刻度：中文开关打开时，还没写回原文属性的刻度先不显示 —— 那一排本来
     就是 aria-hidden 的装饰，藏一帧比露出半帧英文好；译完即刻可见。 */
  `.composer-model-menu[${LEVELS_ATTR}="zh"] .composer-thinking-tick:not([${LEVEL_ATTR}]){visibility:hidden}`,
  `.${VIEW_CLASS}[data-piopt-mp-switch="true"]{animation:piopt-mp-switch var(--pm-fast,135ms) var(--pm-ease-symmetric,cubic-bezier(.22,1,.36,1)) backwards}`,
  `@keyframes piopt-mp-switch{from{opacity:.65}to{opacity:1}}`,
].join("\n");

let host = null;
let grouping = DEFAULT_GROUPING;
// 两项开关的当前值：选中标记用圆角框，推理强度档位用中文。
let frameSelected = false;
let translateThinking = false;
let menu = null;
let bodyObserver = null;
let listObserver = null;
let syncTimer = null;
let building = false;
let collecting = false;
let animateNextView = false;
// 方向键停在哪个模型上（自建视图里的行走的是自己的高亮）。
let highlightKey = null;
// 完整清单：{ signature, check, rows: [{ key, provider, modelId, label, alias, meta, active }] }
let rowsStore = null;

function findLiveMenu() {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return null;
  for (const el of document.querySelectorAll(MENU_SELECTOR)) {
    if (typeof el.getAttribute === "function" && el.getAttribute("data-pm-ghost") === "true") continue;
    return el;
  }
  return null;
}

// The collator is the only locale-aware piece: 模型名多是英文，但排序要和界面的
// 中文语境一致，所以让平台自己决定语言，数字按数而不是按字符比较（`gpt-4` 在
// `gpt-10` 前面）。
const collator = typeof Intl === "object" && typeof Intl.Collator === "function"
  ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
  : null;

// ------------------------------------------------------------------- helpers

function textOf(element) {
  return element && typeof element.textContent === "string" ? element.textContent.trim() : "";
}

function isElement(node) {
  return Boolean(node) && node.nodeType === 1;
}

function closestOf(node, selector) {
  return isElement(node) && typeof node.closest === "function" ? node.closest(selector) : null;
}

function childByClass(parent, className) {
  if (!parent) return null;
  for (const child of parent.children) {
    if (child.classList && child.classList.contains(className)) return child;
  }
  return null;
}

/**
 * 我们自己挂/摘的节点（自建视图、切换按钮）。
 *
 * 观察者盯着整个浮窗，这两个节点的增删也必须忽略，否则一次重建会引出下一次重建。
 */
function isOurs(record) {
  if (record.type !== "childList") return false;
  const nodes = [...record.addedNodes, ...record.removedNodes];
  if (!nodes.length) return false;
  return nodes.every((node) => isElement(node)
    && node.classList
    && (node.classList.contains(VIEW_CLASS) || node.classList.contains(MODES_CLASS)));
}

/**
 * A–Z（含数字感知）比较两个名字：分组名与模型名都用它。
 *
 * 拉丁字母在前、中文在后：模型名几乎都是英文，供应商里则可能混着「腾讯混元」这种
 * 中文名，混在一起按拼音排会让人找不到 A–Z 的起点。中文之间仍按平台的语言排序。
 */
function compareNames(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  const aCjk = /[\u3400-\u9fff]/.test(a);
  const bCjk = /[\u3400-\u9fff]/.test(b);
  if (aCjk !== bCjk) return aCjk ? 1 : -1;
  if (collator) return collator.compare(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRows(left, right) {
  const byLabel = compareNames(left.label, right.label);
  if (byLabel !== 0) return byLabel;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

// ----------------------------------------------------------------- 读取宿主

function paneOf(list) {
  return list ? list.querySelector(PANE_SELECTOR) || list : null;
}

/**
 * 一个原生分组里的一行。
 *
 * 身份是「供应商␟模型 id」：供应商来自分组自己的 aria-label（宿主给的是它显示
 * 在分组抬头上的那个名字），模型 id 来自按钮的 title。同一个模型只出现一次 ——
 * 「最近使用」那一组是宿主从各分组里挑出来另画的，它的 provider 只写在行内，
 * 这一组整组都不收（各分组的清单里本来就有它们）。
 */
function toRow(option, provider) {
  const title = String(option.getAttribute("title") || "").trim();
  const labelElement = option.querySelector(LABEL_SELECTOR);
  const label = textOf(labelElement) || title;
  const modelId = title || label;
  const meta = option.querySelector(META_SELECTOR);
  return {
    key: `${provider}\u001f${modelId.toLowerCase()}`,
    provider,
    modelId,
    label,
    alias: Boolean(labelElement && labelElement.classList && labelElement.classList.contains("is-alias")),
    meta: meta ? meta.innerHTML : "",
    active: option.getAttribute("aria-checked") === "true",
  };
}

/** 当前渲染出来的那几个分组里的行（分页一次只有一组）。 */
function readGroups(list) {
  const pane = paneOf(list);
  const rows = [];
  if (!pane) return rows;
  for (const group of pane.children) {
    if (!group.classList || !group.classList.contains("composer-model-group")) continue;
    const options = [...group.querySelectorAll(OPTION_SELECTOR)];
    if (!options.length) continue;
    // 「最近使用」那一组的每一行都写着来源，跳过：它的模型在各自分组里都有。
    if (options.some((option) => option.querySelector(OPTION_PROVIDER_SELECTOR))) continue;
    const provider = String(group.getAttribute("aria-label") || textOf(group.querySelector(GROUP_LABEL_SELECTOR)) || "").trim();
    for (const option of options) rows.push(toRow(option, provider));
  }
  return rows;
}

/** 当前这一组叫什么名字；停在「最近使用」上时是空串。 */
function currentSectionName(list) {
  const pane = paneOf(list);
  if (!pane) return "";
  for (const group of pane.children) {
    if (!group.classList || !group.classList.contains("composer-model-group")) continue;
    if (group.querySelector(OPTION_PROVIDER_SELECTOR)) continue;
    return String(group.getAttribute("aria-label") || textOf(group.querySelector(GROUP_LABEL_SELECTOR)) || "").trim();
  }
  return "";
}

function railOf(list) {
  const body = closestOf(list, BODY_SELECTOR) || (list ? list.parentElement : null);
  return body ? body.querySelector(RAIL_SELECTOR) : null;
}

function sectionNameOf(railItem) {
  return textOf(railItem.querySelector(RAIL_LABEL_SELECTOR))
    || String(railItem.getAttribute("title") || "").trim();
}

/**
 * 左栏里可点的那几格。
 *
 * 「最近使用」那一格没有计数（宿主只给供应商分组画 count），它不是一组供应商，
 * 点它读不到新的模型。宿主哪天不给供应商画数字了，就退回到整条栏。
 */
function providerRailItems(rail) {
  if (!rail) return [];
  const items = [...rail.querySelectorAll(RAIL_ITEM_SELECTOR)];
  const providers = items.filter((item) => item.querySelector(RAIL_COUNT_SELECTOR));
  return providers.length ? providers : items;
}

/**
 * 左栏的指纹：分组名 + 每组模型数。
 *
 * 加、删模型或供应商，这份指纹就变了，缓存的清单要重读一遍；只是换了顺序的话它
 * 看不出来，所以每次同步还会拿当前这一组和缓存比一比（见 sectionStale）。
 */
function railSignature(list) {
  const items = providerRailItems(railOf(list));
  if (!items.length) return "single";
  return items
    .map((item) => `${sectionNameOf(item)}:${textOf(item.querySelector(RAIL_COUNT_SELECTOR))}`)
    .join("|");
}

/** 宿主那枚勾（13px，带动画路径）。读不到就用自带的那一枚。 */
function grabCheck(list) {
  const pane = paneOf(list);
  if (!pane) return "";
  for (const slot of pane.querySelectorAll(CHECK_SLOT_SELECTOR)) {
    const html = slot.innerHTML.trim();
    if (html) return html;
  }
  return "";
}

/**
 * 当前这一格画出来的内容：分组名 + 行序。
 *
 * 点一次左栏之后它一定会变，用它判断宿主的下一格已经画好了 —— 比读分组名可靠：
 * 「最近使用」那一格没有供应商名。
 */
function paneSignature(list) {
  const pane = paneOf(list);
  if (!pane) return "";
  return [...pane.querySelectorAll(`${GROUP_SELECTOR}, ${OPTION_SELECTOR}`)]
    .map((node) => (node.classList && node.classList.contains("composer-model-group")
      ? `g:${node.getAttribute("aria-label") || ""}`
      : `o:${node.getAttribute("title") || ""}`))
    .join("|");
}

/** 用户在搜索框里打字了：这时别去点左栏，换一格会把刚写的查询清掉。 */
function searching(list) {
  const menuElement = closestOf(list, MENU_SELECTOR);
  const input = menuElement ? menuElement.querySelector(SEARCH_INPUT_SELECTOR) : null;
  return Boolean(input && String(input.value || "").trim());
}

/**
 * 等宿主把下一组画出来：DOM 一变就回来，最多等 ms。用 MutationObserver 而不是
 * 固定的 setTimeout —— 后台窗口会把定时器压到 1s，等待就白等了。
 */
function waitFor(predicate, ms = SECTION_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    let observer = null;
    let timer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      resolve(ok);
    };
    if (predicate()) {
      finish(true);
      return;
    }
    if (typeof MutationObserver === "function" && menu) {
      observer = new MutationObserver(() => {
        if (predicate()) finish(true);
      });
      observer.observe(menu, { childList: true, subtree: true, characterData: true });
    }
    timer = window.setTimeout(() => finish(predicate()), ms);
  });
}

/** 左栏当前的每一格（含「最近使用」）。宿主可能连整条栏一起重画，所以每次现查。 */
function railItems(list) {
  const rail = railOf(list);
  return rail ? [...rail.querySelectorAll(RAIL_ITEM_SELECTOR)] : [];
}

/**
 * 顺着左栏把每一组的模型都读出来。
 *
 * 每组点一下、等它渲染、读一遍；读完再把左栏切回原来停着的那一格，用户看到的分页
 * 位置因此没有变化。手里的节点不能存着用 —— 宿主重画左栏时它们就不在文档里了。
 */
async function collectAll(list) {
  const signature = railSignature(list);
  const names = providerRailItems(railOf(list)).map(sectionNameOf).filter(Boolean);
  if (!names.length) {
    const rows = readGroups(list);
    return { signature, check: grabCheck(list), rows };
  }
  const activeIndex = railItems(list).findIndex((item) => item.classList.contains("active"));
  const rows = [];
  const seen = new Set();
  let check = "";
  for (const name of names) {
    // 用户自己开始打字了就别再翻页，别把输入抢走。
    if (searching(list)) break;
    const item = railItems(list).find((candidate) => sectionNameOf(candidate) === name
      && candidate.querySelector(RAIL_COUNT_SELECTOR));
    if (!item || typeof item.click !== "function") continue;
    if (!item.classList.contains("active")) {
      const before = paneSignature(list);
      item.click();
      await waitFor(() => paneSignature(list) !== before);
    }
    check = check || grabCheck(list);
    for (const row of readGroups(list)) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      rows.push(row);
    }
  }
  if (activeIndex >= 0) {
    const back = railItems(list)[activeIndex];
    if (back && !back.classList.contains("active") && typeof back.click === "function") {
      const before = paneSignature(list);
      back.click();
      await waitFor(() => paneSignature(list) !== before);
    }
  }
  return { signature, check, rows };
}

// ------------------------------------------------------------- 缓存的清单

function normalizeRows(input) {
  if (!input || typeof input !== "object") return null;
  if (typeof input.signature !== "string" || !Array.isArray(input.rows)) return null;
  const rows = [];
  for (const row of input.rows) {
    if (!row || typeof row.key !== "string" || typeof row.modelId !== "string") continue;
    rows.push({
      key: row.key,
      provider: String(row.provider || ""),
      modelId: row.modelId,
      label: String(row.label || row.modelId),
      alias: row.alias === true,
      meta: typeof row.meta === "string" ? row.meta : "",
      active: row.active === true,
    });
  }
  return { signature: input.signature, check: typeof input.check === "string" ? input.check : "", rows };
}

function loadRows() {
  if (rowsStore) return rowsStore;
  try {
    const raw = window.localStorage.getItem(ROWS_STORAGE_KEY);
    rowsStore = raw ? normalizeRows(JSON.parse(raw)) : null;
  } catch {
    // 隐私模式或坏数据：这一份就只在内存里。
    rowsStore = null;
  }
  return rowsStore;
}

function saveRows() {
  if (!rowsStore) return;
  try {
    window.localStorage.setItem(ROWS_STORAGE_KEY, JSON.stringify({
      signature: rowsStore.signature,
      check: rowsStore.check,
      rows: rowsStore.rows.map(({ key, provider, modelId, label, alias, meta, active }) => ({
        key, provider, modelId, label, alias, meta, active,
      })),
    }));
  } catch {
    // 存不进去不影响这一次显示。
  }
}

/** 当前这一组的行序与缓存对不上（改了顺序、换了模型）时重读一遍。 */
function sectionStale(list) {
  if (!rowsStore) return true;
  const current = readGroups(list);
  if (!current.length) return false;
  const provider = current[0].provider;
  const cached = rowsStore.rows.filter((row) => row.provider === provider).map((row) => row.modelId);
  if (!cached.length) return true;
  return cached.join("|") !== current.map((row) => row.modelId).join("|");
}

function needsCollect(list) {
  const stored = loadRows();
  if (!stored || !stored.rows.length) return true;
  if (stored.signature !== railSignature(list)) return true;
  return sectionStale(list);
}

/** 当前选中是哪一行：宿主这会儿画出来的那组是准的，读不到就用缓存里的。 */
function adoptSelection(list) {
  if (!rowsStore) return;
  const pane = paneOf(list);
  if (!pane) return;
  for (const option of pane.querySelectorAll(OPTION_SELECTOR)) {
    if (option.getAttribute("aria-checked") !== "true") continue;
    const title = String(option.getAttribute("title") || "").trim();
    if (!title) continue;
    // 「最近使用」那一行把来源写在行内；供应商分组里则是分组抬头写着它。
    const providerLabel = option.querySelector(OPTION_PROVIDER_SELECTOR);
    const group = closestOf(option, GROUP_SELECTOR);
    const provider = (providerLabel
      ? textOf(providerLabel)
      : String((group && group.getAttribute("aria-label")) || "")).trim();
    const key = `${provider}\u001f${title.toLowerCase()}`;
    const row = rowsStore.rows.find((item) => item.key === key)
      || rowsStore.rows.find((item) => item.modelId === title);
    if (!row || row.active) return;
    for (const item of rowsStore.rows) item.active = item === row;
    if (highlightKey === null) highlightKey = row.key;
    return;
  }
}

function selectedKey() {
  const row = rowsStore ? rowsStore.rows.find((item) => item.active) : null;
  return row ? row.key : null;
}

function rowByKey(key) {
  return rowsStore ? rowsStore.rows.find((row) => row.key === key) : null;
}

function checkMarkup() {
  return (rowsStore && rowsStore.check) || CHECK_FALLBACK;
}

// ---------------------------------------------------------------------- icons

/**
 * 品牌匹配表。
 *
 * 先拿模型名与模型 id 去比，再拿供应商名比：OpenRouter、Azure 这类转售商下面跑
 * 的仍是谁家的模型就显示谁家的标。匹配不到时退回首字母色块，所以没上表的新模型
 * 或新服务也不会空着 —— 名字里带 `claude`、`gpt`、`glm` 之类的新版本照样命中。
 */
const FAMILIES = [
  // Claude 用自家那朵菊花：名字里带 claude / sonnet / opus / haiku 的都先吃它，
  // Anthropic 的 A 标只在「供应商是 Anthropic、模型名又完全认不出」时兜底。
  { icon: "claude", label: "Anthropic", test: /claude|sonnet|opus|haiku|克劳德/i },
  { icon: "anthropic", label: "Anthropic", test: /anthropic/i },
  { icon: "openai", label: "OpenAI", test: /openai|chatgpt|\bgpt\b|gpt-\d|codex|davinci|(?:^|[^a-z])o[1-9](?:[^0-9]|$)/i },
  { icon: "gemini", label: "Google", test: /gemini|gemma|bard|palm|google|谷歌/i },
  { icon: "xai", label: "xAI", test: /grok|xai/i },
  { icon: "deepseek", label: "DeepSeek", test: /deepseek|深度求索/i },
  { icon: "zhipu", label: "Zhipu AI", test: /glm|zhipu|chatglm|bigmodel|智谱|清言/i },
  { icon: "qwen", label: "Alibaba", test: /qwen|qwq|tongyi|dashscope|alibaba|通义|千问|阿里/i },
  { icon: "kimi", label: "Moonshot AI", test: /kimi|moonshot|月之暗面/i },
  { icon: "minimax", label: "MiniMax", test: /minimax|abab|hailuo|海螺/i },
  { icon: "mistral", label: "Mistral", test: /mistral|mixtral|codestral|pixtral|magistral|devstral/i },
  { icon: "meta", label: "Meta", test: /llama|\bmeta\b/i },
  { icon: "cohere", label: "Cohere", test: /cohere|command-r/i },
  { icon: "openrouter", label: "OpenRouter", test: /openrouter/i },
  { icon: "together", label: "Together AI", test: /together/i },
  { icon: "perplexity", label: "Perplexity", test: /perplexity|sonar/i },
  { icon: "doubao", label: "ByteDance", test: /doubao|bytedance|seedream|seed-?edit|豆包|字节/i },
  { icon: "baidu", label: "Baidu", test: /ernie|wenxin|baidu|文心|千帆|百度/i },
  // 混元是那颗蓝球；中文供应商名（腾讯混元）也要能认出来。
  { icon: "hunyuan", label: "Tencent", test: /hunyuan|tencent|混元|腾讯/i },
  { icon: "stepfun", label: "StepFun", test: /stepfun|step-\d|阶跃/i },
  { icon: "huggingface", label: "Hugging Face", test: /huggingface|hf\.co/i },
  { icon: "nvidia", label: "NVIDIA", test: /nvidia|nemotron|英伟达/i },
  { icon: "yi", label: "01.AI", test: /(?:^|[^a-z])yi(?:-|\b)|01\.ai|lingyi|零一/i },
  { icon: "cerebras", label: "Cerebras", test: /cerebras/i },
  { icon: "azure", label: "Azure", test: /azure/i },
  { icon: "aws", label: "AWS", test: /bedrock|\baws\b/i },
  { icon: "ollama", label: "Ollama", test: /ollama/i },
];

// 认不出来的服务用首字母色块，颜色从这一组里按名字取，明暗两种主题下都够醒目。
const LETTER_COLORS = ["#5B8DEF", "#D97757", "#10A37F", "#A855F7", "#F59E0B", "#EC4899", "#14B8A6", "#8B5CF6"];

/**
 * 这个模型属于哪一家厂商。
 *
 * 先看模型名与 id（OpenRouter 上的 claude 也算 Anthropic），再看供应商名；都认不
 * 出来就把它算在供应商名下 —— 自建服务也有一个能排序的分组。
 */
function familyOf(row) {
  const model = `${row.label} ${row.modelId}`.toLowerCase();
  const provider = String(row.provider || "").toLowerCase();
  for (const family of FAMILIES) if (family.test.test(model)) return family;
  for (const family of FAMILIES) if (family.test.test(provider)) return family;
  return null;
}

function iconIdFor(row) {
  const family = familyOf(row);
  return family ? family.icon : "";
}

function vendorOf(row) {
  const family = familyOf(row);
  return family ? family.label : (row.provider || row.label);
}

function letterColor(text) {
  let hash = 0;
  for (const character of String(text)) hash = (hash * 31 + character.codePointAt(0)) | 0;
  return LETTER_COLORS[Math.abs(hash) % LETTER_COLORS.length];
}

function initialOf(text) {
  const match = /[a-z0-9\u4e00-\u9fa5]/i.exec(String(text || "").trim());
  return match ? match[0].toUpperCase() : "?";
}

/** 一行前面那枚 14px 的标：认得出品牌就画彩色图标，认不出就画供应商首字母。 */
function buildLogo(row) {
  const logo = document.createElement("span");
  logo.className = "piopt-mp-logo";
  logo.setAttribute("aria-hidden", "true");
  const icon = iconIdFor(row);
  const svg = icon ? ICONS[icon] : "";
  if (svg) {
    logo.innerHTML = svg;
    return logo;
  }
  const source = row.provider || row.label;
  logo.classList.add("piopt-mp-logo-letter");
  logo.style.setProperty("--piopt-logo", letterColor(source));
  logo.textContent = initialOf(source);
  return logo;
}

// ------------------------------------------------------------------- rendering

/**
 * 一行自建选项。
 *
 * 结构与宿主那一行一模一样（同样是 `.composer-model-option` 里的 main、meta 与
 * 勾位），所以宿主的行高、字号、徽标、勾动画全都照旧生效；只有内容来自缓存里的
 * 那一份 —— 它属于哪一组与当前停在哪儿无关。
 */
function buildRow(row, showSource) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "composer-plus-item composer-model-option";
  item.setAttribute("role", "menuitemradio");
  item.setAttribute("aria-checked", String(row.active === true));
  item.setAttribute(ITEM_ATTR, row.key);
  // 宿主的行把模型 id 写在 title 上，这里也留着：它是这一行的身份。
  item.setAttribute("title", row.modelId);
  if (row.active) item.classList.add("active");

  const main = document.createElement("span");
  main.className = "composer-model-option-main";

  const label = document.createElement("span");
  label.className = row.alias ? "composer-model-label is-alias" : "composer-model-label";
  label.textContent = row.label;
  // 图标和名称贴在一起：宿主给 main 的列间距是 8px，直接塞进去会离得太远，
  // 所以把名称挪进一个自带 6px 间距的 lead 里。
  const lead = document.createElement("span");
  lead.className = "piopt-mp-lead";
  lead.append(buildLogo(row), label);
  main.append(lead);
  // 来源紧跟在名称后面：平铺列表里它替代分组抬头，但只占一枚小字的位置，
  // 不至于把每一条都撑成两行。
  if (showSource && row.provider) {
    const source = document.createElement("span");
    source.className = "piopt-mp-source";
    source.setAttribute(PROVIDER_ATTR, row.provider);
    source.textContent = row.provider;
    main.append(source);
  }

  if (row.meta) {
    const meta = document.createElement("span");
    meta.className = "composer-model-option-meta";
    meta.innerHTML = row.meta;
    main.append(meta);
  }

  const slot = document.createElement("span");
  slot.className = "composer-model-check-slot";
  slot.setAttribute("aria-hidden", "true");
  if (row.active) slot.innerHTML = checkMarkup();

  item.append(main, slot);
  item.addEventListener("click", (event) => {
    event.preventDefault();
    // 自建行只是原生按钮的替身：真正的点击交给原生按钮，选中模型仍然完全由宿主
    // 自己的 React 逻辑完成。
    void choose(row.key);
  });
  return item;
}

function buildGroup(label, rows, showSource) {
  const group = document.createElement("div");
  group.className = "composer-model-group";
  group.setAttribute("role", "group");
  // 宿主没有分组抬头时（列表直接就是一串按钮）不硬造一个空标题。
  if (label) {
    group.setAttribute("aria-label", label);
    const heading = document.createElement("div");
    heading.className = "composer-model-group-label";
    // 文字放在内层：吸顶时由它补一层底色挡住下面滚过去的行（容器查询只能给查询
    // 容器的后代上色，所以标题自身是容器、文字块才是那层底）。
    const title = document.createElement("span");
    title.className = GROUP_TITLE_CLASS;
    title.textContent = label;
    heading.append(title);
    group.append(heading);
  }
  for (const row of rows) group.append(buildRow(row, showSource));
  return group;
}

/**
 * 分组视图（按供应商 / 按厂商共用）：分组名与组内模型都按 A–Z 排。
 */
function groupedView(rows, keyOf) {
  const buckets = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const groups = [];
  for (const [label, bucket] of [...buckets.entries()].sort((left, right) => compareNames(left[0], right[0]))) {
    if (!bucket.length) continue;
    groups.push(buildGroup(label, bucket.slice().sort(compareRows), false));
  }
  return groups;
}

function renderView(list) {
  // 自己在原生列表里挂节点，这些改动不能反过来触发一次重建：先挂起观察者，
  // 建完把这一批记录丢掉。
  building = true;
  const previous = childByClass(list, VIEW_CLASS);
  if (previous) previous.remove();
  const rows = rowsStore ? rowsStore.rows : readGroups(list);
  const view = document.createElement("div");
  view.className = VIEW_CLASS;
  view.setAttribute(LAYOUT_ATTR, grouping);
  if (animateNextView) {
    animateNextView = false;
    view.setAttribute("data-piopt-mp-switch", "true");
    view.addEventListener("animationend", () => view.removeAttribute("data-piopt-mp-switch"), { once: true });
  }
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "composer-model-empty";
    empty.textContent = textOf(list.querySelector(EMPTY_SELECTOR));
    view.append(empty);
  } else if (grouping === "default") {
    // 左栏顺序原样平铺：不分组、也不按名字重排。这里没有分组抬头写着供应商，
    // 所以每一行都补一行淡色的来源。
    for (const row of rows) view.append(buildRow(row, true));
  } else if (grouping === "name") {
    for (const row of rows.slice().sort(compareRows)) view.append(buildRow(row, true));
  } else if (grouping === "vendor") {
    for (const group of groupedView(rows, vendorOf)) view.append(group);
  } else {
    for (const group of groupedView(rows, (row) => row.provider || row.label)) view.append(group);
  }

  list.append(view);
  if (listObserver) listObserver.takeRecords();
  building = false;
  if (highlightKey === null) highlightKey = selectedKey();
  syncHighlight(list);
}

// --------------------------------------------------------------------- switch

// 宿主把当前界面语言写在 <html lang> 上；只有中文界面用中文，其余一律用英文，
// 免得日文/德文界面里冒出一颗中文按钮。
function copyOf() {
  const lang = (document.documentElement && document.documentElement.lang) || "";
  return /^zh\b/i.test(lang) ? COPY.zh : COPY.en;
}

/*
 * 推理强度：滑杆的刻度与发送键旁的 chip 都写着宿主那套档位原名（off / minimal /
 * low / medium / high / xhigh / max，外加 omit＝不发送这个参数、由模型自己决定）。
 * 开启这一项时把它们换成中文，range 的 aria-valuetext 一起换 —— 读屏念的也是同一档。
 *
 * 原文写回 LEVEL_ATTR：宿主重渲染后（它只认自己的英文 vdom）还能认出这一格是哪一档，
 * 重复调用也就不会把中文再翻一遍。只动刻度，不动滑杆里那排装饰圆点：那些圆点是
 * aria-hidden 的，改字只会在圆点里挤出半截汉字。
 */
// 这一格当前该按哪一档算。宿主重渲染会把它自己的英文写回来，所以文本认识就是
// 新的原文；不认识说明文本是我们的译文，原文还在属性里。
function rawLevelOf(element) {
  const text = textOf(element);
  const stored = element.getAttribute(LEVEL_ATTR);
  return LEVEL_COPY[text.toLowerCase()] ? text : (stored || text);
}

function levelOf(element) {
  const raw = rawLevelOf(element);
  const label = LEVEL_COPY[raw.toLowerCase()];
  return label ? { raw, label } : null;
}

/** 把一格档位译成中文，原文写回属性（重复调用不会翻第二遍）。 */
function applyLevel(element) {
  const level = levelOf(element);
  if (!level) return false;
  if (element.getAttribute(LEVEL_ATTR) !== level.raw) element.setAttribute(LEVEL_ATTR, level.raw);
  if (textOf(element) !== level.label) element.textContent = level.label;
  return true;
}

/** 关掉这一项时把文字还给宿主：属性里存着它原来的英文。 */
function restoreLevel(element) {
  if (!element || !element.hasAttribute(LEVEL_ATTR)) return;
  const raw = element.getAttribute(LEVEL_ATTR);
  element.removeAttribute(LEVEL_ATTR);
  if (textOf(element) !== raw) element.textContent = raw;
}

function localizeThinking(menuElement) {
  if (!menuElement) return;
  const labels = [];
  for (const tick of menuElement.querySelectorAll(THINKING_TICK_SELECTOR)) {
    const raw = rawLevelOf(tick);
    const label = LEVEL_COPY[raw.toLowerCase()];
    labels.push(label || raw);
    if (!translateThinking) continue;
    // 认不出的档位也要写回原文属性：样式靠它判断「这一格处理过了」，不写就会被一直藏着。
    if (tick.getAttribute(LEVEL_ATTR) !== raw) tick.setAttribute(LEVEL_ATTR, raw);
    if (!label) continue;
    if (textOf(tick) !== label) tick.textContent = label;
    if (tick.title !== label) tick.title = label;
  }
  const range = menuElement.querySelector(THINKING_RANGE_SELECTOR);
  if (range) {
    const label = labels[Number(range.value)];
    if (label && range.getAttribute("aria-valuetext") !== label) range.setAttribute("aria-valuetext", label);
  }
  syncChip();
}

// ------------------------------------------------------ 发送键旁的思考 chip

/*
 * 档位文字不只在浮窗里：发送键左边那枚 chip 写着同一个词，它在浮窗外面，宿主每次
 * 换档都会重渲染这一小段。这里盯着**整枚 chip**（不是那枚 span）：React 换档时可能
 * 把里面的 span 整个换掉，盯 span 会盯着一个已经不在文档里的节点，之后无论怎么换档
 * 都不再有回调 —— 于是 chip 就停在英文上。盯 chip 则每次都重新取一次 span。
 *
 * 观察者回调早于绘制，所以换档的那一帧就是中文，不会先闪一下英文。
 */
let chipHost = null;
let chipObserver = null;

function syncChip() {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
  const chip = document.querySelector(CHIP_SELECTOR);
  if (!chip) {
    forgetChip();
    return;
  }
  const level = chip.querySelector(CHIP_LEVEL_SELECTOR);
  if (!translateThinking) {
    if (level) restoreLevel(level);
    return;
  }
  if (chip !== chipHost && typeof MutationObserver === "function") {
    if (chipObserver) chipObserver.disconnect();
    chipObserver = new MutationObserver(() => {
      const next = chip.querySelector(CHIP_LEVEL_SELECTOR);
      if (next) applyLevel(next);
    });
    chipObserver.observe(chip, { childList: true, characterData: true, subtree: true });
    chipHost = chip;
  }
  if (level) applyLevel(level);
}

function forgetChip() {
  if (chipObserver) {
    chipObserver.disconnect();
    chipObserver = null;
  }
  chipHost = null;
}

/** 这一批 mutation 碰的是不是推理强度滑杆（宿主也可能整块换成新的）。 */
function touchesThinking(record) {
  if (closestOf(record.target, THINKING_SLIDER_SELECTOR)) return true;
  for (const node of record.addedNodes || []) {
    if (!isElement(node)) continue;
    if (closestOf(node, THINKING_SLIDER_SELECTOR)) return true;
    if (node.classList && node.classList.contains("composer-thinking-slider")) return true;
    if (typeof node.querySelector === "function" && node.querySelector(THINKING_SLIDER_SELECTOR)) return true;
  }
  return false;
}

/**
 * 搜索框下面那条「排列方式」：默认 / 供应商 / 厂商 / 名称，点哪个是哪个。
 *
 * 它挂在宿主的 `.composer-menu-root` 里、紧跟搜索框之后 —— 在搜索框外面，输入框
 * 拿回整行宽度。React 只管它自己的子节点（搜索框、列表、思考滑杆），多出来的一条
 * 不会被它收走。
 */
function syncModes(menuElement) {
  const root = menuElement.querySelector(ROOT_SELECTOR);
  const search = menuElement.querySelector(SEARCH_SELECTOR);
  if (!root) return null;
  let bar = childByClass(root, MODES_CLASS);
  if (!bar) {
    bar = document.createElement("div");
    bar.className = MODES_CLASS;
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", copyOf().modes);
    // 紧跟在搜索框后面：在搜索框外面，输入框能拿回整行宽度。
    if (search && search.parentElement === root) search.after(bar);
    else root.prepend(bar);
  }
  const copy = copyOf();
  for (const mode of GROUPINGS) {
    let button = bar.querySelector(`[${MODE_ATTR}="${mode}"]`);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = MODE_CLASS;
      button.setAttribute(MODE_ATTR, mode);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void setGrouping(mode);
      });
      bar.append(button);
    }
    const label = copy[mode] || mode;
    button.textContent = label;
    button.title = label;
    button.setAttribute("aria-pressed", String(grouping === mode));
  }
  return bar;
}

async function setGrouping(next) {
  if (!GROUPINGS.includes(next) || next === grouping) return grouping;
  grouping = next;
  if (menu) {
    animateNextView = true;
    syncModes(menu);
    sync();
  }
  if (host && typeof host.dispatch === "function") {
    try {
      await host.dispatch("plugin.call", { method: "setModelPickerGrouping", args: { grouping: next } });
    } catch {
      // 存不进去也先把这一份用法留住：浮窗已经按新方式排好了。
    }
  }
  return grouping;
}

// ---------------------------------------------------------------------- sync

function sync() {
  const target = menu;
  if (!target || target.isConnected === false) {
    unbindMenu();
    return;
  }
  const list = target.querySelector(LIST_SELECTOR);
  if (!list) return;

  target.setAttribute(EXPANDED_ATTR, "true");
  syncModes(target);
  // 选中标记与档位文案都只影响这一个浮窗：挂在窗上，换一份设置就整块换掉。
  if (frameSelected) target.setAttribute(MARKER_ATTR, "frame");
  else target.removeAttribute(MARKER_ATTR);
  // 先挂上 `zh`，再译：还没写回原文的刻度在这段时间里是藏着的（见 MODEL_PICKER_CSS），
  // 所以看不到半帧英文。关掉时反过来，把刻度上的中文还给宿主。
  if (translateThinking) {
    target.setAttribute(LEVELS_ATTR, "zh");
    localizeThinking(target);
  } else {
    target.removeAttribute(LEVELS_ATTR);
    for (const tick of target.querySelectorAll(THINKING_TICK_SELECTOR)) restoreLevel(tick);
    syncChip();
  }

  // 搜索由宿主自己筛（它会把每个匹配的组都画出来）：一有查询就把视图让开。
  const input = target.querySelector(SEARCH_INPUT_SELECTOR);
  const query = input ? String(input.value || "").trim() : "";
  if (query) {
    target.setAttribute(SEARCH_ATTR, "true");
    return;
  }
  target.removeAttribute(SEARCH_ATTR);

  adoptSelection(list);
  renderView(list);
  if (!target.hasAttribute(PROBING_ATTR) && target.getAttribute(READY_ATTR) !== "true") {
    target.setAttribute(READY_ATTR, "true");
    // Positioning has already completed while hidden; focus only our own search input.
    target.querySelector(SEARCH_INPUT_SELECTOR)?.focus({ preventScroll: true });
  }
}

function scheduleSync() {
  if (building || syncTimer !== null) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    sync();
  }, SYNC_DELAY_MS);
}

/**
 * 把宿主的键盘高亮（`.kb-active`）抄到自建行上。
 *
 * 方向键由宿主处理，它只会在原生按钮上换高亮；自建行是另一套节点，所以每次高亮
 * 变化都要跟着挪一下，否则按方向键时光标停在看不见的原生行上。
 */
function applyHighlight(view) {
  for (const item of view.querySelectorAll(`[${ITEM_ATTR}]`)) {
    const active = item.getAttribute(ITEM_ATTR) === highlightKey;
    if (item.classList) item.classList.toggle("kb-active", active);
    if (active && typeof item.scrollIntoView === "function") item.scrollIntoView({ block: "nearest" });
  }
}

function syncHighlight(list) {
  if (!list) return;
  const view = childByClass(list, VIEW_CLASS);
  if (!view) return;
  const pane = paneOf(list);
  const native = pane ? pane.querySelector(`${OPTION_SELECTOR}.kb-active`) : null;
  if (native && !native.querySelector(OPTION_PROVIDER_SELECTOR)) {
    const group = closestOf(native, GROUP_SELECTOR);
    const provider = String((group && group.getAttribute("aria-label")) || "").trim();
    const title = String(native.getAttribute("title") || "").trim();
    if (title) highlightKey = `${provider}\u001f${title.toLowerCase()}`;
  }
  applyHighlight(view);
}

/**
 * 方向键与回车。
 *
 * 宿主的键盘游标走在它自己那几行上，而字面上它一次只认得当前这一组；自建视图列出
 * 的却是全部。所以视图显示时由这里接管这四个键，让光标在整份列表上走，回车选中的
 * 也是光标那一行。搜索时不接管 —— 那时显示的就是宿主自己的结果。
 */
function onKeyDown(event) {
  if (!menu || !event || event.isComposing || event.keyCode === 229) return;
  if (menu.getAttribute(SEARCH_ATTR) === "true") return;
  const list = menu.querySelector(LIST_SELECTOR);
  const view = list ? childByClass(list, VIEW_CLASS) : null;
  if (!view) return;
  const input = menu.querySelector(SEARCH_INPUT_SELECTOR);
  if (!input || event.target !== input) return;
  const items = [...view.querySelectorAll(`[${ITEM_ATTR}]`)];
  if (!items.length) return;
  const keys = items.map((item) => item.getAttribute(ITEM_ATTR));
  let index = keys.indexOf(highlightKey);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (index < 0) index = event.key === "ArrowDown" ? -1 : 0;
    index = (index + (event.key === "ArrowDown" ? 1 : -1) + keys.length) % keys.length;
  } else if (event.key === "Home") {
    index = 0;
  } else if (event.key === "End") {
    index = keys.length - 1;
  } else if (event.key === "Enter") {
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    void choose(keys[index]);
    return;
  } else {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  highlightKey = keys[index];
  applyHighlight(view);
}

/**
 * 选中一行：先切到它所属的那一组，再点那枚原生按钮。
 *
 * 分页一次只渲染一组，所以不在当前组里的按钮此刻并不存在 —— 只能先把左栏切过去，
 * 等宿主画出来，再交给它自己处理。
 */
async function choose(key) {
  const row = rowByKey(key);
  const target = menu;
  const list = target ? target.querySelector(LIST_SELECTOR) : null;
  if (!row || !list) return false;
  const rail = railOf(list);
  const items = providerRailItems(rail);
  const item = row.provider
    ? items.find((candidate) => sectionNameOf(candidate) === row.provider)
    : items.find((candidate) => currentSectionName(list) === row.provider);
  if (item && !item.classList.contains("active") && typeof item.click === "function") {
    item.click();
    await waitFor(() => currentSectionName(list) === row.provider);
  }
  const pane = paneOf(list);
  if (!pane) return false;
  for (const option of pane.querySelectorAll(OPTION_SELECTOR)) {
    if (option.querySelector(OPTION_PROVIDER_SELECTOR)) continue;
    if (String(option.getAttribute("title") || "").trim() !== row.modelId) continue;
    highlightKey = row.key;
    if (typeof option.click === "function") option.click();
    markSelected(row.key);
    return true;
  }
  return false;
}

/** 选中态换到这一行：只动视图里的三个地方（aria-checked / 底色 / 勾位）。 */
function markSelected(key) {
  if (!rowsStore) return;
  for (const row of rowsStore.rows) row.active = row.key === key;
  highlightKey = key;
  saveRows();
  const list = menu ? menu.querySelector(LIST_SELECTOR) : null;
  const view = list ? childByClass(list, VIEW_CLASS) : null;
  if (!view) return;
  for (const item of view.querySelectorAll(`[${ITEM_ATTR}]`)) {
    const active = item.getAttribute(ITEM_ATTR) === key;
    item.setAttribute("aria-checked", String(active));
    if (item.classList) item.classList.toggle("active", active);
    const slot = item.querySelector(CHECK_SLOT_SELECTOR);
    if (slot) slot.innerHTML = active ? checkMarkup() : "";
  }
}

/**
 * 打开浮窗后把完整清单读出来（内容先藏起来），读完才让它露面。
 *
 * 宿主的结构变了也不会一直白着：读不到就退回当前这一组，至少能选模型。
 */
async function collectHidden(list) {
  if (collecting || !menu) return;
  collecting = true;
  try {
    const collected = await collectAll(list);
    const merged = normalizeRows(collected);
    if (merged && merged.rows.length) {
      rowsStore = merged;
      saveRows();
    }
  } catch {
    // 读不到就沿用手上这一份。
  } finally {
    collecting = false;
    if (menu) menu.removeAttribute(PROBING_ATTR);
    sync();
  }
}

// -------------------------------------------------------------------- binding

function unbindMenu() {
  if (syncTimer !== null) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  if (listObserver) {
    listObserver.disconnect();
    listObserver = null;
  }
  if (menu) {
    const list = menu.querySelector(LIST_SELECTOR);
    const view = list ? childByClass(list, VIEW_CLASS) : null;
    if (view) view.remove();
    const root = menu.querySelector(ROOT_SELECTOR);
    const bar = root ? childByClass(root, MODES_CLASS) : null;
    if (bar) bar.remove();
    menu.removeAttribute(SEARCH_ATTR);
    menu.removeAttribute(EXPANDED_ATTR);
    menu.removeAttribute(MARKER_ATTR);
    menu.removeAttribute(LEVELS_ATTR);
  }
  menu = null;
  highlightKey = null;
}

function bindMenu(element) {
  unbindMenu();
  menu = element;
  if (typeof MutationObserver === "function") {
    listObserver = new MutationObserver((records) => {
      if (building) return;
      let needsSync = false;
      let highlight = false;
      for (const record of records) {
        if (isOurs(record)) continue;
        const node = record.target;
        if (closestOf(node, `.${VIEW_CLASS},.${MODES_CLASS}`)) continue;
        // 推理强度滑杆是宿主自己的另一块（它就在同一个浮窗里）：档位换了一格、
        // 我们自己的译文写回去，都只在这块里动，别牵动一次整份重建。译文必须在这一批
        // mutation 里同步写完 —— 观察者回调早于绘制，拖到下一次 sync（40ms 之后）
        // 就会先闪一帧英文。
        //
        // 这里不能一遇到别的记录就 return：同一批提交里 list、滑杆与 chip 的改动是
        // 一起到的，先撞上一行模型列表就把后面的滑杆记录丢掉，那样才会「拖动时偶尔
        // 还是英文」。整批扫完，最后统一决定要不要重建。
        if (touchesThinking(record)) {
          if (translateThinking) localizeThinking(element);
          continue;
        }
        // 只是键盘高亮换了一行：跟着挪一下，别整份重建。
        if (record.type === "attributes" && record.attributeName === "class") {
          highlight = true;
          continue;
        }
        needsSync = true;
      }
      // chip 在浮窗外面：每一批都顺手看一眼（一次 querySelector），换绑也不贵。
      if (translateThinking) syncChip();
      if (highlight) syncHighlight(element.querySelector(LIST_SELECTOR));
      if (needsSync) scheduleSync();
    });
    listObserver.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-checked", "aria-expanded", "class"],
    });
  }

  // 缺完整清单时先在隐藏状态下把各组读一遍，再让人看见内容。
  const list = element.querySelector(LIST_SELECTOR);
  const read = list ? needsCollect(list) : false;
  if (read) element.setAttribute(PROBING_ATTR, "true");

  sync();
  if (list && read) void collectHidden(list);
  void refreshConfig();
}

// ----------------------------------------------------------------- lifecycle

// 面板与浮窗里那颗排列按钮写的是同一份设置：每次打开浮窗都读一次，三项一起生效。
async function refreshConfig() {
  if (!host || typeof host.dispatch !== "function") return;
  try {
    const state = await host.dispatch("plugin.call", { method: "modelPickerState", args: {} });
    const config = (state && state.config) || state || {};
    const nextGrouping = GROUPINGS.includes(config.grouping) ? config.grouping : grouping;
    const nextFrame = config.frameSelected === true;
    const nextTranslate = config.translateThinking === true;
    const changed = nextGrouping !== grouping || nextFrame !== frameSelected || nextTranslate !== translateThinking;
    grouping = nextGrouping;
    frameSelected = nextFrame;
    translateThinking = nextTranslate;
    if (changed && menu) {
      syncModes(menu);
      sync();
    }
    // chip 在浮窗外面：设置一变就顺手译一遍（或把英文还回去），不必等下一次开浮窗。
    syncChip();
  } catch {
    // 读不到就沿用上一次的用法，浮窗本身照常工作。
  }
}

function onDocumentInput(event) {
  const target = event ? event.target : null;
  if (!menu || !isElement(target) || typeof target.closest !== "function") return;
  if (!target.closest(SEARCH_INPUT_SELECTOR)) return;
  // 搜索由宿主自己筛：一有查询就把自建视图让开，把原生结果放回来。
  if (String(target.value || "").trim()) menu.setAttribute(SEARCH_ATTR, "true");
  else {
    menu.removeAttribute(SEARCH_ATTR);
    scheduleSync();
  }
}

/** Watches the body for the portal the host mounts each time the popup opens. */
function watchBody() {
  if (typeof MutationObserver !== "function" || !document.body) return;
  bodyObserver = new MutationObserver(() => {
    const found = findLiveMenu();
    if (!found) {
      if (menu) unbindMenu();
      return;
    }
    if (found !== menu) bindMenu(found);
  });
  // The portal is a direct child of <body>; watching that one level is enough and
  // costs nothing while the popup is closed.
  bodyObserver.observe(document.body, { childList: true });
}

// 用户从面板切回来、窗口重新获得焦点时再看一眼 chip：它是浮窗外面唯一写着档位的地方，
// 而这些时机都是廉价的（一次 querySelector）。
function onAttention() {
  syncChip();
}

export function mountModelPicker(bridge) {
  host = bridge;
  loadRows();
  // 入口模块可能在同一个窗口里被重新挂载（插件重载）；监听器只挂一次。
  if (!bodyObserver) {
    document.addEventListener("input", onDocumentInput, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onAttention, true);
    document.addEventListener("visibilitychange", onAttention);
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("focus", onAttention);
    }
    watchBody();
  }
  const open = findLiveMenu();
  if (open && open !== menu) bindMenu(open);
  return refreshConfig();
}

export function unmountModelPicker() {
  document.removeEventListener("input", onDocumentInput, true);
  document.removeEventListener("keydown", onKeyDown, true);
  document.removeEventListener("focusin", onAttention, true);
  document.removeEventListener("visibilitychange", onAttention);
  if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
    window.removeEventListener("focus", onAttention);
  }
  forgetChip();
  if (bodyObserver) {
    bodyObserver.disconnect();
    bodyObserver = null;
  }
  unbindMenu();
  host = null;
  grouping = DEFAULT_GROUPING;
  frameSelected = false;
  translateThinking = false;
}

export const __internals = {
  MENU_SELECTOR,
  LIST_SELECTOR,
  PANE_SELECTOR,
  RAIL_SELECTOR,
  RAIL_ITEM_SELECTOR,
  VIEW_CLASS,
  MODES_CLASS,
  MODE_CLASS,
  MODE_ATTR,
  SEARCH_ATTR,
  EXPANDED_ATTR,
  LAYOUT_ATTR,
  PROVIDER_ATTR,
  MARKER_ATTR,
  LEVEL_ATTR,
  ROWS_STORAGE_KEY,
  DEFAULT_GROUPING,
  GROUPINGS,
};
