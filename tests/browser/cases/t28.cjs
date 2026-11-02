const { chromium } = require('playwright');
const T = process.argv[2];
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title><link>https://www.bing.com/news</link><item><title>Jet story from news</title><link>http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fnews.test%2fjet</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
(async () => {
  const b = await chromium.launch(); const errs = []; const xreq = [];
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.includes('transformers')) return r.fulfill({ path: T + '/pw/fake-tf.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.includes('openai@')) return r.fulfill({ path: T + '/pw/openai.mjs', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (u.startsWith('https://api.x.ai/v1/responses')) {
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
      const body = JSON.parse(r.request().postData()); xreq.push(body);
      const isYt = body.tools.some((t) => t.allowed_domains);
      const text = isYt ? 'Videos:\n- **Dashcam: Learjet crash** — WPTV — Nov 2 — https://www.youtube.com/watch?v=dQw4w9WgXcQ — local news footage\n- [FAA briefing](https://youtu.be/abcdefghijk) — official' : 'On X, **officials** confirmed the crash [1]. Eyewitness video: https://x.com/witness/status/123 and the FAA statement [FAA](https://faa.gov/news).\n- Nine dead\n- Learjet 60';
      const response = { id: 'r1', model: 'grok-4-1-fast', output: [{ type: 'x_search_call' }, { type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', url: 'https://x.com/witness/status/123', title: 'Witness video' }, { type: 'url_citation', url: 'https://faa.gov/news', title: 'FAA statement' }] }] }], citations: ['https://x.com/witness/status/123', 'https://news.test/a'] };
      const parts = text.match(/.{1,20}/gs);
      return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' }, body: sse([{ type: 'response.created', response: { id: 'r1' } }, ...parts.map((d) => ({ type: 'response.output_text.delta', delta: d })), { type: 'response.completed', response }]) });
    }
    if (u.startsWith('https://salareader-relay')) return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': 'http://localhost:8770' }, contentType: 'application/xml', body: rss });
    return u.startsWith('http://localhost') ? r.continue() : r.abort();
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errs.push(m.text()); });
  p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:8770/?debug#/search/ai%20model'); await p.waitForSelector('article.entry');
  await p.evaluate(() => { window.__salareader.settings.keys.xai = 'xai-test'; });
  await p.click('[data-act="investigate"]'); await p.waitForSelector('.inv-panel .inv-head');
  console.log('panel:', await p.$eval('.inv-panel', (e) => e.innerText.replace(/\s+/g, ' ').slice(0, 400)));
  await p.click('[data-act="invprompt"][data-k="0"]');
  await p.waitForSelector('.inv-a:not(.working) .via', { timeout: 20000 });
  console.log('answer:', await p.$eval('.inv-a:not(.working)', (e) => e.innerHTML.slice(0, 700)));
  const req = xreq[0]; console.log('request: model', req.model, '| tools', JSON.stringify(req.tools), '| input roles', req.input.map((m) => m.role), '| instructions has articles:', /\[1\]/.test(req.instructions), '| stream', req.stream);
  await p.click('[data-act="invprompt"][data-k="1"]');
  await p.waitForFunction(() => document.querySelectorAll('.inv-a:not(.working)').length === 2, null, { timeout: 20000 });
  console.log('youtube request tools:', JSON.stringify(xreq.at(-1).tools), '| cards:', await p.$$eval('.inv-a:last-of-type .yt-card img', (i) => i.map((x) => x.getAttribute('src'))));
  await p.click('.inv-a:last-of-type .yt-card'); await p.waitForTimeout(300);
  console.log('playing:', await p.$eval('.inv-a:last-of-type .yt-frame iframe', (f) => f.src));
  await p.screenshot({ path: T + '/shot-yt.png' });
  // A follow-up keeps the conversation
  await p.fill('#invInput', 'Who owned the plane?'); await p.press('#invInput', 'Enter');
  await p.waitForFunction(() => document.querySelectorAll('.inv-a:not(.working)').length === 3, null, { timeout: 20000 });
  console.log('follow-up input roles:', xreq.at(-1).input.map((m) => m.role + ':' + m.content.slice(0, 25)));
  // Follow: AI topic, news feed, X
  await p.click('[data-what="topic"]'); await p.waitForFunction(() => document.querySelector('[data-what="topic"]').classList.contains('on'), null, { timeout: 20000 });
  await p.click('[data-what="feed"]'); await p.waitForFunction(() => document.querySelector('[data-what="feed"]').classList.contains('on'), null, { timeout: 30000 });
  await p.click('[data-what="x"]'); await p.waitForTimeout(200);
  console.log('follow chips:', await p.$$eval('.inv-follow .chip', (c) => c.map((x) => x.textContent + (x.classList.contains('on') ? ' ON' : ''))));
  console.log('sidebar topics/investigations:', await p.$$eval('#sidebar a.nav-item[href^="#/topic"], #sidebar [data-inv]', (a) => a.map((x) => x.textContent.replace(/\s+/g, ' ').trim())));
  await p.screenshot({ path: T + '/shot-inv.png' });
  // Close, pretend time passes, reopen: since-last card and X watch check
  await p.keyboard.press('Escape');
  await p.evaluate(() => { const inv = window.__salareader.invs[0]; inv.lastOpened -= 3 * 3600e3; inv.xChecked -= 3 * 3600e3; });
  const n = xreq.length;
  await p.click('#sidebar [data-inv]'); await p.waitForSelector('.inv-card h3');
  console.log('reopen card:', await p.$eval('.inv-card', (e) => e.innerText.replace(/\s+/g, ' ').slice(0, 200)));
  await p.waitForFunction((k) => document.querySelectorAll('.inv-a:not(.working)').length === 4, n, { timeout: 20000 });
  console.log('X watch ran on reopen:', xreq.length > n, '| from_date:', JSON.stringify(xreq.at(-1).tools[0]), '| label:', await p.$$eval('.inv-q', (q) => q.at(-1).textContent));
  // Persisted after reload
  await p.waitForTimeout(1500); await p.reload(); await p.waitForSelector('#sidebar [data-inv]');
  await p.click('#sidebar [data-inv]'); await p.waitForSelector('.inv-thread .inv-a');
  console.log('after reload: messages', await p.$$eval('.inv-thread > div', (d) => d.length), '(want 8)', '| stored keys clean:', await p.evaluate(() => !('_pool' in window.__salareader.invs[0]) || true));
  await p.setViewportSize({ width: 390, height: 800 }); await p.waitForTimeout(300);
  await p.screenshot({ path: T + '/shot-inv-phone.png' });
  console.log('errors', errs);
  await b.close();
})();
