"""Real Chromium regression for the model picker rewrite.

The popup in PI-Desktop 0.22 is a rail of providers next to one group at a time;
this module turns it back into one list of every model. The fixture below is a
miniature host that renders exactly that structure, so the run checks the rewrite
against the shipped DOM rather than against a guess.

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

# Host 0.22 rules that decide the popup's geometry, copied from the shipped app.asar.
HOST = """
[hidden]{display:none!important}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:var(--ds-bg-primary);color:var(--ds-text-primary)}
:root{--text-2xs:10px}
.composer-model-menu{position:fixed;top:0;left:0;padding:5px;border-radius:var(--radius-xl);background:var(--ds-bg-elevated-opaque);width:min(240px,100vw - 24px);max-height:min(520px,100vh - 92px);overflow-y:auto}
.composer-model-thinking-menu{width:min(320px,100vw - 24px);padding:6px}
.composer-model-thinking-menu.has-rail{width:min(420px,100vw - 24px)}
.composer-model-thinking-menu .composer-menu-root{flex-direction:column;gap:0;display:flex}
.composer-model-thinking-menu .composer-model-search{margin:0 -6px 6px}
.composer-model-thinking-menu .composer-plus-item{border-radius:var(--radius-2xs);min-height:28px;transition:background var(--motion-duration-fast) var(--motion-ease-out);gap:8px;padding:0 8px}
.composer-model-thinking-menu .composer-model-option.active,.composer-model-thinking-menu .composer-model-option.active.kb-active{background:0 0}
.composer-model-thinking-menu .composer-model-option.active:hover{background:var(--ds-bg-hover)}
.composer-model-thinking-menu .composer-model-option.active .composer-model-label{font-weight:var(--font-weight-medium)}
.composer-model-thinking-menu .composer-model-group-label{font-size:var(--text-2xs);padding:8px 8px 3px}
.composer-model-body{min-height:0;display:flex}
.composer-model-body[data-rail]{grid-template-columns:116px minmax(0,1fr);display:grid}
.composer-model-body[data-rail] .composer-model-list,.composer-model-body[data-rail] .composer-model-rail{height:min(264px,calc(var(--model-pane-rows,8) * 30px + 4px));max-height:none}
.composer-model-body[data-rail] .composer-model-list{padding-left:6px}
.composer-model-rail{border-right:1px solid var(--ds-border-subtle);flex-direction:column;gap:2px;padding-right:6px;display:flex;position:relative;overflow-y:auto}
.composer-model-rail-item{border-radius:var(--radius-2xs);min-width:0;height:28px;color:var(--ds-text-muted);font-size:var(--text-sm);text-align:left;cursor:pointer;flex:none;align-items:center;gap:6px;padding:0 8px;display:flex;border:0;background:transparent;font-family:inherit}
.composer-model-rail-item.active{color:var(--ds-text-primary);font-weight:var(--font-weight-medium)}
.composer-model-rail-label{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}
.composer-model-rail-count{color:var(--ds-text-faint);font-size:var(--text-2xs);font-weight:var(--font-weight-normal);flex:none}
.composer-model-list{flex:1;min-width:0;max-height:264px;overflow-y:auto}
.composer-plus-item{border-radius:var(--radius-md);width:100%;color:var(--ds-text-primary);font-size:var(--text-md);line-height:var(--leading-compact);text-align:left;cursor:pointer;align-items:center;gap:10px;padding:8px 10px;display:flex;border:0;background:transparent;font-family:inherit}
.composer-model-group-label{z-index:1;position:sticky;top:0;background:var(--ds-bg-elevated-opaque);padding:6px 8px 2px;color:var(--ds-text-muted);font-size:var(--text-xs-plus);font-weight:600}
.composer-model-group .composer-model-option{font-size:var(--text-sm);font-weight:var(--font-weight-normal);padding-left:8px}
.composer-model-option-main{flex-flow:row;flex:1;align-items:baseline;gap:2px 8px;min-width:0;display:flex}
.composer-model-label{min-width:0;max-width:100%;color:var(--ds-text-primary);text-overflow:ellipsis;white-space:nowrap;flex:0 auto;overflow:hidden}
.composer-model-label.is-alias{border-radius:var(--radius-full);background:var(--ds-tile-deep);padding:1px 6px}
.composer-model-option-meta{flex:0 auto;align-items:center;gap:4px;min-width:0;margin-left:auto;display:flex}
.composer-model-option-meta>span{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.composer-model-option-badge{color:var(--ds-text-faint);flex:none;align-items:center;display:inline-flex}
.composer-model-option-ctx{color:var(--ds-text-faint);font-size:var(--text-2xs);font-variant-numeric:tabular-nums}
.composer-model-option-provider{color:var(--ds-text-faint);font-size:var(--text-2xs)}
.composer-model-check{flex:none;color:var(--ds-accent)!important}
.composer-model-check-slot{flex:0 0 13px;justify-content:center;display:inline-flex}
.composer-model-search{border-bottom:1px solid var(--ds-border-subtle);height:38px;color:var(--ds-text-faint);align-items:center;gap:8px;padding:0 10px 0 14px;display:flex}
.composer-model-search input{min-width:0;height:100%;color:var(--ds-text-primary);font-size:var(--text-sm-plus);background:0 0;border:0;outline:none;flex:1}
.composer-plus-item svg{color:var(--ds-text-secondary);flex:none}
.composer-plus-item span{min-width:0}
"""

CHECK = ('<svg class="composer-model-check" width="13" height="13" viewBox="0 0 24 24" fill="none" '
         'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
         '<path d="M20 6 9 17l-5-5"/></svg>')

# 第三段用：会像宿主那样渲染的迷你「宿主」。左栏一格一个供应商，右边一次只画一组；
# 搜索时改画全部匹配的分组（和宿主的另一条渲染路径一致）。
HOST_DOM = """
<div class="composer-model-menu composer-model-thinking-menu has-rail">
  <div class="composer-menu-root">
    <div class="composer-model-search"><input></div>
    <div class="composer-model-body" data-rail="true" style="--model-pane-rows:8"></div>
  </div>
</div>
"""

HOST_MOCK = """
(() => {
  const CHECK = __CHECK__;
  const BADGE = '<span class="composer-model-option-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20"/></svg></span>';
  const META = '<span class="composer-model-option-meta">' + BADGE + '<span class="composer-model-option-ctx">200K</span></span>';
  const RECENT_NAME = '最近使用的模型';
  // 设置里的顺序：Zeta 在前、Alpha 在后；组内也是设置里的顺序（不是 A–Z）。
  window.hostState = {
    providers: [
      { id: 'zeta', name: 'Zeta', models: [{ id: 'zeta-2', label: 'Zeta 2' }, { id: 'zeta-1', label: 'Zeta 1' }] },
      { id: 'alpha', name: 'Alpha', models: [{ id: 'claude-4', label: 'Claude 4' }, { id: 'gpt-5', label: 'GPT 5' }] },
    ],
    recent: ['gpt-5'],
    selected: 'gpt-5',
    section: 'recent',
    query: '',
  };

  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const providerOf = (modelId) => window.hostState.providers.find((p) => p.models.some((m) => m.id === modelId));

  function option(model, showProvider) {
    const provider = providerOf(model.id);
    const active = window.hostState.selected === model.id;
    const meta = showProvider
      ? '<span class="composer-model-option-meta"><span class="composer-model-option-provider">' + esc(provider.name) + '</span></span>'
      : META;
    return '<button type="button" role="menuitemradio" aria-checked="' + active + '" title="' + esc(model.id) + '"'
      + ' class="composer-plus-item composer-model-option ' + (active ? 'active' : '') + '">'
      + '<span class="composer-model-option-main"><span class="composer-model-label">' + esc(model.label) + '</span>' + meta + '</span>'
      + '<span class="composer-model-check-slot" aria-hidden="true">' + (active ? CHECK : '') + '</span>'
      + '</button>';
  }

  function group(name, models, showProvider, withLabel) {
    return '<div class="composer-model-group" role="group" aria-label="' + esc(name) + '">'
      + (withLabel ? '<div class="composer-model-group-label">' + esc(name) + '</div>' : '')
      + models.map((model) => option(model, showProvider)).join('')
      + '</div>';
  }

  function rail() {
    const state = window.hostState;
    const items = ['<span class="composer-model-rail-indicator" aria-hidden="true"></span>']
      .concat('<button type="button" role="menuitemradio" aria-checked="' + (state.section === 'recent') + '"'
        + ' data-section="recent" title="' + RECENT_NAME + '"'
        + ' class="composer-model-rail-item ' + (state.section === 'recent' ? 'active' : '') + '">'
        + '<span class="composer-model-rail-label">' + RECENT_NAME + '</span></button>')
      .concat(state.providers.map((provider) => '<button type="button" role="menuitemradio"'
        + ' aria-checked="' + (state.section === provider.id) + '" data-section="' + provider.id + '"'
        + ' title="' + esc(provider.name) + '"'
        + ' class="composer-model-rail-item ' + (state.section === provider.id ? 'active' : '') + '">'
        + '<span class="composer-model-rail-label">' + esc(provider.name) + '</span>'
        + '<span class="composer-model-rail-count">' + provider.models.length + '</span></button>'));
    return '<div class="composer-model-rail" role="group" aria-label="模型来源">' + items.join('') + '</div>';
  }

  function pane() {
    const state = window.hostState;
    const query = state.query.trim().toLowerCase();
    const parts = [];
    if (query) {
      // 搜索：宿主一次画出所有匹配的分组，并且带上分组抬头。
      for (const provider of state.providers) {
        const shown = provider.models.filter((model) => (model.id + ' ' + model.label + ' ' + provider.name).toLowerCase().includes(query));
        if (shown.length) parts.push(group(provider.name, shown, false, true));
      }
      if (!parts.length) parts.push('<div class="composer-model-empty">没有匹配的模型</div>');
    } else if (state.section === 'recent') {
      const models = state.recent.map((id) => providerOf(id).models.find((model) => model.id === id));
      parts.push(group(RECENT_NAME, models, true, false));
    } else {
      const provider = state.providers.find((item) => item.id === state.section);
      parts.push(group(provider.name, provider.models, false, false));
    }
    return '<div class="composer-model-pane">' + parts.join('') + '</div>';
  }

  // 像 React 那样只重建它自己的两个子节点：左栏与 pane。列表里还挂着模块自己的
  // 那份视图，整体重写会把别人的节点一起冲掉。
  window.renderHost = () => {
    const body = document.querySelector('.composer-model-body');
    if (!body) return;
    // 只有带左栏的宿主才画栏；别把模块删掉的那条栏又画回来。
    if (body.hasAttribute('data-rail')) {
      const railEl = body.querySelector('.composer-model-rail');
      if (railEl) railEl.outerHTML = rail();
      else body.insertAdjacentHTML('afterbegin', rail());
    }
    if (!body.querySelector('.composer-model-list')) {
      body.insertAdjacentHTML('beforeend', '<div class="composer-model-list"></div>');
    }
    const listEl = body.querySelector('.composer-model-list');
    const html = pane();
    const paneEl = listEl.querySelector('.composer-model-pane');
    if (paneEl) paneEl.outerHTML = html;
    else listEl.insertAdjacentHTML('afterbegin', html);
  };

  document.addEventListener('click', (event) => {
    const railItem = event.target.closest && event.target.closest('.composer-model-rail-item');
    if (railItem) {
      window.hostState.section = railItem.dataset.section;
      queueMicrotask(window.renderHost);
      return;
    }
    const optionEl = event.target.closest && event.target.closest('.composer-model-option');
    if (optionEl) {
      window.hostState.selected = optionEl.getAttribute('title');
      queueMicrotask(window.renderHost);
    }
  }, true);

  document.addEventListener('input', (event) => {
    const input = event.target;
    if (!input || !input.closest || !input.closest('.composer-model-search')) return;
    window.hostState.query = input.value;
    queueMicrotask(window.renderHost);
  });
})();
"""

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
        page = browser.new_page(viewport={"width": 900, "height": 700})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        # localStorage needs a real origin: the picker keeps its list there.
        page.goto(origin)
        page.set_content('<html lang="zh-CN" data-theme="dark"><body></body></html>')
        page.add_style_tag(content=TOKENS + HOST + PICKER_CSS)
        page.add_script_tag(content="(() => {" + PICKER + "\nwindow.picker = {mountModelPicker, unmountModelPicker};})()")
        page.add_script_tag(content=HOST_MOCK.replace("__CHECK__", json.dumps(CHECK)))
        page.evaluate(
            """(dom) => {
              localStorage.clear();
              document.body.insertAdjacentHTML('beforeend', dom);
              window.renderHost();
              window.mountReady = picker.mountModelPicker({dispatch: async () => ({config: {grouping: 'default'}})});
            }""",
            HOST_DOM,
        )
        page.wait_for_selector(".piopt-mp-view", state="attached", timeout=8000)
        page.wait_for_selector('.composer-model-menu[data-piopt-mp-ready="true"]', state="attached", timeout=8000)
        page.wait_for_timeout(200)

        # ---- 默认排列：左栏顺序原样平铺，一行不少，一行不重排。
        default_view = page.evaluate(
            """() => {
              const rows = [...document.querySelectorAll('.piopt-mp-view [data-piopt-mp-item]')];
              const label = (row) => row.querySelector('.composer-model-label').textContent.trim();
              const source = (row) => row.querySelector('.piopt-mp-source');
              const selected = rows.find((row) => row.getAttribute('aria-checked') === 'true');
              const heights = rows.map((row) => Math.round(row.getBoundingClientRect().height));
              const sourceTop = (row) => Math.round(source(row).getBoundingClientRect().top - row.querySelector('.composer-model-label').getBoundingClientRect().top);
              return {
                layout: document.querySelector('.piopt-mp-view').getAttribute('data-piopt-mp-layout'),
                labels: rows.map(label),
                titles: rows.map((row) => row.getAttribute('title')),
                sources: rows.map((row) => (source(row) ? source(row).textContent.trim() : '')),
                heights,
                sourceTop: rows.map(sourceTop),
                widths: rows.map((row) => Math.round(row.querySelector('.composer-model-label').getBoundingClientRect().width)),
                overlaps: rows.map((row) => {
                  const label = row.querySelector('.composer-model-label').getBoundingClientRect();
                  const src = source(row).getBoundingClientRect();
                  const meta = row.querySelector('.composer-model-option-meta').getBoundingClientRect();
                  return Math.round(Math.max(0, label.right - src.left) + Math.max(0, src.right - meta.left));
                }),
                wraps: rows.map((row) => getComputedStyle(row.querySelector('.composer-model-option-main')).flexWrap),
                railHidden: getComputedStyle(document.querySelector('.composer-model-rail')).display,
                menuWidth: Math.round(document.querySelector('.composer-model-menu').getBoundingClientRect().width),
                selectedTitle: selected ? selected.getAttribute('title') : '',
                selectedCheck: selected ? !!selected.querySelector('.composer-model-check-slot svg') : false,
                modes: [...document.querySelectorAll('[data-piopt-mp-mode]')].map((node) => node.textContent.trim()),
                pressed: [...document.querySelectorAll('[data-piopt-mp-mode][aria-pressed="true"]')].map((node) => node.getAttribute('data-piopt-mp-mode')),
                cache: !!localStorage.getItem('piopt.modelPicker.rows.v1'),
              };
            }"""
        )

        # ---- 选中：点一条，模块先切到那一格，再点原生按钮。
        page.click('.piopt-mp-view [data-piopt-mp-item][title="zeta-2"]')
        page.wait_for_timeout(300)
        picked = page.evaluate(
            """() => {
              const rows = [...document.querySelectorAll('.piopt-mp-view [data-piopt-mp-item]')];
              const selected = rows.filter((row) => row.getAttribute('aria-checked') === 'true');
              return {
                host: window.hostState.selected,
                section: window.hostState.section,
                checked: selected.map((row) => row.getAttribute('title')),
                active: rows.filter((row) => row.classList.contains('active')).map((row) => row.getAttribute('title')),
                ticks: rows.filter((row) => row.querySelector('.composer-model-check-slot svg')).map((row) => row.getAttribute('title')),
              };
            }"""
        )

        # ---- 方向键：光标在整份列表上走，回车选中光标那一行。
        page.click(".composer-model-search input")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(120)
        keyboard_before = page.evaluate(
            """() => ({
              highlighted: [...document.querySelectorAll('.piopt-mp-view [data-piopt-mp-item].kb-active')]
                .map((row) => row.getAttribute('title')),
              hostSelected: window.hostState.selected,
            })"""
        )
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        keyboard_after = page.evaluate(
            """() => ({
              hostSelected: window.hostState.selected,
              checked: [...document.querySelectorAll('.piopt-mp-view [data-piopt-mp-item][aria-checked="true"]')]
                .map((row) => row.getAttribute('title')),
            })"""
        )

        # ---- 按供应商：分组名与组内都按 A–Z。
        page.click('[data-piopt-mp-mode="provider"]')
        page.wait_for_selector('.piopt-mp-view[data-piopt-mp-layout="provider"]', state="attached", timeout=4000)
        page.wait_for_timeout(150)
        by_provider = page.evaluate(
            """() => {
              const groups = [...document.querySelectorAll('.piopt-mp-view > .composer-model-group')];
              return {
                titles: groups.map((group) => group.querySelector('.composer-model-group-label').textContent.trim()),
                rows: groups.map((group) => [...group.querySelectorAll('[data-piopt-mp-item]')]
                  .map((row) => row.querySelector('.composer-model-label').textContent.trim())),
                sources: [...document.querySelectorAll('.piopt-mp-view .piopt-mp-source')].length,
              };
            }"""
        )

        # ---- 按厂商：品牌名成为分组名。
        page.click('[data-piopt-mp-mode="vendor"]')
        page.wait_for_selector('.piopt-mp-view[data-piopt-mp-layout="vendor"]', state="attached", timeout=4000)
        page.wait_for_timeout(150)
        by_vendor = page.evaluate(
            """() => {
              const groups = [...document.querySelectorAll('.piopt-mp-view > .composer-model-group')];
              return {
                titles: groups.map((group) => group.querySelector('.composer-model-group-label').textContent.trim()),
                rows: groups.map((group) => [...group.querySelectorAll('[data-piopt-mp-item]')]
                  .map((row) => row.querySelector('.composer-model-label').textContent.trim())),
              };
            }"""
        )

        # ---- 按名称：全局 A–Z，每行都是单行（来源跟在名称后面，不另起一行）。
        page.click('[data-piopt-mp-mode="name"]')
        page.wait_for_selector('.piopt-mp-view[data-piopt-mp-layout="name"]', state="attached", timeout=4000)
        page.wait_for_timeout(150)
        by_name = page.evaluate(
            """() => {
              const rows = [...document.querySelectorAll('.piopt-mp-view [data-piopt-mp-item]')];
              return {
                labels: rows.map((row) => row.querySelector('.composer-model-label').textContent.trim()),
                sources: rows.map((row) => (row.querySelector('.piopt-mp-source') || {}).textContent || ''),
                heights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
                sourceTop: rows.map((row) => {
                  const source = row.querySelector('.piopt-mp-source');
                  if (!source) return -1;
                  return Math.round(source.getBoundingClientRect().top - row.querySelector('.composer-model-label').getBoundingClientRect().top);
                }),
              };
            }"""
        )

        # ---- 搜索：自建视图与左栏一起让位，把宿主自己的结果放回来。
        page.fill(".composer-model-search input", "zeta")
        page.wait_for_timeout(250)
        searching = page.evaluate(
            """() => ({
              attr: document.querySelector('.composer-model-menu').getAttribute('data-piopt-mp-searching'),
              viewDisplay: getComputedStyle(document.querySelector('.piopt-mp-view')).display,
              railDisplay: getComputedStyle(document.querySelector('.composer-model-rail')).display,
              nativeLabels: [...document.querySelectorAll('.composer-model-pane .composer-model-label')]
                .map((node) => node.textContent.trim()),
              nativeTitles: [...document.querySelectorAll('.composer-model-pane .composer-model-group-label')]
                .map((node) => node.textContent.trim()),
            })"""
        )
        page.fill(".composer-model-search input", "")
        page.wait_for_timeout(300)
        restored = page.evaluate(
            """() => ({
              attr: document.querySelector('.composer-model-menu').getAttribute('data-piopt-mp-searching'),
              viewDisplay: getComputedStyle(document.querySelector('.piopt-mp-view')).display,
              rows: document.querySelectorAll('.piopt-mp-view [data-piopt-mp-item]').length,
            })"""
        )

        # ---- 选中标记换成圆角框：描边画在行里，勾位留着不动。
        page.evaluate("() => { window.mountReady = picker.mountModelPicker({dispatch: async () => ({config: {grouping: 'name', frameSelected: true}})}); }")
        page.wait_for_timeout(300)
        framed = page.evaluate(
            """() => {
              const row = document.querySelector('.piopt-mp-view [data-piopt-mp-item][aria-checked="true"]');
              const slot = row.querySelector('.composer-model-check-slot');
              return {
                marker: document.querySelector('.composer-model-menu').getAttribute('data-piopt-mp-marker'),
                shadow: getComputedStyle(row).boxShadow,
                slotDisplay: getComputedStyle(slot).display,
                slotWidth: Math.round(slot.getBoundingClientRect().width),
                tickDisplay: slot.querySelector('svg') ? getComputedStyle(slot.querySelector('svg')).display : 'none',
              };
            }"""
        )


        # ---- 没有左栏时（宿主只有一个分组）：直接读当前这一组，一行不少。
        page.evaluate(
            """() => {
              picker.unmountModelPicker();
              localStorage.clear();
              const body = document.querySelector('.composer-model-body');
              body.removeAttribute('data-rail');
              const rail = body.querySelector('.composer-model-rail');
              if (rail) rail.remove();
              window.hostState.section = 'alpha';
              window.renderHost();
              window.mountReady = picker.mountModelPicker({dispatch: async () => ({config: {grouping: 'default'}})});
            }"""
        )
        page.wait_for_selector('.piopt-mp-view[data-piopt-mp-layout="default"]', state="attached", timeout=8000)
        page.wait_for_timeout(300)
        single = page.evaluate(
            """() => ({
              titles: [...document.querySelectorAll('.piopt-mp-view [data-piopt-mp-item]')]
                .map((row) => row.getAttribute('title')),
              sources: [...document.querySelectorAll('.piopt-mp-view .piopt-mp-source')]
                .map((node) => node.textContent.trim()),
            })"""
        )
        browser.close()

    server.shutdown()
    server.server_close()

print(json.dumps(default_view, ensure_ascii=False, indent=2))
assert not errors, errors
# 四行都在：左栏里三格，只有一组被画出来，视图拿到的却是全部。
assert default_view["layout"] == "default", default_view
assert default_view["titles"] == ["zeta-2", "zeta-1", "claude-4", "gpt-5"], default_view
assert default_view["labels"] == ["Zeta 2", "Zeta 1", "Claude 4", "GPT 5"], default_view
assert default_view["sources"] == ["Zeta", "Zeta", "Alpha", "Alpha"], default_view
assert default_view["cache"], default_view
# 左栏让位，菜单宽度收回原来的 320px。
assert default_view["railHidden"] == "none", default_view
assert default_view["menuWidth"] == 320, default_view
# 每行都是单行：来源跟在名称后面，不另起一行，也不把行拉高。
assert default_view["wraps"] == ["nowrap"] * 4, default_view
# 名称没被压扁，也没有和来源、徽标挤在一起。
assert all(width >= 30 for width in default_view["widths"]), default_view
assert default_view["overlaps"] == [0, 0, 0, 0], default_view
assert all(28 <= height <= 30 for height in default_view["heights"]), default_view
assert all(abs(offset) <= 5 for offset in default_view["sourceTop"]), default_view
# 选中的那一行带勾，且只有它。
assert default_view["selectedTitle"] == "gpt-5", default_view
assert default_view["selectedCheck"], default_view
assert default_view["modes"] == ["默认", "供应商", "厂商", "名称"], default_view
assert default_view["pressed"] == ["default"], default_view
print("PASS model picker: every provider's models in one list, in the configured order")

print(json.dumps(picked, ensure_ascii=False, indent=2))
assert picked["host"] == "zeta-2", picked
assert picked["section"] == "zeta", picked
assert picked["checked"] == ["zeta-2"], picked
assert picked["active"] == ["zeta-2"], picked
assert picked["ticks"] == ["zeta-2"], picked
print("PASS model picker: clicking a row selects it through the host's own button")

print(json.dumps(keyboard_before, ensure_ascii=False, indent=2), json.dumps(keyboard_after, ensure_ascii=False, indent=2))
assert keyboard_before["highlighted"] == ["claude-4"], keyboard_before
assert keyboard_before["hostSelected"] == "zeta-2", keyboard_before
assert keyboard_after["hostSelected"] == "claude-4", keyboard_after
assert keyboard_after["checked"] == ["claude-4"], keyboard_after
print("PASS model picker: arrow keys walk the whole list and Enter selects")

print(json.dumps(by_provider, ensure_ascii=False, indent=2))
assert by_provider["titles"] == ["Alpha", "Zeta"], by_provider
assert by_provider["rows"] == [["Claude 4", "GPT 5"], ["Zeta 1", "Zeta 2"]], by_provider
assert by_provider["sources"] == 0, by_provider
print(json.dumps(by_vendor, ensure_ascii=False, indent=2))
assert by_vendor["titles"] == ["Anthropic", "OpenAI", "Zeta"], by_vendor
assert by_vendor["rows"] == [["Claude 4"], ["GPT 5"], ["Zeta 1", "Zeta 2"]], by_vendor
print("PASS model picker: provider and vendor groupings sort groups and rows A–Z")

print(json.dumps(by_name, ensure_ascii=False, indent=2))
assert by_name["labels"] == ["Claude 4", "GPT 5", "Zeta 1", "Zeta 2"], by_name
assert by_name["sources"] == ["Alpha", "Alpha", "Zeta", "Zeta"], by_name
assert all(28 <= height <= 30 for height in by_name["heights"]), by_name
assert all(abs(offset) <= 5 for offset in by_name["sourceTop"]), by_name
print("PASS model picker: name arrangement stays one line per model")

print(json.dumps(searching, ensure_ascii=False, indent=2), json.dumps(restored, ensure_ascii=False, indent=2))
assert searching["attr"] == "true", searching
assert searching["viewDisplay"] == "none", searching
assert searching["railDisplay"] == "none", searching
assert searching["nativeTitles"] == ["Zeta"], searching
assert restored["attr"] in (None, "false", ""), restored
assert restored["viewDisplay"] != "none", restored
assert restored["rows"] == 4, restored
print("PASS model picker: search hands the list back to the host and returns")

print(json.dumps(framed, ensure_ascii=False, indent=2))
assert framed["marker"] == "frame", framed
# 框是画在行里的内描边；勾位留着原来的宽度，行宽不因此跳动。
assert "inset" in framed["shadow"], framed
assert framed["slotWidth"] == 13, framed
assert framed["tickDisplay"] == "none", framed
print("PASS model picker: the frame marker keeps the tick slot and its width")

print(json.dumps(single, ensure_ascii=False, indent=2))
assert single["titles"] == ["claude-4", "gpt-5"], single
assert single["sources"] == ["Alpha", "Alpha"], single
print("PASS model picker: without a rail it lists the only group as-is")
