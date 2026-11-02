// Fetches every feed in feeds.json, merges the new items with the previous
// run's data, adds a meaning vector to each new item (for AI search), and
// writes the result to data/:
//   data/index.json          feeds + light item list (what the page loads first)
//   data/content.json        full article HTML for every feed, in one file, so the
//                            server can't tell which feeds a reader opens
//   data/vectors.json        one int8 vector per item, base64 (loaded for AI search)
//
// Env: FEEDS_FILE (default feeds.json), DATA_DIR (default data),
//      SKIP_EMBED=1 to skip the AI vectors, MODEL_CACHE for the model files.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const FEEDS_FILE = process.env.FEEDS_FILE || 'feeds.json';
const DATA_DIR = process.env.DATA_DIR || 'data';
// The page loads the same models, so vectors match. English (default) and multilingual.
const MODELS = [
  { id: 'Xenova/all-MiniLM-L6-v2', file: 'vectors.json' },
  { id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', file: 'vectors-multi.json' },
];
const KEEP_DAYS = 60;          // drop items older than this
const KEEP_PER_FEED = 150;     // and keep at most this many per feed
const MAX_CONTENT = 40000;     // characters of article HTML kept per item
const MAX_CONTENT_TOTAL = 25_000_000; // content.json budget; the oldest articles lose their full text first
const TIMEOUT_MS = 20000;
const CONCURRENCY = 8;

const sha = (s, n = 12) => createHash('sha1').update(s).digest('hex').slice(0, n);
const now = Date.now();

async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

// ---------- parsing ----------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  cdataPropName: false,
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  isArray: (name) => ['item', 'entry', 'link', 'category', 'media:content', 'media:thumbnail', 'enclosure'].includes(name),
});

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
function text(x) {
  if (x == null) return '';
  if (typeof x === 'string' || typeof x === 'number') return String(x);
  if (Array.isArray(x)) return text(x[0]);
  if (typeof x === 'object') return text(x['#text'] ?? '');
  return '';
}
const decode = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const stripTags = (html) => decode(String(html)
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' '))
  .replace(/\s+/g, ' ').trim();

function atomLink(links, rel = 'alternate') {
  for (const l of arr(links)) {
    if (typeof l === 'string') return l;
    const r = l['@rel'] || 'alternate';
    if (r === rel && l['@href']) return l['@href'];
  }
  const first = arr(links).find((l) => l && l['@href']);
  return rel === 'alternate' && first ? first['@href'] : '';
}

function firstImage(it, html) {
  for (const key of ['media:thumbnail', 'media:content']) {
    for (const m of arr(it[key])) {
      const url = m?.['@url'];
      const medium = m?.['@medium'] || m?.['@type'] || 'image';
      if (url && /image/.test(medium)) return url;
    }
    const group = it['media:group'];
    if (group) for (const m of arr(group[key])) if (m?.['@url']) return m['@url'];
  }
  for (const e of arr(it.enclosure)) if (e?.['@url'] && /^image\//.test(e['@type'] || '')) return e['@url'];
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html || '');
  return m ? decode(m[1]) : '';
}

/** Absolute http(s) links only: a feed's javascript: or data: "link" is dropped. */
function absolute(url, base) {
  if (!url) return '';
  try { const u = new URL(url, base); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
}

/**
 * Atom type="xhtml" content holds real markup, which an XML parser would
 * split into nodes (losing the text between tags). Keep it as HTML text.
 */
function xhtmlToHtml(xml) {
  // (?<!\/) skips an empty <content type="xhtml"/>, which would otherwise swallow the next entry.
  return xml.replace(/<(content|summary)\b([^>]*)\btype=["']xhtml["']([^>]*?)(?<!\/)>([\s\S]*?)<\/\1>/g,
    (m, tag, a, b, inner) => `<${tag}${a}type="html"${b}><![CDATA[${inner.replace(/]]>/g, ']]&gt;')}]]></${tag}>`);
}

const contentHtml = (c) => text(c);

/** Same link (without tracking bits, http/https, www) and same title = same article. */
function articleKey(link, title) {
  let l = '';
  try {
    const u = new URL(link);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_|ncid$|guccounter$|ref$|src$|cmpid$)/i.test(k)) u.searchParams.delete(k);
    const q = u.searchParams.toString();
    l = `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${q ? '?' + q : ''}`.toLowerCase();
  } catch { /* no link */ }
  return `${l}|${(title || '').trim().toLowerCase()}`;
}

