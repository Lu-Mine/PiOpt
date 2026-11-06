"""Check adjacent sticky command headings never overlap while scrolling."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
script=(ROOT/'renderer/command-enhance.mjs').read_text(encoding='utf-8').replace('export function ', 'function ').replace('export const ', 'const ')
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page()
    page.set_content('''<style>:root{--piopt-permission-icon-size:14px}.composer-ac-list{height:100px;width:300px;overflow:auto;padding:0}.composer-model-group-label{position:sticky;top:0;z-index:1;height:24px;box-sizing:border-box;padding:6px 8px 2px}.composer-ac-item{display:block;height:40px}</style><div class="composer-input" contenteditable>/</div><div class="composer-autocomplete"><div class="composer-ac-list"><div class="composer-model-group-label">内置</div><button class="composer-ac-item"><span class="composer-ac-name">/a</span></button><button class="composer-ac-item"><span class="composer-ac-name">/b</span></button><div class="composer-model-group-label">技能</div><button class="composer-ac-item"><span class="composer-ac-name">/c</span></button><button class="composer-ac-item"><span class="composer-ac-name">/d</span></button><div class="composer-model-group-label">插件</div><button class="composer-ac-item"><span class="composer-ac-name">/e</span></button><button class="composer-ac-item"><span class="composer-ac-name">/f</span></button></div></div>''')
    page.add_script_tag(content='(() => {'+script+'\nwindow.startEnhance=mountCommandEnhance;window.stopEnhance=unmountCommandEnhance;const s=document.createElement("style");s.textContent=COMMAND_ENHANCE_CSS;document.head.append(s);})()')
    page.evaluate('startEnhance()')
    page.wait_for_selector('[data-piopt-slash-title]')
    failures=page.evaluate('''async () => {const list=document.querySelector('.composer-ac-list'), out=[];for(let y=0;y<=list.scrollHeight-list.clientHeight;y++){list.scrollTop=y;list.dispatchEvent(new Event('scroll'));const top=list.getBoundingClientRect().top;const heads=[...list.querySelectorAll('.composer-model-group-label')].map(e=>e.getBoundingClientRect()).filter(r=>r.bottom>top+0.5);for(let i=0;i<heads.length-1;i++)if(heads[i].bottom>heads[i+1].top+0.6)out.push({y,a:heads[i].bottom,b:heads[i+1].top});}return out;}''')
    assert not failures, failures[:5]
    page.evaluate('stopEnhance()')
    assert page.locator('[style*="--piopt-heading-shift"]').count()==0
    print('PASS adjacent sticky headings across all scroll positions')
    browser.close()
