// PiOpt — the chat composer's model popup, rewritten inside the host window.
//
// PI-Desktop's popup lists the three most recent models first and folds every
// other model behind an 「其他模型」 toggle. This module changes exactly that:
// 全部模型始终展开（限高仍是宿主自己的 max-height，这里不碰），搜索框下面一条
// 「供应商 / 厂商 / 名称」切换排列方式，分组与组内顺序都按 A–Z。
//
// 做法：
//   1. 点一次宿主自己的「其他模型」入口把其余分组放出来，随后把入口藏掉；
//   2. 原生列表整体让位，用克隆出来的按钮自建一份视图：
//      · 按供应商：最近使用过的模型还回各自供应商那一组，分组标题不压底色；
//      · 按名称：全部模型平铺，每个选项下面另起一行淡色的来源。
//
// 克隆按钮的点击一律转交给对应的原生按钮（display:none 不影响 .click()），
// 所以选中模型走的仍是宿主自己的逻辑，React 的节点树一个都没被搬动或删除 ——
// 宿主在搜索、方向键高亮、模型异步加载时都会重渲染这棵子树，搬动别人的节点会
// 让它下一次 insertBefore 找不到参照。

import { ICONS } from "./model-logos/icons.mjs";

const MENU_SELECTOR = ".composer-model-menu";
const LIST_SELECTOR = ".composer-model-list";
const GROUP_SELECTOR = ".composer-model-group";
const GROUP_LABEL_SELECTOR = ".composer-model-group-label";
const OPTION_SELECTOR = ".composer-model-option";
const OPTION_MAIN_SELECTOR = ".composer-model-option-main";
const META_SELECTOR = ".composer-model-option-meta";
const LABEL_SELECTOR = ".composer-model-label";
const SEARCH_SELECTOR = ".composer-model-search";
const SEARCH_INPUT_SELECTOR = ".composer-model-search input";
const EMPTY_SELECTOR = ".composer-model-empty";
const COLLAPSE_CLASS = "composer-menu-entry";
const VIEW_CLASS = "piopt-mp-view";
const MODES_CLASS = "piopt-mp-modes";
const MODE_CLASS = "piopt-mp-mode";
const MODE_ATTR = "data-piopt-mp-mode";
const SEARCH_ATTR = "data-piopt-mp-searching";
const EXPANDED_ATTR = "data-piopt-mp-expanded";
const LAYOUT_ATTR = "data-piopt-mp-layout";
const PROVIDER_ATTR = "data-piopt-mp-provider";
const ITEM_ATTR = "data-piopt-mp-item";
const PROBING_ATTR = "data-piopt-mp-probing";
const CAPS_STORAGE_KEY = "piopt.modelPicker.capabilities.v1";
const DEFAULT_GROUPING = "provider";
const GROUPINGS = ["provider", "vendor", "name"];
// 探测一次「最近使用」模型的能力要一次搜索 + 一次渲染；最多等这么久，超时就放弃。
const PROBE_TIMEOUT_MS = 400;
const CAPS_LIMIT = 200;
const SYNC_DELAY_MS = 40;

// 三种排列方式的名字：宿主界面跟随 locale，这里也跟随。
const COPY = {
  zh: { modes: "排列方式", provider: "供应商", vendor: "厂商", name: "名称" },
  en: { modes: "Arrange by", provider: "Provider", vendor: "Vendor", name: "Name" },
};

