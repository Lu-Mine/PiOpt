// PiOpt — the chat composer's model popup, rewritten inside the host window.
//
// PI-Desktop's popup lists the three most recent models first and folds every
// other model behind an 「其他模型」 toggle. This module changes exactly that:
// 全部模型始终展开（限高仍是宿主自己的 max-height，这里不碰），排列方式在搜索
// 框右侧的按钮上一键切换 —— 点一下按供应商分组，再点一下按名称排序。
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
const SWITCH_CLASS = "piopt-mp-switch";
const SEARCH_ATTR = "data-piopt-mp-searching";
const EXPANDED_ATTR = "data-piopt-mp-expanded";
const LAYOUT_ATTR = "data-piopt-mp-layout";
const PROVIDER_ATTR = "data-piopt-mp-provider";
const ITEM_ATTR = "data-piopt-mp-item";
const GROUPINGS = ["provider", "name"];
const DEFAULT_GROUPING = "provider";
const SYNC_DELAY_MS = 40;

// 切换按钮上的两个字：宿主界面跟随 locale，这里也跟随。
const COPY = {
  zh: { provider: "供应商", name: "名称", toName: "点击改为按名称排序", toProvider: "点击改为按供应商分组" },
  en: { provider: "Provider", name: "Name", toName: "Switch to sorting by name", toProvider: "Switch to grouping by provider" },
};

// Injected with the entry stylesheet. Every rule is scoped to a menu this module
// has already touched, so an untouched popup keeps the host's own look.
export const MODEL_PICKER_CSS = [
  /* 「其他模型」是折叠入口，展开后就没用了：藏掉它，收起这条路也一起消失。 */
  `.composer-model-menu[${EXPANDED_ATTR}] .composer-model-list > .${COLLAPSE_CLASS}{display:none}`,
  /* 原生列表让位给自建视图；搜索时反过来（搜索结果由宿主自己筛）。 */
  `.composer-model-menu[${EXPANDED_ATTR}]:not([${SEARCH_ATTR}="true"]) .composer-model-list > *:not(.${VIEW_CLASS}){display:none}`,
  `.composer-model-menu[${EXPANDED_ATTR}][${SEARCH_ATTR}="true"] .${VIEW_CLASS}{display:none}`,
  /* 供应商名称不再压一块底色：滚动到上面时就是普通的一行小标题。 */
  `.composer-model-menu[${EXPANDED_ATTR}] .composer-model-group-label{background:transparent;background-image:none;-webkit-backdrop-filter:none;backdrop-filter:none}`,
  /* 搜索框把右侧让给切换按钮。 */
  `.composer-model-menu[${EXPANDED_ATTR}] .composer-model-search input{flex:1 1 auto;min-width:0}`,
  `.composer-model-menu[${EXPANDED_ATTR}] .${SWITCH_CLASS}{flex:none;height:20px;margin-left:auto;padding:0 7px;border:1px solid var(--ds-border-subtle);border-radius:var(--radius-full);background:color-mix(in oklab,var(--ds-text-primary) 7%,transparent);color:var(--ds-text-muted);font:inherit;font-size:var(--text-xs);line-height:1;cursor:pointer;transition:color var(--motion-duration-fast) var(--motion-ease-out),background var(--motion-duration-fast) var(--motion-ease-out)}`,
  `.composer-model-menu[${EXPANDED_ATTR}] .${SWITCH_CLASS}:hover{background:color-mix(in oklab,var(--ds-text-primary) 13%,transparent);color:var(--ds-text-primary)}`,
  `.composer-model-menu[${EXPANDED_ATTR}] .${SWITCH_CLASS}:focus-visible{outline:2px solid color-mix(in oklab,var(--ds-focus) 55%,transparent);outline-offset:1px}`,
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
].join("\n");

let host = null;
let grouping = DEFAULT_GROUPING;
let menu = null;
let bodyObserver = null;
let listObserver = null;
let syncTimer = null;
let building = false;

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
    && (node.classList.contains(VIEW_CLASS) || node.classList.contains(SWITCH_CLASS)));
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

