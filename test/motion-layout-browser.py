"""Host 0.21 layout regression: fixed-width work panel plus scrollIntoView.
Run with Python Playwright Chromium; does not modify live host state.
"""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
assets = json.loads(subprocess.check_output(['node', '-e', '''
const m=require('./features/appearance/motion.js');
console.log(JSON.stringify({css:m.buildThemeCss({speed:.4})}));
'''], cwd=ROOT, text=True, encoding='utf-8'))
runtime = (ROOT/'renderer/motion-runtime.mjs').read_text(encoding='utf-8').replace('export ', '')
HOST = '''
html,body,#root{height:100%;margin:0;overflow:hidden}
.app-shell{height:100%;min-height:0;display:flex;position:relative;isolation:isolate}
.app-chat-shell{display:contents}
.sidebar{width:275px;flex:0 0 275px;overflow:hidden}
.main-pane{min-width:450px;flex:1;display:flex;position:relative}
.work-panel{display:flex;flex:0 0 var(--work-panel-width);width:var(--work-panel-width);min-width:0;height:100%;position:relative}
.work-panel-main{display:flex;flex:1;min-width:0;flex-direction:column}
.work-panel-header{height:46px;display:flex;flex:none;padding:0 50px 0 12px}
.work-panel-tab-strip-wrap{display:flex;flex:auto;min-width:0;overflow:hidden}
.work-panel-tab-strip{display:flex;flex:0 auto;min-width:0;max-width:100%;width:max-content;overflow:auto hidden}
.work-panel-tab{flex:none;min-width:92px;max-width:180px;height:28px}
.work-panel-tab-button{height:28px}
.work-panel-body{flex:1;min-height:0;overflow:auto}
'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1400,'height':800})
    page.set_content('<div id="root"><div class="app-shell"><div class="app-chat-shell"><aside class="sidebar">Projects</aside><section class="main-pane">Conversation</section></div></div></div>',wait_until='networkidle')
    page.add_style_tag(content=HOST+assets['css'])
    page.add_script_tag(content='(() => {'+runtime+'\nmountMotionRuntime();})()')
    samples=page.evaluate('''async () => {
      const parent=document.querySelector('.app-chat-shell');
      parent.insertAdjacentHTML('beforeend', '<aside class="work-panel" style="--work-panel-width:400px"><div class="work-panel-main"><header class="work-panel-header"><div class="work-panel-tab-strip-wrap"><div class="work-panel-tab-strip"><div class="work-panel-tab"><button class="work-panel-tab-button">code-reviewer</button></div></div></div></header><div class="work-panel-body"><p>Panel content</p></div></div></aside>');
      // Host layout effect runs before mutation observers; ResizeObserver repeats it later.
      const scroll=()=>document.querySelector('.work-panel-tab-button').scrollIntoView({block:'nearest',inline:'nearest'});
      const snapshot=()=>({root:document.querySelector('#root').scrollLeft,body:document.body.scrollLeft,html:document.documentElement.scrollLeft,shell:document.querySelector('.app-shell').scrollLeft,sidebar:document.querySelector('.sidebar').getBoundingClientRect().left,main:document.querySelector('.main-pane').getBoundingClientRect().left});
      const frames=[];scroll();frames.push(snapshot());
      for(let i=0;i<45;i++){await new Promise(requestAnimationFrame);scroll();document.querySelector('.work-panel-tab-button').focus();frames.push(snapshot())}
      return frames;
    }''')
    print('layout origin extrema:',json.dumps({key:[min(s[key] for s in samples),max(s[key] for s in samples)] for key in samples[0]}))
    assert all(s['root']==s['body']==s['html']==s['shell']==0 and abs(s['sidebar'])<.5 and abs(s['main']-275)<.5 for s in samples), samples[:8]
    print('PASS host display:contents layout: tab scroll/focus never shifts page origin')
    tab_scroll=page.evaluate('''() => {
      const strip=document.querySelector('.work-panel-tab-strip');
      strip.insertAdjacentHTML('beforeend',Array.from({length:12},(_,i)=>'<div class="work-panel-tab"><button class="work-panel-tab-button">Tab '+i+'</button></div>').join(''));
      strip.lastElementChild.firstElementChild.scrollIntoView({block:'nearest',inline:'nearest'});
      return {inner:strip.scrollLeft,root:document.querySelector('#root').scrollLeft,sidebar:document.querySelector('.sidebar').getBoundingClientRect().left};
    }''')
    assert tab_scroll['inner']>0 and tab_scroll['root']==0 and tab_scroll['sidebar']==0, tab_scroll
    closed=page.evaluate('''async () => {
      const panel=document.querySelector('.work-panel');panel.classList.add('is-exiting');
      const frames=[];
      for(let i=0;i<45;i++){await new Promise(requestAnimationFrame);document.querySelector('.work-panel-tab-strip').lastElementChild.firstElementChild.scrollIntoView({block:'nearest',inline:'nearest'});frames.push({root:document.querySelector('#root').scrollLeft,sidebar:document.querySelector('.sidebar').getBoundingClientRect().left})}
      panel.remove();await Promise.resolve();
      frames.push({root:document.querySelector('#root').scrollLeft,sidebar:document.querySelector('.sidebar').getBoundingClientRect().left});
      return frames;
    }''')
    assert all(s['root']==0 and s['sidebar']==0 for s in closed), closed[:8]
    print('PASS closing and multi-tab scroll: page origin fixed, tab-strip scrolling preserved')
    browser.close()
