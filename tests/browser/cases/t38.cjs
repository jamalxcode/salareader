const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const errs = [];
  // A normal (not private) browser profile, as people use.
  const ctx = await chromium.launchPersistentContext(T + '/profile-' + Date.now(), { viewport: { width: 1440, height: 900 } }); const b = ctx;
  await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); if (u.includes('transformers')) return r.fulfill({ path: T + '/pw/fake-tf.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); return u.startsWith('http://localhost') ? r.continue() : r.abort(); });
  // The browser's private file system stands in for a folder you pick.
  await ctx.addInitScript(() => { window.showDirectoryPicker = async () => { const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle('Dropbox', { create: true }); }; });
  const p = ctx.pages()[0] || await ctx.newPage(); p.on('console', (m) => /abFolder/.test(m.text()) && console.log(m.text().slice(0, 200))); p.on('pageerror', (e) => errs.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:8770/?debug#/all'); await p.waitForSelector('article.entry');
  await p.click('#list .entry .star'); // something to restore later
  await p.click('#settingsBtn'); await p.waitForTimeout(200);
  console.log('before:', await p.$eval('#abStatus', (e) => e.textContent));
  await p.click('#abChoose'); await p.waitForTimeout(1500);
  console.log('after choose:', await p.$eval('#abStatus', (e) => e.textContent));
  const files = () => p.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('Dropbox'); const out = {}; for await (const [n, h] of d.entries()) out[n] = (await (await h.getFile()).text()).slice(0, 70); return out; });
  console.log('files:', await files());
  // old dated files are pruned to 7
  await p.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('Dropbox'); for (let i = 1; i <= 9; i++) { const f = await d.getFileHandle(`salareader-backup-2026-10-0${i}.json`, { create: true }); const w = await f.createWritable(); await w.write('{}'); await w.close(); } });
  // encrypt
  await p.check('#abEncrypt'); await p.waitForSelector('#passDialog[open]');
  await p.fill('#pass1', 'correct horse'); await p.fill('#pass2', 'correct horse'); await p.click('#passDialog button[value="ok"]'); await p.waitForTimeout(2500);
  console.log('encrypted status:', await p.$eval('#abStatus', (e) => e.textContent));
  const f2 = await files(); console.log('file count:', Object.keys(f2).length, '| latest starts:', f2['salareader-backup.json']);
  const enc = await p.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('Dropbox'); return (await (await d.getFileHandle('salareader-backup.json')).getFile()).text(); });
  console.log('keys inside? plaintext visible:', /starred|subs/.test(enc));
  // restore it: wrong passphrase first, then right one
  require('fs').writeFileSync(T + '/enc-backup.json', enc);
  const S0 = await p.evaluate(() => Object.keys(window.__salareader.starred).length);
  await p.evaluate(() => { window.__salareader.starred = {}; });
  await p.setInputFiles('#backupFile', T + '/enc-backup.json'); await p.waitForSelector('#passDialog[open]');
  await p.fill('#pass1', 'wrong passphrase'); await p.click('#passDialog button[value="ok"]'); await p.waitForTimeout(1500);
  console.log('wrong pass toast:', await p.$eval('#toast', (e) => e.textContent));
  await p.setInputFiles('#backupFile', T + '/enc-backup.json'); await p.waitForSelector('#passDialog[open]');
  await p.fill('#pass1', 'correct horse');
  p.on('crash', () => console.log('CRASH')); p.on('close', () => console.log('CLOSED'));
  await p.click('#passDialog button[value="ok"]');
  await p.waitForTimeout(4000);
  console.log('url now', p.url());
  await p.waitForSelector('article.entry, .hero');
  console.log('restored starred:', S0, '→', await p.evaluate(() => Object.keys(window.__salareader.starred).length), '| auto backup kept:', await p.evaluate(() => 1));
  await p.click('#settingsBtn'); await p.waitForTimeout(300);
  console.log('status after restore:', await p.$eval('#abStatus', (e) => e.textContent));
  // a crash while reading the folder must not stop the reader opening next time
  await p.evaluate(() => localStorage.setItem('srl.abReading', '1'));
  console.log('flag set:', await p.evaluate(() => localStorage.getItem('srl.abReading')));
  await p.reload(); await p.waitForSelector('article.entry, .hero'); await p.waitForTimeout(500);
  console.log('flag after:', await p.evaluate(() => localStorage.getItem('srl.abReading')));
  await p.click('#settingsBtn'); await p.waitForTimeout(300);
  console.log('after a simulated crash:', await p.$eval('#abStatus', (e) => e.textContent));
  console.log('errors', errs); await b.close();
})();
