const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = []; const dialogs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.startsWith('https://salareader-relay.jamal-akuna-matata.workers.dev')) return r.fulfill({ response: await r.fetch({ url: u.replace('https://salareader-relay.jamal-akuna-matata.workers.dev', 'http://localhost:8902') }) });
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  const mk = async () => { const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => { if (d.type() === 'alert') dialogs.push(d.message()); d.accept(); }); return p; };
  const A = await mk();
  await A.goto('http://localhost:8770/'); await A.waitForSelector('.hero');
  console.log('DOMPurify loaded with integrity check:', await A.evaluate(() => !!window.DOMPurify));
  const B = await mk();
  await B.goto('http://localhost:8770/#/all'); await B.waitForSelector('article.entry');
  // Import in tab A (duplicates + a javascript: url).
  await A.setInputFiles('#opmlFile', T + '/pw/dup.opml');
  await A.waitForFunction(() => !document.querySelector('.nav-note.progress') && document.querySelectorAll('#sidebar a.feed').length >= 7, null, { timeout: 60000 });
  await A.waitForTimeout(800);
  const names = await A.$$eval('#sidebar a.feed .name', (l) => l.map((x) => x.textContent));
  console.log('A feeds:', names.length, '| Latin count:', names.filter((n) => /Latin|Caf/.test(n)).length, '| has javascript feed:', names.some((n) => /alert/.test(n)));
  console.log('B sees new feeds without reload:', (await B.$$eval('#sidebar a.feed .name', (l) => l.map((x) => x.textContent))).length);
  // Latin-1 feed decoded.
  await A.click('#sidebar a.feed >> text=Latin'); await A.waitForSelector('article.entry');
  console.log('latin item:', await A.$eval('article.entry .line', (e) => e.textContent));
  // Evil feed.
  await A.click('#sidebar a.feed >> text=Evil'); await A.waitForSelector('article.entry');
  await A.click('article.entry .row'); await A.waitForSelector('.body .content'); await A.waitForTimeout(500);
  console.log('evil hrefs:', await A.$$eval('.body a', (l) => l.map((a) => a.getAttribute('href')).filter((h) => h && !h.startsWith('#/'))), '| imgs:', await A.$$eval('.body img', (l) => l.map((i) => i.getAttribute('src'))));
  await A.click('.body h2 a').catch(() => {}); await A.click('.body .actions a.button').catch(() => {}); await A.waitForTimeout(500);
  console.log('alerts fired:', dialogs);
  // Star in A, mark read in B, check both persist.
  await A.click('.body .actions [data-act=star]'); await A.waitForTimeout(1200);
  console.log('B starred count after A starred:', await B.$eval('a[href="#/starred"] .count', (e) => e.textContent).catch(() => 'none'));
  await B.click('article.entry .row'); await B.waitForTimeout(1200);
  const readA = await A.evaluate(() => document.querySelector('a[href="#/all"] .count')?.textContent);
  const readB = await B.evaluate(() => document.querySelector('a[href="#/all"] .count')?.textContent);
  console.log('All-items unread A/B after B read one:', readA, readB);
  // Erase while a refresh is running.
  await A.evaluate(() => { const s = JSON.parse(JSON.stringify(1)); });
  await A.click('#settingsBtn'); await A.click('#eraseAll'); await A.waitForTimeout(2000);
  const p2 = await mk(); await p2.goto('http://localhost:8770/'); await p2.waitForSelector('.hero'); await p2.waitForTimeout(800);
  const keys = await p2.evaluate(() => new Promise((res) => { const r = indexedDB.open('salareader'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').getAllKeys(); q.onsuccess = () => res(q.result); }; }));
  console.log('after erase, stored keys:', keys.join(','), '| own feeds in sidebar:', await p2.$$eval('#sidebar a.feed', (l) => l.filter((a) => a.getAttribute('href').includes('/feed/L')).length));
  console.log('errors', errs);
  await b.close();
})();
