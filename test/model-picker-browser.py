"""Real Chromium regression for the model picker's selected row.

Run: python test/model-picker-browser.py
Requires Python Playwright and its Chromium build; nothing outside a temp dir is written.
"""
import functools
import http.server
import json
import socketserver
import subprocess
import tempfile
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PICKER = (ROOT / "renderer/model-picker.mjs").read_text(encoding="utf-8")
PICKER = PICKER.replace('import { ICONS } from "./model-logos/icons.mjs";', "const ICONS = {};").replace("export ", "")
PICKER_CSS = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e",
    "import {MODEL_PICKER_CSS} from './renderer/model-picker.mjs';console.log(JSON.stringify(MODEL_PICKER_CSS));",
], cwd=ROOT, text=True, encoding="utf-8"))
TOKENS = (ROOT / "renderer/tokens.css").read_text(encoding="utf-8")

# Host 0.21 rules that shape a selected row, copied from the shipped app.asar.
HOST = """
[hidden]{display:none!important}
html,body{margin:0;background:var(--ds-bg-primary);color:var(--ds-text-primary)}
:root{--text-2xs:10px}
.composer-model-menu{position:fixed;top:0;left:0;width:260px;background:var(--ds-bg-elevated-opaque)}
.composer-model-list{max-height:280px;overflow:auto}
.composer-plus-item{display:flex;align-items:center;gap:10px;width:100%;min-height:28px;padding:5px 8px;border:0;background:transparent;color:var(--ds-text-primary);font:inherit;text-align:left}
.composer-model-option{display:flex}
.composer-model-option-main{flex-flow:row;flex:1;align-items:baseline;gap:2px 8px;min-width:0;display:flex}
.composer-model-label{min-width:0;max-width:100%;color:var(--ds-text-primary);text-overflow:ellipsis;white-space:nowrap;flex:0 auto;overflow:hidden}
.composer-model-option-meta{flex:0 auto;align-items:center;gap:4px;min-width:0;margin-left:auto;display:flex}
.composer-model-option-meta>span{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.composer-model-option-badge{color:var(--ds-text-faint);flex:none;align-items:center;display:inline-flex}
.composer-model-option-ctx{color:var(--ds-text-faint);font-size:var(--text-2xs);font-variant-numeric:tabular-nums}
.composer-plus-item svg{color:var(--ds-text-secondary);flex:none}
.composer-plus-item span{min-width:0}
.composer-plus-item.active{background:var(--ds-bg-active);border-radius:var(--radius-sm)}
.composer-plus-item.active span:last-child:not(.composer-ac-path){color:var(--ds-text-primary)}
.composer-plus-item.kb-active{background:var(--ds-bg-hover)}
.composer-plus-item.active.kb-active{background:var(--ds-bg-active)}
.composer-model-check{flex:none;color:var(--ds-accent)!important}
.composer-model-group-label{z-index:1;position:sticky;top:0;padding:6px 8px 2px;background:color-mix(in oklab,var(--ds-bg-elevated-opaque) 82%,transparent);-webkit-backdrop-filter:saturate(1.6) blur(40px);backdrop-filter:saturate(1.6) blur(40px);color:var(--ds-text-muted);font-size:var(--text-xs-plus);font-weight:600}
.composer-model-search{height:28px;display:flex;align-items:center;padding:0 8px}
"""

CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
BADGE = '<span class="composer-model-option-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20"/></svg></span>'
CACHED = f'<span class="composer-model-option-meta">{BADGE}<span class="composer-model-option-ctx">200K</span></span>'

