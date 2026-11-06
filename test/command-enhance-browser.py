"""Exercise host slash list enhancement and teardown in a real DOM."""
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
script = (ROOT/'renderer/command-enhance.mjs').read_text(encoding='utf-8').replace('export function ', 'function ').replace('export const ', 'const ')
css = subprocess.check_output(['node','-e',"process.stdout.write(require('./features/appearance/motion.js').buildThemeCss({override:true}))"],cwd=ROOT,text=True,encoding='utf-8')
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page()
    page.set_content('''<div contenteditable class="composer-input">/</div><div class="composer-autocomplete"><div class="composer-ac-list"><div class="composer-model-group-label">内置</div><button class="composer-ac-item"><span class="composer-ac-name">/help</span>帮助</button><div class="composer-model-group-label">技能</div><button class="composer-ac-item"><span class="composer-ac-name">/skill</span>技能</button></div></div><div class="composer-autocomplete" data-piopt-command-menu><div class="composer-ac-list"><div class="composer-model-group-label">插件</div></div></div>''')
    page.add_style_tag(content=css)
    page.add_script_tag(content='(() => {'+script+'\nwindow.startEnhance=mountCommandEnhance;window.stopEnhance=unmountCommandEnhance;const style=document.createElement("style");style.textContent=COMMAND_ENHANCE_CSS;document.head.append(style);})()')
    page.evaluate('''() => { window.chosen=''; document.querySelectorAll('.composer-ac-item').forEach(e=>e.addEventListener('mousedown',()=>window.chosen=e.textContent)); startEnhance(); }''')
    page.wait_for_selector('[data-piopt-native-search]')
    assert page.locator('[data-piopt-native-search]').count()==1
    assert page.locator('[data-piopt-slash-title]').count()==3
    page.locator('[data-piopt-native-search]').fill('skill')
    assert page.locator('.composer-ac-item:visible').count()==1
    assert page.locator('[data-piopt-slash-hidden]').count()==2
    page.locator('[data-piopt-native-search]').press('Enter')
    assert 'skill' in page.evaluate('chosen')
    page.locator('.composer-input').focus()
    assert page.locator('.composer-ac-item:visible').count()==2
    page.evaluate('stopEnhance()')
    assert page.locator('[data-piopt-native-search]').count()==0
    assert page.locator('[data-piopt-slash-title]').count()==0
    print('PASS native search, selection, reset, two menus and teardown')
    browser.close()
