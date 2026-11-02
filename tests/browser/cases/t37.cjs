const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  for (const scheme of ['light', 'dark']) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); if (u.includes('transformers')) return r.fulfill({ path: T + '/pw/fake-tf.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); return u.startsWith('http://localhost') ? r.continue() : r.abort(); });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8770/?debug#/all'); await p.waitForSelector('article.entry');
    await p.click('[data-act="pane"]'); await p.keyboard.press('j'); await p.waitForTimeout(300);
    await p.addScriptTag({ path: T + '/pw/node_modules/axe-core/axe.min.js' });
    const scan = async (label, ctxSel) => { const v = await p.evaluate(async (sel) => (await axe.run(sel ? document.querySelector(sel) : document, { resultTypes: ['violations'] })).violations.filter((x) => /serious|critical/.test(x.impact)).map((x) => x.id + ': ' + x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')), ctxSel); console.log(scheme, label, v.length ? v : 'ok'); };
    await scan('pane view');
    await p.click('#list .entry:nth-child(2) .row', { button: 'right' }); await scan('context menu', '#ctxMenu'); await p.keyboard.press('Escape');
    await p.click('#aaBtn'); await scan('text panel', '#aaPop'); await p.keyboard.press('Escape');
    await p.keyboard.press('Control+k'); await p.keyboard.type('a'); await scan('palette', '#cmdk'); await p.keyboard.press('Escape');
    await p.click('#settingsBtn'); await p.waitForTimeout(300); await scan('settings', '#settingsDialog');
    await ctx.close();
  }
  console.log('errors', errs); await b.close();
})();
