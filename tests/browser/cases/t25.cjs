const { chromium } = require('playwright');
const T = process.argv[2];
const feeds = {
  'https://fr.test/rss': ['fr-FR', [['Le gouvernement présente le budget', 'Le ministre des finances a présenté le projet au parlement.', 'Politique'], ['Un nouveau film de Cannes', 'Le festival a présenté une sélection de films pour les cinéphiles.', 'Culture']]],
  'https://ar.test/rss': ['ar', [['الرئيس يلتقي وزير الخارجية', 'بحث الجانبان الأوضاع في المنطقة', ''], ['ارتفاع سعر بيتكوين', 'العملات المشفرة تسجل مكاسب', '']]],
  'https://en.test/rss': ['en-us', [['Bitcoin hits a record as ETF inflows surge', 'Crypto markets rallied on the news.', 'Markets'], ['Apple unveils a faster iPhone chip', 'The company said the phone ships next week.', 'Tech'], ['Opinion: why the election matters', 'The vote will shape the country for years.', 'Opinion']]],
  'https://pod.test/rss': ['en', [['Episode 12: the history of jets', 'We talk to a pilot about the plane and the industry.', '']]],
};
const rss = (u) => { const [lang, items] = feeds[u]; return `<?xml version="1.0"?><rss version="2.0"><channel><title>${u}</title><language>${lang}</language><link>${u.replace('rss', '')}</link>${items.map(([t, d, c], i) => `<item><title>${t}</title><link>${u}/${i}</link><description>${d}</description>${c ? `<category>${c}</category>` : ''}${u.includes('pod') ? '<enclosure url="https://pod.test/1.mp3" type="audio/mpeg" length="1"/>' : ''}<pubDate>${new Date(Date.now() - 3600e3).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`; };
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.startsWith('https://salareader-relay')) { const t = new URL(u).searchParams.get('url'); return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': 'http://localhost:8770' }, contentType: 'application/xml', body: rss(t) }); }
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8770/?debug'); await p.waitForSelector('.hero'); await p.waitForTimeout(800);
  const opml = `<?xml version="1.0"?><opml version="1.0"><body><outline text="Mixed">${Object.keys(feeds).map((u) => `<outline type="rss" text="${u}" xmlUrl="${u}"/>`).join('')}</outline></body></opml>`;
  await p.evaluate((x) => { const f = new File([x], 'a.opml'); const dt = new DataTransfer(); dt.items.add(f); const inp = document.querySelector('#opmlFile'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); }, opml);
  await p.waitForFunction(() => { const own = window.__salareader.subs.filter((s) => s.own); return own.length === 4 && own.every((s) => s.ok || s.error); }, null, { timeout: 60000 });
  await p.goto('http://localhost:8770/?debug#/home'); await p.waitForTimeout(500);
  const rows = await p.$$eval('#sidebar .smart-group', (gs) => gs.map((g) => g.querySelector('.group-name').textContent + ': ' + [...g.querySelectorAll('.nav-item.smart')].map((a) => a.textContent.replace(/\s+/g, ' ').trim()).join(', ')));
  console.log(rows.join('\n'));
  await p.screenshot({ path: T + '/shot-smart.png', clip: { x: 0, y: 0, width: 420, height: 1000 } });
  await p.click('a[href="#/smart/lang%3Aar"]'); await p.waitForSelector('article.entry');
  console.log('Arabic view:', await p.$eval('#viewHeader h1', (e) => e.textContent), '|', await p.$$eval('article.entry .t', (a) => a.map((x) => x.textContent)), '| unread/all toggle shown:', !!(await p.$('[data-act="allitems"]')));
  await p.click('article.entry .line'); await p.waitForTimeout(300);
  console.log('after reading one: list', await p.$$eval('article.entry', (a) => a.length), '(opened stays) | sidebar Arabic:', await p.$eval('a[href="#/smart/lang%3Aar"]', (e) => e.textContent.replace(/\s+/g, ' ').trim()));
  await p.goto('http://localhost:8770/?debug#/smart/lang%3Aar'); await p.goto('http://localhost:8770/?debug#/home'); await p.goto('http://localhost:8770/?debug#/smart/lang%3Aar'); await p.waitForTimeout(300);
  console.log('revisit Arabic: unread shown', await p.$$eval('article.entry', (a) => a.length));
  await p.click('.smart-group .group-name'); await p.waitForTimeout(200);
  console.log('Languages collapsed:', await p.$eval('.smart-group', (g) => g.classList.contains('closed')));
  console.log('errors', errs);
  await b.close();
})();
