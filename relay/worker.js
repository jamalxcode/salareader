// Sala Reader relay: a tiny Cloudflare Worker that fetches a feed for YOUR
// Sala Reader, for sites that don't let web pages read their feeds.
//
// - It only answers your Sala Reader (checked by the browser's Origin header),
//   and, if you set a TOKEN secret, only requests that carry that token.
// - It stores nothing and keeps no logs (leave Workers Logs off in the
//   Worker's Settings → Observability).
// - It only fetches http(s) addresses and only returns feed-sized answers.
//
// Setup: see "Your own relay" in the README.

const ALLOWED_ORIGINS = [
  'https://salareader.sala.company',
  'http://localhost:8000',
];
const MAX_BYTES = 5_000_000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin) || (env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN);
    const headers = {
      'Access-Control-Allow-Origin': allowed ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Relay-Token',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Origin',
    };
    const reply = (status, body = null, extra = {}) => new Response(body, { status, headers: { ...headers, ...extra } });

    if (!allowed) return reply(403, 'This relay only answers its own Sala Reader.');
    if (request.method === 'OPTIONS') return reply(204);
    if (request.method !== 'GET') return reply(405);
    if (env.TOKEN && request.headers.get('X-Relay-Token') !== env.TOKEN) return reply(401, 'Wrong token.');

    let target;
    try { target = new URL(new URL(request.url).searchParams.get('url') || ''); } catch { return reply(400, 'Add ?url=<feed address>.'); }
    if (!/^https?:$/.test(target.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(target.hostname)) {
      return reply(400, 'Only public http(s) addresses.');
    }

    let res;
    try {
      res = await fetch(target, {
        redirect: 'follow',
        headers: {
          // Only a generic agent: nothing about the person reading is passed on.
          'User-Agent': 'SalaReader/1.0 (+https://salareader.sala.company)',
          Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.5, */*;q=0.3',
        },
      });
    } catch {
      return reply(502, "Couldn't reach that site.");
    }
    const body = await res.arrayBuffer();
    if (body.byteLength > MAX_BYTES) return reply(413, 'Too big for a feed.');
    return reply(res.status, body, { 'Content-Type': res.headers.get('Content-Type') || 'application/xml' });
  },
};
