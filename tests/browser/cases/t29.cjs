const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  for (const scheme of ['light', 'dark']) {
    const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
    await ctx.route('**/*', async (r) => {
      const u = r.request().url();
      if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
      if (u.includes('transformers')) return r.fulfill({ path: T + '/pw/fake-tf.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
      return u.startsWith('http://localhost') ? r.continue() : r.abort();
    });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8770/?debug#/search/ai%20model'); await p.waitForSelector('article.entry');
    await p.click('[data-act="investigate"]'); await p.waitForSelector('.inv-head');
    // Wait for the search to finish checking feeds, then open the first result.
    await p.waitForFunction(() => !/checking/i.test(document.querySelector('#viewHeader .sub')?.textContent || ''), null, { timeout: 60000 });
    const before = await p.evaluate(() => ({ sub: document.querySelector('#viewHeader .sub')?.textContent, n: document.querySelectorAll('article.entry').length }));
    await p.click('article.entry .line');
    let opened = await p.waitForSelector('.body .actions', { timeout: 8000 }).catch(() => null);
    if (!opened) { // seen once in a full run: say what the page looked like, then try once more
      console.log('NOTE first click did not open:', await p.evaluate(() => JSON.stringify({ cur: window.__salareader.cur, sub: document.querySelector('#viewHeader .sub')?.textContent, n: document.querySelectorAll('article.entry').length, open: document.querySelectorAll('article.entry.open').length, dialog: !!document.querySelector('dialog[open]') })));
      await p.click('article.entry .line');
      opened = await p.waitForSelector('.body .actions', { timeout: 8000 }).catch(() => null);
    }
    if (!opened) {
      console.log('DEBUG before', JSON.stringify(before), 'after', await p.evaluate(() => JSON.stringify({ cur: window.__salareader.cur, sub: document.querySelector('#viewHeader .sub')?.textContent, n: document.querySelectorAll('article.entry').length, open: document.querySelectorAll('article.entry.open').length, inv: document.body.classList.contains('inv-open'), dialog: !!document.querySelector('dialog[open]'), pending: !!window.__salareader.view.pending })));
      await p.screenshot({ path: `${T}/shot-t29-fail.png` });
      throw new Error('article did not open');
    }
    await p.click('.body [data-act="related"]'); await p.waitForTimeout(800);
    await p.screenshot({ path: `${T}/shot-color-${scheme}.png` });
    // axe on this view
    await p.addScriptTag({ path: T + '/pw/node_modules/axe-core/axe.min.js' }).catch(() => {});
    const v = await p.evaluate(async () => window.axe ? (await axe.run(document, { runOnly: ['color-contrast'] })).violations.map((x) => x.nodes.length + ' ' + x.nodes.slice(0, 4).map((n) => n.target.join(' ') + ' ' + (n.any[0]?.message || '').slice(0, 90)).join(' || ')) : ['no axe']);
    console.log(scheme, 'contrast violations:', v);
    await ctx.close();
  }
  console.log('errors', errs);
  await b.close();
})();