/** News-search links go through a click-tracking redirect; use the article's own address. */
function unwrapLink(link) {
  try {
    const u = new URL(link);
    if (/(^|\.)bing\.com$/.test(u.hostname) && u.searchParams.get('url')) return absolute(u.searchParams.get('url')) || link;
  } catch { /* not a URL */ }
  return link;
}

export function parseFeed(xml, feedUrl) {
  const doc = parser.parse(xhtmlToHtml(xml));
  let channel, items, kind;
  if (doc.rss) { kind = 'rss'; channel = doc.rss.channel || {}; items = arr(channel.item); }
  else if (doc.feed) { kind = 'atom'; channel = doc.feed; items = arr(channel.entry); }
  else if (doc['rdf:RDF']) { kind = 'rdf'; channel = doc['rdf:RDF'].channel || {}; items = arr(doc['rdf:RDF'].item); }
  else throw new Error('Not an RSS or Atom feed');

  const site = kind === 'atom' ? atomLink(channel.link) : text(arr(channel.link).find((l) => typeof l === 'string') ?? channel.link);
  const out = {
    title: stripTags(text(channel.title)),
    site: absolute(site, feedUrl),
    lang: String(text(channel.language) || text(channel['dc:language']) || channel['@xml:lang'] || '').toLowerCase().slice(0, 5),
    items: [],
  };
  // Atom's xml:base sets the address relative links are resolved against.
  const feedBase = absolute(channel['@xml:base'] || '', feedUrl) || feedUrl;
  const guidCount = new Map();
  for (const it of items) { const g = text(it.guid) || text(it.id); if (g) guidCount.set(g, (guidCount.get(g) || 0) + 1); }
  for (const it of items) {
    const title = stripTags(text(it.title)) || '(untitled)';
    const base = absolute(it['@xml:base'] || '', feedBase) || (kind === 'atom' ? feedBase : out.site || feedUrl);
    // An RSS guid is a link only if it isn't marked isPermaLink="false" and is a web address.
    const guidObj = arr(it.guid)[0];
    const guidIsLink = !(typeof guidObj === 'object' && guidObj?.['@isPermaLink'] === 'false') && /^https?:\/\//i.test(text(it.guid));
    const link = unwrapLink(absolute(kind === 'atom' ? atomLink(it.link) : text(arr(it.link)[0]) || (guidIsLink ? text(it.guid) : ''), base));
    let guid = text(it.guid) || text(it.id) || link || title;
    // Items sharing an id would collapse into one: tell every copy apart by its link.
    if (guidCount.get(guid) > 1) guid = `${guid}|${link || title}`;
    const html = text(it['content:encoded']) || contentHtml(it.content) || text(it.description) || contentHtml(it.summary) || '';
    const dateStr = text(it.pubDate) || text(it.published) || text(it.updated) || text(it['dc:date']);
    let d = Date.parse(dateStr);
    if (!Number.isFinite(d) || d > now + 864e5) d = NaN;
    const author = stripTags(text(it.author?.name ?? it.author) || text(it['dc:creator']));
    // Categories and attached audio/video, for smart folders.
    const cats = arr(it.category).map((c) => stripTags(typeof c === 'object' ? c['@term'] || text(c) : text(c))).filter((c) => c && c.length < 50).slice(0, 8);
    const types = [...arr(it.enclosure), ...arr(it['media:content']), ...arr(it['media:group']?.['media:content'])].map((e) => e?.['@type'] || (e?.['@medium'] ? e['@medium'] + '/' : ''));
    if (it['yt:videoId']) types.push('video/youtube');
    const media = types.some((t) => /^audio\//i.test(t)) ? 'audio' : types.some((t) => /^video\//i.test(t)) || /youtube\.com\/watch|youtu\.be\//i.test(link) ? 'video' : '';
    const words = (stripTags(String(html)).match(/[\p{L}\p{N}]+/gu) || []).length;
    out.items.push({ cats, media, words, guid, title, link, html: String(html), date: d, author, image: (() => { const im = firstImage(it, html); return im ? absolute(im, link) : ''; })() });
  }
  return out;
}

// ---------- fetching ----------

// Like the relay: a plain agent first, then (for sites that turn those away) a browser-style one.
const AGENTS = ['SalaReader/1.0 (+https://reader.sala.company)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 SalaReader/1.0'];

async function fetchText(url) {
  for (const agent of AGENTS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'user-agent': agent, accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' },
      });
      if ([401, 403, 406, 429, 503].includes(res.status) && agent === AGENTS[0]) continue;
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      return decodeFeed(await res.arrayBuffer(), res.headers.get('content-type') || '');
    } catch (e) {
      if (e.status) throw e;
      throw Object.assign(new Error(e.name === 'AbortError' ? 'Timed out' : `Couldn't reach the site (${e.cause?.code || e.message})`), { network: true });
    } finally { clearTimeout(t); }
  }
}

