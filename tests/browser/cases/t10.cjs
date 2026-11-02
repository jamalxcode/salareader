const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.route('**/*', (r) => { const u = r.request().url(); if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); return u.startsWith('http://localhost') ? r.continue() : r.abort(); });
  const axe = async (label) => {
    await p.addScriptTag({ path: T + '/pw/node_modules/axe-core/axe.min.js' });
    const v = await p.evaluate(async () => (await axe.run(document)).violations.filter((x) => ['serious', 'critical'].includes(x.impact)).map((x) => `${x.id} (${x.nodes.length}) ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`));
    console.log(label, v.length ? v : 'clean');
  };
  for (const theme of ['light', 'dark', 'classic', 'paper']) {
    await p.goto('http://localhost:8770/');
    await p.evaluate((t) => localStorage.setItem('sr.theme', t), theme);
    await p.goto('http://localhost:8770/#/all'); await p.reload(); await p.waitForSelector('article.entry');
    await p.evaluate(() => document.querySelector('#streak').textContent = '🔥 3');
    await p.click('article.entry .line'); await p.waitForSelector('.body .actions');
    await axe(theme + ' list');
  }
  await p.goto('http://localhost:8770/#/home'); await p.reload(); await p.waitForSelector('.hero'); await axe('home');
  // keyboard: Tab to the first title and press Enter.
  await p.goto('http://localhost:8770/#/all'); await p.reload(); await p.waitForSelector('article.entry');
  await p.focus('article.entry .line'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  console.log('Enter on title opens:', await p.$eval('article.entry', (a) => a.classList.contains('open')), '| aria-expanded:', await p.$eval('article.entry .line', (x) => x.getAttribute('aria-expanded')));
  await p.keyboard.press('j'); await p.waitForTimeout(300);
  console.log('j moves to next:', await p.$eval('article.entry.open', (a) => a.dataset.idx));
  await p.click('article.entry.open .line'); await p.waitForTimeout(200);
  console.log('click title again closes:', !(await p.$('article.entry.open')));
  console.log('errors', errs);
  await b.close();
})();
