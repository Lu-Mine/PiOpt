"""Exercise real flex layout, content changes and resize without touching the host."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
css = subprocess.check_output(['node', '-e', "process.stdout.write(require('./features/appearance/motion.js').buildThemeCss({override:true}))"], cwd=ROOT, text=True, encoding='utf-8')
script = (ROOT / 'renderer/composer-compact.mjs').read_text(encoding='utf-8').replace('export function ', 'function ')
html = '''<style>
*{box-sizing:border-box}.composer-stack{width:700px;container:composer-stack/inline-size}
.composer-toolbar{display:flex;justify-content:space-between;gap:8px;padding:4px 8px 8px}
.composer-left,.composer-right{display:flex;align-items:center;gap:4px;min-width:0;flex:0 auto}
button{font:14px sans-serif;display:inline-flex;align-items:center;gap:6px;padding:0 10px;height:28px;white-space:nowrap}
.composer-mode-chip{width:96px;min-width:96px;max-width:96px;flex:0 0 96px}.composer-mode-chip-face{display:inline-flex;gap:6px}
@container composer-stack (max-width:450px){.model{width:32px!important}}
</style><div class="composer-stack"><div class="composer-toolbar"><div class="composer-left">
<button style="width:28px">+</button><button class="composer-mode-chip"><span class="composer-mode-chip-face"><i>◦</i><span class="composer-mode-chip-label">智能体</span></span><span class="composer-mode-chip-caret">⌄</span></button>
<div class="composer-permission"><button data-piopt-permission-icon="auto"><span>全自动</span><svg width="12"></svg></button></div><button data-piopt-command-button><span><i>/</i><span class="composer-mode-chip-label">指令</span></span></button></div>
<div class="composer-right"><button class="model" style="width:160px">模型</button><button style="width:32px">发送</button></div></div></div>'''
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 900, 'height': 600})
    page.set_content(html)
    page.add_style_tag(content=css)
    page.add_script_tag(content='(() => {' + script + '\nwindow.startCompact=mountComposerCompact;window.stopCompact=unmountComposerCompact;})()')
    page.evaluate('startCompact()')
    def check(width, expected):
        page.locator('.composer-stack').evaluate('(e,w)=>e.style.width=w+"px"', width)
        page.wait_for_timeout(150)
        result = page.locator('.composer-toolbar').get_attribute('data-piopt-compact')
        assert (result == 'true') == expected, (width, result)
    check(700, False)
    check(440, True)
    check(700, False)
    page.locator('.composer-mode-chip-label').first.evaluate('(e)=>e.textContent="A considerably longer mode label"')
    check(540, True)
    check(850, False)
    page.evaluate('stopCompact()')
    assert page.locator('.composer-toolbar').get_attribute('data-piopt-compact') is None
    print('PASS: narrow, wide, long label, restore and unload')
    browser.close()
