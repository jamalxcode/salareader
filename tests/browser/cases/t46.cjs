// For you learns, swipe rounds, highlights and notes, mute by meaning, the recap and achievements, Esc closes Brief me.
const { chromium } = require('playwright');
const T = process.argv[2];
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8770/?debug#/home'); await p.waitForSelector('.hero'); await p.waitForTimeout(800);
  // For you: newest first until it learns; opening articles teaches it.
  await p.click('#sidebar a[href="#/foryou"]'); await p.waitForSelector('#list article.entry');
  for (let i = 0; i < 3; i++) { await p.keyboard.press('j'); await p.waitForTimeout(200); }
  console.log('for you learned:', await p.evaluate(() => window.__salareader.taste.n), '|', await p.$eval('#viewHeader .sub', (e) => e.textContent));
  // Highlight with a note.
  await p.waitForTimeout(300);
  const sel = await p.evaluate(() => {
    const box = document.querySelector('article.entry.open [data-content]');
    const w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode()) && n.data.trim().length < 12);
    const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 12); getSelection().removeAllRanges(); getSelection().addRange(r); return r.toString();
  });
  await p.waitForSelector('#hlBar:not([hidden])');
  await p.click('#hlBar [data-hl="note"]'); await p.fill('#noteText', 'Check this later'); await p.click('#noteForm button[value="save"]'); await p.waitForTimeout(200);
  console.log('highlight mark:', await p.$$eval('article.entry.open mark.hl', (l) => l.map((m) => `${m.textContent}|${m.title}`).join()), '| selected:', sel);
  await p.click('#sidebar a[href="#/highlights"]'); await p.waitForTimeout(300);
  console.log('highlights page:', await p.$$eval('.hl-q', (l) => l.length), await p.$eval('.hl-note', (e) => e.textContent));
  const [md] = await Promise.all([p.waitForEvent('download'), p.click('[data-act="hlexport"]')]);
  console.log('markdown export:', md.suggestedFilename());
  // Mute a subject: hidden from mixed views and counts, "Show" brings it back.
  await p.click('#sidebar a[href="#/all"]'); await p.waitForTimeout(300);
  const before = await p.$eval('#sidebar a[href="#/all"] .count', (e) => +e.textContent);
  await p.evaluate(() => document.querySelector('[data-act="mutes"]').click()); await p.fill('#muteInput', 'quantum'); await p.press('#muteInput', 'Enter');
  await p.waitForFunction(() => /by meaning|by its words/.test(document.querySelector('#muteStatus').textContent), null, { timeout: 10000 });
  await p.click('#muteDialog [data-close]'); await p.waitForTimeout(300);
  const after = await p.$eval('#sidebar a[href="#/all"] .count', (e) => +e.textContent);
  console.log('mute hides:', before > after, '| quantum shown:', await p.$$eval('#list article.entry .t', (l) => l.filter((x) => /quantum/i.test(x.textContent)).length), '|', await p.$eval('#viewHeader .sub', (e) => /muted/.test(e.textContent)));
  await p.click('[data-act="showmuted"]'); await p.waitForTimeout(200);
  console.log('show muted:', await p.$$eval('#list article.entry .t', (l) => l.some((x) => /quantum/i.test(x.textContent))));
  // Swipe round: keys sort the cards; kept ones get their own list.
  await p.goto('http://localhost:8770/?debug#/home'); await p.waitForSelector('.hero');
  await p.keyboard.press('t'); await p.waitForSelector('#triageDialog[open] .tri-card');
  const n = await p.evaluate(() => document.querySelector('#triProg').textContent.split('/')[1].trim());
  for (let i = 0; i < +n; i++) { await p.keyboard.press(i % 2 ? 'ArrowLeft' : 'ArrowRight'); await p.waitForTimeout(220); }
  console.log('round done:', await p.$eval('.tri-done h2', (e) => e.textContent), '| kept', await p.evaluate(() => window.__salareader.kept.length), 'of', n);
  await p.click('[data-tri="readkept"]'); await p.waitForTimeout(300);
  console.log('kept list:', await p.evaluate(() => location.hash), await p.$$eval('#list article.entry', (l) => l.length));
  // Recap and achievements.
  await p.goto('http://localhost:8770/?debug#/recap'); await p.waitForSelector('.recap');
  console.log('recap:', await p.$eval('.recap-big', (e) => e.textContent.trim()), '| badges earned:', await p.$$eval('.badges li.on', (l) => l.map((x) => x.querySelector('b').textContent).join(', ')));
  const [png] = await Promise.all([p.waitForEvent('download'), p.click('[data-act="recapsave"]')]);
  console.log('recap image:', png.suggestedFilename());
  // Brief me: Esc closes it.
  await p.goto('http://localhost:8770/?debug#/home'); await p.waitForSelector('.hero');
  await p.evaluate(() => { const S = window.__salareader; S.settings.aiProvider = 'gemini'; S.settings.keys = { gemini: 'test' }; });
  await p.click('.hero [data-act="brief"]'); await p.waitForSelector('#brief:not([hidden]) .brief-close');
  await p.locator('#list').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  console.log('brief closed by Esc:', await p.$eval('#brief', (e) => e.hidden));
  console.log('errors', errs); await b.close();
})();
