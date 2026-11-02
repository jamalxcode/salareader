const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext();
  await ctx.route('**/*', async (r) => { const u = r.request().url(); if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); if (u.includes('localhost:8766/cors/')) await new Promise((res) => setTimeout(res, 1500)); return u.startsWith('http://localhost') ? r.continue() : r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept());
  const st = () => p.evaluate(() => { const S = window.__salareader; const urls = S.subs.map((s) => s.url); const ids = S.items.map((i) => i.id); return { subs: urls.length, dupSubs: urls.length - new Set(urls).size, dupItems: ids.length - new Set(ids).size }; });
  await p.goto('http://localhost:8770/?debug'); await p.waitForSelector('.hero'); await p.waitForTimeout(800);
  // Press Enter, then click Subscribe again while it's still fetching (slow feed).
  await p.click('#addBtn'); await p.fill('#addUrl', 'http://localhost:8766/cors/xkcd.xml');
  await p.press('#addUrl', 'Enter'); await p.waitForTimeout(200);
  await p.evaluate(() => { const b = document.querySelector('#addSubmit'); b.disabled = false; b.click(); });
  await p.waitForTimeout(4000);
  console.log('double add:', await st(), '| status:', await p.$eval('#addStatus', (e) => e.textContent));
  // Duplicates saved by an earlier version: subs listed twice.
  await p.evaluate(async () => {
    const r = indexedDB.open('salareader'); await new Promise((res) => (r.onsuccess = res)); const db = r.result;
    const subs = await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('subs'); q.onsuccess = () => res(q.result); });
    const own = subs.filter((s) => s.own);
    await new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put([...subs, ...own.map((s) => ({ ...s }))], 'subs'); tx.oncomplete = res; });
  });
  await p.goto('http://localhost:8770/?debug#/home'); await p.reload(); await p.waitForSelector('.hero'); await p.waitForTimeout(800);
  console.log('stored twice, after load:', await st(), '| xkcd entries in sidebar:', await p.$$eval('#sidebar a.feed', (l) => l.filter((a) => /xkcd|Xkcd/.test(a.textContent)).length));
  const href = await p.$eval('#sidebar a.feed[href^="#/feed/L"]', (a) => a.getAttribute('href'));
  await p.click(`#sidebar a[href="${href}"]`); await p.waitForSelector('article.entry'); await p.click('[data-act="allitems"]');
  const titles = await p.$$eval('article.entry .t', (l) => l.map((x) => x.textContent));
  console.log('feed page:', await p.$eval('#viewHeader .sub', (e) => e.textContent), '| repeated titles:', titles.length - new Set(titles).size);
  console.log('errors', errs);
  await b.close();
})();