// ---------- dead or alive (the same rules as the reader uses for your own feeds) ----------
//  gone:    404/410 and no new address found: dead after a day (and at least two tries)
//  notfeed: the address shows a web page or something that isn't a feed: dead after 3 days
//  down:    5xx, timeouts, unreachable: left alone; dead after 30 days
//  blocked: 401/403/429: left alone; dead after 30 days
// Retired catalog feeds are checked again once a week, and come back if they work.
export const DEAD_AFTER = { gone: 864e5, notfeed: 3 * 864e5, down: 30 * 864e5, blocked: 30 * 864e5 };
const RECHECK_RETIRED_MS = 7 * 864e5;

export function failKind(e) {
  if (e.status === 404 || e.status === 410) return 'gone';
  if ([401, 403, 429].includes(e.status)) return 'blocked';
  if (e.status) return 'down';
  if (e.network) return 'down';
  return 'notfeed';
}

export function judge(feed, kind, t = now) {
  if (feed.failKind !== kind) { feed.failKind = kind; feed.kindSince = t; feed.kindTries = 0; }
  feed.kindTries = (feed.kindTries || 0) + 1;
  feed.failSince ??= t;
  let why = '';
  if (kind === 'gone' || kind === 'notfeed') {
    if (t - feed.kindSince >= DEAD_AFTER[kind] && feed.kindTries >= 2) why = kind === 'gone' ? 'gone' : 'no longer a feed';
  } else if (t - feed.failSince >= DEAD_AFTER.down) why = kind === 'blocked' ? 'unreadable for a month' : 'down for a month';
  if (why) { feed.retired ??= t; feed.retiredWhy = why; }
  return why;
}

