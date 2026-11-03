const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript' });
    if (u.startsWith('https://salareader-relay.jamal-akuna-matata.workers.dev')) return r.fulfill({ response: await r.fetch({ url: u.replace('https://salareader-relay.jamal-akuna-matata.workers.dev', 'http://localhost:8902') }) });
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  await p.goto('http://localhost:8770/?debug'); await p.waitForSelector('.hero'); await p.keyboard.press('Control+k'); await p.keyboard.type('show all feeds'); await p.keyboard.press('Enter'); await p.waitForTimeout(1500); // this test needs every feed in the sidebar
  await p.setInputFiles('#opmlFile', T + '/big.opml');
  await p.waitForFunction(() => { const own = (window.__salareader.subs || []).filter((s) => s.own); return own.length > 60 && own.every((s) => s.ok || s.error); }, null, { timeout: 180000 });
  await p.waitForTimeout(2000);
  console.log('entity sub:', await p.evaluate(() => { const S = window.__salareader; const s = S.subs.find((x) => x.url.includes('entity')); return s && JSON.stringify({ ok: !!s.ok, error: s.error, items: (S.ownItems[s.id] || []).length }); }));
  console.log('red !:', await p.$$eval('#sidebar a.feed.broken', (l) => l.map((a) => a.textContent.trim() + ' => ' + a.title)));
  await p.click('#sidebar a.feed >> text=Entity feed');
  await p.waitForTimeout(500); console.log('entity view:', await p.$eval('#viewHeader', (e) => e.textContent.replace(/\s+/g, ' ').slice(0, 200)), await p.$eval('#list', (e) => e.textContent.replace(/\s+/g, ' ').slice(0, 200)));
  await p.waitForSelector('article.entry');
  console.log('entity item:', await p.$eval('article.entry .line', (e) => e.textContent));
  console.log('errors', []);
  await b.close();
})();