# 「最近使用」组的选中行：只有 aria-checked 与一枚没有 composer-model-check 的勾。
# 供应商组里的同一个模型带着完整 meta 与宿主自己的选中类，用来喂缓存和比对。
DOM = f"""
<div class="composer-model-menu is-open">
  <div class="composer-menu-root">
    <div class="composer-model-search"><input></div>
    <div class="composer-model-list">
      <button class="composer-menu-entry" aria-expanded="true">Other models</button>
      <div class="composer-model-group" role="group" aria-label="Recent">
        <div class="composer-model-group-label">Recent</div>
        <button type="button" role="menuitemradio" aria-checked="true" data-model-index="0" title="Alpha · model-a" class="composer-plus-item composer-model-option">
          <span class="composer-model-option-main"><span class="composer-model-label">Model A</span><span class="composer-model-option-meta" title="Alpha">Alpha</span></span>
          {CHECK}
        </button>
        <button type="button" role="menuitemradio" aria-checked="false" data-model-index="1" title="Alpha · model-b" class="composer-plus-item composer-model-option">
          <span class="composer-model-option-main"><span class="composer-model-label">Model B</span><span class="composer-model-option-meta" title="Alpha">Alpha</span></span>
        </button>
      </div>
      <div class="composer-model-group" role="group" aria-label="Alpha">
        <div class="composer-model-group-label">Alpha</div>
        <button type="button" role="menuitemradio" aria-checked="true" data-model-index="2" title="model-a" class="composer-plus-item composer-model-option active">
          <span class="composer-model-option-main"><span class="composer-model-label">Model A</span><span class="composer-model-option-meta" title="model-a">{CACHED}</span></span>
          <svg class="composer-model-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
        </button>
        <button type="button" role="menuitemradio" aria-checked="false" data-model-index="3" title="model-b" class="composer-plus-item composer-model-option">
          <span class="composer-model-option-main"><span class="composer-model-label">Model B</span><span class="composer-model-option-meta" title="model-b">{CACHED}</span></span>
        </button>
      </div>
    </div>
  </div>
</div>
"""

# 默认排列：宿主的顺序（最近使用那一组在最前，供应商组按它自己的顺序，组内也不排序）。
# 组名与组内顺序都故意不是 A–Z 的顺序，一旦被重排这条断言就挂。
DEFAULT_DOM = f"""
<div class="composer-model-menu is-open">
  <div class="composer-menu-root">
    <div class="composer-model-search"><input></div>
    <div class="composer-model-list">
      <button class="composer-menu-entry" aria-expanded="true">Other models</button>
      <div class="composer-model-group" role="group" aria-label="Recent">
        <div class="composer-model-group-label">Recent</div>
        <button type="button" role="menuitemradio" aria-checked="false" title="Alpha · model-a" class="composer-plus-item composer-model-option">
          <span class="composer-model-option-main"><span class="composer-model-label">Model A</span><span class="composer-model-option-meta" title="Alpha">Alpha</span></span>
        </button>
      </div>
      <div class="composer-model-group" role="group" aria-label="Zeta">
        <div class="composer-model-group-label">Zeta</div>
        <button type="button" role="menuitemradio" aria-checked="false" title="zeta-2" class="composer-plus-item composer-model-option">
          <span class="composer-model-option-main"><span class="composer-model-label">Zeta 2</span></span>
        </button>
        <button type="button" role="menuitemradio" aria-checked="false" title="zeta-1" class="composer-plus-item composer-model-option">
          <span class="composer-model-option-main"><span class="composer-model-label">Zeta 1</span></span>
        </button>
      </div>
      <div class="composer-model-group" role="group" aria-label="Alpha">
        <div class="composer-model-group-label">Alpha</div>
        <button type="button" role="menuitemradio" aria-checked="false" title="model-b" class="composer-plus-item composer-model-option">
          <span class="composer-model-option-main"><span class="composer-model-label">Model B</span><span class="composer-model-option-meta" title="model-b">{CACHED}</span></span>
        </button>
      </div>
    </div>
  </div>
</div>
"""

# 第三段用：一个会像宿主那样渲染的迷你「宿主」。它的搜索不过滤「最近使用」那一组，
# 又用供应商名匹配整组 —— 模块正是靠这两点把设置里的完整顺序问出来。
HOST_DOM = """
<div class="composer-model-menu is-open">
  <div class="composer-menu-root">
    <div class="composer-model-search"><input></div>
    <div class="composer-model-list"></div>
  </div>
</div>
"""

