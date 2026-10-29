"""Real Chromium regressions for host motion. Run: python test/motion-browser.py.
Requires Python Playwright and its Chromium browser; no live host or settings writes.
"""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ASSETS = json.loads(subprocess.check_output([
    'node', '--input-type=module', '-e', '''
import motion from './features/appearance/motion.js';
import glass from './features/appearance/glass.js';
import {MODEL_PICKER_CSS} from './renderer/model-picker.mjs';
console.log(JSON.stringify({css:motion.buildThemeCss({speed:.4})+glass.buildGlassCss({enabled:true}),picker:MODEL_PICKER_CSS}));
'''], cwd=ROOT, text=True, encoding='utf-8'))

# Host 0.21 declarations involved in these regressions, including glass priority.
HOST = '''
[hidden]{display:none!important} body{margin:0}
.shell,.app-chat-shell{display:flex;height:500px;width:1000px;overflow:hidden}.main{flex:1;min-width:0}
.work-panel{flex:0 0 var(--work-panel-width);width:var(--work-panel-width);min-width:0;position:relative}
.dock{width:400px;overflow:hidden}.dock-content{display:grid;grid-template-rows:0fr;opacity:0;transform:translateY(-4px)}
.dock.is-expanded .dock-content{grid-template-rows:1fr;opacity:1;transform:none}
.dock-clip{min-height:0;overflow:hidden}.dock-panel{max-height:200px;overflow:auto}
.todo-dock-row{height:28px}.context-menu,.composer-model-menu{position:fixed;top:0;left:0;opacity:0;visibility:hidden;pointer-events:none;width:240px;background:#222}
.context-menu.is-open,.composer-model-menu.is-open{opacity:1;visibility:visible;pointer-events:auto}
.context-menu{height:100px}.composer-model-list{max-height:280px;overflow:auto}
.composer-model-option{display:block;height:30px}
'''
RUNTIME = (ROOT / 'renderer/motion-runtime.mjs').read_text(encoding='utf-8').replace('export ', '')
PICKER = (ROOT / 'renderer/model-picker.mjs').read_text(encoding='utf-8')
PICKER = PICKER.replace('import { ICONS } from "./model-logos/icons.mjs";', 'const ICONS = {};').replace('export ', '')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.set_content('<html><body></body></html>', wait_until='networkidle')
    page.add_style_tag(content=HOST + ASSETS['css'] + ASSETS['picker'])
    page.add_script_tag(content='(() => {' + RUNTIME + '\nwindow.motion = {mountMotionRuntime,unmountMotionRuntime,MOTION_RUNTIME_CSS};mountMotionRuntime();})()')
    page.add_style_tag(content=page.evaluate('motion.MOTION_RUNTIME_CSS'))

    # Work panel must beat the later glass animation:none!important rule.
    page.evaluate('''() => {document.body.insertAdjacentHTML('beforeend', '<div class="shell app-chat-shell"><main class="main"><div class="thread-content">Conversation</div></main><aside class="work-panel" style="--work-panel-width:400px"><div class="work-panel-main"><p>Long text stays on the same lines throughout the entire slide.</p></div></aside></div>')}''')
    assert page.locator('.work-panel').evaluate('(e)=>getComputedStyle(e).animationName') == 'work-panel-in-pm'
    page.wait_for_timeout(700)
    page.locator('.work-panel').evaluate('(e)=>e.classList.add("is-exiting")')
    assert page.locator('.work-panel').evaluate('(e)=>getComputedStyle(e).animationName') == 'work-panel-out-pm'
    samples = page.evaluate('''async () => {const result=[];for(let i=0;i<8;i++){await new Promise(requestAnimationFrame);result.push({main:document.querySelector('.main').getBoundingClientRect().width,inner:document.querySelector('.work-panel-main').getBoundingClientRect().width,left:document.querySelector('.work-panel-main').getBoundingClientRect().left})}return result}''')
    assert all(abs(s['inner']-400)<1 for s in samples), samples
    assert all(samples[i]['main']<=samples[i+1]['main'] for i in range(len(samples)-1)), samples
    assert samples[-1]['left']>samples[0]['left'], samples
    page.wait_for_timeout(220)
    handoff = page.evaluate('''async () => {const old=document.querySelector('.work-panel');const before=old.getBoundingClientRect().width;old.remove();await Promise.resolve();const ghost=document.querySelector('[data-pm-ghost].work-panel');return {before,after:ghost.getBoundingClientRect().width,cssAnimations:ghost.getAnimations().filter(a=>a.animationName).length}}''')
    assert abs(handoff['before']-handoff['after'])<4, handoff
    assert handoff['cssAnimations']==0, handoff
    page.wait_for_timeout(10)
    assert page.locator('[data-pm-ghost].work-panel').count() == 1
    page.evaluate('''() => {document.querySelector('.shell').insertAdjacentHTML('beforeend','<aside class="work-panel" style="--work-panel-width:400px"></aside>')}''')
    page.wait_for_timeout(10)
    assert page.locator('[data-pm-ghost].work-panel').count() == 0
    assert page.locator('.work-panel').evaluate('(e)=>parseFloat(e.style.getPropertyValue("--pm-wp-from"))') > 0
    print('PASS work panel: glass cascade, 220ms unmount, interrupted reopen')
    page.wait_for_timeout(700)

    page.evaluate('''() => {document.body.insertAdjacentHTML('beforeend', '<div class="dock is-expanded"><div class="dock-content"><div class="dock-clip"><div class="dock-panel"><div class="todo-dock-list"><div class="todo-dock-row">Task 1</div><div class="todo-dock-row">Task 2</div></div></div></div></div></div>')}''')
    page.wait_for_timeout(550)
    height = page.locator('.dock-content').evaluate('(e)=>e.getBoundingClientRect().height')
    page.evaluate('''() => {document.querySelector('.dock').classList.remove('is-expanded');document.querySelector('.dock-panel').hidden=true}''')
    page.wait_for_timeout(40)
    middle = page.locator('.dock-content').evaluate('(e)=>e.getBoundingClientRect().height')
    assert 0 < middle < height, (middle, height)
    assert page.locator('.todo-dock-list').evaluate('(e)=>getComputedStyle(e).visibility') == 'visible'
    page.wait_for_timeout(550)
    assert page.locator('.dock-content').evaluate('(e)=>e.getBoundingClientRect().height') == 0
    print('PASS task dock: hidden panel does not destroy closing grid transition')

    page.evaluate('''() => {document.body.insertAdjacentHTML('beforeend','<div class="settings-content-enter"><h1 class="settings-section-title">General</h1><div>Settings</div></div>')}''')
    page.wait_for_timeout(550)
    page.locator('.settings-section-title').evaluate('(e)=>e.textContent="Models"')
    page.wait_for_timeout(20)
    assert page.locator('.settings-content-enter').evaluate('(e)=>e.getAnimations().length') == 1
    page.locator('.settings-content-enter').evaluate('(e)=>e.lastElementChild.textContent="Refreshed data"')
    page.wait_for_timeout(20)
    assert page.locator('.settings-content-enter').evaluate('(e)=>e.getAnimations().length') == 1
    print('PASS settings: reused category container animates without refresh replay')

    # Layout-effect-mounted menu is already .is-open when observer receives it.
    page.evaluate('''() => {document.body.insertAdjacentHTML('beforeend','<div class="context-menu is-open" role="menu" style="top:100px;left:150px"><button role="menuitem">Copy</button></div>')}''')
    page.wait_for_timeout(40)
    assert page.locator('.context-menu').evaluate('(e)=>e.getAnimations().length') > 0
    page.wait_for_timeout(350)
    # No pointer/click snapshot: hover/automatic dismissal must still fade out.
    page.locator('.context-menu').evaluate('(e)=>e.remove()')
    page.wait_for_timeout(10)
    assert page.locator('[data-pm-ghost].context-menu').count() == 1
    page.wait_for_timeout(400)
    assert page.locator('[data-pm-ghost].context-menu').count() == 0
    print('PASS chat context menu: positioned mount entrance and automatic dismissal')
    page.evaluate('''() => {for(const cls of ['context-menu','context-menu context-menu-submenu']) document.body.insertAdjacentHTML('beforeend',`<div class="${cls} is-open" style="left:160px;top:100px">Menu</div>`)}''')
    page.wait_for_timeout(350)
    page.evaluate("document.querySelectorAll('.context-menu').forEach(e=>e.remove())")
    page.wait_for_timeout(10)
    assert page.locator('[data-pm-ghost].context-menu').count() == 2
    page.wait_for_timeout(400)
    assert page.locator('[data-pm-ghost].context-menu').count() == 0

    first_frame = page.evaluate('''() => {const el=document.createElement('div');el.className='composer-model-menu composer-model-thinking-menu is-open';el.innerHTML='<div>Native UI</div>';document.body.append(el);const visibility=getComputedStyle(el).visibility;el.remove();return visibility}''')
    assert first_frame == 'hidden'
    page.wait_for_timeout(10)
    assert page.locator('[data-pm-ghost].composer-model-menu').count() == 0
    page.add_script_tag(content='(() => {' + PICKER + '\nwindow.picker = {mountModelPicker,unmountModelPicker};})()')
    page.evaluate('''() => {document.body.insertAdjacentHTML('beforeend', `<div class="composer-model-menu composer-model-thinking-menu is-open"><div class="composer-menu-root"><div class="composer-model-search"><input></div><div class="composer-model-list"><button class="composer-menu-entry" aria-expanded="false">Other models</button><div class="composer-model-group"><div class="composer-model-group-label">Provider</div><button class="composer-model-option" title="model-1"><span class="composer-model-option-main"><span class="composer-model-label">Model 1</span></span></button></div></div></div></div>`);return picker.mountModelPicker({dispatch:async()=>({config:{grouping:'provider'}})})}''')
    assert page.locator('.piopt-mp-view').count() == 0
    assert page.locator('.composer-model-menu').evaluate('(e)=>getComputedStyle(e).visibility') == 'hidden'
    page.locator('.composer-menu-entry').evaluate('(e)=>e.setAttribute("aria-expanded","true")')
    page.wait_for_timeout(75)
    assert page.locator('.composer-model-menu').evaluate('(e)=>e.getAnimations().some(a=>a.effect.getKeyframes().some(f=>f.transform && f.transform!=="none"))')
    assert page.locator('.composer-model-search input').evaluate('(e)=>document.activeElement===e')
    page.wait_for_timeout(150)
    page.evaluate('window.stableView=document.querySelector(".piopt-mp-view")')
    page.wait_for_timeout(250)
    assert page.evaluate('stableView===document.querySelector(".piopt-mp-view")')
    page.locator('.composer-model-menu').evaluate('(e)=>e.classList.add("hovered")')
    page.wait_for_timeout(120)
    assert page.evaluate('stableView===document.querySelector(".piopt-mp-view")')
    print('PASS model picker: no self-triggered rebuild or replay on class changes')
    page.locator('.composer-model-menu').evaluate('(e)=>e.remove()')
    page.wait_for_timeout(10)
    assert page.locator('[data-pm-ghost].composer-model-menu').evaluate('(e)=>e.getAnimations().some(a=>a.effect.getKeyframes().some(f=>f.transform && f.transform!=="none"))')
    page.wait_for_timeout(550)
    assert page.locator('[data-pm-ghost].composer-model-menu').count() == 0
    page.evaluate('''() => {const old=document.createElement('div');old.className='sidebar-floating-menu sidebar-row-menu';old.setAttribute('role','menu');old.addEventListener('keydown',e=>{if(e.key==='Escape'){window.oldMenuClosed=true;old.remove()}});document.body.append(old);document.querySelector('.main').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))}''')
    assert page.evaluate('window.oldMenuClosed===true')
    assert page.locator('.sidebar-floating-menu').count() == 0
    assert page.locator('[data-pm-ghost].sidebar-row-menu').count() == 0
    print('PASS context menu exclusivity: new chat context request closes sidebar host state')
    assert not errors, errors
    page.evaluate('picker.unmountModelPicker();motion.unmountMotionRuntime()')
    browser.close()
print('All five browser regressions passed.')
