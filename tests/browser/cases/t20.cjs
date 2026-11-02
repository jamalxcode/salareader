const { chromium } = require('playwright');
const T = process.argv[2];
const yt = (id) => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom"><title>Channel ${id}</title><link rel="alternate" href="https://www.youtube.com/channel/x"/>
${[1, 2].map((n) => `<entry><id>yt:video:${id}${n}</id><title>Video ${n} of ${id}</title><link rel="alternate" href="https://www.youtube.com/watch?v=${id}${n}"/><published>2026-10-${20 + n}T10:00:00+00:00</published><media:group><media:title>Video ${n}</media:title><media:thumbnail url="https://i.ytimg.com/vi/${id}${n}/hqdefault.jpg" width="480" height="360"/><media:description>First line about ${id}.\n\nSecond paragraph.</media:description></media:group></entry>`).join('')}</feed>`;
(async () => {
  const b = await chromium.launch(); const errs = []; const asked = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.startsWith('https://salareader-relay')) {
      const t = new URL(u).searchParams.get('url'); asked.push(t); const h = { 'access-control-allow-origin': 'http://localhost:8770' };
      if (t.includes('youtube.com/feeds/videos.xml')) return r.fulfill({ status: 200, headers: h, contentType: 'application/xml', body: yt(new URL(t).searchParams.get('playlist_id').slice(-4)) });
      return r.fulfill({ status: 502, headers: h, body: 'The site answered HTTP 404.' });
    }
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8770/?debug'); await p.waitForSelector('.hero'); await p.waitForTimeout(800);
  const t0 = Date.now();
  await p.click('#settingsBtn'); await p.setInputFiles('#opmlFile', T + '/yt.opml');
  await p.waitForTimeout(500);
  console.log('import + first render:', Date.now() - t0, 'ms | toast:', await p.$eval('#toast', (e) => e.textContent));
  const st = await p.evaluate(() => { const S = window.__salareader; const own = S.subs.filter((s) => s.own); return { subs: S.subs.length, own: own.length, multi: own.filter((s) => s.folders?.length).length, dupUrls: S.subs.length - new Set(S.subs.map((s) => s.url)).size }; });
  console.log('subscriptions:', st);
  const where = await p.$$eval('#sidebar .folder', (fs) => fs.filter((f) => [...f.querySelectorAll('a.feed .name')].some((n) => n.textContent === 'Some channel')).map((f) => f.querySelector('.folder-row .name').textContent.trim()));
  console.log('Some channel shown in folders:', where);
  await p.waitForTimeout(5000);
  console.log('relay asked so far:', asked.length, '| youtube mapped:', asked.filter((u) => u.includes('feeds/videos.xml?playlist_id=')).length, '| raw playlist pages asked:', asked.filter((u) => u.includes('/playlist?list=')).length);
  const ytFeed = await p.evaluate(() => { const S = window.__salareader; const s = S.subs.find((x) => x.url.includes('youtube.com/playlist') && x.ok); return s && { id: s.id, every: Math.round(s.every / 3600e3 * 10) / 10 + ' h', title: s.title }; });
  console.log('a YouTube feed after fetch:', ytFeed);
  if (ytFeed) {
    await p.goto(`http://localhost:8770/?debug#/feed/${ytFeed.id}`); await p.waitForSelector('article.entry'); await p.click('article.entry .line'); await p.waitForSelector('.body .content'); await p.waitForTimeout(400);
    console.log('  video article:', await p.$eval('.body .content', (e) => e.innerHTML.replace(/\s+/g, ' ').slice(0, 200)));
  }
  const failing = await p.evaluate(() => { const S = window.__salareader; const f = S.subs.find((x) => x.error); return f && { next: Math.round((f.lastTry + 3600e3 - Date.now()) / 60e3) + ' min' }; });
  console.log('a failing feed is retried in:', failing);
  // Click into a folder to check rendering speed with 1,100+ feeds.
  let t = Date.now(); await p.click('#sidebar .folder-row .name >> text=Tech'); await p.waitForSelector('#viewHeader h1'); console.log('open folder:', Date.now() - t, 'ms');
  console.log('errors', errs.slice(0, 3));
  await b.close();
})();
