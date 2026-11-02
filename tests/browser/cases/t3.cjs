const { chromium } = require('playwright');
const T = process.argv[2];
const fs = require('fs');
(async () => {
  const b = await chromium.launch(); const errs = []; const reqs = [];
  const mk = async () => {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('request', (r) => reqs.push(r.url()));
    await p.route('**/*', (r) => {
      const u = r.request().url();
      if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript' });
      return u.startsWith('http://localhost') ? r.continue() : r.abort();
    });
    return p;
  };
  const dump = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('salareader'); r.onsuccess = () => { const out = {}; const c = r.result.transaction('kv').objectStore('kv').openCursor(); c.onsuccess = () => { const x = c.result; if (x) { out[x.key] = x.value; x.continue(); } else res(out); }; }; }));
  const p = await mk();
  // An older version's data in localStorage.
  await p.goto('http://localhost:8770/');
  await p.evaluate(() => { localStorage.setItem('sr.read', JSON.stringify({ abc: Date.now() })); localStorage.setItem('sr.settings', JSON.stringify({ claudeKey: 'sk-ant-x', theme: 'dark' })); localStorage.setItem('sr.topics', '[]'); });
  await p.reload(); await p.waitForSelector('.hero'); await p.waitForTimeout(600);
  let db = await dump(p);
  await p.waitForTimeout(400); db = await dump(p); console.log('1. first run subs:', db.subs?.length, '| migrated read:', Object.keys(db.read || {}), '| key:', db.settings?.keys?.anthropic, '| localStorage left:', await p.evaluate(() => Object.keys(localStorage)));
  console.log('   theme dark applied:', await p.evaluate(() => document.documentElement.dataset.theme));
  // Unsubscribe from a catalog feed.
  const firstFeed = await p.$eval('#sidebar a.feed', (a) => a.getAttribute('href'));
  await p.goto('http://localhost:8770/' + firstFeed); await p.waitForSelector('[data-act="unsub"]');
  p.once('dialog', (d) => d.accept()); await p.click('[data-act="unsub"]'); await p.waitForTimeout(500);
  db = await dump(p);
  console.log('2. after unsubscribe subs:', db.subs.length, '| sidebar feeds:', await p.$$eval('#sidebar a.feed', (a) => a.length));
  // Add dialog: catalog list + own feeds.
  await p.click('#addBtn');
  console.log('3. discover shows:', await p.$$eval('#discoverList li .name', (l) => l.map((x) => x.textContent)));
  await p.click('#discoverList [data-sub]'); await p.waitForTimeout(200);
  console.log('   re-added, subs:', (await dump(p)).subs.length, 'discover now:', await p.$$eval('#discoverList li', (l) => l.length));
  await p.fill('#addUrl', 'http://localhost:8766/cors/xkcd.xml'); await p.fill('#addFolder', 'Mine');
  await p.click('#addSubmit'); await p.waitForTimeout(800);
  console.log('4. own CORS feed added ->', p.url().split('#')[1], '| entries', await p.$$eval('article.entry', (a) => a.length));
  await p.click('#addBtn');
  await p.fill('#addUrl', 'http://localhost:8766/plain/bbc.xml'); await p.click('#addSubmit'); await p.waitForTimeout(800);
  console.log('5. blocked feed, no relay:', await p.$eval('#addStatus', (e) => e.textContent));
  await p.keyboard.press('Escape');
  await p.click('#settingsBtn');
  await p.check('input[name="relayMode"][value="own"]');
  await p.fill('#relayInput', 'http://localhost:8902'); await p.press('#relayInput', 'Tab');
  await p.click('#testRelay'); await p.waitForTimeout(800);
  console.log('6. relay test without token:', await p.$eval('#relayStatus', (e) => e.textContent));
  await p.fill('#relayToken', 'tok'); await p.press('#relayToken', 'Tab');
  await p.evaluate(() => { document.querySelector('#settingsDialog').close(); });
  await p.click('#addBtn'); await p.fill('#addUrl', 'http://feeds.test/plain/bbc.xml'); await p.click('#addSubmit'); await p.waitForTimeout(1000);
  console.log('7. via relay ->', p.url().split('#')[1], '| title', await p.$eval('.vh-title h1', (e) => e.textContent.trim()), '| entries', await p.$$eval('article.entry', (a) => a.length));
  await p.keyboard.press('j'); await p.waitForTimeout(300); await p.keyboard.press('s'); await p.waitForTimeout(500);
  db = await dump(p);
  console.log('   stored: subs', db.subs.length, 'own feeds', db.subs.filter((s) => s.own).length, 'own: records', Object.keys(db).filter((k) => k.startsWith('own:')).length, 'starred', Object.keys(db.starred).length, 'read', Object.keys(db.read).length);
  await p.screenshot({ path: T + '/shot-own.png' });
  // Export backup (without keys).
  await p.click('#settingsBtn');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exportBackup')]);
  const file = T + '/backup.json'; await dl.saveAs(file);
  const bk = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('8. backup:', dl.suggestedFilename(), '| subs', bk.data.subs.length, '| keys in file:', JSON.stringify(bk.data.settings.keys), 'token:', JSON.stringify(bk.data.settings.relayToken), '| relay kept:', bk.data.settings.relay);
  await p.screenshot({ path: T + '/shot-privacy.png' });
  // Fresh "device": import.
  const q = await mk();
  await q.goto('http://localhost:8770/'); await q.waitForSelector('.hero');
  await q.click('#settingsBtn');
  q.once('dialog', (d) => d.accept());
  await q.setInputFiles('#backupFile', file); await q.waitForTimeout(1500);
  await q.waitForSelector('#sidebar a.feed');
  const qdb = await dump(q);
  console.log('9. new device after import: subs', qdb.subs.length, 'starred', Object.keys(qdb.starred).length, 'read', Object.keys(qdb.read).length, '| sidebar has Mine folder:', await q.$$eval('.folder-row .name', (l) => l.map((x) => x.textContent.trim()).join(', ')));
  // Erase.
  await q.click('#settingsBtn'); q.once('dialog', (d) => d.accept()); await q.click('#eraseAll'); await q.waitForTimeout(1200);
  console.log('10. after erase: subs', (await dump(q)).subs?.length, '(fresh catalog default)');
  const outside = [...new Set(reqs.filter((u) => !u.startsWith('http://localhost')).map((u) => new URL(u).host))];
  const dataReqs = [...new Set(reqs.filter((u) => u.includes('/data/')).map((u) => new URL(u).pathname))];
  console.log('outside hosts requested:', outside, '| data files:', dataReqs);
  console.log('errors', errs);
  await b.close();
})();
