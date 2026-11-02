const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); return u.startsWith('http://localhost') ? r.continue() : r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8770/?debug#/smart/topic%3Atech'); await p.waitForSelector('article.entry');
  const t0 = await p.$$eval('article.entry', (a) => a.length);
  await p.click('article.entry .line'); await p.waitForSelector('.body .actions');
  const id = await p.$eval('article.entry.open', (a) => a.dataset.id);
  // Another tab marks something read: this tab rebuilds.
  const p2 = await ctx.newPage(); await p2.goto('http://localhost:8770/?debug#/all'); await p2.waitForSelector('article.entry');
  await p2.click('article.entry:nth-child(5) .line'); await p2.waitForTimeout(2500);
  await p.waitForTimeout(1000);
  const still = await p.$(`article.entry.open[data-id="${id}"] .body`);
  console.log('list', t0, '| opened article still open after a background update:', !!still, '| header:', await p.$eval('#viewHeader .sub', (e) => e.textContent));
  // Move on: next article with j, the first stays listed (read) until leaving the view
  await p.keyboard.press('j'); await p.waitForTimeout(300);
  console.log('after j: first still listed', !!(await p.$(`article.entry[data-id="${id}"]`)));
  console.log('errors', errs);
  await b.close();
})();
