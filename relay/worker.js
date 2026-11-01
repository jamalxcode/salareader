// Sala Reader relay: a small Cloudflare Worker that fetches feeds for
// Sala Reader, for sites that don't let web pages read their feeds.
//
// It's built to be shared safely:
// - Feeds only. It returns a response only if it's RSS or Atom. Given a web
//   page, it returns just the feed links found on it, never the page, so it
//   can't be used as a general proxy.
// - Rate-limited per visitor (60 requests a minute).
// - Each feed is cached for 10 minutes, so many readers of one feed cost one
//   fetch, and feed sites aren't hammered.
// - It only answers Sala Reader pages (the browser's Origin header). Set a
//   TOKEN secret to make it answer only requests carrying that token (for a
//   private relay). Leave TOKEN unset for a shared relay.
// - It stores nothing and passes nothing about the reader on. Keep Workers
//   Logs off (Settings → Observability).
//
// Setup: see "Your own relay" in the README.

const ALLOWED_ORIGINS = [
  'https://salareader.sala.company',
  'http://localhost:8000',
];
const MAX_BYTES = 5_000_000;
const CACHE_SECONDS = 600;
const RATE_LIMIT = 60; // requests per visitor per minute

// Best-effort limit per Worker instance. A Cloudflare rate-limiting binding
// named LIMITER (see wrangler.toml) is used instead when present.
const hits = new Map();
function overLimit(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now > h.reset) { hits.set(ip, { n: 1, reset: now + 60_000 }); if (hits.size > 5000) hits.clear(); return false; }
  return ++h.n > RATE_LIMIT;
}

const FEED_START = /^(?:﻿)?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*|<\?xml-stylesheet[^>]*\?>\s*|<!DOCTYPE[^>]*>\s*)*<(?:rss|feed|rdf:RDF)[\s>]/i;
const isFeed = (text) => FEED_START.test(text.slice(0, 4000));
const isHtml = (text) => /<html[\s>]|<!doctype html/i.test(text.slice(0, 4000));

/** The RSS/Atom links a web page advertises, as absolute URLs. */
function feedLinks(html, base) {
  const out = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/\brel=["']?alternate\b/i.test(tag)) continue;
    if (!/\btype=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = /\bhref=["']([^"']+)["']/i.exec(tag) || /\bhref=([^\s>]+)/i.exec(tag);
    if (!href) continue;
    try { out.push(new URL(href[1].replace(/&amp;/g, '&'), base).href); } catch { /* skip */ }
  }
  return [...new Set(out)].slice(0, 10);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin) || (env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN);
    const headers = {
      'Access-Control-Allow-Origin': allowed ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Relay-Token',
      'Access-Control-Expose-Headers': 'X-Relay-Kind',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Origin',
    };
    const reply = (status, body = null, extra = {}) => new Response(body, { status, headers: { ...headers, ...extra } });

    if (!allowed) return reply(403, 'This relay only answers Sala Reader.');
    if (request.method === 'OPTIONS') return reply(204);
    if (request.method !== 'GET') return reply(405);
    if (env.TOKEN && request.headers.get('X-Relay-Token') !== env.TOKEN) return reply(401, 'Wrong token.');

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const limited = env.LIMITER ? !(await env.LIMITER.limit({ key: ip })).success : overLimit(ip);
    if (limited) return reply(429, 'Too many requests. Try again in a minute.', { 'Retry-After': '60' });

    let target;
    try { target = new URL(new URL(request.url).searchParams.get('url') || ''); } catch { return reply(400, 'Add ?url=<feed address>.'); }
    if (!/^https?:$/.test(target.protocol) || target.port && !['80', '443'].includes(target.port)
      || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)/i.test(target.hostname) || !target.hostname.includes('.')) {
      return reply(400, 'Only public http(s) addresses.');
    }

    let res;
    try {
      res = await fetch(target, {
        redirect: 'follow',
        // Shared 10-minute cache for everyone reading this feed.
        cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
        headers: {
          // Only a generic agent: nothing about the person reading is passed on.
          'User-Agent': 'SalaReader/1.0 (+https://salareader.sala.company)',
          Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.5',
        },
      });
    } catch {
      return reply(502, "Couldn't reach that site.");
    }
    if (!res.ok) return reply(res.status === 404 ? 404 : 502, `The site answered HTTP ${res.status}.`);
    const len = Number(res.headers.get('Content-Length') || 0);
    if (len > MAX_BYTES) return reply(413, 'Too big for a feed.');
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return reply(413, 'Too big for a feed.');
    const text = new TextDecoder().decode(buf);

    if (isFeed(text)) {
      return reply(200, text, { 'Content-Type': 'application/xml; charset=utf-8', 'X-Relay-Kind': 'feed' });
    }
    if (isHtml(text)) {
      // A web page: only say which feeds it links to.
      return reply(200, JSON.stringify({ feeds: feedLinks(text, res.url || target.href) }), { 'Content-Type': 'application/json', 'X-Relay-Kind': 'links' });
    }
    return reply(415, "That address isn't a feed.");
  },
};