/** A gone or changed feed's new address: the same address over https or with/without www, the site's feed links, the usual paths. */
async function findMoved(url, site) {
  const tries = [];
  try {
    const u = new URL(url);
    if (u.protocol === 'http:') tries.push('https://' + u.host + u.pathname + u.search);
    const flip = u.hostname.startsWith('www.') ? u.hostname.slice(4) : 'www.' + u.hostname;
    tries.push('https://' + flip + u.pathname + u.search);
    const pages = [site, u.origin + '/'].filter(Boolean);
    for (const page of pages) {
      try {
        const html = await fetchText(page);
        for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
          const tag = m[0];
          if (/rel=["']?alternate/i.test(tag) && /type=["']?application\/(rss|atom)\+xml/i.test(tag)) {
            const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
            if (href) tries.push(absolute(decode(href), page));
          }
        }
      } catch { /* no page */ }
    }
    for (const p of ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml']) tries.push(u.origin + p);
  } catch { return ''; }
  for (const t of [...new Set(tries.filter(Boolean))]) {
    if (t === url) continue;
    try { const xml = await fetchText(t); parseFeed(xml, t); return t; } catch { /* not there */ }
  }
  return '';
}

/** Decodes feed bytes using the charset in Content-Type or the XML declaration (UTF-8 if neither). */
function decodeFeed(buf, contentType = '') {
  const bytes = new Uint8Array(buf);
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 300));
    charset = /^\s*(?:﻿|ï»¿)?<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1];
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = 'utf-8';
  try { return new TextDecoder(charset || 'utf-8').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

async function pool(list, n, fn) {
  const results = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i++; results[k] = await fn(list[k], k); }
  }));
  return results;
}

// ---------- vectors ----------

const embedders = new Map();
async function embed(texts, model) {
  if (!embedders.has(model)) {
    const { pipeline, env } = await import('@huggingface/transformers');
    if (process.env.MODEL_CACHE) env.cacheDir = process.env.MODEL_CACHE;
    embedders.set(model, await pipeline('feature-extraction', model, { dtype: 'q8' }));
  }
  const embedder = embedders.get(model);
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const t = await embedder(batch, { pooling: 'mean', normalize: true });
    const dim = t.dims[t.dims.length - 1];
    for (let b = 0; b < batch.length; b++) out.push(t.data.slice(b * dim, (b + 1) * dim));
  }
  return out;
}
export const embedText = (it) => `${it.t}. ${it.s}`.slice(0, 1000);
function toB64(vec) {
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(vec[i] * 127)));
  return Buffer.from(q.buffer).toString('base64');
}

// ---------- main ----------

