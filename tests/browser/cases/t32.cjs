const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  for (const [w, h] of [[1000, 640], [1440, 900]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } });
    await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); if (u.includes('transformers')) return r.fulfill({ path: T + '/pw/fake-tf.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); return u.startsWith('http://localhost') ? r.continue() : r.abort(); });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8770/?debug#/smart/topic%3Aai'); await p.waitForSelector('article.entry');
    await p.click('article.entry .line'); await p.waitForSelector('.body .actions');
    await p.click('.body [data-act="digdeeper"]'); await p.waitForSelector('.inv-head'); await p.waitForTimeout(300);
    const m = await p.evaluate(() => { const r = (s) => document.querySelector(s)?.getBoundingClientRect(); return { main: Math.round(r('main').width), side: getComputedStyle(document.querySelector('#sidebar')).position, panel: Math.round(r('#invPanel').width), text: Math.round(r('.body .content').width) }; });
    console.log(w, 'px window:', m, '| main share', Math.round(m.main / w * 100) + '%', '| overflow', await p.evaluate(() => document.documentElement.scrollWidth - innerWidth));
    await p.screenshot({ path: `${T}/shot-stage-${w}.png` });
    if (w === 1000) { await p.click('#menuBtn'); await p.waitForTimeout(300); await p.screenshot({ path: `${T}/shot-stage-menu.png` }); await p.click('#sidebar a[href="#/all"]'); await p.waitForTimeout(300); console.log('menu closes after picking:', !(await p.evaluate(() => document.body.classList.contains('nav-open')))); }
    await ctx.close();
  }
  console.log('errors', errs); await b.close();
})();
