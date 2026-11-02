// Sala Reader's service worker: lets the app install and open offline.
// Only this site's own files are handled, always from the network first (so
// updates arrive straight away), with the last copy as the offline fallback.
// Feeds, the relay, AI companies and every other site are never touched.
const CACHE = 'salareader-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'ai.js', 'smart.js', 'embed-worker.js', 'icon.svg', 'manifest.webmanifest', 'feeds.json', 'directory.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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
