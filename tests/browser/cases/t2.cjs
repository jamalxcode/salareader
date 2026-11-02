const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.route('**/*', (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript' });
    if (u === 'https://openrouter.ai/api/v1/auth/keys') return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ key: 'sk-or-test', posted: r.request().postData() }) });
    if (u.startsWith('https://openrouter.ai/auth')) { console.log('redirected to', u.slice(0, 80) + '…'); return r.fulfill({ status: 200, body: 'auth page' }); }
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  await p.goto('http://localhost:8770/#/all');
  await p.evaluate(() => localStorage.setItem('sr.settings', JSON.stringify({ claudeKey: 'sk-ant-old', claudeModel: 'claude-haiku-5-5' })));
  await p.reload(); await p.waitForSelector('article.entry');
  await p.keyboard.press('j'); await p.waitForSelector('[data-act="summarize"]');
  await p.click('[data-act="summarize"]'); await p.waitForTimeout(800);
  console.log('claude summarize (CDN blocked):', await p.$eval('.ai-out', (e) => e.textContent));
  if (await p.$eval('#settingsDialog', (d) => d.open)) await p.keyboard.press('Escape');
  await p.keyboard.press('Alt+2'); await p.waitForTimeout(200);
  console.log('toast:', await p.$eval('#toast', (e) => e.textContent));
  await p.click('[data-act="summarize"]'); await p.waitForTimeout(400);
  console.log('needKey opened settings:', await p.$eval('#settingsDialog', (d) => d.open), '| label:', await p.$eval('#keyLabel', (e) => e.textContent), '| models:', await p.$$eval('#modelSel option', (o) => o.map((x) => x.textContent)));
  await p.fill('#keyInput', 'sk-test'); await p.press('#keyInput', 'Tab');
  console.log('providers:', await p.$$eval('#providerSel option', (o) => o.map((x) => x.textContent).join(' | ')));
  await p.selectOption('#providerSel', 'anthropic');
  console.log('claude migrated:', await p.inputValue('#keyInput'), await p.inputValue('#modelSel'));
  await p.selectOption('#providerSel', 'openrouter');
  console.log('openrouter signin visible:', await p.isVisible('#orSignInBtn'), await p.$$eval('#modelSel option', (o) => o.map((x) => x.textContent)));
  await p.screenshot({ path: T + '/shot-ai-settings.png' });
  await p.click('#orSignInBtn'); await p.waitForTimeout(800);
  const verifier = await p.evaluate(() => sessionStorage.getItem('sr.orVerifier'));
  await p.goto('http://localhost:8770/?debug&openrouter=1&code=abc123#/home'); await p.waitForTimeout(800);
  console.log('after return: url', p.url(), '| toast', await p.$eval('#toast', (e) => e.textContent));
  console.log('saved:', await p.evaluate(() => { const s = window.__salareader?.settings; return s ? [s.aiProvider, s.keys] : 'needs ?debug'; }), 'verifier was set:', !!verifier);
  console.log('errors', errs);
  await b.close();
})();
