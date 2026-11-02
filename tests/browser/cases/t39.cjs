const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
  await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); return u.startsWith('http://localhost') ? r.continue() : r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:8770/?debug'); await p.waitForSelector('.hero');
  await p.click('#settingsBtn'); await p.check('input[name="relayMode"][value="own"]'); await p.fill('#relayInput', 'http://localhost:8902'); await p.press('#relayInput', 'Tab');
  await p.setInputFiles('#opmlFile', T + '/health.opml');
  await p.waitForFunction(() => { const S = window.__salareader; const own = (S.subs || []).filter((s) => s.own); return own.length === 6 && own.every((s) => s.ok || s.error); }, null, { timeout: 60000 });
  const state = () => p.evaluate(() => window.__salareader.subs.filter((s) => s.own).map((s) => `${s.title}: ${s.retired ? 'RETIRED (' + s.retiredWhy + ')' : s.error ? s.failKind + (s.relayIssue ? '/relay' : '') : 'ok'}`));
  console.log('first fetch:', await state());
  // Time passes: gone 2 days, page 4 days, blocked 31 days, down 10 days.
  await p.evaluate(() => {
    const day = 864e5, now = Date.now();
    for (const s of window.__salareader.subs) {
      const back = { 'http://gone.test/feed': 2, 'http://page.test/feed': 4, 'http://block.test/feed': 31, 'http://down.test/feed': 10 }[s.url];
      if (back && s.error) { s.failSince = now - back * day; s.kindSince = now - back * day; s.kindTries = 3; }
    }
  });
  await p.keyboard.press('Escape'); await p.evaluate(() => { location.hash = '#/health'; }); await p.waitForSelector('[data-act="checkfeeds"]');
  await p.click('[data-act="checkfeeds"]'); await p.waitForTimeout(300);
  await p.waitForFunction(() => !window.__salareader.ownProgress && document.querySelector('[data-act="checkfeeds"]') && !document.querySelector('[data-act="checkfeeds"]').disabled, null, { timeout: 60000 });
  await p.waitForTimeout(500);
  console.log('after the check:', await state());
  console.log('health header:', await p.$eval('#viewHeader .sub', (e) => e.textContent));
  console.log('groups:', await p.$$eval('.health h2', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' '))));
  console.log('down note:', await p.$eval('.health-list li:has-text("Down feed") .r-why', (e) => e.textContent));
  await p.screenshot({ path: `${T}/shot-health.png`, fullPage: true });
  // Relay trouble never counts against feeds.
  const before = await p.evaluate(() => window.__salareader.subs.find((s) => s.url.includes('down.test')).failSince);
  await p.evaluate(() => { const S = window.__salareader; S.settings.relay = 'http://localhost:8999'; for (const s of S.subs) { delete s.ok; delete s.lastTry; } });
  await p.click('[data-act="checkfeeds"]'); await p.waitForTimeout(1500);
  await p.waitForFunction(() => !window.__salareader.ownProgress, null, { timeout: 60000 }); await p.waitForTimeout(500);
  console.log('relay down:', await state(), '| down feed failSince unchanged:', before === await p.evaluate(() => window.__salareader.subs.find((s) => s.url.includes('down.test')).failSince));
  await p.goto('http://localhost:8770/?debug#/home'); await p.waitForSelector('.hero');
  console.log('home:', await p.$eval('.home', (e) => (e.textContent.match(/Feed health.*?See feed health/s) || [''])[0].replace(/\s+/g, ' ')));
  console.log('errors', errs); await b.close();
})();
