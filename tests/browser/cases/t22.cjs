const { chromium } = require('playwright');
const T = process.argv[2];
const rss = (title, links) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://www.bing.com/news</link>${links.map((l) => `<item><title>${l} story</title><link>http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fnews.test%2f${l}</link><pubDate>Mon, 02 Nov 2026 08:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
(async () => {
  const b = await chromium.launch(); const errs = []; const asked = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.startsWith('https://salareader-relay')) {
      const t = new URL(u).searchParams.get('url'); asked.push(t); const h = { 'access-control-allow-origin': 'http://localhost:8770' };
      if (t.includes('news.google.com')) return r.fulfill({ status: 502, headers: h, body: 'The site answered HTTP 503.' });
      if (t.includes('bing.com/news')) {
        const q = new URL(t).searchParams.get('q');
        const map = { bitcoin: ['btc-price', 'etf'], blockchain: ['etf', 'chain-news'], cryptocurrency: ['regulation'] };
        return r.fulfill({ status: 200, headers: h, contentType: 'application/xml', body: rss(q, /\sOR\s/.test(q) ? [] : map[q] || []) });
      }
      return r.fulfill({ status: 404, headers: h, body: 'The site answered HTTP 404.' });
    }
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:8770/?debug'); await p.waitForSelector('.hero'); await p.waitForTimeout(800);
  const opml = `<?xml version="1.0"?><opml version="1.0"><body><outline text="Crypto">
    <outline type="rss" text="&quot;bitcoin OR blockchain OR cryptocurrency&quot; - Google News" xmlUrl="http://news.google.com/news?hl=en&amp;gl=us&amp;q=bitcoin%20OR%20blockchain%20OR%20cryptocurrency&amp;um=1&amp;ie=UTF-8&amp;output=rss"/>
    <outline type="rss" text="BitcoinNews.com" xmlUrl="http://www.bitcoinnews.com/rss"/></outline></body></opml>`;
  await p.evaluate((x) => { const f = new File([x], 'a.opml'); const dt = new DataTransfer(); dt.items.add(f); const inp = document.querySelector('#opmlFile'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); }, opml);
  await p.waitForFunction(() => window.__salareader.subs.filter((s) => s.own).every((s) => s.ok || s.error), null, { timeout: 120000 });
  const gn = await p.evaluate(() => { const S = window.__salareader; const s = S.subs.find((x) => x.url.includes('news.google')); return { id: s.id, items: (S.ownItems[s.id] || []).map((i) => i.t), via: s.via }; });
  console.log('OR search →', gn.items, '| via', gn.via, '| Bing asked for:', asked.filter((u) => u.includes('bing')).map((u) => new URL(u).searchParams.get('q')));
  // BitcoinNews: gone, nothing found → being confirmed; a day later still gone → retired.
  console.log('gone, first day:', await p.evaluate(() => { const s = window.__salareader.subs.find((x) => x.url.includes('bitcoinnews')); return { kind: s.failKind, retired: !!s.retired }; }));
  await p.evaluate(() => { const s = window.__salareader.subs.find((x) => x.url.includes('bitcoinnews')); s.kindSince = s.failSince = Date.now() - 2 * 864e5; s.kindTries = 2; delete s.lastTry; delete s.probedAt; });
  await p.click('[data-act="refresh"]');
  await p.waitForFunction(() => window.__salareader.subs.find((x) => x.url.includes('bitcoinnews')).retired, null, { timeout: 60000 });
  await p.goto('http://localhost:8770/?debug#/home'); await p.waitForTimeout(400);
  const sidebar = await p.$$eval('#sidebar .folder-row .name', (l) => l.map((x) => x.textContent.trim()));
  console.log('sidebar folders:', sidebar, '| retired folder closed:', await p.$eval('.folder.retired', (f) => f.classList.contains('closed')));
  console.log('home note:', await p.$eval('.home', (e) => e.textContent.match(/📦[^.]*\./)?.[0]));
  await p.goto(`http://localhost:8770/?debug#/folder/__retired`); await p.waitForSelector('.retired-list li');
  console.log('retired page:', await p.$eval('.retired-list li', (e) => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 170)));
  await p.screenshot({ path: T + '/shot-retired.png' });
  const relayBefore = asked.length;
  await p.evaluate(() => document.querySelector('[data-act="keepfeed"]').click()); await p.waitForTimeout(400);
  console.log('after Keep trying: retired feeds', await p.evaluate(() => window.__salareader.subs.filter((s) => s.retired).length), '| folder of BitcoinNews:', await p.$$eval('#sidebar .folder', (fs) => fs.filter((f) => /BitcoinNews/.test(f.textContent)).map((f) => f.querySelector('.folder-row .name').textContent.trim())));
  await p.waitForFunction(() => { const s = window.__salareader.subs.find((x) => x.url.includes('bitcoinnews')); return s.lastTry && s.error; }, null, { timeout: 60000 });
  console.log('kept feed fails again → still kept (not retired):', await p.evaluate(() => { const s = window.__salareader.subs.find((x) => x.url.includes('bitcoinnews')); return { retired: !!s.retired, keep: s.keep }; }));
  await p.evaluate(() => { const s = window.__salareader.subs.find((x) => x.url.includes('bitcoinnews')); s.retired = Date.now(); location.hash = '#/home'; setTimeout(() => { location.hash = '#/folder/__retired'; }, 200); });
  await p.waitForSelector('[data-act="unsubretired"]');
  await p.click('[data-act="unsubretired"]'); await p.waitForTimeout(400);
  console.log('after Delete all: subscriptions with bitcoinnews:', await p.evaluate(() => window.__salareader.subs.filter((s) => s.url.includes('bitcoinnews')).length));
  console.log('errors', errs);
  await b.close();
})();
