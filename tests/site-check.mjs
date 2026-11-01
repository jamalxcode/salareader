// Loads the live site in a real Chrome and uses it like a reader would.
// Run by .github/workflows/site-check.yml (Actions → Check the live site).
// SITE=https://reader.sala.company node tests/site-check.mjs

import { chromium } from 'playwright';

const SITE = (process.env.SITE || 'https://reader.sala.company').replace(/\/$/, '');
const results = [];
const pass = (name, detail = '') => { results.push(['PASS', name, detail]); console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`); };
const fail = (name, detail = '') => { results.push(['FAIL', name, detail]); console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`); };
const info = (name, detail = '') => { results.push(['INFO', name, detail]); console.log(`INFO ${name}${detail ? `: ${detail}` : ''}`); };
async function step(name, fn) {
  try { const d = await fn(); pass(name, d || ''); } catch (e) { fail(name, String(e.message || e).split('\n')[0].slice(0, 300)); }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('dialog', (d) => d.accept());

await step('site loads', async () => {
  await page.goto(SITE + '/', { waitUntil: 'load' });
  await page.waitForSelector('.hero', { timeout: 30000 });
  return await page.title();
});

await step('DOMPurify loaded (integrity hash matches the CDN)', async () => {
  if (!(await page.evaluate(() => !!window.DOMPurify))) throw new Error('window.DOMPurify missing: the integrity hash may not match');
});

await step('catalog articles are listed', async () => {
  const n = await page.$eval('a[href="#/all"] .count', (e) => e.textContent);
  if (!n || n === '0') throw new Error('no unread articles');
  return `${n} unread`;
});

await step('opening an article shows its text', async () => {
  await page.goto(SITE + '/#/all');
  await page.waitForSelector('article.entry');
  await page.click('article.entry .row');
  await page.waitForFunction(() => document.querySelector('.body [data-content]')?.dataset.filled && !document.querySelector('.body [data-content] .loading'), null, { timeout: 30000 });
  return (await page.$eval('.body [data-content]', (e) => e.textContent.trim().slice(0, 80))) || '(empty)';
});

const consoleMsgs = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleMsgs.push(m.text().slice(0, 300)); });
page.on('requestfailed', (r) => consoleMsgs.push(`request failed: ${r.url().slice(0, 150)} ${r.failure()?.errorText}`));

await step('AI model loads in the browser', async () => {
  const r = await page.evaluate(async () => {
    try {
      const ai = await import('/ai.js');
      const [v] = await ai.embed(['hello world']);
      return `ok, ${v.length} numbers`;
    } catch (e) { return 'ERROR ' + (e && (e.stack || e.message) || String(e)); }
  });
  if (r.startsWith('ERROR')) throw new Error(r.slice(0, 600) + ' || console: ' + consoleMsgs.slice(-6).join(' | '));
  return r;
});

