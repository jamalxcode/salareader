// 1,700 feeds, ~51,000 articles: how long the work takes, and whether the page stays responsive during a full refresh.
const { chromium } = require('playwright');
const T = process.argv[2];
const N = +(process.argv[3] || 1700);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.includes('dompurify')) return r.fulfill({ path: T + '/pw/node_modules/dompurify/dist/purify.min.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); if (u.includes('transformers')) return r.fulfill({ path: T + '/pw/fake-tf.js', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); return u.startsWith('http://localhost') ? r.continue() : r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8770/icon.svg');
  await p.evaluate(async (N) => {
    const r = indexedDB.open('salareader', 2); await new Promise((res) => { r.onupgradeneeded = () => { for (const n of ['kv', 'bodies']) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); }; r.onsuccess = res; });
    const db = r.result; const tx = db.transaction('kv', 'readwrite'); const st = tx.objectStore('kv');
    const now = Date.now(), subs = [];
    const words = ['market', 'election', 'bitcoin', 'climate', 'football', 'startup', 'rocket', 'vaccine', 'court', 'chip'];
    for (let i = 0; i < N; i++) {
      const id = 'Lp' + i;
      subs.push({ id, url: `http://localhost:8767/eng?n=${i}`, title: `Feed ${i}`, folder: `Folder ${i % 40}`, own: true, site: '', ok: now - 3 * 864e5, every: 3600e3 });
      st.put(Array.from({ length: 30 }, (_, k) => ({ id: `${id}-${k}`, f: id, t: `${words[(i + k) % 10]} story ${i}-${k}`, l: `http://localhost:8767/s/${i}/${k}`, d: now - (i * 30 + k) * 60e3, s: 'Summary of the story.' })), 'own:' + id);
    }
    st.put(subs, 'subs');
    await new Promise((res) => (tx.oncomplete = res));
  }, N);
  await p.addInitScript(() => {
    window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: true });
  });
  const t0 = Date.now();
  await p.goto('http://localhost:8770/?debug#/all'); await p.waitForSelector('article.entry', { timeout: 60000 });
  console.log(`load: ${Date.now() - t0} ms to the first articles | feeds ${await p.evaluate(() => window.__salareader.feeds.length)}, items ${await p.evaluate(() => window.__salareader.items.length)}`);
  await p.waitForTimeout(2000);
  const longs = () => p.evaluate(() => { const l = window.__long.splice(0); return { n: l.length, total: Math.round(l.reduce((a, b) => a + b, 0)), max: Math.round(Math.max(0, ...l)) }; });
  console.log('settling long tasks:', await longs());
  // Let the refresh at start finish, then time a full refresh of every feed.
  await p.waitForFunction(() => !window.__salareader.ownProgress, null, { timeout: 180000 }); await p.waitForTimeout(1000);
  await p.evaluate(() => { for (const s of window.__salareader.subs) delete s.ok; });
  const cdp = await ctx.newCDPSession(p); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start');
  const t1 = Date.now();
  await p.click('#refreshBtn');
  const lags = [];
  while (Date.now() - t1 < 90000) {
    const lag = await p.evaluate(() => new Promise((res) => { const t = performance.now(); setTimeout(() => res(performance.now() - t), 0); }));
    lags.push(lag); await p.waitForTimeout(100);
    if (Date.now() - t1 > 2000 && !(await p.evaluate(() => window.__salareader.ownProgress))) break;
  }
  const prog = await p.evaluate(() => window.__salareader.ownProgress);
  console.log('subs ok now:', await p.evaluate(() => window.__salareader.subs.filter((s) => s.ok).length), 'errors:', await p.evaluate(() => [...new Set(window.__salareader.subs.map((s) => s.error).filter(Boolean))].slice(0, 3)));
  console.log(`refresh: ${prog ? `still running after 90 s: ${prog.done}/${prog.total}` : `done in ${Date.now() - t1} ms`} | event-loop lag max ${Math.round(Math.max(...lags))} ms, p90 ${Math.round(lags.sort((a, b) => a - b)[Math.floor(lags.length * 0.9)])} ms`);
  console.log('refresh long tasks:', await longs());
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = profile.timeDeltas; const counts = new Map();
  profile.samples.forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (dt[i] || 0)));
  // inclusive time per function: walk parents
  const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const incl = new Map();
  for (const [id, t] of counts) { const seen = new Set(); let cur = id; while (cur != null) { const n = byId.get(cur); const k = `${n.callFrame.functionName || '(anon)'}:${n.callFrame.lineNumber + 1}`; if (!seen.has(k)) { incl.set(k, (incl.get(k) || 0) + t); seen.add(k); } cur = parent.get(cur); } const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'}:${n.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + t); }
  const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, t]) => `${k} ${Math.round(t / 1000)}ms`);
  console.log('INCLUSIVE', top(incl)); console.log('SELF', top(self));
  await p.waitForTimeout(3000);
  await cdp.send('Profiler.start');
  const tk = Date.now(); await p.keyboard.press('j'); await p.waitForSelector('#list .entry.current'); console.log('j responded in', Date.now() - tk, 'ms');
  await p.waitForTimeout(800);
  { const { profile } = await cdp.send('Profiler.stop'); const byId = new Map(profile.nodes.map((n) => [n.id, n])); const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id); const incl = new Map(); profile.samples.forEach((id, i) => { const t = profile.timeDeltas[i] || 0; const seen = new Set(); let cur = id; while (cur != null) { const n = byId.get(cur); const k = `${n.callFrame.functionName || '(anon)'}:${n.callFrame.lineNumber + 1}`; if (!seen.has(k)) { incl.set(k, (incl.get(k) || 0) + t); seen.add(k); } cur = parent.get(cur); } }); console.log('J PROFILE', [...incl].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, t]) => `${k} ${Math.round(t / 1000)}ms`)); }
  console.log('errors', errs); await b.close();
})();
