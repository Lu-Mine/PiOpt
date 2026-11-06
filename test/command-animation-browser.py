"""Verify the plugin command menu enters through the host's open transition."""
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
script = (ROOT/'renderer/command-menu.mjs').read_text(encoding='utf-8').replace('export const ', 'const ').replace('export async function ', 'async function ').replace('export function ', 'function ')
css = subprocess.check_output(['node','-e',"process.stdout.write(require('./features/appearance/motion.js').buildThemeCss({override:true}))"],cwd=ROOT,text=True,encoding='utf-8')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_content('<div class="composer-input-wrap"><div class="composer-input" contenteditable></div></div><button id="trigger">指令</button>')
    page.add_style_tag(content='.composer-autocomplete{position:fixed;width:300px;height:180px;opacity:0;visibility:hidden}.composer-autocomplete.is-open{opacity:1;visibility:visible}'+css)
    page.evaluate('''() => { window.piDesktop={invoke:async()=>({ok:true,data:{commands:[{name:'help',kind:'builtin'}]}})}; window.host={dispatch:()=>{}} }''')
    page.add_script_tag(content='(() => {'+script+'\nwindow.openMenu=()=>openCommandMenu(document.querySelector("#trigger"),host);window.closeMenu=closeCommandMenu;})()')
    state = page.evaluate('''async () => { await openMenu(); const e=document.querySelector('.composer-autocomplete'); const before={open:e.classList.contains('is-open'),opacity:getComputedStyle(e).opacity}; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return {before,open:e.classList.contains('is-open'),animations:e.getAnimations().length,opacity:getComputedStyle(e).opacity}; }''')
    assert state['before']['open'] is False, state
    assert state['open'] and state['animations'] > 0 and float(state['opacity']) < 1, state
    page.evaluate('''async () => { closeMenu(); openMenu(); closeMenu(); await new Promise(requestAnimationFrame); }''')
    assert page.locator('.composer-autocomplete').count() == 0
    print('PASS: staged opening animates and quick close leaves no menu')
    browser.close()
