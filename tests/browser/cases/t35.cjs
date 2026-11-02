const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); if (u.includes('transformers')) return r.fulfill({ path: T + '/pw/fake-tf.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); return u.startsWith('http://localhost') ? r.continue() : r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/Failed to load|net::/.test(m.text()) && errs.push('console: ' + m.text()));
  p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:8770/?debug#/all'); await p.waitForSelector('article.entry');
  // 1. Reading pane
  await p.click('[data-act="pane"]'); await p.waitForTimeout(200);
  console.log('pane class:', await p.evaluate(() => document.body.classList.contains('pane')), '| empty reader:', await p.isVisible('.reader-empty'));
  await p.keyboard.press('j'); await p.waitForTimeout(300);
  const m = await p.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { list: Math.round(r('#list').width), reader: Math.round(r('#reader').width), readerTitle: document.querySelector('#reader h2')?.textContent.trim().slice(0, 40), cur: document.querySelector('#list .entry.current .t')?.textContent.slice(0, 40), pageScroll: document.documentElement.scrollHeight - innerHeight }; });
  console.log('after j:', m);
  await p.keyboard.press('j'); await p.waitForTimeout(200);
  console.log('2nd j reader:', await p.$eval('#reader h2', (e) => e.textContent.trim().slice(0, 40)), '| first read:', await p.$eval('#list .entry', (e) => e.classList.contains('read')));
  await p.click('#reader [data-act="star"]'); await p.waitForTimeout(100);
  console.log('star from reader → list star on:', await p.$eval('#list .entry.current .star', (e) => e.classList.contains('on')));
  // Space pages the reader
  const st0 = await p.$eval('#reader', (e) => e.scrollTop); await p.keyboard.press(' '); await p.waitForTimeout(600);
  console.log('space: reader scroll', st0, '→', await p.$eval('#reader', (e) => e.scrollTop), '| scrollable', await p.$eval('#reader', (e) => e.scrollHeight > e.clientHeight));
  await p.click('#list .entry:nth-child(5) .line'); await p.waitForTimeout(200);
  console.log('click 5th → reader:', await p.$eval('#reader h2', (e) => e.textContent.trim().slice(0, 30)), '=', await p.$eval('#list .entry:nth-child(5) .t', (e) => e.textContent.slice(0, 30)));
  // list resizer
  const bx = await p.locator('#listResizer').boundingBox(); await p.mouse.move(bx.x + 4, bx.y + 200); await p.mouse.down(); await p.mouse.move(bx.x + 104, bx.y + 200, { steps: 5 }); await p.mouse.up();
  console.log('list resized:', await p.$eval('#list', (e) => Math.round(e.getBoundingClientRect().width)));
  await p.screenshot({ path: `${T}/shot-pane.png` });
  // mode is global
  await p.goto('http://localhost:8770/?debug#/starred'); await p.waitForTimeout(400); await p.goto('http://localhost:8770/?debug#/folder/Science'); await p.waitForSelector('#list .entry');
  console.log('pane in other view:', await p.evaluate(() => document.body.classList.contains('pane')));
  // narrow window falls back
  await p.setViewportSize({ width: 900, height: 800 }); await p.waitForTimeout(300);
  console.log('900px pane:', await p.evaluate(() => document.body.classList.contains('pane')), '| pane button shown:', await p.isVisible('[data-act="pane"]'));
  await p.setViewportSize({ width: 1440, height: 900 }); await p.waitForTimeout(300);
  // 5. right-click menus
  await p.click('#list .entry:nth-child(3) .row', { button: 'right' }); await p.waitForTimeout(100);
  console.log('article menu:', await p.$$eval('#ctxMenu .ctx-item span', (x) => x.map((e) => e.textContent)));
  await p.screenshot({ path: `${T}/shot-ctx.png` });
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('Escape');
  console.log('menu closed by Esc:', await p.isHidden('#ctxMenu'));
  const unreadBefore = await p.$$eval('#list .entry:not(.read)', (x) => x.length);
  await p.click('#list .entry:nth-child(4) .row', { button: 'right' });
  await p.click('#ctxMenu .ctx-item:has-text("above as read")'); await p.waitForTimeout(200);
  console.log('mark above read: unread', unreadBefore, '→', await p.$$eval('#list .entry:not(.read)', (x) => x.length));
  await p.click('#sidebar a.feed >> nth=0', { button: 'right' });
  console.log('feed menu:', await p.$$eval('#ctxMenu .ctx-item span', (x) => x.map((e) => e.textContent)));
  await p.keyboard.press('Escape');
  await p.click('#sidebar .folder-row[data-drop] >> nth=0', { button: 'right' });
  console.log('folder menu:', await p.$$eval('#ctxMenu .ctx-item span', (x) => x.map((e) => e.textContent)));
  await p.keyboard.press('Escape');
  await p.click('#sidebar a[href="#/all"]', { button: 'right' });
  console.log('all menu:', await p.$$eval('#ctxMenu .ctx-item span', (x) => x.map((e) => e.textContent)));
  await p.keyboard.press('Escape');
  // 7. command palette
  await p.keyboard.press('Control+k'); await p.waitForTimeout(100);
  console.log('palette open:', await p.evaluate(() => document.querySelector('#cmdk').open), '| items', await p.$$eval('#cmdkList li', (x) => x.length));
  await p.keyboard.type('verge'); await p.waitForTimeout(100);
  console.log('“verge”:', await p.$$eval('#cmdkList li .cl', (x) => x.slice(0, 5).map((e) => e.textContent)));
  await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  console.log('went to:', await p.evaluate(() => location.hash), await p.$eval('#viewHeader h1', (e) => e.textContent.trim()));
  await p.keyboard.press('Meta+k'); await p.keyboard.type('dark'); await p.waitForTimeout(100);
  console.log('“dark”:', await p.$$eval('#cmdkList li .cl', (x) => x.slice(0, 3).map((e) => e.textContent)));
  await p.keyboard.press('Enter'); await p.waitForTimeout(100);
  console.log('theme now:', await p.evaluate(() => document.documentElement.dataset.theme));
  await p.keyboard.press('Control+k'); await p.keyboard.type('electric cars'); await p.waitForTimeout(100);
  console.log('“electric cars” last:', await p.$$eval('#cmdkList li .cl', (x) => x.slice(-3).map((e) => e.textContent)));
  await p.keyboard.press('Escape');
  await p.keyboard.press('Control+k'); await p.keyboard.type('lyout pane'); await p.waitForTimeout(100);
  console.log('fuzzy “lyout pane”:', await p.$$eval('#cmdkList li .cl', (x) => x.slice(0, 2).map((e) => e.textContent)));
  await p.keyboard.press('Escape');
  await p.screenshot({ path: `${T}/shot-dark.png` });
  // 10. text size
  await p.keyboard.press('j'); await p.waitForTimeout(200);
  const fs = () => p.$eval('#reader .content', (e) => getComputedStyle(e).fontSize + ' ' + getComputedStyle(e).fontFamily.slice(0, 12) + ' ' + getComputedStyle(e).maxWidth);
  console.log('text before:', await fs());
  await p.keyboard.press('='); await p.keyboard.press('='); console.log('after + +:', await fs());
  await p.keyboard.press('-'); console.log('after −:', await fs());
  await p.click('#aaBtn'); await p.waitForTimeout(100);
  await p.click('[data-aa-font="sans"]'); await p.click('[data-aa-width="narrow"]'); await p.click('[data-aa-lh="loose"]');
  console.log('sans narrow loose:', await fs(), await p.$eval('#reader .content', (e) => getComputedStyle(e).lineHeight));
  await p.screenshot({ path: `${T}/shot-aa.png` });
  await p.keyboard.press('Escape'); await p.waitForTimeout(2500); console.log('aa closed:', await p.isHidden('#aaPop'));
  await p.reload(); await p.waitForSelector('#list .entry'); await p.keyboard.press('j'); await p.waitForTimeout(200);
  console.log('after reload:', await fs());
  // 2. app
  console.log('manifest:', await p.evaluate(async () => (await (await fetch('manifest.webmanifest')).json()).name), '| sw:', await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!r; }), '| title:', await p.title());
  await p.click('#settingsBtn'); await p.waitForTimeout(300);
  console.log('app info:', await p.$eval('#appInfo', (e) => e.textContent.slice(0, 160)));
  console.log('auto backup box:', await p.isVisible('#abChoose'), await p.$eval('#abStatus', (e) => e.textContent));
  console.log('errors', errs); await b.close();
})();
