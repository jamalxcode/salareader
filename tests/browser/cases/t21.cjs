const { chromium } = require('playwright');
const T = process.argv[2];
const rss = (t) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${t}</title><link>https://x.test/</link><item><title>${t} story</title><link>https://x.test/${encodeURIComponent(t)}</link><pubDate>Sun, 01 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
const answers = {
  'http://english.aljazeera.net/Services/Rss/?PostingId=2007731105943979989': [200, '{"feeds":["https://www.aljazeera.com/xml/rss/all.xml"]}'],
  'https://www.aljazeera.com/xml/rss/all.xml': [200, rss('Al Jazeera')],
  'http://www.panarmenian.net/stickers/news/news_eng.rss': [404],
  'https://www.pan.am/en/newsfeed/rss': [200, rss('PanARMENIAN')],
  'http://www.tasnimnews.com/en/rss/feed/0/7/0/all-stories': [530],
  'https://www.tasnimnews.ir/en/rss/feed/0/0/0/0/AllStories': [200, rss('Tasnim')],
  'https://armenpress.am/eng/rss/news/': [404],
  'http://www.cbc.ca/cmlink/1.394': [520],
  'https://moved.test/old.xml': [404],
  'https://moved.test/feed': [200, rss('Moved blog')],
};
(async () => {
  const b = await chromium.launch(); const errs = []; const asked = [];
  const ctx = await b.newContext();
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.startsWith('https://salareader-relay')) {
      const t = new URL(u).searchParams.get('url'); asked.push(t); const h = { 'access-control-allow-origin': 'http://localhost:8770' };
      const a = answers[t];
      if (!a) return r.fulfill({ status: 404, headers: h, body: 'The site answered HTTP 404.' });
      if (a[0] === 200) return r.fulfill({ status: 200, headers: h, contentType: a[1].startsWith('{') ? 'application/json' : 'application/xml', body: a[1] });
      return r.fulfill({ status: a[0] === 404 ? 404 : 502, headers: h, body: `The site answered HTTP ${a[0]}.` });
    }
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8770/?debug'); await p.waitForSelector('.hero'); await p.waitForTimeout(800);
  const subsUrls = Object.keys(answers).filter((u) => !/aljazeera\.com|pan\.am|\.ir\/|moved\.test\/feed/.test(u));
  const opml = `<?xml version="1.0"?><opml version="1.0"><body><outline text="News">${subsUrls.map((u, i) => `<outline type="rss" text="Feed ${i}" xmlUrl="${u.replace(/&/g, '&amp;')}" htmlUrl="${u.includes('moved.test') ? 'https://moved.test/' : ''}"/>`).join('')}</outline></body></opml>`;
  await p.evaluate((x) => { const f = new File([x], 'a.opml'); const dt = new DataTransfer(); dt.items.add(f); const inp = document.querySelector('#opmlFile'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); }, opml);
  await p.waitForFunction((n) => { const own = window.__salareader.subs.filter((s) => s.own); return own.length === n && own.every((s) => s.ok || s.error); }, subsUrls.length, { timeout: 180000 });
  const res = await p.evaluate(() => window.__salareader.subs.filter((s) => s.own).map((s) => ({ url: s.url.slice(0, 58), ok: !!s.ok && !s.error, now: s.fetchUrl || '', error: (s.error || '').slice(0, 110), items: (window.__salareader.ownItems[s.id] || []).length })));
  for (const r of res) console.log(r.ok ? 'OK  ' : 'FAIL', r.url, r.now ? '→ ' + r.now : '', r.error, r.items ? `(${r.items} items)` : '');
  console.log('relay requests:', asked.length);
  const moved = await p.evaluate(() => window.__salareader.subs.find((s) => s.fetchUrl)?.id);
  await p.goto(`http://localhost:8770/?debug#/feed/${moved}`); await p.waitForSelector('.feed-addr');
  console.log('feed page:', await p.$eval('#viewHeader .sub', (e) => e.textContent), '|', await p.$eval('.feed-addr', (e) => e.textContent.replace(/\s+/g, ' ').trim()));
  console.log('errors', errs);
  await b.close();
})();
