// Sidebar: feeds with nothing unread, and feeds that can't be read, are hidden; "Show all" brings them back.
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
  await p.waitForFunction(() => { const own = window.__salareader.subs.filter((s) => s.own); return own.length === 6 && own.every((s) => s.ok || s.error); }, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  const feeds = () => p.$$eval('#sidebar a.feed .name', (l) => l.map((x) => x.textContent));
  console.log('shown:', (await feeds()).sort());
  console.log('switch:', await p.$eval('[data-act="toggleallfeeds"]', (e) => e.textContent));
  // Read everything in Verge News: it drops out of the sidebar.
  await p.click('#sidebar a.feed:has-text("Verge News")'); await p.waitForSelector('article.entry');
  await p.keyboard.press('Shift+A'); await p.waitForTimeout(400);
  console.log('read Verge, still shown while open:', (await feeds()).includes('Verge News'));
  await p.evaluate(() => { location.hash = '#/all'; }); await p.waitForTimeout(400);
  console.log('after leaving it:', (await feeds()).includes('Verge News'));
  await p.click('[data-act="toggleallfeeds"]'); await p.waitForTimeout(200);
  const all = await feeds();
  console.log('show all:', all.length, '| has Verge:', all.includes('Verge News'), '| has failing:', all.some((n) => /Gone feed|Down feed|Blocked feed|Page feed/.test(n)));
  console.log('switch now:', await p.$eval('[data-act="toggleallfeeds"]', (e) => e.textContent));
  console.log('errors', errs); await b.close();
})();