HOST_MOCK = """
(() => {
  const CACHED = %s;
  // 设置里的顺序：Zeta 在前、Alpha 在后；model-a 在 Alpha 组里排第二。
  window.hostGroups = {
    Zeta: [{ id: 'zeta-2', label: 'Zeta 2' }, { id: 'zeta-1', label: 'Zeta 1' }],
    Alpha: [{ id: 'model-b', label: 'Model B' }, { id: 'model-a', label: 'Model A' }],
  };
  window.hostRecent = [{ id: 'model-a', label: 'Model A' }];
  window.renderHost = (query) => {
    const q = String(query || '').trim().toLowerCase();
    const list = document.querySelector('.composer-model-list');
    if (!list) return;
    const row = (title, label, meta) =>
      `<button type="button" role="menuitemradio" aria-checked="false" title="${title}" class="composer-plus-item composer-model-option"><span class="composer-model-option-main"><span class="composer-model-label">${label}</span>${meta}</span></button>`;
    const group = (name, rows) =>
      `<div class="composer-model-group" role="group" aria-label="${name}"><div class="composer-model-group-label">${name}</div>${rows.join('')}</div>`;
    const parts = [];
    // 「最近使用」那一组一直在最上面，搜索时也不过滤（和宿主一致）。
    parts.push(group('Recent', window.hostRecent.map((m) =>
      row(`Alpha · ${m.id}`, m.label, '<span class="composer-model-option-meta" title="Alpha">Alpha</span>'))));
    parts.push('<button class="composer-menu-entry" aria-expanded="true">Other models</button>');
    for (const [name, models] of Object.entries(window.hostGroups)) {
      const shown = models.filter((m) => {
        // 没有查询：宿主把最近用过的那几个从分组里剔出去。
        if (!q) return !window.hostRecent.some((r) => r.id === m.id);
        // 有查询：它用 providerSearchText（含供应商名）匹配，所以搜供应商名会列出整组。
        return m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q) || name.toLowerCase().includes(q);
      });
      if (!shown.length) continue;
      parts.push(group(name, shown.map((m) => row(m.id, m.label, CACHED))));
    }
    list.innerHTML = parts.join('');
  };
  document.addEventListener('input', (event) => {
    const input = event.target;
    if (!input || !input.closest || !input.closest('.composer-model-search')) return;
    window.renderHost(input.value);
  });
})();
""" % json.dumps(CACHED)

WHITE = "rgb(255, 255, 255)"

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


