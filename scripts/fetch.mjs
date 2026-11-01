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
const MODEL = 'Xenova/all-MiniLM-L6-v2'; // the page loads the same model, so vectors match
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
  try { const u = new URL(url, base); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
}

export function parseFeed(xml, feedUrl) {
  const doc = parser.parse(xml);
  let channel, items, kind;
  if (doc.rss) { kind = 'rss'; channel = doc.rss.channel || {}; items = arr(channel.item); }
  else if (doc.feed) { kind = 'atom'; channel = doc.feed; items = arr(channel.entry); }
  else if (doc['rdf:RDF']) { kind = 'rdf'; channel = doc['rdf:RDF'].channel || {}; items = arr(doc['rdf:RDF'].item); }
  else throw new Error('Not an RSS or Atom feed');

  const site = kind === 'atom' ? atomLink(channel.link) : text(arr(channel.link).find((l) => typeof l === 'string') ?? channel.link);
  const out = {
    title: stripTags(text(channel.title)),
    site: absolute(site, feedUrl),
    items: [],
  };
  for (const it of items) {
    const title = stripTags(text(it.title)) || '(untitled)';
    const link = absolute(kind === 'atom' ? atomLink(it.link) : text(arr(it.link)[0]) || text(it.guid), out.site || feedUrl);
    const guid = text(it.guid) || text(it.id) || link || title;
    const html = text(it['content:encoded']) || text(it.content) || text(it.description) || text(it.summary) || '';
    const dateStr = text(it.pubDate) || text(it.published) || text(it.updated) || text(it['dc:date']);
    let d = Date.parse(dateStr);
    if (!Number.isFinite(d) || d > now + 864e5) d = NaN;
    const author = stripTags(text(it.author?.name ?? it.author) || text(it['dc:creator']));
    out.items.push({ guid, title, link, html: String(html), date: d, author, image: (() => { const im = firstImage(it, html); return im ? absolute(im, link) : ''; })() });
  }
  return out;
}

// ---------- fetching ----------

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'SalaReader/1.0 (+https://reader.sala.company)',
        accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return decodeFeed(await res.arrayBuffer(), res.headers.get('content-type') || '');
  } finally { clearTimeout(t); }
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

let embedder;
async function embed(texts) {
  if (!embedder) {
    const { pipeline, env } = await import('@huggingface/transformers');
    if (process.env.MODEL_CACHE) env.cacheDir = process.env.MODEL_CACHE;
    embedder = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  }
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
  const prevVectors = await readJSON(path.join(DATA_DIR, 'vectors.json'), { v: {} });
  const prevFeeds = new Map(prev.feeds.map((f) => [f.id, f]));

  const wanted = [];
  for (const folder of config.folders || []) {
    for (const f of folder.feeds || []) wanted.push({ ...f, folder: folder.name || '' });
  }
  for (const f of config.feeds || []) wanted.push({ ...f, folder: f.folder || '' });

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
    const feed = { id, url: f.url, folder: f.folder, title: f.title || old.title || f.url, site: old.site || '', ok: old.ok || 0, error: '' };
    const map = itemsByFeed.get(id) || new Map();
    try {
      const parsed = parseFeed(await fetchText(f.url), f.url);
      if (!f.title && parsed.title) feed.title = parsed.title;
      if (parsed.site) feed.site = parsed.site;
      feed.ok = now;
      parsed.items.forEach((p, idx) => {
        const itemId = sha(`${f.url}|${p.guid}`);
        const existing = map.get(itemId);
        // Undated items keep their first-seen time; idx keeps feed order stable.
        // Future dates (wrong time zones) are capped at the time we first saw the item.
        const date = Number.isFinite(p.date) && p.date <= now ? p.date : existing?.d ?? (Number.isFinite(p.date) ? now : now - idx * 1000);
        map.set(itemId, {
          id: itemId, f: id, t: p.title, l: p.link,
          d: date, s: stripTags(p.html).slice(0, 280),
          ...(p.image ? { i: p.image } : {}),
          ...(p.author ? { a: p.author } : {}),
        });
        if (p.html) content[id][itemId] = p.html.length > MAX_CONTENT ? p.html.slice(0, MAX_CONTENT) + '…' : p.html;
      });
      console.log(`ok   ${feed.title} (${parsed.items.length})`);
    } catch (e) {
      feed.error = String(e.message || e).slice(0, 200);
      console.log(`FAIL ${feed.title}: ${feed.error}`);
    }
    const keep = [...map.values()]
      .filter((it) => it.d > now - KEEP_DAYS * 864e5)
      .sort((a, b) => b.d - a.d)
      .slice(0, KEEP_PER_FEED);
    feed.count = keep.length;
    return { feed, items: keep };
  });

  const items = feeds.flatMap((x) => x.items).sort((a, b) => b.d - a.d);
  const keepIds = new Set(items.map((i) => i.id));

  // Vectors: reuse old ones, embed only new items.
  const vectors = {};
  const todo = [];
  for (const it of items) {
    if (prevVectors.v?.[it.id] && prevVectors.model === MODEL) vectors[it.id] = prevVectors.v[it.id];
    else todo.push(it);
  }
  if (todo.length && process.env.SKIP_EMBED !== '1') {
    try {
      const vecs = await embed(todo.map(embedText));
      todo.forEach((it, k) => { vectors[it.id] = toB64(vecs[k]); });
      console.log(`embedded ${todo.length} new items`);
    } catch (e) {
      console.log(`embedding skipped: ${e.message}`);
    }
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
  await writeFile(path.join(DATA_DIR, 'vectors.json'), JSON.stringify({ model: MODEL, dim: 384, v: vectors }));
  await writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify({
    updated: now,
    feeds: feeds.map((x) => x.feed),
    items,
  }));
  const failed = feeds.filter((x) => x.feed.error).length;
  console.log(`\n${items.length} items from ${feeds.length - failed}/${feeds.length} feeds`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
