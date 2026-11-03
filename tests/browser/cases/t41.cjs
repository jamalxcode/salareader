// Background refresh: the worker prefetches feeds; the next refresh reads those copies without the network.
const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
  await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); return u.startsWith('http://localhost') ? r.continue() : r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:8770/?debug'); await p.waitForSelector('.hero');
  await p.click('#settingsBtn'); await p.check('input[name="relayMode"][value="own"]'); await p.fill('#relayInput', 'http://localhost:8902'); await p.press('#relayInput', 'Tab'); await p.keyboard.press('Escape');
  await p.setInputFiles('#opmlFile', T + '/health.opml');
  await p.click('#addBtn'); await p.fill('#addUrl', 'http://localhost:8767/eng'); await p.press('#addUrl', 'Enter'); await p.waitForFunction(() => location.hash.startsWith('#/feed/'));
  await p.waitForFunction(() => { const own = window.__salareader.subs.filter((s) => s.own); return own.length === 7 && own.every((s) => s.ok || s.error); }, null, { timeout: 60000 });
  await p.evaluate(() => navigator.serviceWorker.ready); await p.reload(); await p.waitForSelector('#sidebar a.feed');
  console.log('worker in control:', await p.evaluate(() => !!navigator.serviceWorker.controller));
  // A refresh saves the plan for the worker.
  await p.evaluate(() => { for (const s of window.__salareader.subs) delete s.ok; }); await p.click('#refreshBtn'); await p.waitForTimeout(1000);
  await p.waitForFunction(() => !window.__salareader.ownProgress); await p.waitForTimeout(1500);
  // The plan is written at the end of the refresh (slower machines: a moment later).
  await p.waitForFunction(async () => { const r = await (await caches.open('salareader-prefetch')).match('/__prefetch-plan'); const pl = r && (await r.json()); return pl && pl.feeds.some((f) => f.direct); }, null, { timeout: 30000, polling: 500 }).catch(() => {});
  const plan = await p.evaluate(async () => { const r = await (await caches.open('salareader-prefetch')).match('/__prefetch-plan'); return r && (await r.json()); });
  console.log('eng sub:', await p.evaluate(() => JSON.stringify(window.__salareader.subs.filter((s) => s.url.includes('8767')).map(({ id, url, direct, ok, error }) => ({ url, direct, ok: !!ok, error })))));
  console.log('plan:', plan && { relay: plan.relay, feeds: plan.feeds.map((f) => f.url.replace('http://', '') + (f.direct ? ' (direct)' : '')) });
  // The browser wakes the worker (here: asked directly).
  const n = await p.evaluate(() => new Promise((res) => { navigator.serviceWorker.addEventListener('message', (e) => res(e.data.prefetched)); navigator.serviceWorker.controller.postMessage('prefetch-now'); }));
  console.log('prefetched in the background:', n, await p.evaluate(async () => (await (await caches.open('salareader-prefetch')).keys()).map((r) => decodeURIComponent(new URL(r.url).pathname)).filter((x) => x.startsWith('/__prefetch/'))));
  // Next refresh: prefetched feeds don't touch the network.
  const hits = [];
  p.on('request', (r) => { const u = r.url(); if (/8767\/eng|8902\/\?url/.test(u)) hits.push(u.includes('8902') ? decodeURIComponent(u.split('url=')[1]) : u); });
  await p.evaluate(() => { for (const s of window.__salareader.subs) delete s.ok; }); await p.click('#refreshBtn'); await p.waitForTimeout(1000);
  await p.waitForFunction(() => !window.__salareader.ownProgress); await p.waitForTimeout(500);
  console.log('network requests in the next refresh (should be the not-prefetched ones only):', hits);
  console.log('cache emptied:', await p.evaluate(async () => (await (await caches.open('salareader-prefetch')).keys()).filter((r) => r.url.includes('/__prefetch/')).length));
  console.log('errors', errs); await b.close();
})();
