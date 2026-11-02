const { chromium } = require('playwright');
const T = process.argv[2];
const rss = (title, n) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://x.test/</link>${Array.from({ length: n }, (_, i) => `<item><title>${title} ${i}</title><link>http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fexample.org%2f${i}</link></item>`).join('')}</channel></rss>`;
(async () => {
  const b = await chromium.launch(); const errs = []; const asked = [];
  const ctx = await b.newContext();
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.startsWith('https://salareader-relay')) {
      const t = new URL(u).searchParams.get('url'); asked.push(t); const h = { 'access-control-allow-origin': 'http://localhost:8770' };
      if (t.includes('news.google.com')) return r.fulfill({ status: 200, headers: h, contentType: 'application/xml', body: rss('"tbilisi" - Google News', 0) });
      return r.fulfill({ status: 200, headers: h, contentType: 'application/xml', body: rss('Bing ' + new URL(t).searchParams.get('q'), 3) });
    }
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8770/'); await p.waitForSelector('.hero'); await p.waitForTimeout(1000);
  // An earlier version fetched it with 0 items: subs has ok set, no via.
  await p.evaluate(async () => {
    const r = indexedDB.open('salareader'); await new Promise((res) => (r.onsuccess = res));
    const db = r.result; const subs = await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('subs'); q.onsuccess = () => res(q.result); });
    subs.push({ id: 'Lgn1', url: 'https://news.google.com/news?hl=en&gl=us&q=%22tbilisi%22&um=1&ie=UTF-8&output=rss', title: '"tbilisi" - Google News', titleSet: true, folder: '', own: true, ok: Date.now(), error: '' });
    await new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(subs, 'subs'); tx.objectStore('kv').delete('gnRetried'); tx.oncomplete = res; });
  });
  await p.reload(); await p.waitForSelector('.hero'); await p.waitForTimeout(3500);
  await p.goto('http://localhost:8770/#/feed/Lgn1'); await p.waitForSelector('#viewHeader .sub');
  console.log('header:', await p.$eval('#viewHeader .sub', (e) => e.textContent));
  console.log('address line:', await p.$eval('.feed-addr', (e) => e.textContent.replace(/\s+/g, ' ').trim()));
  console.log('articles:', await p.$$eval('article.entry .t', (l) => l.map((x) => x.textContent)));
  console.log('asked:', asked.map((x) => new URL(x).hostname + ' q=' + new URL(x).searchParams.get('q')).join(' → '));
  console.log('errors', errs);
  await b.close();
})();
