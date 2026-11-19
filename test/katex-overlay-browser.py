"""Verify the host modal overlay rule cannot obscure KaTeX glyphs."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
css = json.loads(subprocess.check_output([
    'node', '--input-type=module', '-e',
    "import {KATEX_OVERLAY_CSS} from './renderer/entry.mjs'; console.log(JSON.stringify(KATEX_OVERLAY_CSS))",
], cwd=ROOT, text=True))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_content('''<style>
      .overlay { position:fixed; inset:0; z-index:40; background:rgba(0,0,0,.45);
        padding:24px; display:flex; align-items:center; justify-content:center;
        animation:overlay-in 1s both }
      .katex .overlay { display:block }
      @keyframes overlay-in { from { opacity:0 } to { opacity:1 } }
    </style><div class="katex"><span class="overlay" style="height:0.714em;width:0.471em"><svg width="0.471em" height="0.714em"><path d="M0 0L1 1"/></svg></span></div><div id="modal" class="overlay"></div>''')
    page.add_style_tag(content=css)
    glyph = page.locator('.katex .overlay').evaluate('''e => {
      const s = getComputedStyle(e), r = e.getBoundingClientRect();
      return {position:s.position, top:s.top, background:s.backgroundColor, padding:s.padding,
        display:s.display, animation:s.animationName, zIndex:s.zIndex, width:r.width, height:r.height,
        fontSize:parseFloat(s.fontSize)};
    }''')
    assert glyph['position'] == 'static' and glyph['top'] == 'auto', glyph
    assert glyph['background'] == 'rgba(0, 0, 0, 0)' and glyph['padding'] == '0px', glyph
    assert glyph['display'] == 'block' and glyph['animation'] == 'none' and glyph['zIndex'] == 'auto', glyph
    assert abs(glyph['width'] - .471 * glyph['fontSize']) < 1 and abs(glyph['height'] - .714 * glyph['fontSize']) < 1, glyph
    modal = page.locator('#modal').evaluate('''e => { const s=getComputedStyle(e); return {position:s.position,padding:s.padding,background:s.backgroundColor,animation:s.animationName}; }''')
    assert modal == {'position':'fixed', 'padding':'24px', 'background':'rgba(0, 0, 0, 0.45)', 'animation':'overlay-in'}, modal
    browser.close()
    print('PASS KaTeX overlay and host modal')
