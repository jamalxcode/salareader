// Investigations in the sidebar: unread news first; one you're caught up on drops down; the section collapses.
const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); if (u.includes('transformers')) return r.fulfill({ path: T + '/pw/fake-tf.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); return u.startsWith('http://localhost') ? r.continue() : r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  const order = () => p.$$eval('#sidebar [data-inv]', (l) => l.map((a) => a.querySelector('.name').textContent.split(' ').slice(0, 3).join(' ') + ':' + (a.querySelector('.count')?.textContent || '0')));
  for (const q of ['startup', 'climate']) {
    await p.goto(`http://localhost:8770/?debug#/search/${q}`); await p.waitForSelector('[data-act="investigate"]');
    await p.click('[data-act="investigate"]'); await p.waitForSelector('.inv-head'); await p.keyboard.press('Escape');
  }
  // Two days pass: everything in both is new since they were last opened.
  await p.evaluate(() => { for (const inv of window.__salareader.invs) inv.lastOpened = Date.now() - 30 * 864e5; location.hash = '#/home'; });
  await p.waitForTimeout(400);
  console.log('both with news:', await order());
  // Read every article of the first one (as if read in the feeds).
  await p.evaluate(() => {
    const S = window.__salareader; const inv = S.invs.find((i) => /startup/i.test(i.query));
    for (const it of S.uniq) if (/startup/i.test(it.t)) S.read[it.id] = Date.now();
    location.hash = '#/all';
  });
  await p.waitForTimeout(500);
  console.log('after reading the startup one:', await order());
  // Collapse and expand.
  await p.click('#sidebar .inv-section .twisty'); await p.waitForTimeout(100);
  console.log('collapsed: rows visible', await p.isVisible('#sidebar [data-inv]'), '| total shown', await p.$eval('#sidebar .inv-section', (e) => e.textContent.trim()));
  await p.waitForTimeout(2000); await p.reload(); await p.waitForSelector('#sidebar .inv-section');
  console.log('still collapsed after reload:', !(await p.isVisible('#sidebar [data-inv]')));
  await p.click('#sidebar .inv-section .group-name'); await p.waitForTimeout(100);
  console.log('expanded again:', await p.isVisible('#sidebar [data-inv]'));
  await p.screenshot({ path: `${T}/shot-invs.png`, clip: { x: 0, y: 0, width: 260, height: 900 } });
  console.log('errors', errs); await b.close();
})();