function compareRows(left, right) {
  if (collator) {
    const byLabel = collator.compare(left.label, right.label);
    if (byLabel !== 0) return byLabel;
  } else if (left.label !== right.label) {
    return left.label < right.label ? -1 : 1;
  }
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

/** 原生分组的顺序（最近使用那一组不算供应商）。 */
function providerOrder(list) {
  const order = [];
  for (const group of list.querySelectorAll(GROUP_SELECTOR)) {
    const option = group.querySelector(OPTION_SELECTOR);
    if (!option) continue;
    if (String(option.getAttribute("title") || "").indexOf(" · ") > 0) continue;
    const label = textOf(group.querySelector(GROUP_LABEL_SELECTOR));
    if (label && !order.includes(label)) order.push(label);
  }
  return order;
}

function insertSorted(bucket, row) {
  const at = bucket.findIndex((existing) => compareRows(row, existing) < 0);
  if (at === -1) bucket.push(row);
  else bucket.splice(at, 0, row);
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
  { icon: "claude", test: /claude|sonnet|opus|haiku|克劳德/i },
  { icon: "anthropic", test: /anthropic/i },
  { icon: "openai", test: /openai|chatgpt|\bgpt\b|gpt-\d|codex|davinci|(?:^|[^a-z])o[1-9](?:[^0-9]|$)/i },
  { icon: "gemini", test: /gemini|gemma|bard|palm|google|谷歌/i },
  { icon: "xai", test: /grok|xai/i },
  { icon: "deepseek", test: /deepseek|深度求索/i },
  { icon: "zhipu", test: /glm|zhipu|chatglm|bigmodel|智谱|清言/i },
  { icon: "qwen", test: /qwen|qwq|tongyi|dashscope|alibaba|通义|千问|阿里/i },
  { icon: "kimi", test: /kimi|moonshot|月之暗面/i },
  { icon: "minimax", test: /minimax|abab|hailuo|海螺/i },
  { icon: "mistral", test: /mistral|mixtral|codestral|pixtral|magistral|devstral/i },
  { icon: "meta", test: /llama|\bmeta\b/i },
  { icon: "cohere", test: /cohere|command-r/i },
  { icon: "openrouter", test: /openrouter/i },
  { icon: "together", test: /together/i },
  { icon: "perplexity", test: /perplexity|sonar/i },
  { icon: "doubao", test: /doubao|bytedance|seedream|seed-?edit|豆包|字节/i },
  { icon: "baidu", test: /ernie|wenxin|baidu|文心|千帆|百度/i },
  // 混元是那颗蓝球；中文供应商名（腾讯混元）也要能认出来。
  { icon: "hunyuan", test: /hunyuan|tencent|混元|腾讯/i },
  { icon: "stepfun", test: /stepfun|step-\d|阶跃/i },
  { icon: "huggingface", test: /huggingface|hf\.co/i },
  { icon: "nvidia", test: /nvidia|nemotron|英伟达/i },
  { icon: "yi", test: /(?:^|[^a-z])yi(?:-|\b)|01\.ai|lingyi|零一/i },
  { icon: "cerebras", test: /cerebras/i },
  { icon: "azure", test: /azure/i },
  { icon: "aws", test: /bedrock|\baws\b/i },
  { icon: "ollama", test: /ollama/i },
];

// 认不出来的服务用首字母色块，颜色从这一组里按名字取，明暗两种主题下都够醒目。
const LETTER_COLORS = ["#5B8DEF", "#D97757", "#10A37F", "#A855F7", "#F59E0B", "#EC4899", "#14B8A6", "#8B5CF6"];

function iconIdFor(row) {
  const model = `${row.label} ${row.modelId}`.toLowerCase();
  const provider = String(row.provider || "").toLowerCase();
  for (const family of FAMILIES) if (family.test.test(model)) return family.icon;
  for (const family of FAMILIES) if (family.test.test(provider)) return family.icon;
  return "";
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
      const meta = main.querySelector(META_SELECTOR);
      if (meta) meta.remove();
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
 * 按供应商：每个供应商一组，顺序沿用宿主；最近使用过的模型按名称插回它所属的
 * 那一组（分组不存在时补一个同名分组）。
 */
function groupedView(rows, order) {
  const buckets = new Map();
  for (const label of order) buckets.set(label, []);
  const bucketFor = (provider) => {
    if (!buckets.has(provider)) buckets.set(provider, []);
    return buckets.get(provider);
  };
  for (const row of rows) if (!row.recent) bucketFor(row.provider).push(row);
  for (const row of rows) if (row.recent) insertSorted(bucketFor(row.provider), row);

  const groups = [];
  for (const [label, bucket] of buckets) {
    if (!bucket.length) continue;
    groups.push(buildGroup(label, bucket, false));
  }
  return groups;
}

function renderView(list) {
  // 自己在原生列表里挂节点，这些改动不能反过来触发一次重建：先挂起观察者，
  // 建完把这一批记录丢掉。
  building = true;
  const previous = childByClass(list, VIEW_CLASS);
  if (previous) previous.remove();

  const rows = readRows(list);
  const view = document.createElement("div");
  view.className = VIEW_CLASS;
  view.setAttribute(LAYOUT_ATTR, grouping);

  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "composer-model-empty";
    empty.textContent = textOf(list.querySelector(EMPTY_SELECTOR));
    view.append(empty);
  } else if (grouping === "name") {
    rows.sort(compareRows);
    for (const row of rows) view.append(buildRow(row, true));
  } else {
    for (const group of groupedView(rows, providerOrder(list))) view.append(group);
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
 * 搜索框右侧的切换按钮：点一下换一种排列。
 *
 * 按钮挂在宿主那枚 `<label class="composer-model-search">` 里。React 只管它自己
 * 的三个子节点（图标、读屏文案、输入框），多出来的一颗按钮不会被它收走。
 */
function syncSwitch(menuElement) {
  const search = menuElement.querySelector(SEARCH_SELECTOR);
  if (!search) return null;
  let button = childByClass(search, SWITCH_CLASS);
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = SWITCH_CLASS;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void setGrouping(grouping === "provider" ? "name" : "provider");
    });
    search.append(button);
  }
  const copy = copyOf();
  button.textContent = copy[grouping];
  const hint = grouping === "provider" ? copy.toName : copy.toProvider;
  button.title = hint;
  button.setAttribute("aria-label", `${copy[grouping]} · ${hint}`);
  return button;
}

async function setGrouping(next) {
  if (!GROUPINGS.includes(next) || next === grouping) return grouping;
  grouping = next;
  if (menu) {
    syncSwitch(menu);
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
  syncSwitch(target);

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
    const search = menu.querySelector(SEARCH_SELECTOR);
    const button = search ? childByClass(search, SWITCH_CLASS) : null;
    if (button) button.remove();
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

  sync();
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
        syncSwitch(menu);
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
    const found = document.querySelector(MENU_SELECTOR);
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
  const open = document.querySelector(MENU_SELECTOR);
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
  SWITCH_CLASS,
  SEARCH_ATTR,
  EXPANDED_ATTR,
  LAYOUT_ATTR,
  PROVIDER_ATTR,
  DEFAULT_GROUPING,
  GROUPINGS,
};