async function main() {
  const config = await readJSON(FEEDS_FILE, null);
  if (!config) throw new Error(`Can't read ${FEEDS_FILE}`);
  const prev = await readJSON(path.join(DATA_DIR, 'index.json'), { feeds: [], items: [] });

  const prevFeeds = new Map(prev.feeds.map((f) => [f.id, f]));

  const wanted = [];
  for (const folder of config.folders || []) {
    for (const f of folder.feeds || []) wanted.push({ ...f, folder: folder.name || '' });
  }
  for (const f of config.feeds || []) wanted.push({ ...f, folder: f.folder || '' });

  // When each undated item was first seen, kept longer than the items themselves,
  // so an old undated item doesn't come back as "new" after it ages out.
  const seen = await readJSON(path.join(DATA_DIR, 'seen.json'), {});
  const content = {}; // feedId -> {itemId: html}
  const prevContent = await readJSON(path.join(DATA_DIR, 'content.json'), {});
  for (const f of wanted) {
    const id = sha(f.url, 8);
    // Older runs kept one file per feed.
    content[id] = await readJSON(path.join(DATA_DIR, 'content', `${id}.json`), {});
  }

  const itemsByFeed = new Map();
  for (const it of prev.items) {
    if (!itemsByFeed.has(it.f)) itemsByFeed.set(it.f, new Map());
    itemsByFeed.get(it.f).set(it.id, it);
  }

  const feeds = await pool(wanted, CONCURRENCY, async (f) => {
    const id = sha(f.url, 8);
    const old = prevFeeds.get(id) || {};
    const feed = { id, url: f.url, folder: f.folder, title: f.title || old.title || f.url, site: old.site || '', ...(old.lang ? { lang: old.lang } : {}), ok: old.ok || 0, error: '' };
    for (const k of ['failKind', 'kindSince', 'kindTries', 'failSince', 'retired', 'retiredWhy', 'lastTry', 'fetchUrl']) if (old[k] != null) feed[k] = old[k];
    const map = itemsByFeed.get(id) || new Map();
    // A retired feed is only checked again once a week.
    if (feed.retired && now - (feed.lastTry || 0) < RECHECK_RETIRED_MS) {
      feed.error = old.error || '';
      console.log(`RETIRED ${feed.title} (${feed.retiredWhy}), next check in ${Math.ceil((feed.lastTry + RECHECK_RETIRED_MS - now) / 864e5)} days`);
      const kept = [...map.values()].filter((it) => it.d > now - KEEP_DAYS * 864e5).sort((a, b) => b.d - a.d).slice(0, KEEP_PER_FEED);
      feed.count = kept.length;
      return { feed, items: kept };
    }
    feed.lastTry = now;
    try {
      let xml, parsed, addr = feed.fetchUrl || f.url;
      try {
        xml = await fetchText(addr);
        parsed = parseFeed(xml, addr);
      } catch (e) {
        // Gone, or no longer a feed: look for where it went before judging it.
        const kind = failKind(e);
        if (kind !== 'gone' && kind !== 'notfeed') throw e;
        const moved = await findMoved(f.url, feed.site);
        if (!moved) throw e;
        addr = moved;
        parsed = parseFeed(await fetchText(moved), moved);
        feed.fetchUrl = moved;
        console.log(`MOVED ${feed.title}: now ${moved} (update feeds.json)`);
      }
      for (const k of ['failKind', 'kindSince', 'kindTries', 'failSince', 'retired', 'retiredWhy']) delete feed[k];
      if (!f.title && parsed.title) feed.title = parsed.title;
      if (parsed.site) feed.site = parsed.site;
      if (parsed.lang) feed.lang = parsed.lang;
      feed.ok = now;
      // The same article under a new guid keeps its old id (so read marks stay).
      const idByKey = new Map([...map.values()].map((it) => [articleKey(it.l, it.t), it.id]));
      parsed.items.forEach((p, idx) => {
        let itemId = sha(`${f.url}|${p.guid}`);
        if (!map.has(itemId) && idByKey.has(articleKey(p.link, p.title))) itemId = idByKey.get(articleKey(p.link, p.title));
        const existing = map.get(itemId);
        // Undated items keep their first-seen time; idx keeps feed order stable.
        // Future dates (wrong time zones) are capped at the time we first saw the item.
        const firstSeen = existing?.d ?? seen[itemId];
        const date = Number.isFinite(p.date) && p.date <= now ? p.date : firstSeen ?? (Number.isFinite(p.date) ? now : now - idx * 1000);
        if (!(itemId in seen)) seen[itemId] = date;
        map.set(itemId, {
          id: itemId, f: id, t: p.title, l: p.link,
          d: date, s: stripTags(p.html).slice(0, 280),
          ...(p.image ? { i: p.image } : {}),
          ...(p.author ? { a: p.author } : {}),
          ...(p.cats.length ? { g: p.cats } : {}),
          ...(p.media ? { m: p.media } : {}),
          ...(p.words > 150 ? { w: p.words } : {}),
        });
        if (p.html) content[id][itemId] = p.html.length > MAX_CONTENT ? p.html.slice(0, MAX_CONTENT) + '…' : p.html;
      });
      console.log(`ok   ${feed.title} (${parsed.items.length})`);
    } catch (e) {
      const kind = failKind(e);
      feed.error = kind === 'notfeed' ? `Not a feed any more (${String(e.message || e).slice(0, 120)})` : String(e.message || e).slice(0, 200);
      const why = judge(feed, kind);
      console.log(`${why ? 'DEAD' : 'FAIL'} ${feed.title}: ${kind}, ${feed.error}${why ? ` -> retired (${why})` : ''}`);
    }
    // One copy per article (earlier runs may have stored one twice).
    const keyed = new Set();
    const keep = [...map.values()]
      .filter((it) => it.d > now - KEEP_DAYS * 864e5)
      .sort((a, b) => b.d - a.d)
      .filter((it) => { const k = articleKey(it.l, it.t); if (keyed.has(k)) return false; keyed.add(k); return true; })
      .slice(0, KEEP_PER_FEED);
    feed.count = keep.length;
    return { feed, items: keep };
  });

  const items = feeds.flatMap((x) => x.items).sort((a, b) => b.d - a.d);
  const keepIds = new Set(items.map((i) => i.id));

  // Vectors for each model: reuse old ones, embed only new items.
  const vectorFiles = {};
  for (const m of MODELS) {
    const prev = await readJSON(path.join(DATA_DIR, m.file), { v: {} });
    const vectors = {};
    const todo = [];
    for (const it of items) {
      if (prev.v?.[it.id] && prev.model === m.id) vectors[it.id] = prev.v[it.id];
      else todo.push(it);
    }
    if (todo.length && process.env.SKIP_EMBED !== '1') {
      try {
        const vecs = await embed(todo.map(embedText), m.id);
        todo.forEach((it, k) => { vectors[it.id] = toB64(vecs[k]); });
        console.log(`embedded ${todo.length} new items (${m.id})`);
      } catch (e) {
        console.log(`embedding skipped for ${m.id}: ${e.message}`);
      }
    }
    vectorFiles[m.file] = { model: m.id, dim: 384, v: vectors };
  }

  await mkdir(DATA_DIR, { recursive: true });
  // Newest first, until the budget is used up; older articles show their summary instead.
  const allContent = {};
  let budget = MAX_CONTENT_TOTAL;
  for (const it of items) {
    const html = content[it.f]?.[it.id] ?? prevContent[it.id];
    if (!html || html.length > budget) continue;
    allContent[it.id] = html;
    budget -= html.length;
  }
  await writeFile(path.join(DATA_DIR, 'content.json'), JSON.stringify(allContent));
  await rm(path.join(DATA_DIR, 'content'), { recursive: true, force: true });
  for (const [file, data] of Object.entries(vectorFiles)) await writeFile(path.join(DATA_DIR, file), JSON.stringify(data));
  for (const [k, t] of Object.entries(seen)) if (t < now - 400 * 864e5) delete seen[k];
  await writeFile(path.join(DATA_DIR, 'seen.json'), JSON.stringify(seen));
  await writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify({
    updated: now,
    feeds: feeds.map((x) => x.feed),
    items,
  }));
  const failed = feeds.filter((x) => x.feed.error).length;
  console.log(`\n${items.length} items from ${feeds.length - failed}/${feeds.length} feeds`);
  // A report for the catalog's keeper: what's dead (to remove from feeds.json), moved, or having trouble.
  const fs = feeds.map((x) => x.feed);
  const rows = (list, fmt) => list.map((f) => `| ${f.title.replace(/\|/g, '/')} | ${f.url} | ${fmt(f)} |`).join('\n');
  const dead = fs.filter((f) => f.retired), moved = fs.filter((f) => f.fetchUrl && !f.retired), trouble = fs.filter((f) => f.error && !f.retired);
  const report = `## Catalog feed health\n\n${fs.length} feeds: ${fs.length - failed} working, ${trouble.length} having trouble (left alone), ${dead.length} retired as dead, ${moved.length} moved.\n`
    + (dead.length ? `\n### Retired as dead: remove from feeds.json\n\n| Feed | Address | Why |\n|---|---|---|\n${rows(dead, (f) => `${f.retiredWhy}: ${f.error}`)}\n` : '')
    + (moved.length ? `\n### Moved: update the address in feeds.json\n\n| Feed | Old address | Now |\n|---|---|---|\n${rows(moved, (f) => f.fetchUrl)}\n` : '')
    + (trouble.length ? `\n### Having trouble (left alone)\n\n| Feed | Address | Problem |\n|---|---|---|\n${rows(trouble, (f) => `${f.failKind} since ${new Date(f.failSince).toISOString().slice(0, 10)}: ${f.error}`)}\n` : '');
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, report, { flag: 'a' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
