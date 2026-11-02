// Local stand-in for the Cloudflare relay: runs relay/worker.js, with feeds.test served from fx/srv.
import http from 'node:http';
const worker = (await import(new URL('../../../relay/worker.js', import.meta.url).href)).default;
const realFetch = globalThis.fetch;
globalThis.fetch = (target, init) => {
  const u = new URL(String(target));
  const ua = new Headers(init?.headers || {}).get('user-agent') || '';
  const rss = (t) => new Response(`<?xml version="1.0"?><rss version="2.0"><channel><title>${t}</title><link>http://${u.hostname}/</link><item><title>${t} story</title><link>http://${u.hostname}/1</link><guid>${u.hostname}-1</guid><pubDate>Sun, 01 Nov 2026 08:00:00 GMT</pubDate></item></channel></rss>`, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  if (u.hostname === 'gone.test') return Promise.resolve(new Response('nope', { status: 404 }));
  if (u.hostname === 'down.test') return Promise.resolve(new Response('oops', { status: 500 }));
  if (u.hostname === 'block.test') return Promise.resolve(new Response('no bots', { status: 403 }));
  if (u.hostname === 'uablock.test') return Promise.resolve(/Mozilla/.test(ua) ? rss('UA picky') : new Response('no bots', { status: 403 }));
  if (u.hostname === 'page.test') return Promise.resolve(new Response('<html><head><title>Hi</title></head><body>No feed here</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  if (u.hostname === 'quiet.test') return Promise.resolve(new Response(`<?xml version="1.0"?><rss version="2.0"><channel><title>Quiet blog</title><item><title>Old post</title><link>http://quiet.test/1</link><guid>q1</guid><pubDate>Mon, 01 Jan 2024 08:00:00 GMT</pubDate></item></channel></rss>`, { status: 200, headers: { 'content-type': 'application/rss+xml' } }));
  if (u.hostname === 'feeds.test') return realFetch('http://localhost:8765/' + u.pathname.split('/').pop(), { redirect: 'manual' });
  return realFetch(target, init);
};
http.createServer(async (req, res) => {
  const r = await worker.fetch(new Request('http://localhost:8902' + req.url, { method: req.method, headers: { Origin: req.headers.origin || '' } }), { ALLOWED_ORIGIN: req.headers.origin });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8902);
