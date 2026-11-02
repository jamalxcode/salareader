const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext();
  let blockIndex = false, relayCalls = 0;
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (blockIndex && u.includes('/data/index.json')) return r.fulfill({ status: 404, body: '' });
    if (u.startsWith('https://salareader-relay')) { relayCalls++; return r.fulfill({ response: await r.fetch({ url: u.replace('https://salareader-relay.jamal-akuna-matata.workers.dev', 'http://localhost:8902') }) }); }
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8770/'); await p.waitForSelector('.hero');
  // Enter on a focused sidebar link opens it.
  await p.focus('#sidebar a[href="#/starred"]'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  console.log('Enter on link ->', await p.evaluate(() => location.hash));
  await p.focus('#settingsBtn'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  console.log('Enter on ⚙ button opens settings:', await p.$eval('#settingsDialog', (d) => d.open));
  await p.keyboard.press('Escape');
  // j still works after clicking a row.
  await p.goto('http://localhost:8770/#/all'); await p.waitForSelector('article.entry');
  await p.click('article.entry .row'); await p.keyboard.press('j'); await p.waitForTimeout(400);
  console.log('j after clicking a row -> open article index:', await p.$eval('article.entry.open', (a) => a.dataset.idx));
  // Index fails to load: catalog feeds must not go through the relay.
  blockIndex = true; relayCalls = 0;
  await p.reload(); await p.waitForTimeout(2500);
  const keys = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('salareader'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').getAllKeys(); q.onsuccess = () => res(q.result); }; }));
  console.log('index missing -> relay calls:', relayCalls, '| own: records:', keys.filter((k) => k.startsWith('own:')).length, '| sidebar feeds still listed:', await p.$$eval('#sidebar a.feed', (l) => l.length));
  // Plant a stray own: record for a catalog feed, then load normally: it's cleaned up.
  blockIndex = false;
  await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('salareader'); r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put([{ id: 'x' }], 'own:7cd99579'); tx.oncomplete = res; }; }));
  await p.goto('http://localhost:8770/#/home'); await p.reload(); await p.waitForSelector('.hero'); await p.waitForTimeout(1200);
  const keys2 = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('salareader'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').getAllKeys(); q.onsuccess = () => res(q.result); }; }));
  console.log('stray own: record cleaned up:', !keys2.includes('own:7cd99579'));
  console.log('errors', errs);
  await b.close();
})();