await step('AI search by meaning (downloads the model)', async () => {
  await page.fill('#q', 'space exploration and rockets');
  await page.press('#q', 'Enter');
  await page.waitForFunction(() => location.hash.startsWith('#/search/'), null, { timeout: 10000 });
  const t0 = Date.now();
  let last = '';
  await page.waitForFunction(() => {
    const sub = document.querySelector('#viewHeader .sub')?.textContent || '';
    return location.hash.startsWith('#/search/') && sub && !/Finding articles|Downloading/.test(sub);
  }, null, { timeout: 240000, polling: 500 }).catch(async (e) => { last = await page.$eval('#viewHeader .sub', (x) => x.textContent).catch(() => '?'); throw new Error(`still "${last}"`); });
  info('AI search took', `${Math.round((Date.now() - t0) / 1000)} s`);
  const sub = await page.$eval('#viewHeader .sub', (e) => e.textContent);
  if (/Couldn't load the AI model|word matches/.test(sub)) throw new Error(sub);
  const n = await page.$$eval('article.entry', (a) => a.length);
  const pct = await page.$$eval('article.entry .match', (m) => m.slice(0, 3).map((x) => x.textContent));
  if (!n) throw new Error(`no results; header says "${sub}"; empty text: ${await page.$eval('#list', (e) => e.textContent.trim().slice(0, 120))}`);
  if (!pct.length) throw new Error(`results are word matches only (no match scores); header says "${sub}"`);
  return `${n} results, top matches ${pct.join(' ')}`;
});

await step('More like this', async () => {
  await page.goto(SITE + '/#/all');
  await page.waitForSelector('article.entry');
  await page.click('article.entry .row');
  await page.waitForSelector('.body [data-act="related"]');
  await page.click('.body [data-act="related"]');
  await page.waitForFunction(() => { const r = document.querySelector('.body .related'); return r && !r.querySelector('.loading'); }, null, { timeout: 120000 });
  const t = await page.$eval('.body .related', (e) => e.textContent.trim());
  if (/Couldn't/.test(t)) throw new Error(t);
  return t.slice(0, 100);
});

await step('add a website through the shared relay', async () => {
  await page.goto(SITE + '/#/home');
  await page.click('#addBtn');
  await page.fill('#addUrl', 'https://daringfireball.net/');
  await page.click('#addSubmit');
  await page.waitForFunction(() => location.hash.startsWith('#/feed/L') || /[a-z]/i.test(document.querySelector('#addStatus')?.textContent || '') && !/Looking|Found/.test(document.querySelector('#addStatus').textContent), null, { timeout: 60000 });
  const hash = await page.evaluate(() => location.hash);
  if (!hash.startsWith('#/feed/L')) throw new Error(await page.$eval('#addStatus', (e) => e.textContent));
  await page.waitForSelector('article.entry', { timeout: 20000 });
  return `${await page.$$eval('article.entry', (a) => a.length)} articles`;
});

await step('follow a news search (words in Subscribe)', async () => {
  await page.goto(SITE + '/#/home');
  await page.click('#addBtn');
  await page.fill('#addUrl', 'tbilisi');
  await page.press('#addUrl', 'Enter');
  await page.waitForFunction(() => location.hash.startsWith('#/feed/L') || /couldn|isn't|refus|blocks/i.test(document.querySelector('#addStatus')?.textContent || ''), null, { timeout: 60000 });
  const hash = await page.evaluate(() => location.hash);
  if (!hash.startsWith('#/feed/L')) throw new Error(await page.$eval('#addStatus', (e) => e.textContent));
  await page.waitForSelector('article.entry', { timeout: 20000 });
  await page.click('article.entry .line');
  const href = await page.$eval('.body h2 a', (a) => a.href);
  if (/bing\.com\/news\/apiclick/.test(href)) throw new Error('article link still goes through Bing: ' + href);
  return `${await page.$$eval('article.entry', (a) => a.length)} articles, first links to ${new URL(href).hostname}`;
});

await step('old Google News search address works (via Bing News)', async () => {
  await page.evaluate(() => { const f = new File([`<?xml version="1.0"?><opml version="1.0"><body><outline type="rss" text="tbilisi - Google News" xmlUrl="https://news.google.com/news?q=tbilisi&amp;output=rss"/></body></opml>`], 'gn.opml', { type: 'text/xml' }); const dt = new DataTransfer(); dt.items.add(f); const inp = document.querySelector('#opmlFile'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => !document.querySelector('.nav-note.progress') && [...document.querySelectorAll('#sidebar a.feed')].some((a) => /Google News/.test(a.textContent)), null, { timeout: 60000 });
  await page.click('#sidebar a.feed >> text=Google News');
  await page.waitForSelector('#viewHeader .sub');
  const sub = await page.$eval('#viewHeader .sub', (e) => e.textContent);
  if (/Couldn't/.test(sub)) throw new Error(sub);
  return sub;
});

// Each assistant gets a fake key. A "key rejected" answer means the browser
// reached the company's API (it accepts requests from web pages); "couldn't
// reach" means it blocks them (CORS) or is down.
const providers = [['anthropic', 'claude-haiku-5-5'], ['openai', 'auto'], ['deepseek', 'deepseek-v4-flash'], ['xai', 'grok-4'], ['openrouter', 'openrouter/auto'], ['gemini', 'gemini-2.5-flash']];
for (const [id, model] of providers) {
  const r = await page.evaluate(async ([id, model]) => {
    try {
      const ai = await import('/ai.js');
      await ai.askAI({ providerId: id, apiKey: 'sk-fake-key-for-testing-0000000000', model, system: 'Say hi.', prompt: 'Hi' });
      return 'answered (unexpected)';
    } catch (e) { return String(e.message || e); }
  }, [id, model]);
  const reached = /didn't accept|rejected|API error 4|out of credit|isn't available|rate limit/i.test(r);
  if (reached) pass(`AI ${id}: reachable from the browser`, r.slice(0, 120));
  else info(`AI ${id}: NOT reachable from the browser`, r.slice(0, 160));
}

// ---------- phone ----------
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
phone.on('pageerror', (e) => pageErrors.push('phone: ' + e.message));
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

await step('phone: home fits the screen', async () => {
  await phone.goto(SITE + '/');
  await phone.waitForSelector('.hero');
  const o = await overflow(phone);
  if (o > 1) throw new Error(`page is ${o}px wider than the screen`);
});

await step('phone: menu opens the subscriptions, picking one closes it', async () => {
  await phone.tap('#menuBtn');
  await phone.waitForTimeout(400);
  const open = await phone.evaluate(() => document.body.classList.contains('nav-open') && document.querySelector('#sidebar').getBoundingClientRect().left >= 0);
  if (!open) throw new Error('sidebar did not slide in');
  await phone.tap('#sidebar a.feed');
  await phone.waitForTimeout(400);
  if (await phone.evaluate(() => document.body.classList.contains('nav-open'))) throw new Error('sidebar stayed open');
  await phone.waitForSelector('article.entry');
});

await step('phone: an open article fits the screen', async () => {
  await phone.tap('article.entry .row');
  await phone.waitForSelector('.body .actions');
  await phone.waitForTimeout(800);
  const o = await overflow(phone);
  if (o > 1) throw new Error(`page is ${o}px wider than the screen`);
});

await step('phone: Settings dialog fits and scrolls', async () => {
  await phone.tap('#settingsBtn');
  const r = await phone.$eval('#settingsDialog', (d) => { const b = d.getBoundingClientRect(); return { w: b.width, right: b.right, h: b.height, sh: d.scrollHeight, vw: innerWidth, vh: innerHeight }; });
  if (r.right > r.vw || r.h > r.vh) throw new Error(JSON.stringify(r));
  await phone.keyboard.press('Escape');
});

// ---------- accessibility (axe-core) ----------
async function axe(p, label) {
  await p.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/axe-core@4.14.0/axe.min.js' });
  const res = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations
    .filter((v) => ['serious', 'critical'].includes(v.impact))
    .map((v) => `${v.impact} ${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(', ')}`));
  if (res.length) { for (const r of res) info(`a11y ${label}`, r); throw new Error(`${res.length} serious/critical accessibility problems (listed above)`); }
}
await step('accessibility: home', async () => { await page.goto(SITE + '/#/home'); await page.waitForSelector('.hero'); await axe(page, 'home'); });
await step('accessibility: article list with an open article', async () => {
  await page.goto(SITE + '/#/all'); await page.reload(); await page.waitForSelector('article.entry');
  await page.click('article.entry .row'); await page.waitForSelector('.body .actions');
  await axe(page, 'list');
});
await step('accessibility: Settings', async () => {
  await page.click('#settingsBtn'); await page.waitForTimeout(300);
  await axe(page, 'settings');
  await page.keyboard.press('Escape');
});
await step('accessibility: dark theme contrast', async () => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(SITE + '/#/all'); await page.reload(); await page.waitForSelector('article.entry');
  await axe(page, 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
});

if (pageErrors.length) fail('no page errors', pageErrors.slice(0, 5).join(' | '));
else pass('no page errors');

await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
