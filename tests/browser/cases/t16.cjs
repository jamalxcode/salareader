const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext();
  await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); return u.startsWith('http://localhost') ? r.continue() : r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept());
  const rows = () => p.$$eval('article.entry .t', (l) => l.map((x) => x.textContent));
  await p.goto('http://localhost:8770/?debug'); await p.waitForSelector('.hero');
  await p.click('#addBtn'); await p.fill('#addUrl', 'http://localhost:8767/eng'); await p.press('#addUrl', 'Enter');
  await p.waitForFunction(() => location.hash.startsWith('#/feed/L')); await p.waitForSelector('article.entry');
  await p.click('article.entry .line'); await p.waitForTimeout(300);   // read "Story 5"
  await p.click('[data-act="allitems"]');
  console.log('after 1st fetch:', (await rows()).length, 'articles');
  // Fetch again twice (new guids each time).
  for (let i = 0; i < 2; i++) { await p.click('[data-act="refresh"]'); await p.evaluate(() => { const S = window.__salareader; for (const s of S.subs) delete s.ok; }); await p.click('[data-act="refresh"]'); await p.waitForTimeout(2500); }
  await p.goto('http://localhost:8770/?debug#/home'); await p.waitForTimeout(300); await p.click('#sidebar a.feed:has-text("Engadget-like")'); await p.waitForSelector('article.entry'); await p.click('[data-act="allitems"]');
  const st = await p.evaluate(() => { const S = window.__salareader; const id = location.hash.split('/')[2]; const items = S.items.filter((i) => i.f === id); return { n: items.length, read: items.filter((i) => i.id in S.read).map((i) => i.t) }; });
  console.log('after 3 fetches with new guids each time:', st.n, 'articles | still read:', st.read, '| header:', await p.$eval('#viewHeader .sub', (e) => e.textContent));
  // Duplicates saved by an earlier version are cleaned on load.
  await p.evaluate(async () => {
    const r = indexedDB.open('salareader'); await new Promise((res) => (r.onsuccess = res)); const db = r.result;
    const subs = await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('subs'); q.onsuccess = () => res(q.result); });
    const sub = subs.find((s) => s.url.includes('8767'));
    const items = await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('own:' + sub.id); q.onsuccess = () => res(q.result); });
    const dup = items.map((i) => ({ ...i, id: i.id + 'x' }));
    await new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put([...items, ...dup], 'own:' + sub.id); const rq = tx.objectStore('kv').get('read'); rq.onsuccess = () => { const read = rq.result; read[dup[0].id] = Date.now(); tx.objectStore('kv').put(read, 'read'); }; tx.oncomplete = res; });
  });
  await p.reload(); await p.waitForSelector('.hero, article.entry'); await p.waitForTimeout(500);
  const st2 = await p.evaluate(() => { const S = window.__salareader; const sub = S.subs.find((s) => s.url.includes('8767')); const items = S.items.filter((i) => i.f === sub.id); return { n: items.length, read: items.filter((i) => i.id in S.read).map((i) => i.t) }; });
  console.log('stored duplicates cleaned on load:', st2.n, 'articles | read:', st2.read);
  // A feed where every item links to the same page keeps all items.
  await p.click('#addBtn'); await p.fill('#addUrl', 'http://localhost:8767/same-link'); await p.press('#addUrl', 'Enter');
  await p.waitForFunction(() => location.hash.startsWith('#/feed/L') && document.querySelector('.vh-title h1')?.textContent.includes('Comic')); await p.waitForSelector('article.entry');
  console.log('same-link feed keeps:', await rows());
  console.log('errors', errs);
  await b.close();
})();
