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
                stuckTitleHeight: stuck ? stuck.firstElementChild.getBoundingClientRect().height : 0,
                looseTitle: background(loose),
                looseBackdrop: getComputedStyle(loose).backdropFilter,
                nativeTitle: native ? getComputedStyle(native).backgroundColor : '',
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
# 吸顶的那一层与下面滚过去的行之间必须隔着一块底，且底要铺满整条标题。
assert sticky["stuck"], sticky
assert sticky["stuckTitle"] not in ("transparent", "rgba(0, 0, 0, 0)"), sticky
assert "blur" in sticky["stuckBackdrop"], sticky
assert abs(sticky["stuckTitleHeight"] - sticky["stuckHeight"]) < 1, sticky
# 没吸顶的标题保持原来的样子：不压底色、不模糊。
assert sticky["looseTitle"] in ("transparent", "rgba(0, 0, 0, 0)"), sticky
assert sticky["looseBackdrop"] in ("none", ""), sticky
# 原生分组标题仍用宿主自己的底色（搜索时显示的就是它）。
assert sticky["nativeTitle"] not in ("transparent", "rgba(0, 0, 0, 0)", ""), sticky
print("PASS model picker: group label only paints its own wash while stuck")
