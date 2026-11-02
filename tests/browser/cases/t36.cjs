const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); if (u.includes('transformers')) return r.fulfill({ path: T + '/pw/fake-tf.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); return u.startsWith('http://localhost') ? r.continue() : r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8770/?debug#/all'); await p.waitForSelector('article.entry');
  await p.click('[data-act="pane"]'); await p.waitForTimeout(200);
  for (let i = 0; i < 20; i++) await p.keyboard.press('j');
  await p.waitForTimeout(300);
  const m = await p.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const c = r('#list .entry.current'), l = r('#list'); return { mainScroll: document.querySelector('main').scrollTop, header: Math.round(r('#viewHeader').top), curVisible: c.top >= l.top - 1 && c.bottom <= l.bottom + 1, listScroll: document.querySelector('#list').scrollTop, readerH2: Math.round(r('#reader h2').top) }; });
  console.log(m);
  // Long article to test Space
  await p.evaluate(() => { const c = document.querySelector('#reader .content'); c.innerHTML = '<p>x</p>'.repeat(200); });
  const id0 = await p.$eval('#reader', (e) => e.dataset.id);
  await p.keyboard.press(' '); await p.waitForTimeout(500);
  console.log('space scrolls:', await p.$eval('#reader', (e) => e.scrollTop));
  await p.$eval('#reader', (e) => { e.scrollTop = e.scrollHeight; }); await p.waitForTimeout(100);
  await p.keyboard.press(' '); await p.waitForTimeout(300);
  console.log('space at end → next article:', (await p.$eval('#reader', (e) => e.dataset.id)) !== id0, '| reader top', await p.$eval('#reader', (e) => e.scrollTop));
  await p.screenshot({ path: `${T}/shot-pane.png` });
  console.log('errors', errs); await b.close();
})();
