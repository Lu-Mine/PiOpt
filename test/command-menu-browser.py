"""Verify opening and filtering commands never edits the composer draft."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
script = (ROOT / 'renderer/command-menu.mjs').read_text(encoding='utf-8').replace('export const ', 'const ').replace('export async function ', 'async function ').replace('export function ', 'function ')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_content('<div contenteditable="true" class="composer-input">草稿</div><button id="trigger">指令</button>')
    page.evaluate('''() => { window.calls=[]; window.fetches=0; window.piDesktop={invoke:async()=>{window.fetches++; await new Promise(r=>setTimeout(r,150)); return {ok:true,data:{commands:[{name:'help',kind:'builtin',description:'帮助'},{name:'skill-test',kind:'skill',description:'技能'}]}}}}; window.host={dispatch:(action,payload)=>{window.calls.push({action,payload})}} }''')
    page.add_script_tag(content='(() => {' + script + '\nwindow.openMenu=()=>openCommandMenu(document.querySelector("#trigger"),window.host);window.closeMenu=closeCommandMenu;window.prefetch=prefetchCommands;})()')
    page.evaluate('prefetch()')
    assert page.evaluate('fetches') == 1
    page.evaluate('openMenu()')
    assert page.locator('.composer-ac-item').count() == 2
    page.locator('.composer-ac-item').first.wait_for()
    assert page.locator('.composer-input').inner_text() == '草稿'
    assert page.evaluate('calls.length') == 0
    assert page.locator('.composer-model-group-label').count() == 2
    page.locator('.piopt-command-search').fill('skill')
    assert page.locator('.composer-ac-item').count() == 1
    page.keyboard.press('Escape')
    assert page.locator('.composer-autocomplete').count() == 0
    assert page.locator('.composer-input').inner_text() == '草稿'
    page.evaluate('openMenu()')
    assert page.evaluate('fetches') == 1
    page.locator('.composer-ac-item').first.wait_for()
    page.locator('.composer-ac-item').filter(has_text='/help').click()
    assert page.evaluate('calls[0].payload.text') == '/help '
    assert page.locator('.composer-autocomplete').count() == 0
    print('PASS: open, filter and cancel preserve draft; selection inserts command')
    browser.close()
