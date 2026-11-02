const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = []; const asked = []; const files = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.startsWith('https://salareader-relay')) {
      const q = new URL(u).searchParams; asked.push(q.get('mode') + ' ' + q.get('url'));
      const h = { 'access-control-allow-origin': 'http://localhost:8770', 'access-control-expose-headers': 'X-Relay-Kind', 'x-relay-kind': 'article' };
      return r.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify({ title: 'X', blocks: [{ t: 'h2', x: 'Whole story' }, { t: 'p', x: 'Para one <script>alert(1)</script>' }, { t: 'li', x: 'a' }, { t: 'li', x: 'b' }, { t: 'img', src: 'javascript:alert(1)' }, { t: 'p', x: 'Para two' }] }) });
    }
    if (u.startsWith('http://localhost')) { files.push(new URL(u).pathname); return r.continue(); }
    return r.abort();
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:8770/?debug#/all'); await p.waitForSelector('.entry');
  await p.click('.entry .line'); await p.waitForSelector('[data-act="fullarticle"]');
  await p.click('[data-act="fullarticle"]'); await p.waitForFunction(() => /Feed version/.test(document.querySelector('[data-act="fullarticle"]').textContent));
  console.log('full article:', await p.$eval('[data-content]', (e) => e.innerHTML));
  console.log('relay asked:', asked);
  await p.click('[data-act="fullarticle"]'); await p.waitForTimeout(300);
  console.log('back to feed version:', await p.$eval('[data-act="fullarticle"]', (e) => e.textContent), '| content starts', (await p.$eval('[data-content]', (e) => e.textContent)).slice(0, 60));
  // Language model switch
  await p.evaluate(() => document.querySelector('#settingsBtn, [data-act="settings"], #openSettings')?.click());
  await p.waitForTimeout(300);
  const open = await p.$eval('#settingsDialog', (d) => d.open);
  console.log('settings open', open, '| model select', await p.$eval('#aiModelSel', (e) => e.value));
  await p.selectOption('#aiModelSel', 'multi'); await p.waitForTimeout(300);
  console.log('note:', await p.$eval('#aiModelNote', (e) => e.textContent));
  console.log('saved setting:', await p.evaluate(() => window.__salareader.settings.aiModel));
  await p.evaluate(() => document.querySelector('#settingsDialog').close());
  await p.goto('http://localhost:8770/?debug#/search/ukraine'); await p.waitForTimeout(1500);
  console.log('vector files fetched:', files.filter((f) => f.includes('vectors')));
  console.log('errors', errs);
  await b.close();
})();