with tempfile.TemporaryDirectory() as serve:
    Path(serve, "blank.html").write_text("<!doctype html><html><body></body></html>", encoding="utf-8")
    handler = functools.partial(Quiet, directory=serve)
    server = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = "http://127.0.0.1:%d/blank.html" % server.server_address[1]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 900, "height": 600})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        # localStorage needs a real origin: the picker caches row meta there.
        page.goto(origin)
        page.set_content('<html lang="zh-CN" data-theme="dark"><body></body></html>')
        page.add_style_tag(content=TOKENS + HOST + PICKER_CSS)
        page.add_script_tag(content="(() => {" + PICKER + "\nwindow.picker = {mountModelPicker, unmountModelPicker};})()")
        page.evaluate(
            """([dom, cached]) => {
              localStorage.setItem('piopt.modelPicker.capabilities.v1', JSON.stringify({
                'Alpha\\u001fmodel-a': cached,
                'Alpha\\u001fmodel-b': cached,
                'model-a': cached,
                'model-b': cached,
              }));
              window.mountReady = picker.mountModelPicker({dispatch: async () => ({config: {grouping: 'provider'}})});
              document.body.insertAdjacentHTML('beforeend', dom);
            }""",
            [DOM, CACHED],
        )
        page.wait_for_selector(".piopt-mp-view", state="attached", timeout=4000)
        page.wait_for_timeout(300)
        state = page.evaluate(
            """() => {
              const rows = [...document.querySelectorAll('.piopt-mp-view [data-piopt-mp-item]')];
              const selected = rows.find((row) => row.getAttribute('aria-checked') === 'true');
              const other = rows.find((row) => row.getAttribute('aria-checked') !== 'true');
              const tick = selected && selected.lastElementChild;
              return {
                rows: rows.length,
                classes: selected ? selected.className : '',
                tick: tick ? tick.getAttribute('class') || '' : '',
                ctx: selected ? getComputedStyle(selected.querySelector('.composer-model-option-ctx')).color : '',
                label: selected ? getComputedStyle(selected.querySelector('.composer-model-label')).color : '',
                tickColor: tick ? getComputedStyle(tick).color : '',
                wash: selected ? getComputedStyle(selected).backgroundColor : '',
                otherCtx: other ? getComputedStyle(other.querySelector('.composer-model-option-ctx')).color : '',
                otherWash: other ? getComputedStyle(other).backgroundColor : '',
              };
            }"""
        )

        # 第二段：分组标题只在吸顶时压底色，否则滚过去的行会从标题底下穿过去。
        page.evaluate(
            """() => {
              document.querySelector('.composer-model-menu').remove();
              const rows = (prefix) => Array.from({ length: 8 }, (_, i) =>
                `<button type="button" role="menuitemradio" aria-checked="false" title="${prefix}-${i}" class="composer-plus-item composer-model-option"><span class="composer-model-option-main"><span class="composer-model-label">${prefix} ${i}</span><span class="composer-model-option-meta"><span class="composer-model-option-ctx">200K</span></span></span></button>`).join('');
              const group = (label, prefix) => `<div class="composer-model-group" role="group" aria-label="${label}"><div class="composer-model-group-label">${label}</div>${rows(prefix)}</div>`;
              document.body.insertAdjacentHTML('beforeend', `
                <div class="composer-model-menu is-open">
                  <div class="composer-menu-root">
                    <div class="composer-model-search"><input></div>
                    <div class="composer-model-list">
                      <button class="composer-menu-entry" aria-expanded="true">Other models</button>
                      ${group('Alpha', 'a')}${group('Beta', 'b')}${group('Gamma', 'c')}
                    </div>
                  </div>
                </div>`);
            }"""
        )
        page.wait_for_selector(".piopt-mp-view [data-piopt-mp-item]", state="attached", timeout=4000)
        page.wait_for_timeout(300)
        page.evaluate("() => { document.querySelector('.composer-model-list').scrollTop = 120; }")
        page.wait_for_timeout(120)
        sticky = page.evaluate(
            """() => {
              const list = document.querySelector('.composer-model-list');
              const labels = [...document.querySelectorAll('.piopt-mp-view .composer-model-group-label')];
              const listTop = list.getBoundingClientRect().top;
              const stuck = labels.find((label) => Math.abs(label.getBoundingClientRect().top - listTop) < 1);
              const loose = labels[labels.length - 1];
              const background = (label) => getComputedStyle(label.firstElementChild).backgroundColor;
              // 原生分组还在 DOM 里（视图显示时整组隐藏）：搜索时用宿主自己的标题底色。
              const native = document.querySelector('.composer-model-list > .composer-model-group > .composer-model-group-label');
              return {
                scrollTop: list.scrollTop,
                labels: labels.length,
                stuck: !!stuck,
                stuckTitle: stuck ? getComputedStyle(stuck.firstElementChild).backgroundColor : '',
                stuckBackdrop: stuck ? getComputedStyle(stuck.firstElementChild).backdropFilter : '',
                stuckHeight: stuck ? stuck.getBoundingClientRect().height : 0,
                stuckWidth: stuck ? stuck.getBoundingClientRect().width : 0,
                stuckTitleHeight: stuck ? stuck.firstElementChild.getBoundingClientRect().height : 0,
                stuckTitleWidth: stuck ? stuck.firstElementChild.getBoundingClientRect().width : 0,
                stuckTitleRadius: stuck ? getComputedStyle(stuck.firstElementChild).borderRadius : '',
                stuckTitleShadow: stuck ? getComputedStyle(stuck.firstElementChild).boxShadow : '',
                looseTitle: background(loose),
                looseBackdrop: getComputedStyle(loose).backdropFilter,
                nativeTitle: native ? getComputedStyle(native).backgroundColor : '',
              };
            }"""
        )

        # 第三段：「默认」排列按宿主那份完整顺序平铺。宿主把最近用过的模型从分组里
        # 剔了出去，所以这里用会搜索的迷你宿主（HOST_MOCK）让它把顺序问出来 ——
        # 最近用过的那一行要回到 Alpha 组里的原位，能力标记与来源照旧。
        page.add_script_tag(content=HOST_MOCK)
        page.evaluate(
            """([dom]) => {
              localStorage.removeItem('piopt.modelPicker.order.v1');
              picker.unmountModelPicker();
              document.querySelector('.composer-model-menu').remove();
              document.body.insertAdjacentHTML('beforeend', dom);
              window.renderHost('');
              window.mountReady = picker.mountModelPicker({dispatch: async () => ({config: {grouping: 'default'}})});
            }""",
            [HOST_DOM],
        )
        page.wait_for_function(
            "() => !!localStorage.getItem('piopt.modelPicker.order.v1')", timeout=8000
        )
        page.wait_for_selector('.piopt-mp-view[data-piopt-mp-layout="default"]', state="attached", timeout=8000)
        page.wait_for_timeout(400)
        host_order = page.evaluate(
            """() => {
              const inView = (node) => !!node.closest('.piopt-mp-view');
              const nativeRows = [...document.querySelectorAll('.composer-model-list .composer-model-option')].filter((row) => !inView(row));
              const viewRows = [...document.querySelectorAll('.piopt-mp-view [data-piopt-mp-item]')];
              const label = (row) => row.querySelector('.composer-model-label').textContent.trim();
              const title = (row) => row.getAttribute('title') || '';
              const source = (row) => getComputedStyle(row.querySelector('.composer-model-option-main'), '::after').content;
              const recent = viewRows.find((row) => title(row).includes(' · '));
              const plain = viewRows[1];
              return {
                layout: document.querySelector('.piopt-mp-view').getAttribute('data-piopt-mp-layout'),
                nativeLabels: nativeRows.map(label),
                viewLabels: viewRows.map(label),
                nativeTitles: [...document.querySelectorAll('.composer-model-list > .composer-model-group > .composer-model-group-label')].map((node) => node.textContent.trim()),
                viewTitles: [...document.querySelectorAll('.piopt-mp-view .composer-model-group-label')].map((node) => node.textContent.trim()),
                recentTitle: recent ? title(recent) : '',
                recentSource: recent ? source(recent) : '',
                firstHasBadge: !!recent.querySelector('.composer-model-option-meta .composer-model-option-badge'),
                firstCtx: recent.querySelector('.composer-model-option-ctx') ? recent.querySelector('.composer-model-option-ctx').textContent : '',
                plainSource: plain ? source(plain) : '',
                modes: [...document.querySelectorAll('[data-piopt-mp-mode]')].map((node) => node.textContent.trim()),
                pressed: [...document.querySelectorAll('[data-piopt-mp-mode][aria-pressed="true"]')].map((node) => node.getAttribute('data-piopt-mp-mode')),
              };
            }"""
        )

        # 第四段：切到「按名称」。来源那一行改由行上的属性驱动之后，平铺视图仍然
        # 每行都有它，而且照旧另起一行。
        page.click('[data-piopt-mp-mode="name"]')
        page.wait_for_selector('.piopt-mp-view[data-piopt-mp-layout="name"]', state="attached", timeout=4000)
        page.wait_for_timeout(200)
        by_name = page.evaluate(
            """() => {
              const rows = [...document.querySelectorAll('.piopt-mp-view [data-piopt-mp-item]')];
              const main = (row) => row.querySelector('.composer-model-option-main');
              return {
                labels: rows.map((row) => row.querySelector('.composer-model-label').textContent.trim()),
                sources: rows.map((row) => getComputedStyle(main(row), '::after').content),
                wraps: rows.map((row) => getComputedStyle(main(row)).flexWrap),
              };
            }"""
        )

        browser.close()

    server.shutdown()
    server.server_close()

