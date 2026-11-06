"""Verify opening and filtering commands never edits the composer draft."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
script = (ROOT / 'renderer/command-menu.mjs').read_text(encoding='utf-8').replace('export const ', 'const ').replace('export async function ', 'async function ').replace('export function ', 'function ')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_content('<div contenteditable="true" class="composer-input">草稿</div><button id="trigger">指令</button>')
    page.evaluate('''() => { window.calls=[]; window.piDesktop={invoke:async()=>({ok:true,data:{commands:[{name:'help',kind:'builtin',description:'帮助'},{name:'skill-test',kind:'skill',description:'技能'}]}})}; window.host={dispatch:(action,payload)=>{window.calls.push({action,payload})}} }''')
    page.add_script_tag(content='(() => {' + script + '\nwindow.openMenu=()=>openCommandMenu(document.querySelector("#trigger"),window.host);window.closeMenu=closeCommandMenu;})()')
    page.evaluate('openMenu()')
    page.locator('.piopt-command-row').first.wait_for()
    assert page.locator('.composer-input').inner_text() == '草稿'
    assert page.evaluate('calls.length') == 0
    page.locator('.piopt-command-search').fill('skill')
    assert page.locator('.piopt-command-row').count() == 1
    page.keyboard.press('Escape')
    assert page.locator('.piopt-command-menu').count() == 0
    assert page.locator('.composer-input').inner_text() == '草稿'
    page.evaluate('openMenu()')
    page.locator('.piopt-command-row').first.wait_for()
    page.locator('.piopt-command-row').filter(has_text='/help').click()
    assert page.evaluate('calls[0].payload.text') == '/help '
    assert page.locator('.piopt-command-menu').count() == 0
    print('PASS: open, filter and cancel preserve draft; selection inserts command')
    browser.close()
