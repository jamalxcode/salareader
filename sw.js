// Sala Reader's service worker: lets the app install and open offline.
// Only this site's own files are handled, always from the network first (so
// updates arrive straight away), with the last copy as the offline fallback.
// Feeds, the relay, AI companies and every other site are never touched.
const CACHE = 'salareader-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'ai.js', 'smart.js', 'embed-worker.js', 'icon.svg', 'manifest.webmanifest', 'feeds.json', 'directory.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('salareader-v') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // One cached copy per file, whatever cache-busting query it was asked with.
  const key = req.mode === 'navigate' ? new URL('index.html', self.registration.scope).href : url.origin + url.pathname;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(key);
      if (hit) return hit;
      throw err;
    }
  })());
});

// ---------- background refresh (installed app in Chrome or Edge) ----------
// Now and then the browser wakes this worker; it fetches your most-read feeds
// (the list the page saved, kept only in this browser) the same way the page does:
// directly, or through your chosen relay, paced to the relay's limit. The copies
// wait in this browser's cache until the page next opens and reads them in.
const PREFETCH = 'salareader-prefetch';
const RELAY_GAP_MS = 1100;
const BUDGET_MS = 4 * 60e3; // the browser gives a background task a few minutes at most

async function prefetchFeeds() {
  const cache = await caches.open(PREFETCH);
  const planRes = await cache.match('/__prefetch-plan');
  if (!planRes) return 0;
  const plan = await planRes.json();
  const started = Date.now();
  let n = 0;
  let nextRelay = 0;
  for (const f of plan.feeds || []) {
    if (Date.now() - started > BUDGET_MS) break;
    let text = '';
    try {
      if (f.direct) {
        const r = await fetch(f.url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (r.ok) text = await r.text();
      } else if (plan.relay) {
        const wait = nextRelay - Date.now();
        if (wait > 0) await new Promise((res) => setTimeout(res, wait));
        nextRelay = Date.now() + RELAY_GAP_MS;
        const r = await fetch(`${plan.relay}/?url=${encodeURIComponent(f.url)}`, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000), headers: plan.token ? { 'X-Relay-Token': plan.token } : {} });
        if (r.status === 429) break; // over the relay's limit: stop, the page carries on later
        if (r.ok && r.headers.get('X-Relay-Kind') === 'feed') text = await r.text();
      }
    } catch { /* skip this one */ }
    if (text && /<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 2000))) {
      await cache.put('/__prefetch/' + encodeURIComponent(f.url), new Response(text, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'X-Fetched-At': String(Date.now()) } }));
      n++;
    }
  }
  return n;
}

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'feeds') e.waitUntil(prefetchFeeds());
});

// For testing and for the page: "prefetch now", answered with how many feeds were fetched.
self.addEventListener('message', (e) => {
  if (e.data === 'prefetch-now') e.waitUntil(prefetchFeeds().then((n) => e.source?.postMessage({ prefetched: n })));
});
