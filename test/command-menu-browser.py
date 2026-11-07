"""Verify execution, safe fallbacks, errors and draft preservation."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
script = (ROOT / 'renderer/command-menu.mjs').read_text(encoding='utf-8').replace('export const ', 'const ').replace('export async function ', 'async function ').replace('export function ', 'function ')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_content('<div contenteditable="true" class="composer-input">草稿</div><button id="trigger">指令</button>')
    page.evaluate('''() => { window.calls=[]; window.fetches=0; window.fail=false; window.piDesktop={invoke:async(channel,arg)=>{ if(channel.includes('commands')) { window.fetches++; return {ok:true,data:{commands:[{name:'run',id:'plugin.run',kind:'plugin'},{name:'fail',id:'plugin.fail',kind:'plugin'},{name:'with-args',id:'plugin.args',kind:'plugin',argumentHint:'<value>'},{name:'template',kind:'template'},{name:'plan',id:'builtin.mode.plan',kind:'builtin'}]}} } window.calls.push({channel,arg}); return window.fail ? {ok:false,error:{message:'测试错误'}} : {ok:true,data:{}}; }}; window.host={dispatch:(action,payload)=>{window.calls.push({action,payload})}} }''')
    page.add_script_tag(content='(() => {' + script + '\nwindow.openMenu=()=>openCommandMenu(document.querySelector("#trigger"),window.host);window.prefetch=prefetchCommands;window.commandCss=COMMAND_MENU_CSS;})()')
    page.add_style_tag(content='input { background: white !important; box-shadow: 0 0 0 2px white !important; }')
    page.evaluate('''() => { const style=document.createElement('style'); style.textContent=window.commandCss; document.head.append(style); }''')
    page.evaluate('prefetch()')
    page.evaluate('openMenu()')
    page.locator('.composer-ac-item').first.wait_for()
    assert page.locator('.piopt-command-search').evaluate("e => getComputedStyle(e).backgroundColor") == 'rgba(0, 0, 0, 0)'
    page.locator('.composer-ac-item').filter(has_text='/run').click()
    page.wait_for_function("calls.length===1")
    assert page.evaluate('calls[0]') == {'channel':'pi-desktop/commandPalette/execute','arg':'plugin.run'}
    assert page.locator('.composer-input').inner_text() == '草稿'
    page.evaluate('openMenu()')
    page.locator('.composer-ac-item').filter(has_text='/with-args').click()
    page.wait_for_function('calls.length===2')
    assert page.evaluate('calls[1].payload.text') == '/with-args '
    page.evaluate('openMenu()')
    page.evaluate('fail=true')
    page.locator('.composer-ac-item').filter(has_text='/fail').click()
    page.get_by_role('alert').wait_for()
    assert '测试错误' in page.get_by_role('alert').inner_text()
    assert page.locator('.composer-input').inner_text() == '草稿'
    page.keyboard.press('Escape')
    page.evaluate('openMenu()')
    page.locator('.composer-ac-item').filter(has_text='/plan').click()
    page.wait_for_function('calls.length===4')
    assert page.evaluate('calls[3].payload.text') == '/plan '
    assert page.evaluate('fetches') == 1
    print('PASS: direct execution, argument and host-state fallbacks, error and draft preservation')
    browser.close()
