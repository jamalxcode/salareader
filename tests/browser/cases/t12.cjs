const { chromium } = require('playwright');
const T = process.argv[2];
const bingRss = (q) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${q} - BingNews</title><link>https://www.bing.com/news</link>
<item><title>${q} story one</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;tid=1&amp;url=https%3a%2f%2fexample.org%2fone&amp;c=1</link><pubDate>${new Date().toUTCString()}</pubDate><description>About ${q}</description></item>
<item><title>${q} story two</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;tid=2&amp;url=https%3a%2f%2fexample.org%2ftwo&amp;c=1</link><description>More</description></item></channel></rss>`;
(async () => {
  const b = await chromium.launch(); const errs = []; const relayed = [];
  const ctx = await b.newContext();
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.startsWith('https://salareader-relay')) {
      const target = new URL(u).searchParams.get('url'); relayed.push(target);
      const h = { 'access-control-allow-origin': 'http://localhost:8770' };
      if (target.includes('news.google.com')) return r.fulfill({ status: 502, headers: h, body: 'The site answered HTTP 503.' });
      if (target.includes('bing.com/news')) return r.fulfill({ status: 200, headers: h, contentType: 'application/xml', body: bingRss(new URL(target).searchParams.get('q')) });
      if (target.includes('dead.test')) return r.fulfill({ status: 502, headers: h, body: 'The site answered HTTP 410.' });
      return r.fulfill({ status: 502, headers: h, body: "Couldn't reach that site." });
    }
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:8770/'); await p.waitForSelector('.hero'); await p.keyboard.press('Control+k'); await p.keyboard.type('show all feeds'); await p.keyboard.press('Enter'); await p.waitForTimeout(1500); // this test needs every feed in the sidebar
  // 1. Words in Subscribe -> news search.
  await p.click('#addBtn'); await p.fill('#addUrl', 'tbilisi'); await p.press('#addUrl', 'Enter');
  await p.waitForFunction(() => location.hash.startsWith('#/feed/L'), null, { timeout: 15000 });
  console.log('news search:', await p.$eval('.vh-title h1', (e) => e.textContent.trim()), '|', await p.$$eval('article.entry .t', (l) => l.map((x) => x.textContent)));
  await p.click('article.entry .line'); await p.waitForSelector('.body h2 a');
  console.log('  link unwrapped:', await p.$eval('.body h2 a', (a) => a.href));
  // 2. Old Google News search feed via OPML -> comes from Bing News.
  require('fs').writeFileSync(T + '/gn.opml', `<?xml version="1.0"?><opml version="1.0"><body><outline text="Searches">
    <outline type="rss" text="&quot;bitcoin OR blockchain&quot; - Google News" xmlUrl="https://news.google.com/news/feeds?q=bitcoin+OR+blockchain&amp;output=rss"/>
    <outline type="rss" text="Dead blog" xmlUrl="https://dead.test/feed"/></outline></body></opml>`);
  await p.click('#settingsBtn'); await p.setInputFiles('#opmlFile', T + '/gn.opml');
  await p.waitForFunction(() => !document.querySelector('.nav-note.progress') && [...document.querySelectorAll('#sidebar a.feed')].some((a) => /Dead/.test(a.textContent) && a.classList.contains('broken')), null, { timeout: 30000 });
  await p.click('#sidebar a.feed >> text=Google News');
  await p.waitForSelector('article.entry');
  console.log('  ids:', JSON.stringify(await p.$$eval('article.entry', (l) => l.map((a) => [a.dataset.id, a.classList.contains('read')]))));
  const dbRead = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('salareader'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('read'); q.onsuccess = () => res(Object.keys(q.result || {})); }; }));
  console.log('  read ids:', JSON.stringify(dbRead), '| hash:', await p.evaluate(() => location.hash));
  console.log('google news:', await p.$eval('#viewHeader .sub', (e) => e.textContent), '|', await p.$$eval('article.entry .t', (l) => l.length), 'items');
  const subsNow = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('salareader'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('subs'); q.onsuccess = () => res(q.result); }; }));
  console.log('  debug:', JSON.stringify(subsNow.filter((x) => /google/.test(x.url)).map((x) => ({ via: x.via, err: x.error, ok: !!x.ok }))), '| read ids:', await p.evaluate(() => document.querySelectorAll('article.entry.read').length));
  console.log('  relay asked Google then Bing:', relayed.filter((x) => /google|bing/.test(x)).map((x) => new URL(x).hostname).join(' → '));
  // 3. Dead feed message + Try again.
  await p.click('#sidebar a.feed >> text=Dead blog'); await p.waitForSelector('[data-act="retry"]');
  console.log('dead feed:', await p.$eval('#viewHeader .sub', (e) => e.textContent));
  await p.click('[data-act="retry"]'); await p.waitForTimeout(1500);
  console.log('  after Try again toast:', await p.$eval('#toast', (e) => e.textContent));
  // 4. Space after clicking a title scrolls instead of closing it.
  await p.goto('http://localhost:8770/#/all'); await p.waitForSelector('article.entry');
  await p.click('article.entry .line'); await p.waitForSelector('article.entry.open');
  const y0 = await p.evaluate(() => scrollY); await p.keyboard.press(' '); await p.waitForTimeout(400);
  console.log('Space after click: still open', !!(await p.$('article.entry.open')), '| scrolled', (await p.evaluate(() => scrollY)) > y0, '| title focused:', await p.evaluate(() => document.activeElement?.classList.contains('line')));
  console.log('errors', errs);
  await b.close();
})();