// Injected with the entry stylesheet. Every rule is scoped to a menu this module
// has already touched, so an untouched popup keeps the host's own look.
export const MODEL_PICKER_CSS = [
  /* 探测某个模型的能力时把内容藏起来（布局不动，浮窗坐标不抖）。 */
  `.composer-model-menu[${PROBING_ATTR}] .composer-menu-root{visibility:hidden}`,
  /* 「其他模型」是折叠入口，展开后就没用了：藏掉它，收起这条路也一起消失。 */
  `.composer-model-menu[${EXPANDED_ATTR}] .composer-model-list > .${COLLAPSE_CLASS}{display:none}`,
  /* 原生列表让位给自建视图；搜索时反过来（搜索结果由宿主自己筛）。 */
  `.composer-model-menu[${EXPANDED_ATTR}]:not([${SEARCH_ATTR}="true"]) .composer-model-list > *:not(.${VIEW_CLASS}){display:none}`,
  `.composer-model-menu[${EXPANDED_ATTR}][${SEARCH_ATTR}="true"] .${VIEW_CLASS}{display:none}`,
  /* 供应商名称不再压一块底色：滚动到上面时就是普通的一行小标题。 */
  `.composer-model-menu[${EXPANDED_ATTR}] .composer-model-group-label{background:transparent;background-image:none;-webkit-backdrop-filter:none;backdrop-filter:none}`,
  /* 搜索框下面单独一条：三种排列方式，点哪个是哪个。 */
  `.composer-model-menu[${EXPANDED_ATTR}] .${MODES_CLASS}{display:flex;gap:2px;margin:0 3px 5px;padding:2px;border-radius:var(--radius-full);background:color-mix(in oklab,var(--ds-text-primary) 6%,transparent)}`,
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
  /* 按名称：来源另起一行、居左、比次要文字再淡一档。 */
  `.${VIEW_CLASS}[${LAYOUT_ATTR}="name"] .composer-model-option-main{flex-wrap:wrap}`,
  `.${VIEW_CLASS}[${LAYOUT_ATTR}="name"] .composer-model-option-main::after{content:attr(${PROVIDER_ATTR});flex:1 0 100%;color:var(--ds-text-faint);font-size:var(--text-xs);line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
  `.${VIEW_CLASS}[data-piopt-mp-switch="true"]{animation:piopt-mp-switch var(--motion-duration-fast,135ms) var(--motion-ease-out,cubic-bezier(.22,1,.36,1)) backwards}`,
  `@keyframes piopt-mp-switch{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:translateY(0)}}`,
].join("\n");

let host = null;
let grouping = DEFAULT_GROUPING;
let menu = null;
let bodyObserver = null;
let listObserver = null;
let syncTimer = null;
let building = false;
let animateNextView = false;

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
 * 一行原生按钮的模型身份。
 *
 * 最近使用那一组的 title 是「供应商 · 模型 id」，供应商要自己拆出来；供应商分组
 * 里的 title 只有模型 id，供应商就是分组标题。身份用来去重（同一个模型只出现一
 * 次）、把最近使用过的模型还回分类，以及把宿主的键盘高亮映射到自建行上。
 */
function identityOf(option, groupLabel) {
  const title = String(option.getAttribute("title") || "");
  const at = title.indexOf(" · ");
  const recent = at > 0;
  const provider = recent ? title.slice(0, at) : groupLabel;
  const modelId = recent ? title.slice(at + 3) : title;
  // 分隔符用 US（单元分隔符）而不是 NUL：NUL 在属性值里会被序列化替换掉，
  // 这个键要先写进 data-piopt-mp-item 再读回来比对。
  return { provider, modelId, recent, key: `${provider}\u001f${modelId.toLowerCase()}` };
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

/** 原生列表里的每一个模型，按身份去重后的行。 */
function readRows(list) {
  const rows = [];
  const seen = new Set();
  for (const option of list.querySelectorAll(OPTION_SELECTOR)) {
    // 自建视图里的按钮也是 .composer-model-option，不能把它们当成原生行。
    if (closestOf(option, `.${VIEW_CLASS}`)) continue;
    const group = closestOf(option, GROUP_SELECTOR);
    const groupLabel = textOf(group ? group.querySelector(GROUP_LABEL_SELECTOR) : null);
    const identity = identityOf(option, groupLabel);
    if (seen.has(identity.key)) continue;
    seen.add(identity.key);
    rows.push({
      option,
      key: identity.key,
      provider: identity.provider,
      modelId: identity.modelId,
      recent: identity.recent,
      label: textOf(option.querySelector(LABEL_SELECTOR)) || identity.modelId,
    });
  }
  return rows;
}


// ------------------------------------------------------------------- rendering

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

// ------------------------------------------------------------- capabilities

/*
 * 「最近使用」那一组只有模型名和来源：宿主把能力徽标（推理 / 视觉）与上下文读数
 * 只画在供应商分组里，而它展开时又把最近用过的模型从分组里剔掉了。所以这些信息
 * 只能来自宿主自己的另一次渲染 —— 搜索时它不过滤最近使用，那些模型会带着完整的
 * meta 出现在各自的分组里。
 *
 * 打开浮窗时如果还有没缓存过的最近使用模型，就把这一次搜索跑掉：内容先藏起来
 * （visibility:hidden，布局不动），跑完再放出来。结果按「供应商␟模型 id」缓存到
 * localStorage，之后每次打开直接用，不再探测。
 */

let capsStore = null;
let probeRunning = false;
let probeUnsupported = false;

function caps() {
  if (capsStore) return capsStore;
  capsStore = new Map();
  try {
    const raw = window.localStorage.getItem(CAPS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    for (const [key, value] of Object.entries(parsed || {})) {
      if (typeof value === "string" && value) capsStore.set(key, value);
    }
  } catch {
    // 隐私模式下读不到：这一份就只在内存里。
  }
  return capsStore;
}

function saveCaps() {
  try {
    const entries = [...caps().entries()].slice(-CAPS_LIMIT);
    window.localStorage.setItem(CAPS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 存不进去不影响这一次显示。
  }
}

function metaOf(option) {
  const meta = option.querySelector(META_SELECTOR);
  return meta && meta.innerHTML.trim() ? meta : null;
}

/** 原生分组里带完整 meta 的行，顺手都记下来。 */
function harvestCaps(list) {
  const store = caps();
  let changed = false;
  for (const option of list.querySelectorAll(OPTION_SELECTOR)) {
    if (closestOf(option, `.${VIEW_CLASS}`)) continue;
    const group = closestOf(option, GROUP_SELECTOR);
    const groupLabel = textOf(group ? group.querySelector(GROUP_LABEL_SELECTOR) : null);
    const identity = identityOf(option, groupLabel);
    if (identity.recent) continue;
    const meta = metaOf(option);
    if (!meta) continue;
    if (store.get(identity.key) !== meta.outerHTML) {
      store.set(identity.key, meta.outerHTML);
      changed = true;
    }
  }
  if (changed) saveCaps();
}

function missingCapRows(list) {
  const store = caps();
  return readRows(list).filter((row) => row.recent && !store.has(row.key));
}

/** 给宿主的搜索框喂一个值。React 认的是原生 setter + input 事件。 */
function setQuery(input, value) {
  const descriptor = window.HTMLInputElement
    ? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
    : null;
  if (descriptor && descriptor.set) descriptor.set.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function metaHtmlFor(list, key) {
  for (const option of list.querySelectorAll(OPTION_SELECTOR)) {
    if (closestOf(option, `.${VIEW_CLASS}`)) continue;
    const group = closestOf(option, GROUP_SELECTOR);
    const groupLabel = textOf(group ? group.querySelector(GROUP_LABEL_SELECTOR) : null);
    const identity = identityOf(option, groupLabel);
    if (identity.recent || identity.key !== key) continue;
    const meta = metaOf(option);
    if (meta) return meta.outerHTML;
  }
  return "";
}

/**
 * 等宿主的下一帧渲染：DOM 一变就回来，最多等 ms。用 MutationObserver 而不是固定
 * 的 setTimeout —— 后台窗口会把定时器压到 1s，浮窗这时会白着。
 */
function nextRender(target, ms = 80) {
  return new Promise((resolve) => {
    let timer = null;
    let observer = null;
    const finish = () => {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      resolve();
    };
    if (typeof MutationObserver === "function") {
      observer = new MutationObserver(finish);
      observer.observe(target, { childList: true, subtree: true });
    }
    timer = window.setTimeout(finish, ms);
  });
}

/**
 * 逐个搜出最近使用过的模型，把它们的 meta（徽标 + 上下文）抄下来。
 * 只在没有缓存时跑一次；宿主不再按搜索重渲染时立刻放弃，不再重试。
 */
async function probeCaps(list) {
  if (probeRunning || probeUnsupported || !menu || !list) return;
  probeRunning = true;
  try {
    const input = menu.querySelector(SEARCH_INPUT_SELECTOR);
    if (!input || input.value.trim()) return;
    const pending = missingCapRows(list);
    let owned = "";
    for (let index = 0; index < pending.length; index += 1) {
      const row = pending[index];
      if (menu !== findLiveMenu()) return;
      // 用户自己开始打字了就退出，别把输入抢走。
      if (input.value !== owned) return;
      owned = row.modelId;
      setQuery(input, owned);
      const deadline = Date.now() + PROBE_TIMEOUT_MS;
      let html = metaHtmlFor(list, row.key);
      while (!html && Date.now() < deadline) {
        await nextRender(list);
        html = metaHtmlFor(list, row.key);
      }
      if (!html) {
        // 第一个就没等到：宿主不会为程序化的搜索重渲染，别再耗着。
        if (index === 0) probeUnsupported = true;
        break;
      }
      caps().set(row.key, html);
    }
    saveCaps();
    if (input.value === owned) setQuery(input, "");
    await nextRender(list);
  } finally {
    probeRunning = false;
    if (menu) menu.removeAttribute(PROBING_ATTR);
    sync();
  }
}

/**
 * 一行自建选项。克隆保留宿主的样子（标签、徽标、上下文读数、对勾），只去掉两样
 * 东西：键盘高亮的瞬时类，以及「最近使用」行右侧那枚来源 —— 需求是来源不写在
 * 右边，按名称时它改由下方那行淡字承担。
 */
function buildRow(row, showSource) {
  const item = row.option.cloneNode(true);
  item.removeAttribute("data-model-index");
  if (item.classList) item.classList.remove("kb-active");
  item.setAttribute(ITEM_ATTR, row.key);
  const main = item.querySelector(OPTION_MAIN_SELECTOR);
  if (main) {
    if (row.recent) {
      // 最近使用那一组把来源写在右侧；这里换成宿主在同一模型的分组行上画的
      // 那套 meta（推理 / 视觉徽标 + 上下文读数）。缓存里没有就先空着，探测
      // 完成后重建这一行。
      const meta = main.querySelector(META_SELECTOR);
      const cached = caps().get(row.key);
      if (cached) {
        const holder = document.createElement("span");
        holder.innerHTML = cached;
        const replacement = holder.firstElementChild;
        if (replacement && meta) meta.replaceWith(replacement);
        else if (replacement) main.append(replacement);
      } else if (meta) {
        meta.remove();
      }
    }
    if (showSource && row.provider) main.setAttribute(PROVIDER_ATTR, row.provider);
    // 图标和名称贴在一起：宿主给 main 的列间距是 8px，直接塞进去会离得太远，
    // 所以把名称挪进一个自带 6px 间距的 lead 里。
    const label = main.querySelector(LABEL_SELECTOR);
    if (label) {
      const lead = document.createElement("span");
      lead.className = "piopt-mp-lead";
      label.replaceWith(lead);
      lead.append(buildLogo(row), label);
    }
  }
  item.addEventListener("click", (event) => {
    event.preventDefault();
    // 克隆行只是原生按钮的替身：真正的点击交给隐藏着的原生按钮，选中模型
    // 仍然完全由宿主的 React 逻辑完成。
    if (typeof row.option.click === "function") row.option.click();
  });
  return item;
}

function buildGroup(label, rows, showSource) {
  const group = document.createElement("div");
  group.className = "composer-model-group";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  const heading = document.createElement("div");
  heading.className = "composer-model-group-label";
  heading.textContent = label;
  group.append(heading);
  for (const row of rows) group.append(buildRow(row, showSource));
  return group;
}

/**
 * 分组视图（按供应商 / 按厂商共用）：分组名与组内模型都按 A–Z 排。
 *
 * 宿主原来按自己的顺序排分组、组内也按它自己的顺序；这里统一成字典序，最近使用
 * 过的模型因为已经在 rows 里，跟着落到各自的分组里，不再单独排序插入。
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
  // 先收一遍宿主已经画出来的能力标记，再建视图：最近使用那几行的 meta 从缓存里取。
  harvestCaps(list);
  const rows = readRows(list);
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
  } else if (grouping === "name") {
    rows.sort(compareRows);
    for (const row of rows) view.append(buildRow(row, true));
  } else if (grouping === "vendor") {
    for (const group of groupedView(rows, vendorOf)) view.append(group);
  } else {
    for (const group of groupedView(rows, (row) => row.provider || row.label)) view.append(group);
  }

  list.append(view);
  if (listObserver) listObserver.takeRecords();
  building = false;
  syncHighlight(list);
}

// --------------------------------------------------------------------- switch

// 宿主把当前界面语言写在 <html lang> 上；只有中文界面用中文，其余一律用英文，
// 免得日文/德文界面里冒出一颗中文按钮。
function copyOf() {
  const lang = (document.documentElement && document.documentElement.lang) || "";
  return /^zh\b/i.test(lang) ? COPY.zh : COPY.en;
}

/**
 * 搜索框下面那条「排列方式」：供应商 / 厂商 / 名称，点哪个是哪个。
 *
 * 它挂在宿主的 `.composer-menu-root` 里、紧跟搜索框之后 —— 在搜索框外面，输入框
 * 拿回整行宽度。React 只管它自己的子节点（搜索框、列表、思考滑杆），多出来的一条
 * 不会被它收走。
 */
function syncModes(menuElement) {
  const root = menuElement.querySelector(".composer-menu-root");
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

  // 宿主的折叠入口：点一次把它全部展开，然后它在 CSS 里被藏掉，用户不能再收起。
  // 点击是异步生效的，这一轮先让原生列表照常显示，展开后的下一轮再建视图，免得
  // 浮窗先空一下。
  const collapse = childByClass(list, COLLAPSE_CLASS);
  if (collapse && collapse.getAttribute("aria-expanded") === "false") {
    if (typeof collapse.click === "function") collapse.click();
    return;
  }

  renderView(list);
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
 * 方向键由宿主处理，它只会在原生按钮上换高亮；自建行是克隆体，所以每次高亮
 * 变化都要跟着挪一下，否则按方向键时光标停在看不见的原生行上。
 */
function syncHighlight(list) {
  const view = childByClass(list, VIEW_CLASS);
  if (!view) return;
  let activeKey = null;
  for (const option of list.querySelectorAll(`${OPTION_SELECTOR}.kb-active`)) {
    // 自建行此刻正被同步，只看原生行，否则移除高亮时会被自己的克隆体说服
    // 「还有人高亮着」。
    if (closestOf(option, `.${VIEW_CLASS}`)) continue;
    const group = closestOf(option, GROUP_SELECTOR);
    const groupLabel = textOf(group ? group.querySelector(GROUP_LABEL_SELECTOR) : null);
    activeKey = identityOf(option, groupLabel).key;
    break;
  }
  for (const item of view.querySelectorAll(`[${ITEM_ATTR}]`)) {
    const active = activeKey !== null && item.getAttribute(ITEM_ATTR) === activeKey;
    if (item.classList) item.classList.toggle("kb-active", active);
    if (active && typeof item.scrollIntoView === "function") item.scrollIntoView({ block: "nearest" });
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
    const root = menu.querySelector(".composer-menu-root");
    const bar = root ? childByClass(root, MODES_CLASS) : null;
    if (bar) bar.remove();
    menu.removeAttribute(SEARCH_ATTR);
    menu.removeAttribute(EXPANDED_ATTR);
  }
  menu = null;
}

function bindMenu(element) {
  unbindMenu();
  menu = element;

  if (typeof MutationObserver === "function") {
    listObserver = new MutationObserver((records) => {
      if (building) return;
      for (const record of records) {
        if (isOurs(record)) continue;
        const node = record.target;
        if (closestOf(node, `.${VIEW_CLASS}`)) continue;
        // 只是键盘高亮换了一行：跟着挪一下，别整份重建。
        if (record.type === "attributes" && record.attributeName === "class") {
          syncHighlight(element.querySelector(LIST_SELECTOR));
          continue;
        }
        scheduleSync();
        return;
      }
    });
    listObserver.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-checked", "aria-expanded", "class"],
    });
  }

  // 最近使用那几行缺能力标记时，先在隐藏状态下把探测跑完，再让人看见内容。
  const list = element.querySelector(LIST_SELECTOR);
  const pending = list ? missingCapRows(list) : [];
  if (pending.length) element.setAttribute(PROBING_ATTR, "true");

  sync();
  if (pending.length && list) void probeCaps(list);
  void refreshGrouping();
}

// ----------------------------------------------------------------- lifecycle

async function refreshGrouping() {
  if (!host || typeof host.dispatch !== "function") return;
  try {
    const state = await host.dispatch("plugin.call", { method: "modelPickerState", args: {} });
    const next = state && state.config ? state.config.grouping : state && state.grouping;
    if (GROUPINGS.includes(next) && next !== grouping) {
      grouping = next;
      if (menu) {
        syncModes(menu);
        sync();
      }
    }
  } catch {
    // 读不到就沿用上一次的排列方式，浮窗本身照常工作。
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

export function mountModelPicker(bridge) {
  host = bridge;
  // 入口模块可能在同一个窗口里被重新挂载（插件重载）；监听器只挂一次。
  if (!bodyObserver) {
    document.addEventListener("input", onDocumentInput, true);
    watchBody();
  }
  const open = findLiveMenu();
  if (open && open !== menu) bindMenu(open);
  return refreshGrouping();
}

export function unmountModelPicker() {
  document.removeEventListener("input", onDocumentInput, true);
  if (bodyObserver) {
    bodyObserver.disconnect();
    bodyObserver = null;
  }
  unbindMenu();
  host = null;
  grouping = DEFAULT_GROUPING;
}

export const __internals = {
  MENU_SELECTOR,
  LIST_SELECTOR,
  VIEW_CLASS,
  MODES_CLASS,
  MODE_CLASS,
  MODE_ATTR,
  SEARCH_ATTR,
  EXPANDED_ATTR,
  LAYOUT_ATTR,
  PROVIDER_ATTR,
  DEFAULT_GROUPING,
  GROUPINGS,
};
