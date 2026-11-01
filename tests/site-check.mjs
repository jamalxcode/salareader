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

if (pageErrors.length) fail('no page errors', pageErrors.slice(0, 5).join(' | '));
else pass('no page errors');

await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
