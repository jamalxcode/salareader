const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext();
  let failIndex = false, dropFeed = null;
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.includes('/data/index.json')) {
      if (failIndex) return r.abort();
      if (dropFeed) { const res = await r.fetch(); const j = await res.json(); j.feeds = j.feeds.filter((f) => f.url !== dropFeed); j.items = j.items.filter((i) => j.feeds.some((f) => f.id === i.f)); return r.fulfill({ json: j }); }
    }
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8770/'); await p.waitForSelector('.hero');
  // Enter in the Subscribe box subscribes.
  await p.click('#addBtn'); await p.fill('#addUrl', 'http://localhost:8766/cors/edge.xml'); await p.press('#addUrl', 'Enter');
  await p.waitForFunction(() => location.hash.startsWith('#/feed/L'), null, { timeout: 10000 }).catch(() => {});
  console.log('Enter in Subscribe ->', await p.evaluate(() => location.hash), '| dialog open:', await p.$eval('#addDialog', (d) => d.open));
  const rows = await p.$$eval('article.entry .t', (l) => l.map((x) => x.textContent));
  console.log('xml:base + duplicate ids: items', rows);
  await p.click('article.entry .line'); await p.waitForSelector('.body .content'); await p.waitForTimeout(300);
  console.log('P1 link:', await p.$eval('.body h2 a', (a) => a.href), '| xhtml body:', await p.$eval('.body .content', (e) => e.textContent.trim()));
  // Cancel button closes; Enter in topic box with only spaces doesn't make a topic.
  await p.click('#addBtn'); await p.click('#addDialog [data-close]'); console.log('Close button closes:', !(await p.$eval('#addDialog', (d) => d.open)));
  await p.click('#addTopicBtn2'); await p.fill('#topicQuery', '   '); await p.press('#topicQuery', 'Enter'); await p.waitForTimeout(200);
  console.log('blank topic ->', await p.$eval('#topicStatus', (e) => e.textContent), '| topics:', await p.$$eval('#sidebar a[href^="#/topic/"]', (l) => l.length));
  await p.keyboard.press('Escape');
  // Refresh with no connection keeps everything.
  const before = await p.$eval('a[href="#/all"] .count', (e) => e.textContent);
  failIndex = true; await p.click('#refreshBtn'); await p.waitForTimeout(800);
  console.log('failed refresh: toast', JSON.stringify(await p.$eval('#toast', (e) => e.textContent)), '| count before/after', before, await p.$eval('a[href="#/all"] .count', (e) => e.textContent));
  failIndex = false;
  // A feed removed from the catalog becomes your own feed.
  dropFeed = 'http://localhost:8765/bbc.xml';
  await p.goto('http://localhost:8770/#/home'); await p.reload(); await p.waitForSelector('.hero'); await p.waitForTimeout(2500);
  const bbc = await p.$$eval('#sidebar a.feed', (l) => l.filter((a) => /Bbc/.test(a.textContent)).map((a) => a.getAttribute('href') + ' ' + (a.querySelector('.count')?.textContent || '0')));
  console.log('removed catalog feed ->', bbc);
  // Keep set survives re-routing to the same view.
  await p.goto('http://localhost:8770/#/all'); await p.waitForSelector('article.entry');
  const firstId = await p.$eval('article.entry', (a) => a.dataset.id);
  await p.click('article.entry .line'); await p.waitForTimeout(200);
  await p.evaluate(() => { location.hash = '#/all'; window.dispatchEvent(new HashChangeEvent('hashchange')); }); await p.waitForTimeout(300);
  console.log('opened article still listed after same-view route:', await p.$$eval('article.entry', (l, id) => l.some((a) => a.dataset.id === id), firstId));
  console.log('errors', errs);
  await b.close();
})();