print(json.dumps(state, ensure_ascii=False, indent=2))
assert not errors, errors
assert state["rows"] == 2, state
# 宿主只给分组里的选中行挂这两个类，最近使用组的那一行靠模块补齐。
assert "active" in state["classes"].split(), state
assert "composer-model-check" in state["tick"].split(), state
# 上下文读数与勾都跟名称一样变成前景色（PiOpt 主题下 accent 就是前景色）。
assert state["ctx"] == WHITE == state["label"], state
assert state["tickColor"] == WHITE, state
assert state["wash"] not in ("", "rgba(0, 0, 0, 0)"), state
# 未选中的行保持淡色，也没有选中底色。
assert state["otherCtx"] != WHITE, state
assert state["otherWash"] in ("rgba(0, 0, 0, 0)", "transparent"), state
print("PASS model picker: selected recent row keeps the host's active wash, white context and tick")
print(json.dumps(sticky, ensure_ascii=False, indent=2))
assert sticky["scrollTop"] > 0, sticky
assert sticky["labels"] == 3, sticky
# 吸顶时只罩住文字本身：一个圆角小块，不拉成整行、也不盖满整条标题。
assert sticky["stuck"], sticky
assert sticky["stuckTitle"] not in ("transparent", "rgba(0, 0, 0, 0)"), sticky
assert "blur" in sticky["stuckBackdrop"], sticky
assert sticky["stuckTitleWidth"] < sticky["stuckWidth"] - 40, sticky
assert sticky["stuckTitleHeight"] < sticky["stuckHeight"] - 3, sticky
assert sticky["stuckTitleRadius"] not in ("0px", ""), sticky
# 小块要像一片压在列表上的浮层：有厚度（不透明底）、模糊和投影。
assert sticky["stuckTitleShadow"] not in ("none", ""), sticky
# 没吸顶的标题保持原来的样子：不压底色、不模糊。
assert sticky["looseTitle"] in ("transparent", "rgba(0, 0, 0, 0)"), sticky
assert sticky["looseBackdrop"] in ("none", ""), sticky
# 原生分组标题仍用宿主自己的底色（搜索时显示的就是它）。
assert sticky["nativeTitle"] not in ("transparent", "rgba(0, 0, 0, 0)", ""), sticky
print("PASS model picker: group label only paints its own wash while stuck")
print(json.dumps(by_name, ensure_ascii=False, indent=2))
assert by_name["labels"] == ["Model A", "Model B", "Zeta 1", "Zeta 2"], by_name
assert by_name["sources"] == ['"Alpha"', '"Alpha"', '"Zeta"', '"Zeta"'], by_name
assert by_name["wraps"] == ["wrap"] * 4, by_name
print("PASS model picker: name arrangement keeps its source line under every option")
print(json.dumps(host_order, ensure_ascii=False, indent=2))
assert host_order["layout"] == "default", host_order
# 四个按钮的顺序，以及当前选中的就是「默认」。
assert host_order["modes"] == ["默认", "供应商", "厂商", "名称"], host_order
assert host_order["pressed"] == ["default"], host_order
# 「最近使用」那一类连标题一起没有：视图里一个分组抬头都没有。
assert host_order["nativeTitles"] == ["Recent", "Zeta", "Alpha"], host_order
assert host_order["viewTitles"] == [], host_order
# 原生列表把 model-a 摆在最前（宿主随手放那儿），视图把它送回 Alpha 组里它的位置
# —— 顺序与设置里那份一致：Zeta 组在前、组内原序，Alpha 组里 model-b 在 model-a 之前。
assert host_order["nativeLabels"] == ["Model A", "Zeta 2", "Zeta 1", "Model B"], host_order
assert host_order["viewLabels"] == ["Zeta 2", "Zeta 1", "Model B", "Model A"], host_order
# 能力标记照旧补上；平铺之后没有抬头写着供应商，所以每行都写一行来源。
assert host_order["recentTitle"] == "Alpha · model-a", host_order
assert host_order["firstHasBadge"], host_order
assert host_order["firstCtx"] == "200K", host_order
assert host_order["recentSource"] == '"Alpha"', host_order
assert host_order["plainSource"] == '"Zeta"', host_order
print("PASS model picker: default arrangement restores the configured order")
