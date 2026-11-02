const { chromium } = require('playwright');
const T = process.argv[2];
const rss = (n) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed ${n}</title><link>https://f${n}.test/</link>${Array.from({ length: 60 }, (_, i) => `<item><title>Feed ${n} jet story ${i}</title><link>https://f${n}.test/${i}</link><description>About planes and jets number ${i}</description><pubDate>Mon, 02 Nov 2026 0${i % 9}:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.includes('transformers')) return r.fulfill({ path: T + '/pw/fake-tf.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.startsWith('https://salareader-relay')) {
      const t = new URL(u).searchParams.get('url'); const n = /f(\d+)\.test/.exec(t)?.[1];
      return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': 'http://localhost:8770' }, contentType: 'application/xml', body: rss(n) });
    }
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errs.push(m.text()); });
  await p.goto('http://localhost:8770/?debug'); await p.waitForSelector('.hero'); await p.waitForTimeout(800);
  const opml = `<?xml version="1.0"?><opml version="1.0"><body><outline text="Mine">${Array.from({ length: 80 }, (_, i) => `<outline type="rss" text="F${i}" xmlUrl="https://f${i}.test/rss"/>`).join('')}</outline></body></opml>`;
  await p.evaluate((x) => { const f = new File([x], 'a.opml'); const dt = new DataTransfer(); dt.items.add(f); const inp = document.querySelector('#opmlFile'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); }, opml);
  await p.waitForFunction(() => { const own = window.__salareader.subs.filter((s) => s.own); return own.length === 80 && own.every((s) => s.ok || s.error); }, null, { timeout: 120000 });
  console.log('own items:', await p.evaluate(() => Object.values(window.__salareader.ownItems).flat().length));
  console.log('own with vectors before search:', await p.evaluate(() => { const S = window.__salareader; return Object.values(S.ownItems).flat().filter((i) => S.vectors.has(i.id)).length; }), '| workers:', ctx.serviceWorkers().length, p.workers().length);
  // Watch for main-thread stalls.
  await p.evaluate(() => { window.__gap = 0; let last = performance.now(); (function tick() { const n = performance.now(); window.__gap = Math.max(window.__gap, n - last); last = n; requestAnimationFrame(tick); })(); });
  await p.evaluate(() => { const S = window.__salareader; window.__log = []; const t0 = performance.now(); setInterval(() => window.__log.push([Math.round(performance.now() - t0), S.vectors.size, S.view.status || '']), 250); });
  await p.fill('#q', 'jet'); await p.press('#q', 'Enter');
  await p.waitForSelector('article.entry'); await p.waitForTimeout(500);
  await p.waitForTimeout(10); console.log('own flag:', await p.evaluate(() => { const S = window.__salareader; return [S.items.filter((i) => S.feedById.get(i.f)?.own).length, S.items.length, S.vectors.size, S.view.status]; }));
  console.log('workers now:', p.workers().map((w) => w.url()));
  console.log('status while working:', await p.$eval('#viewHeader .sub', (e) => e.textContent));
  const t0 = Date.now(); await p.click('article.entry .line'); await p.waitForSelector('.body'); console.log('article opened in', Date.now() - t0, 'ms');
  await p.waitForFunction(() => !/checking/.test(document.querySelector('#viewHeader .sub').textContent), null, { timeout: 120000 });
  console.log('final status:', await p.$eval('#viewHeader .sub', (e) => e.textContent), '| article still open:', !!(await p.$('.body')));
  console.log(JSON.stringify((await p.evaluate(() => window.__log)).filter((x, i, a) => i === 0 || x[1] !== a[i - 1][1] || x[2] !== a[i - 1][2]).slice(0, 30)));
  console.log('longest main-thread stall:', Math.round(await p.evaluate(() => window.__gap)), 'ms');
  const pend = await p.$('[data-act="showpending"]'); if (pend) { await pend.click(); await p.waitForTimeout(300); console.log('after Show them:', await p.$$eval('article.entry', (a) => a.length), 'results'); }
  console.log('errors', errs);
  await b.close();
})();
