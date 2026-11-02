const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const mk = async () => {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.route('**/*', async (r) => {
      const u = r.request().url();
      if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript' });
      if (u.startsWith('https://salareader-relay.jamal-akuna-matata.workers.dev')) {
        const res = await r.fetch({ url: u.replace('https://salareader-relay.jamal-akuna-matata.workers.dev', 'http://localhost:8902') });
        return r.fulfill({ response: res });
      }
      return u.startsWith('http://localhost') ? r.continue() : r.abort();
    });
    return p;
  };
  // A new user: shared relay by default.
  const p = await mk();
  await p.goto('http://localhost:8770/'); await p.waitForSelector('.hero');
  await p.click('#settingsBtn');
  console.log('new user mode:', await p.$eval('input[name=relayMode]:checked', (e) => e.value), '| own fields hidden:', await p.$eval('#ownRelay', (e) => e.hidden));
  await p.click('#testRelay'); await p.waitForTimeout(800);
  console.log('test:', await p.$eval('#relayStatus', (e) => e.textContent));
  await p.evaluate(() => document.querySelector('#settingsDialog').close());
  await p.click('#addBtn'); await p.fill('#addUrl', 'http://feeds.test/plain/page.html'); await p.click('#addSubmit'); await p.waitForTimeout(4000);
  console.log('status:', await p.$eval('#addStatus', (e) => e.textContent)); console.log('add a web page ->', p.url().split('#')[1], '|', await p.$eval('.vh-title h1', (e) => e.textContent.trim()), '|', await p.$$eval('article.entry', (a) => a.length), 'entries');
  await p.click('#addBtn'); await p.fill('#addUrl', 'http://feeds.test/plain/nope.xml'); await p.click('#addSubmit'); await p.waitForTimeout(800);
  console.log('404:', await p.$eval('#addStatus', (e) => e.textContent));
  await p.keyboard.press('Escape');
  await p.click('#settingsBtn'); await p.check('input[name=relayMode][value=off]');
  await p.evaluate(() => document.querySelector('#settingsDialog').close());
  await p.click('#addBtn'); await p.fill('#addUrl', 'http://feeds.test/plain/bbc.xml'); await p.click('#addSubmit'); await p.waitForTimeout(800);
  console.log('relay off:', await p.$eval('#addStatus', (e) => e.textContent));
  await p.keyboard.press('Escape');
  await p.click('#settingsBtn'); await p.check('input[name=relayMode][value=own]');
  console.log('own fields shown:', !(await p.$eval('#ownRelay', (e) => e.hidden)));
  await p.check('input[name=relayMode][value=shared]');
  await p.screenshot({ path: T + '/shot-relay.png' });
  // Your current setup: own-relay settings pointing at the shared address, with a token.
  const q = await mk();
  await q.goto('http://localhost:8770/');
  await q.evaluate(() => new Promise((res) => { const r = indexedDB.open('salareader'); r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ relay: 'https://salareader-relay.jamal-akuna-matata.workers.dev/', relayToken: 'sr-7f' }, 'settings'); tx.oncomplete = res; }; }));
  await q.reload(); await q.waitForSelector('.hero'); await q.waitForTimeout(500);
  await q.click('#settingsBtn');
  console.log('your settings ->', await q.$eval('input[name=relayMode]:checked', (e) => e.value));
  console.log('errors', errs);
  await b.close();
})();
