const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = []; let relayCalls = 0, relay429 = 0;
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('response', (r) => { if (r.url().includes('workers.dev')) { relayCalls++; if (r.status() === 429) relay429++; } });
  await p.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript' });
    if (u.startsWith('https://salareader-relay.jamal-akuna-matata.workers.dev')) return r.fulfill({ response: await r.fetch({ url: u.replace('https://salareader-relay.jamal-akuna-matata.workers.dev', 'http://localhost:8902') }) });
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  await p.goto('http://localhost:8770/'); await p.waitForSelector('.hero');
  await p.click('#settingsBtn');
  await p.setInputFiles('#opmlFile', T + '/big.opml');
  const t0 = Date.now();
  await p.waitForTimeout(8000);
  console.log('after 8s:', await p.$eval('.nav-note.progress', (e) => e.textContent).catch(() => 'no progress note'), '| All items count:', await p.$eval('a[href="#/all"] .count', (e) => e.textContent));
  await p.screenshot({ path: T + '/shot-importing.png' });
  await p.waitForFunction(() => !document.querySelector('.nav-note.progress'), null, { timeout: 180000 });
  console.log('done in', Math.round((Date.now() - t0) / 1000), 's | relay calls', relayCalls, '| 429s', relay429, '| red !:', await p.$$eval('#sidebar .warn', (w) => w.length));
  console.log('entity feed:', await p.$$eval('#sidebar a.feed .name', (l) => l.map((x) => x.textContent).filter((t) => /Entit/.test(t))));
  const before = relayCalls;
  await p.reload(); await p.waitForSelector('.hero'); await p.waitForTimeout(3000);
  console.log('reload re-fetched', relayCalls - before, 'feeds (fresh ones are skipped)');
  console.log('errors', errs);
  await b.close();
})();
