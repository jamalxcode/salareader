// The Refresh button under Subscribe reads every own feed now, not only the ones that are due.
const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext();
  const hits = [];
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.includes('/cors/edge.xml')) hits.push(u);
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8770/'); await p.waitForSelector('.hero');
  const pos = await p.evaluate(() => { const a = document.querySelector('#addBtn').getBoundingClientRect(), r = document.querySelector('#sideRefreshBtn').getBoundingClientRect(); return { under: r.top >= a.bottom - 1, sameLeft: Math.abs(r.left - a.left) < 2 }; });
  console.log('refresh button under Subscribe:', pos.under && pos.sameLeft, '| label:', await p.$eval('#sideRefreshBtn', (e) => e.textContent.trim()));
  await p.click('#addBtn'); await p.fill('#addUrl', 'http://localhost:8766/cors/edge.xml'); await p.press('#addUrl', 'Enter');
  await p.waitForFunction(() => location.hash.startsWith('#/feed/L'), null, { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(500);
  // Just fetched, so not due: the button still reads it again.
  hits.length = 0;
  await p.click('#sideRefreshBtn');
  console.log('while refreshing, disabled:', await p.$eval('#sideRefreshBtn', (e) => e.disabled));
  await p.waitForFunction(() => !document.querySelector('#sideRefreshBtn').disabled, null, { timeout: 15000 });
  await p.waitForTimeout(200);
  console.log('feed read again:', hits.length > 0, '| label after:', await p.$eval('#sideRefreshBtn', (e) => e.textContent.trim()), '| toast:', JSON.stringify(await p.$eval('#toast', (e) => e.textContent)));
  console.log('errors', errs); await b.close();
})();
