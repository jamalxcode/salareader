const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext();
  await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); return u.startsWith('http://localhost') ? r.continue() : r.abort(); });
  const state = (p) => p.evaluate(() => { const S = window.__salareader; const urls = S.subs.map((s) => s.url); const ids = S.items.map((i) => i.id); return { subs: urls.length, dupSubs: urls.length - new Set(urls).size, items: ids.length, dupItems: ids.length - new Set(ids).size }; });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push('A ' + e.message)); p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:8770/?debug'); await p.waitForSelector('.hero'); await p.waitForTimeout(800);
  require('fs').writeFileSync(T + '/two.opml', `<?xml version="1.0"?><opml version="1.0"><body><outline text="Tech"><outline type="rss" text="Eng" xmlUrl="http://localhost:8766/cors/xkcd.xml"/><outline type="rss" text="Q" xmlUrl="http://localhost:8766/cors/quanta.xml"/></outline></body></opml>`);
  // A second tab open during the import (as when the reader is open twice).
  const p2 = await ctx.newPage(); p2.on('pageerror', (e) => errs.push('B ' + e.message));
  await p2.goto('http://localhost:8770/?debug'); await p2.waitForSelector('.hero');
  await p.click('#settingsBtn'); await p.setInputFiles('#opmlFile', T + '/two.opml');
  await p.waitForTimeout(6000);
  console.log('after import  A:', await state(p), ' B:', await state(p2));
  await p.reload(); await p.waitForSelector('.hero'); await p.waitForTimeout(4000);
  await p2.reload(); await p2.waitForSelector('.hero'); await p2.waitForTimeout(4000);
  console.log('after reloads A:', await state(p), ' B:', await state(p2));
  // Import the same file again.
  await p.click('#settingsBtn'); await p.setInputFiles('#opmlFile', T + '/two.opml'); await p.waitForTimeout(4000);
  console.log('import again  A:', await state(p), ' B:', await state(p2));
  console.log('errors', errs);
  await b.close();
})();
