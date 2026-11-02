// Search: an article opened while the AI is still starting stays open; the AI's order waits behind "Show them".
const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.includes('transformers')) return r.fulfill({ path: T + '/pw/fake-tf.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    // The AI search data arrives slowly, as on a slow connection.
    if (u.includes('/data/vectors')) { await new Promise((res) => setTimeout(res, 2500)); return r.continue(); }
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8770/?debug#/search/model'); await p.waitForSelector('article.entry');
  const first = await p.$eval('article.entry .t', (e) => e.textContent);
  await p.click('article.entry .line'); await p.waitForSelector('.body .actions');
  await p.waitForTimeout(4000); // the AI finishes meanwhile
  console.log('opened article still open after the AI finished:', await p.evaluate(() => !!document.querySelector('article.entry.open .body .actions')), '| title:', first);
  console.log('header offers the AI order:', await p.$eval('#viewHeader .sub', (e) => e.textContent));
  await p.click('[data-act="showpending"]'); await p.waitForTimeout(300);
  console.log('after Show them:', await p.$$eval('article.entry', (a) => a.length) > 0, '| status:', await p.$eval('#viewHeader .sub', (e) => e.textContent));
  console.log('errors', errs); await b.close();
})();
