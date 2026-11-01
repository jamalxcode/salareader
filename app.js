// Sala Reader: a Google Reader-style RSS reader with AI search.
//
// Privacy: everything about the reader (subscriptions, folders, read and
// starred articles, topics, settings, keys) is stored only on this device,
// in IndexedDB. The site serves one shared catalog of feeds (data/), the
// same files for everyone, so it can't tell what anyone follows or reads.
// Feeds you add yourself are fetched by this page, straight from the feed's
// site or through your own relay (relay/worker.js). Backup → export/import
// moves everything to another device.

import { decodeVector, dot, embed, embedText, askAI, PROVIDERS, provider, listModels, startOpenRouterSignIn, finishOpenRouterSignIn } from './ai.js';

const PAGE = 60;
const OWN_ITEMS_PER_FEED = 80;

// ---------- storage: IndexedDB on this device ----------
// A synchronous in-memory copy for the app, written back to IndexedDB
// shortly after each change (localStorage if IndexedDB isn't available).

const DB_NAME = 'salareader';
const KV = 'kv';
const cache = new Map();
const dirty = new Set();
let dbPromise = null;
let useLocalStorage = false;
let flushTimer;

function openDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(KV);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
  return dbPromise;
}

async function loadStore() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(KV, 'readonly');
      const req = tx.objectStore(KV).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) { cache.set(c.key, c.value); c.continue(); } else resolve();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    useLocalStorage = true;
  }
  // Move data from older versions (and the localStorage fallback) into the cache.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith('sr.') || k === 'sr.theme') continue;
      const key = k.slice(3);
      if (!cache.has(key)) { cache.set(key, JSON.parse(localStorage.getItem(k))); dirty.add(key); }
      if (!useLocalStorage) localStorage.removeItem(k);
    }
  } catch { /* storage blocked */ }
  if (dirty.size) scheduleFlush();
  // Ask the browser not to clear this data when space runs low.
  navigator.storage?.persist?.().catch(() => {});
}

async function flush() {
  clearTimeout(flushTimer);
  if (!dirty.size) return;
  const keys = [...dirty];
  dirty.clear();
  if (useLocalStorage) {
    for (const k of keys) {
      try { if (cache.has(k)) localStorage.setItem('sr.' + k, JSON.stringify(cache.get(k))); else localStorage.removeItem('sr.' + k); } catch { /* full */ }
    }
    return;
  }
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(KV, 'readwrite');
      const os = tx.objectStore(KV);
      for (const k of keys) { if (cache.has(k)) os.put(cache.get(k), k); else os.delete(k); }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('Saving failed', e);
    keys.forEach((k) => dirty.add(k));
  }
}
function scheduleFlush() { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 300); }
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

const store = {
  // structuredClone keeps the stored copy separate from objects the app keeps changing.
  get(key, fallback) { return cache.has(key) ? structuredClone(cache.get(key)) : fallback; },
  set(key, value) { cache.set(key, structuredClone(value)); dirty.add(key); scheduleFlush(); },
  del(key) { cache.delete(key); dirty.add(key); scheduleFlush(); },
  keys() { return [...cache.keys()]; },
};

// The shared relay everyone uses unless they pick their own (relay/worker.js).
const SHARED_RELAY = 'https://salareader-relay.jamal-akuna-matata.workers.dev';
const DEFAULT_SETTINGS = { theme: 'auto', unreadOnly: true, mode: 'list', threshold: 0.4, aiProvider: 'anthropic', keys: {}, models: {}, relayMode: 'shared', relay: '', relayToken: '' };

const S = {
  index: { feeds: [], items: [], updated: 0 },
  feeds: [],            // your subscriptions (catalog + your own)
  feedById: new Map(),
  items: [],            // their items, newest first
  byId: new Map(),
  content: null,        // Promise<{itemId: html}> for the catalog
  vectors: new Map(),   // itemId -> Float32Array
  vectorsState: 'none', // none | loading | ready | missing
  subs: null,           // [{id, url, title, folder, own?, site?, error?, ok?}] (null until first run)
  ownItems: {},         // feedId -> items[] for feeds this page fetches itself
  read: {},             // id -> time read
  starred: {},          // id -> item copy (survives feed cleanup)
  topics: [],           // {id, name, query, qv: number[]}
  collapsed: {},
  days: [],             // days you read something (YYYY-MM-DD)
  settings: { ...DEFAULT_SETTINGS },
  view: { type: 'home' },
  list: [],
  shown: 0,
  cur: -1,
  scores: null,         // id -> score (search / topic views)
};

function loadState() {
  S.subs = store.get('subs', null);
  S.ownItems = store.get('ownItems', {});
  S.read = store.get('read', {});
  S.starred = store.get('starred', {});
  S.topics = store.get('topics', []);
  S.collapsed = store.get('collapsed', {});
  S.days = store.get('days', []);
  S.settings = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };
  // Earlier versions had only Claude.
  if (S.settings.claudeKey) S.settings.keys = { ...S.settings.keys, anthropic: S.settings.keys?.anthropic || S.settings.claudeKey };
  if (S.settings.claudeModel) S.settings.models = { ...S.settings.models, anthropic: S.settings.models?.anthropic || S.settings.claudeModel };
  if ('claudeKey' in S.settings || 'claudeModel' in S.settings) {
    delete S.settings.claudeKey; delete S.settings.claudeModel;
    saveSettings();
  }
  // Before the shared relay, a relay address meant your own relay.
  if (!store.get('settings', {}).relayMode) {
    const own = S.settings.relay.trim().replace(/\/+$/, '');
    if (own && own !== SHARED_RELAY) S.settings.relayMode = 'own';
    else { S.settings.relayMode = 'shared'; S.settings.relay = ''; S.settings.relayToken = ''; }
    saveSettings();
  }
  // Earlier versions kept browser-added feeds separately.
  const oldFeeds = store.get('localFeeds', null);
  if (oldFeeds) {
    S.subs = S.subs || null;
    S.pendingOwn = oldFeeds.map((f) => ({ id: f.id, url: f.url, title: f.title, folder: f.folder || '', own: true, site: f.site || '' }));
    S.ownItems = { ...store.get('localItems', {}), ...S.ownItems };
    store.del('localFeeds'); store.del('localItems');
  }
}
const saveSettings = () => store.set('settings', S.settings);
const saveSubs = () => store.set('subs', S.subs);
const saveOwnItems = () => store.set('ownItems', S.ownItems);
const ai = () => {
  const p = provider(S.settings.aiProvider);
  return { p, key: S.settings.keys[p.id] || '', model: S.settings.models[p.id] || 'auto' };
};

// ---------- small helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, '0'); };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
/** A letter icon drawn on the device (no favicon service learns what you follow). */
function avatar(f, big = false) {
  const name = (f?.title || host(f?.url) || '?').replace(/^the\s+/i, '');
  const letter = (name.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
  const hue = parseInt(hash(f?.url || name).slice(0, 4), 16) % 360;
  return `<span class="fav av${big ? ' big' : ''}" style="--h:${hue}" aria-hidden="true">${esc(letter)}</span>`;
}
const isRead = (id) => id in S.read;
const strip = (html) => { const d = document.createElement('div'); d.innerHTML = DOMPurifySafe(html); return (d.textContent || '').replace(/\s+/g, ' ').trim(); };
function DOMPurifySafe(html) { return window.DOMPurify ? window.DOMPurify.sanitize(html) : String(html).replace(/<[^>]+>/g, ' '); }

const agoText = (t) => (ago(t) === 'just now' ? 'just now' : `${ago(t)} ago`);

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------- the shared catalog ----------

async function loadIndex(bust) {
  try {
    const res = await fetch(`data/index.json${bust ? `?t=${Date.now()}` : ''}`, { cache: bust ? 'no-store' : 'default' });
    if (!res.ok) throw new Error(res.status);
    S.index = await res.json();
  } catch {
    S.index = { feeds: [], items: [], updated: 0, missing: true };
  }
  S.content = null;
  // First visit: start with every catalog feed (you can unsubscribe any).
  if (!S.subs && S.index.feeds.length) {
    S.subs = S.index.feeds.map((f) => ({ id: f.id, url: f.url, title: f.title, folder: f.folder || '' }));
    if (S.pendingOwn) S.subs.push(...S.pendingOwn.filter((o) => !S.subs.some((s) => s.url === o.url)));
    saveSubs();
  }
  rebuild();
}

const catalogByUrl = () => new Map(S.index.feeds.map((f) => [f.url, f]));

function rebuild() {
  const catalog = catalogByUrl();
  S.feeds = (S.subs || S.pendingOwn || []).map((s) => {
    const c = catalog.get(s.url);
    // Catalog feeds come from the shared data; the rest is fetched by this page.
    return c ? { ...c, title: s.title || c.title, folder: s.folder ?? c.folder } : Object.assign(s, { own: true });
  });
  S.feedById = new Map(S.feeds.map((f) => [f.id, f]));
  const catIds = new Set(S.feeds.filter((f) => !f.own).map((f) => f.id));
  const own = S.feeds.filter((f) => f.own).flatMap((f) => S.ownItems[f.id] || []);
  S.items = [...S.index.items.filter((i) => catIds.has(i.f)), ...own].sort((a, b) => b.d - a.d);
  S.byId = new Map(S.items.map((i) => [i.id, i]));
  // Forget read marks for items that are long gone.
  const cutoff = Date.now() - 90 * 864e5;
  let changed = false;
  for (const [id, t] of Object.entries(S.read)) if (t < cutoff && !S.byId.has(id)) { delete S.read[id]; changed = true; }
  if (changed) store.set('read', S.read);
}

async function feedContent(feedId) {
  const feed = S.feedById.get(feedId);
  if (feed?.own) return Object.fromEntries((S.ownItems[feedId] || []).map((i) => [i.id, i.c || '']));
  // One file with every catalog article, so the server can't tell which feeds you read.
  S.content ??= fetch(`data/content.json?u=${S.index.updated}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return S.content;
}

async function loadVectors() {
  if (S.vectorsState === 'ready' || S.vectorsState === 'loading') return S.vectorsPromise;
  S.vectorsState = 'loading';
  S.vectorsPromise = (async () => {
    try {
      const res = await fetch(`data/vectors.json?u=${S.index.updated}`);
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      for (const [id, b64] of Object.entries(data.v || {})) S.vectors.set(id, decodeVector(b64));
      S.vectorsState = S.vectors.size ? 'ready' : 'missing';
    } catch {
      S.vectorsState = 'missing';
    }
  })();
  return S.vectorsPromise;
}

/** Makes sure every item has a vector, embedding in the browser where needed. */
async function ensureVectors(items, onProgress) {
  await loadVectors();
  const todo = items.filter((i) => !S.vectors.has(i.id));
  if (!todo.length) return;
  const vecs = await embed(todo.map(embedText), onProgress);
  todo.forEach((it, k) => S.vectors.set(it.id, vecs[k]));
}

// ---------- your own feeds (fetched by this page) ----------

class NeedsRelay extends Error {}

/** The relay this device uses: the shared one, your own, or none. */
function relayUrl() {
  if (S.settings.relayMode === 'off') return '';
  if (S.settings.relayMode === 'own') return S.settings.relay.trim().replace(/\/+$/, '');
  return SHARED_RELAY;
}

/**
 * Fetches a feed straight from its site, or through the relay. Never a public proxy.
 * For a web page, the relay answers with just the feed links on it (JSON).
 */
async function fetchFeedText(url, { relayOnly = false } = {}) {
  if (!relayOnly) try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (res.ok) return await res.text();
  } catch { /* the site doesn't let web pages read it: try the relay */ }
  const relay = relayUrl();
  const own = S.settings.relayMode === 'own';
  if (!relay) {
    throw new NeedsRelay(S.settings.relayMode === 'own'
      ? "This site doesn't let web pages read its feed. Enter your relay's address in ⚙ Settings → Your feeds."
      : "This site doesn't let web pages read its feed, and the relay is turned off in ⚙ Settings → Your feeds.");
  }
  const name = own ? 'your relay' : 'the shared relay';
  const res = await fetch(`${relay}/?url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(20000),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: own && S.settings.relayToken ? { 'X-Relay-Token': S.settings.relayToken } : {},
  }).catch(() => { throw new Error(`Couldn't reach ${name}.${own ? ' Check its address in ⚙ Settings.' : ' Try again in a moment.'}`); });
  if (res.status === 401) throw new Error('Your relay rejected the token. Check it in ⚙ Settings.');
  if (res.status === 403) throw new Error(own ? "Your relay doesn't allow this site. Check ALLOWED_ORIGIN in the Worker." : 'The shared relay refused this request.');
  if (res.status === 429) throw new Error(`${own ? 'Your' : 'The shared'} relay is busy. Try again in a minute.`);
  if (res.status === 415) throw new Error("That address isn't a feed, or a page that links to one.");
  if (res.status === 413) throw new Error('That feed is too big.');
  if (res.status === 404) throw new Error('Nothing was found at that address (404).');
  if (!res.ok) throw new Error(`The feed couldn't be fetched (HTTP ${res.status}).`);
  return res.text();
}

function parseFeedXML(xml, feedUrl, feedId) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) return null;
  const root = doc.documentElement;
  const name = root.localName;
  if (!['rss', 'feed', 'RDF'].includes(name)) return null;
  const atom = name === 'feed';
  const child = (el, tag) => [...el.children].find((c) => c.localName === tag || c.tagName === tag);
  const txt = (el, ...tags) => { for (const t of tags) { const c = child(el, t); if (c && c.textContent.trim()) return c.textContent.trim(); } return ''; };
  const channel = atom ? root : child(root, 'channel') || root;
  const linkOf = (el) => {
    if (!atom) return txt(el, 'link') || txt(el, 'guid');
    const links = [...el.children].filter((c) => c.localName === 'link');
    const alt = links.find((l) => (l.getAttribute('rel') || 'alternate') === 'alternate') || links[0];
    return alt?.getAttribute('href') || '';
  };
  const abs = (u, base) => { try { return new URL(u, base).href; } catch { return u; } };
  const site = abs(linkOf(channel), feedUrl);
  const entries = atom ? [...root.children].filter((c) => c.localName === 'entry') : [...doc.getElementsByTagName('item')];
  const items = entries.slice(0, 60).map((el, idx) => {
    const html = txt(el, 'content:encoded', 'encoded', 'content', 'description', 'summary');
    const link = abs(linkOf(el), site || feedUrl);
    const guid = txt(el, 'guid', 'id') || link;
    let d = Date.parse(txt(el, 'pubDate', 'published', 'updated', 'dc:date', 'date'));
    if (!Number.isFinite(d) || d > Date.now()) d = NaN;
    const media = [...el.getElementsByTagName('*')].find((c) => /^(thumbnail|content)$/.test(c.localName) && c.getAttribute('url') && /image|^$/.test(c.getAttribute('medium') || c.getAttribute('type') || ''));
    const imgMatch = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
    const img = media?.getAttribute('url') || (imgMatch ? imgMatch[1] : '');
    return {
      id: 'L' + hash(feedUrl + '|' + guid) + hash(guid),
      f: feedId,
      t: strip(txt(el, 'title')) || '(untitled)',
      l: link,
      d: Number.isFinite(d) ? d : Date.now() - idx * 1000,
      dated: Number.isFinite(d),
      s: strip(html).slice(0, 280),
      ...(img ? { i: abs(img, link) } : {}),
      c: html.slice(0, 40000),
    };
  });
  return { title: strip(txt(channel, 'title')), site, items };
}

function discoverFeed(html, pageUrl) {
  // The relay sends a page's feed links instead of the page.
  if (/^\s*\{/.test(html)) { try { return JSON.parse(html).feeds?.[0] || ''; } catch { return ''; } }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const link = doc.querySelector('link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]');
  if (!link) return '';
  try { return new URL(link.getAttribute('href'), pageUrl).href; } catch { return ''; }
}

async function fetchOwnFeed(feed, xml) {
  xml ??= await fetchFeedText(feed.url);
  const parsed = parseFeedXML(xml, feed.url, feed.id);
  if (!parsed) throw new Error('Not an RSS or Atom feed');
  const old = new Map((S.ownItems[feed.id] || []).map((i) => [i.id, i]));
  for (const it of parsed.items) {
    const prev = old.get(it.id);
    // Undated items keep the time we first saw them.
    old.set(it.id, { ...prev, ...it, d: it.dated ? it.d : prev?.d ?? it.d });
  }
  S.ownItems[feed.id] = [...old.values()].sort((a, b) => b.d - a.d).slice(0, OWN_ITEMS_PER_FEED);
  feed.site = parsed.site || feed.site;
  if (!feed.titleSet && parsed.title) feed.title = parsed.title;
  feed.ok = Date.now();
  feed.error = '';
  return parsed;
}

async function refreshOwnFeeds() {
  const own = (S.subs || []).filter((s) => !catalogByUrl().has(s.url));
  for (let i = 0; i < own.length; i += 4) {
    await Promise.all(own.slice(i, i + 4).map(async (f) => {
      try { await fetchOwnFeed(f); } catch (e) { f.error = e.message || 'Could not fetch'; }
    }));
  }
  if (own.length) { saveSubs(); saveOwnItems(); }
}

function subscribeCatalog(c, folder) {
  S.subs ??= [];
  if (S.subs.some((s) => s.url === c.url)) return;
  S.subs.push({ id: c.id, url: c.url, title: c.title, folder: folder ?? c.folder ?? '' });
  saveSubs();
  rebuild();
}

async function addFeed(url, folder) {
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const status = $('#addStatus');
  const already = () => { throw new Error("You're already subscribed to this feed."); };
  if (S.feeds.some((f) => f.url === url)) already();
  const inCatalog = catalogByUrl().get(url);
  if (inCatalog) { subscribeCatalog(inCatalog, folder.trim() || inCatalog.folder); return S.feedById.get(inCatalog.id); }
  status.textContent = 'Looking for the feed…';
  let text = await fetchFeedText(url);
  let feedUrl = url;
  if (!parseFeedXML(text, url, 'x')) {
    const found = discoverFeed(text, url);
    if (!found) throw new Error("This page doesn't list an RSS or Atom feed. Try the feed's own address.");
    feedUrl = found;
    status.textContent = `Found ${feedUrl}`;
    if (S.feeds.some((f) => f.url === feedUrl)) already();
    const c = catalogByUrl().get(feedUrl);
    if (c) { subscribeCatalog(c, folder.trim() || c.folder); return S.feedById.get(c.id); }
    text = await fetchFeedText(feedUrl);
  }
  const feed = { id: 'L' + hash(feedUrl), url: feedUrl, title: host(feedUrl), folder: folder.trim(), own: true, site: '' };
  await fetchOwnFeed(feed, text);
  S.subs ??= [];
  S.subs.push(feed);
  saveSubs();
  saveOwnItems();
  rebuild();
  return feed;
}

function unsubscribe(id) {
  const f = S.feedById.get(id);
  if (!f) return;
  S.subs = S.subs.filter((s) => s.url !== f.url);
  delete S.ownItems[id];
  saveSubs();
  saveOwnItems();
  rebuild();
}

// ---------- read state, stars, streak ----------

function markRead(id, read = true) {
  const before = totalUnread();
  if (read) { if (!isRead(id)) S.read[id] = Date.now(); } else delete S.read[id];
  store.set('read', S.read);
  if (read) noteActivity();
  updateEntryDom(id);
  renderSidebar();
  renderHeaderCounts();
  if (read && before > 0 && totalUnread() === 0) celebrate();
}

function markAllRead(items) {
  const before = totalUnread();
  const t = Date.now();
  let n = 0;
  for (const it of items) if (!isRead(it.id)) { S.read[it.id] = t; n++; }
  store.set('read', S.read);
  if (n) noteActivity();
  render();
  if (n) toast(`Marked ${n} as read`);
  if (before > 0 && totalUnread() === 0) celebrate();
}

function toggleStar(id) {
  const it = S.byId.get(id) || S.starred[id];
  if (!it) return;
  if (S.starred[id]) delete S.starred[id];
  else S.starred[id] = { ...it, starredAt: Date.now() };
  store.set('starred', S.starred);
  updateEntryDom(id);
  renderSidebar();
}

function noteActivity() {
  const d = today();
  if (S.days[S.days.length - 1] !== d) {
    S.days.push(d);
    S.days = S.days.slice(-400);
    store.set('days', S.days);
    renderStreak();
  }
}

function streak() {
  const set = new Set(S.days);
  const d = new Date();
  if (!set.has(today())) d.setDate(d.getDate() - 1); // still alive if you read yesterday
  let n = 0;
  for (;;) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!set.has(key)) break;
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function renderStreak() {
  const n = streak();
  $('#streak').textContent = n ? `🔥 ${n}` : '';
  $('#streak').title = n ? `${n}-day reading streak` : '';
}

const unreadOf = (items) => items.reduce((n, i) => n + (isRead(i.id) ? 0 : 1), 0);
const totalUnread = () => unreadOf(S.items);

// ---------- topics ----------

function topicMatches(topic) {
  const words = topic.query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const phrase = topic.query.toLowerCase();
  const qv = topic.qv ? Float32Array.from(topic.qv) : null;
  const out = [];
  const scores = {};
  for (const it of S.items) {
    const hay = `${it.t} ${it.s}`.toLowerCase();
    let score = 0;
    const v = S.vectors.get(it.id);
    if (qv && v) score = dot(qv, v);
    if (hay.includes(phrase)) score = Math.max(score, 0.99);
    else if (words.length > 1 && words.every((w) => hay.includes(w))) score = Math.max(score, S.settings.threshold + 0.05);
    if (score >= S.settings.threshold) { out.push(it); scores[it.id] = score; }
  }
  return { items: out, scores };
}

async function createTopic(query) {
  const status = $('#topicStatus');
  status.textContent = 'Teaching the AI what you mean… (the first time downloads the model, ~25 MB)';
  const [qv] = await embed([query], (p) => { status.textContent = `Downloading the AI model… ${Math.round(p * 100)}%`; });
  const topic = { id: hash(query + Date.now()), name: query.replace(/^./, (c) => c.toUpperCase()), query, qv: Array.from(qv, (x) => +x.toFixed(4)) };
  S.topics.push(topic);
  store.set('topics', S.topics);
  await loadVectors();
  return topic;
}

// ---------- views ----------

function viewItems() {
  const v = S.view;
  S.scores = null;
  let items;
  switch (v.type) {
    case 'all': items = S.items; break;
    case 'starred': items = Object.values(S.starred).sort((a, b) => b.starredAt - a.starredAt); break;
    case 'feed': items = S.items.filter((i) => i.f === v.id); break;
    case 'folder': {
      const ids = new Set(S.feeds.filter((f) => (f.folder || '') === v.id).map((f) => f.id));
      items = S.items.filter((i) => ids.has(i.f));
      break;
    }
    case 'topic': {
      const topic = S.topics.find((t) => t.id === v.id);
      if (!topic) { items = []; break; }
      const m = topicMatches(topic);
      S.scores = m.scores;
      items = m.items;
      break;
    }
    case 'search': items = v.results || []; S.scores = v.scores || null; break;
    default: items = [];
  }
  const showAll = v.type === 'starred' || v.type === 'search' || !S.settings.unreadOnly;
  return showAll ? items : items.filter((i) => !isRead(i.id) || v.keep?.has(i.id));
}

function viewTitle() {
  const v = S.view;
  switch (v.type) {
    case 'all': return 'All items';
    case 'starred': return 'Starred';
    case 'feed': return S.feedById.get(v.id)?.title || 'Feed';
    case 'folder': return v.id || 'Unfiled';
    case 'topic': return '✨ ' + (S.topics.find((t) => t.id === v.id)?.name || 'Topic');
    case 'search': return `“${v.q}”`;
    default: return '';
  }
}

function sourceItems() {
  // All items in the current view regardless of the unread filter (for counts / mark all).
  const keep = S.settings.unreadOnly;
  S.settings.unreadOnly = false;
  const all = viewItems();
  S.settings.unreadOnly = keep;
  return all;
}

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const [type, ...rest] = parts;
  const arg = decodeURIComponent(rest.join('/'));
  const prevKey = JSON.stringify([S.view.type, S.view.id, S.view.q]);
  if (type === 'all' || type === 'starred') S.view = { type };
  else if (type === 'feed' || type === 'folder' || type === 'topic') S.view = { type, id: arg };
  else if (type === 'search' && arg) {
    if (S.view.type !== 'search' || S.view.q !== arg) { S.view = { type: 'search', q: arg }; runSearch(arg); }
  } else S.view = { type: 'home' };
  if (JSON.stringify([S.view.type, S.view.id, S.view.q]) !== prevKey) S.view.keep = new Set();
  $('#q').value = S.view.type === 'search' ? S.view.q : '';
  S.cur = -1;
  closeSidebar();
  render();
  $('#main').scrollTop = 0;
  window.scrollTo(0, 0);
}

function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

// ---------- search ----------

async function runSearch(q) {
  const v = S.view;
  const lower = q.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const keyword = (it) => { const hay = `${it.t} ${it.s} ${S.feedById.get(it.f)?.title || ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); };
  // 1) Instant keyword results.
  v.results = S.items.filter(keyword).slice(0, 200);
  v.scores = null;
  v.status = 'Finding articles by meaning…';
  render();
  // 2) Meaning-based results.
  try {
    await loadVectors();
    const [qv] = await embed([q], (p) => { if (S.view === v) { v.status = `Downloading the AI model (first time only)… ${Math.round(p * 100)}%`; renderHeader(); } });
    await ensureVectors(S.items.filter((i) => i.f.startsWith('L')));
    if (S.view !== v) return;
    const scores = {};
    const ranked = [];
    for (const it of S.items) {
      const vec = S.vectors.get(it.id);
      let s = vec ? dot(qv, vec) : 0;
      if (keyword(it)) s += 0.2;
      if (s >= 0.3) { scores[it.id] = s; ranked.push(it); }
    }
    ranked.sort((a, b) => scores[b.id] - scores[a.id]);
    v.results = ranked.slice(0, 150);
    v.scores = scores;
    v.status = S.vectors.size ? '' : 'AI search needs the next feed update to finish its first run; showing word matches.';
  } catch (e) {
    console.warn(e);
    if (S.view !== v) return;
    v.status = "Couldn't load the AI model, so these are word matches only.";
  }
  if (S.view === v) render();
}

// ---------- rendering ----------

function renderSidebar() {
  const nav = $('#sidebar');
  const folders = new Map();
  for (const f of S.feeds) {
    const k = f.folder || '';
    if (!folders.has(k)) folders.set(k, []);
    folders.get(k).push(f);
  }
  const unreadByFeed = new Map();
  for (const it of S.items) if (!isRead(it.id)) unreadByFeed.set(it.f, (unreadByFeed.get(it.f) || 0) + 1);
  const v = S.view;
  const active = (type, id) => (v.type === type && (id === undefined || v.id === id) ? ' active' : '');
  const count = (n) => (n ? `<span class="count">${n > 999 ? '999+' : n}</span>` : '');
  const total = totalUnread();
  const nStar = Object.keys(S.starred).length;

  let html = `
    <button class="add-btn" id="addBtn">＋ Subscribe</button>
    <a class="nav-item${active('home')}" href="#/home"><span class="ico">🏠</span>Home</a>
    <a class="nav-item${active('all')}" href="#/all"><span class="ico">📚</span><span class="name">All items</span>${count(total)}</a>
    <a class="nav-item${active('starred')}" href="#/starred"><span class="ico">⭐</span><span class="name">Starred</span>${nStar ? `<span class="count muted">${nStar}</span>` : ''}</a>
    <div class="nav-section"><span>AI topics</span><button class="mini" id="addTopicBtn" title="New AI topic" aria-label="New AI topic">＋</button></div>`;
  if (!S.topics.length) html += `<button class="nav-empty" id="addTopicBtn2">Follow a topic across all feeds →</button>`;
  for (const t of S.topics) {
    let n = '';
    if (S.vectorsState === 'ready' || S.vectorsState === 'missing') n = count(unreadOf(topicMatches(t).items));
    html += `<a class="nav-item${active('topic', t.id)}" href="#/topic/${t.id}"><span class="ico">✨</span><span class="name">${esc(t.name)}</span>${n}</a>`;
  }
  html += `<div class="nav-section"><span>Subscriptions</span></div>`;
  const names = [...folders.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  for (const name of names) {
    const list = folders.get(name).sort((a, b) => a.title.localeCompare(b.title));
    const feedRow = (f) => `<a class="nav-item feed${active('feed', f.id)}${f.error ? ' broken' : ''}" href="#/feed/${f.id}" title="${esc(f.error ? `Couldn't fetch: ${f.error}` : f.url)}">
        ${avatar(f)}<span class="name">${esc(f.title)}</span>${f.error ? '<span class="warn" aria-label="Fetch problem">!</span>' : ''}${count(unreadByFeed.get(f.id) || 0)}</a>`;
    if (!name) { html += list.map(feedRow).join(''); continue; }
    const n = list.reduce((s, f) => s + (unreadByFeed.get(f.id) || 0), 0);
    const closed = S.collapsed[name];
    html += `<div class="folder${closed ? ' closed' : ''}">
      <div class="nav-item folder-row${active('folder', name)}"><button class="twisty" data-folder="${esc(name)}" aria-label="${closed ? 'Expand' : 'Collapse'} ${esc(name)}">▾</button><a href="#/folder/${encodeURIComponent(name)}" class="name">📁 ${esc(name)}</a>${count(n)}</div>
      <div class="folder-feeds">${list.map(feedRow).join('')}</div></div>`;
  }
  if (!S.feeds.length) html += `<p class="nav-note">No subscriptions yet. Press ＋ Subscribe to pick some.</p>`;
  html += `<p class="nav-note">${S.index.updated ? `Updated ${agoText(S.index.updated)}` : S.index.missing ? 'Waiting for the first feed update' : ''} · <button class="linkish" data-act="refresh">Refresh</button></p>`;
  nav.innerHTML = html;
}

function renderHeaderCounts() {
  const el = $('#viewHeader .sub');
  if (el) el.textContent = headerSub();
}

function headerSub() {
  const all = sourceItems();
  const unread = unreadOf(all);
  const v = S.view;
  if (v.type === 'starred') return `${all.length} starred`;
  if (v.type === 'search') return v.status || `${all.length} results, best matches first`;
  if (v.type === 'feed') {
    const f = S.feedById.get(v.id);
    if (f?.error) return `⚠ Couldn't fetch this feed last time: ${f.error}`;
  }
  return `${unread} unread${all.length !== unread ? ` of ${all.length}` : ''}`;
}

function renderHeader() {
  const v = S.view;
  const h = $('#viewHeader');
  if (v.type === 'home') { h.innerHTML = ''; return; }
  const feed = v.type === 'feed' ? S.feedById.get(v.id) : null;
  const filterable = !['starred', 'search'].includes(v.type);
  h.innerHTML = `
    <div class="vh-title">
      <h1>${feed ? avatar(feed, true) : ''}${esc(viewTitle())}</h1>
      <p class="sub">${esc(headerSub())}</p>
    </div>
    <div class="vh-actions">
      ${filterable ? `<div class="seg" role="group" aria-label="Show"><button data-act="unread" class="${S.settings.unreadOnly ? 'on' : ''}">Unread</button><button data-act="allitems" class="${S.settings.unreadOnly ? '' : 'on'}">All</button></div>` : ''}
      <div class="seg" role="group" aria-label="View"><button data-act="list" class="${S.settings.mode === 'list' ? 'on' : ''}" title="List view (1)">☰ List</button><button data-act="expanded" class="${S.settings.mode === 'expanded' ? 'on' : ''}" title="Expanded view (2)">▤ Expanded</button></div>
      ${v.type !== 'starred' ? `<button data-act="markall" title="Mark all as read (Shift+A)">✓ Mark all read</button>` : ''}
      <button data-act="brief" class="ai" title="Ask your AI assistant for a short briefing on this list">✨ Brief me</button>
      ${v.type === 'search' ? `<button data-act="savetopic" title="Follow this search as an AI topic">＋ Save as topic</button>` : ''}
      ${v.type === 'topic' ? `<button data-act="deltopic" class="ghost" title="Delete this topic">Delete topic</button>` : ''}
      ${feed ? `<button data-act="unsub" class="ghost">Unsubscribe</button>` : ''}
    </div>
    <div class="brief" id="brief" hidden></div>`;
}

function entryHTML(it, idx) {
  const f = S.feedById.get(it.f);
  const read = isRead(it.id);
  const star = !!S.starred[it.id];
  const score = S.scores?.[it.id];
  const expanded = S.settings.mode === 'expanded';
  return `<article class="entry${read ? ' read' : ''}${expanded ? ' expanded' : ''}" data-id="${esc(it.id)}" data-idx="${idx}">
    <div class="row" role="button" tabindex="-1">
      <button class="star${star ? ' on' : ''}" data-act="star" aria-label="${star ? 'Unstar' : 'Star'}" title="Star (s)">${star ? '★' : '☆'}</button>
      <span class="src">${avatar(f)}${esc(f?.title || '')}</span>
      <span class="line"><span class="t">${esc(it.t)}</span><span class="snip"> – ${esc(it.s)}</span></span>
      ${score != null && score < 0.99 ? `<span class="match" title="How closely this matches">${Math.round(Math.min(score, 1) * 100)}%</span>` : ''}
      <time datetime="${new Date(it.d).toISOString()}" title="${esc(new Date(it.d).toLocaleString())}">${ago(it.d)}</time>
    </div>
    ${expanded ? `<div class="body">${bodyHTML(it)}</div>` : ''}
  </article>`;
}

function bodyHTML(it) {
  const f = S.feedById.get(it.f);
  const star = !!S.starred[it.id];
  return `
    <h2><a href="${esc(it.l)}" target="_blank" rel="noopener">${esc(it.t)} <span class="ext">↗</span></a></h2>
    <p class="meta">from <a href="#/feed/${esc(it.f)}">${esc(f?.title || 'a feed')}</a>${it.a ? ` by ${esc(it.a)}` : ''} · ${esc(new Date(it.d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</p>
    <div class="content" data-content><p class="loading">${esc(it.s || '')}</p></div>
    <div class="actions">
      <button data-act="star" class="${star ? 'on' : ''}">${star ? '★ Starred' : '☆ Star'}</button>
      <button data-act="unread">${isRead(it.id) ? '◌ Keep unread' : '● Mark read'}</button>
      <a class="button" href="${esc(it.l)}" target="_blank" rel="noopener">Open original ↗</a>
      <button data-act="summarize" class="ai">✨ Summarize</button>
      <button data-act="related">🔗 More like this</button>
      <button data-act="share">Share</button>
    </div>
    <div class="ai-out" hidden></div>
    <div class="related" hidden></div>`;
}

async function fillContent(article) {
  const it = S.byId.get(article.dataset.id) || S.starred[article.dataset.id];
  const box = article.querySelector('[data-content]');
  if (!it || !box || box.dataset.filled) return;
  box.dataset.filled = '1';
  const html = it.c ?? (await feedContent(it.f))[it.id];
  if (!html) { box.innerHTML = `<p>${esc(it.s || '')}</p>${it.i ? `<img src="${esc(it.i)}" alt="" loading="lazy">` : ''}`; return; }
  box.innerHTML = sanitize(html, it.l);
  if (it.i && !box.querySelector('img')) box.insertAdjacentHTML('afterbegin', `<img class="lead" src="${esc(it.i)}" alt="" loading="lazy">`);
}

function sanitize(html, base) {
  const clean = window.DOMPurify
    ? window.DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'], FORBID_ATTR: ['style', 'class', 'id', 'width', 'height'] })
    : esc(strip(html));
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  for (const a of tpl.content.querySelectorAll('a[href]')) {
    try { a.href = new URL(a.getAttribute('href'), base).href; } catch { /* keep */ }
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  for (const img of tpl.content.querySelectorAll('img')) {
    const src = img.getAttribute('src') || img.getAttribute('data-src');
    if (src) { try { img.src = new URL(src, base).href; } catch { /* keep */ } }
    img.removeAttribute('srcset');
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
  }
  return tpl.innerHTML;
}

function renderList(reset = true) {
  const list = $('#list');
  if (reset) { S.list = viewItems(); S.shown = 0; list.innerHTML = ''; }
  if (!S.list.length) {
    list.innerHTML = emptyHTML();
    return;
  }
  const next = S.list.slice(S.shown, S.shown + PAGE);
  list.querySelector('.more')?.remove();
  list.insertAdjacentHTML('beforeend', next.map((it, k) => entryHTML(it, S.shown + k)).join(''));
  S.shown += next.length;
  if (S.settings.mode === 'expanded') list.querySelectorAll('article.expanded').forEach((a) => { fillContent(a); readObserver.observe(a); });
  if (S.shown < S.list.length) {
    list.insertAdjacentHTML('beforeend', `<div class="more"><button data-act="more">Show more (${S.list.length - S.shown} left)</button></div>`);
    moreObserver.observe(list.querySelector('.more'));
  } else if (S.view.type !== 'search') {
    list.insertAdjacentHTML('beforeend', `<div class="end">That's everything here. ${unreadOf(sourceItems()) ? '' : '🎉'}</div>`);
  }
}

function emptyHTML() {
  const v = S.view;
  if (v.type === 'search') return `<div class="empty"><p class="big">🔍</p><p>${esc(v.status || 'Nothing matched. Try describing it in other words.')}</p></div>`;
  if (v.type === 'starred') return `<div class="empty"><p class="big">☆</p><p>Star articles with <kbd>s</kbd> to keep them here, even after they leave the feed.</p></div>`;
  if (v.type === 'topic' && S.vectorsState === 'loading') return `<div class="empty"><p>Finding matching articles…</p></div>`;
  if (S.settings.unreadOnly && sourceItems().length) {
    return `<div class="empty"><p class="big">🎉</p><p><b>All caught up.</b> No unread articles here.</p><p><button data-act="allitems">Show read articles</button> <button data-act="surprise">🎲 Surprise me</button></p></div>`;
  }
  if (S.index.missing) return `<div class="empty"><p class="big">📡</p><p>The first feed update hasn't run yet. Once cron-job.org triggers the GitHub Action, articles show up here.</p></div>`;
  return `<div class="empty"><p>Nothing here yet.</p></div>`;
}

/** Each person's reader lives in their browser on their device. */
function deviceNoteHTML(card) {
  const text = `Your reader lives in this browser on this device. Your phone and laptop each have their own, and clearing this browser's data erases it. To move it or keep it safe, use <b>⚙ Settings → Export backup</b>, then <b>Import backup</b> on the other device.`;
  return card
    ? `<div class="device-note" role="note"><span class="device-ico" aria-hidden="true">📱💻</span><p>${text}</p><div class="device-actions"><button data-act="backup" class="primary">Export backup</button><button data-act="dismissnote" class="ghost">Got it</button></div></div>`
    : `<p class="device-foot">📱 ${text} <button class="linkish" data-act="backup">Export backup</button></p>`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function renderHome() {
  const list = $('#list');
  const unread = S.items.filter((i) => !isRead(i.id));
  const fresh = unread.filter((i) => i.i).slice(0, 6);
  const freshIds = new Set(fresh.map((i) => i.id));
  const latest = unread.filter((i) => !freshIds.has(i.id)).slice(0, 8);
  const broken = S.feeds.filter((f) => f.error);
  const n = streak();
  const feedsWithUnread = new Set(unread.map((i) => i.f)).size;
  list.innerHTML = `
    <section class="home">
      ${store.get('deviceNoteDismissed', false) ? '' : deviceNoteHTML(true)}
      <div class="hero">
        <h1>${greeting()} 👋</h1>
        <p>${unread.length ? `You have <b>${unread.length}</b> unread article${unread.length === 1 ? '' : 's'} from <b>${feedsWithUnread}</b> feed${feedsWithUnread === 1 ? '' : 's'}.` : S.items.length ? '<b>Inbox zero.</b> You read everything. 🎉' : 'Your reader is warming up.'}
          ${n > 1 ? ` You're on a <b>${n}-day</b> streak 🔥` : ''}</p>
        <div class="hero-actions">
          <a class="button primary" href="#/all">Start reading →</a>
          <button data-act="surprise">🎲 Surprise me</button>
          <button data-act="brief" class="ai">✨ Brief me on what's new</button>
        </div>
        <div class="brief" id="brief" hidden></div>
      </div>
      ${fresh.length ? `<h2 class="home-h">Fresh picks</h2><div class="cards">${fresh.map((it) => {
        const f = S.feedById.get(it.f);
        return `<a class="card" href="#/feed/${esc(it.f)}" data-open="${esc(it.id)}"><img src="${esc(it.i)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"><span class="card-src">${esc(f?.title || '')} · ${ago(it.d)}</span><span class="card-t">${esc(it.t)}</span></a>`;
      }).join('')}</div>` : ''}
      ${latest.length ? `<h2 class="home-h">Latest</h2><div class="mini-list">${latest.map((it) => `<a href="#/feed/${esc(it.f)}" data-open="${esc(it.id)}"><span class="src">${esc(S.feedById.get(it.f)?.title || '')}</span><span class="t">${esc(it.t)}</span><time>${ago(it.d)}</time></a>`).join('')}</div>` : ''}
      <h2 class="home-h">AI topics</h2>
      <p class="hint">Follow a subject across every feed. The AI matches articles by meaning, not just keywords.</p>
      <div class="chips">${S.topics.map((t) => `<a class="chip" href="#/topic/${t.id}">✨ ${esc(t.name)}${S.vectorsState !== 'loading' ? ` <b>${unreadOf(topicMatches(t).items)}</b>` : ''}</a>`).join('')}<button class="chip add" data-act="newtopic">＋ New topic</button></div>
      ${broken.length ? `<h2 class="home-h">Needs attention</h2><ul class="broken">${broken.map((f) => `<li><a href="#/feed/${f.id}">${esc(f.title)}</a>: ${esc(f.error)}</li>`).join('')}</ul>` : ''}
      ${store.get('deviceNoteDismissed', false) ? deviceNoteHTML(false) : ''}
    </section>`;
}

function render() {
  renderSidebar();
  renderHeader();
  if (S.view.type === 'home') renderHome();
  else renderList();
  document.title = S.view.type === 'home' ? `Sala Reader${totalUnread() ? ` (${totalUnread()})` : ''}` : `${viewTitle()} · Sala Reader`;
}

function updateEntryDom(id) {
  for (const a of document.querySelectorAll(`article.entry[data-id="${CSS.escape(id)}"]`)) {
    a.classList.toggle('read', isRead(id));
    const star = !!S.starred[id];
    const sb = a.querySelector('.row .star');
    sb.classList.toggle('on', star);
    sb.textContent = star ? '★' : '☆';
    const bs = a.querySelector('.actions [data-act="star"]');
    if (bs) { bs.classList.toggle('on', star); bs.textContent = star ? '★ Starred' : '☆ Star'; }
    const bu = a.querySelector('.actions [data-act="unread"]');
    if (bu) bu.textContent = isRead(id) ? '◌ Keep unread' : '● Mark read';
  }
  document.title = S.view.type === 'home' ? `Sala Reader${totalUnread() ? ` (${totalUnread()})` : ''}` : `${viewTitle()} · Sala Reader`;
}

// ---------- opening entries ----------

function entries() { return [...document.querySelectorAll('#list article.entry')]; }

function select(idx, { open = true, scroll = true } = {}) {
  const all = entries();
  if (idx < 0 || idx >= all.length) {
    if (idx >= all.length && S.shown < S.list.length) { renderList(false); return select(idx, { open, scroll }); }
    return;
  }
  const prev = all[S.cur];
  if (prev && prev !== all[idx]) {
    prev.classList.remove('current');
    if (S.settings.mode === 'list') closeEntry(prev);
  }
  S.cur = idx;
  const a = all[idx];
  a.classList.add('current');
  if (open) openEntry(a);
  if (scroll) {
    // Scroll so the article sits just below the sticky top bar and view header.
    const offset = $('.top').offsetHeight + $('#viewHeader').offsetHeight + 8;
    const r = a.getBoundingClientRect();
    if (open && S.settings.mode === 'list') window.scrollTo({ top: r.top + scrollY - offset, behavior: 'smooth' });
    else if (r.top < offset || r.bottom > innerHeight) window.scrollTo({ top: r.top + scrollY - offset, behavior: 'smooth' });
  }
}

function openEntry(a) {
  const id = a.dataset.id;
  if (S.settings.mode === 'list' && !a.classList.contains('open')) {
    a.classList.add('open');
    a.insertAdjacentHTML('beforeend', `<div class="body">${bodyHTML(S.byId.get(id) || S.starred[id])}</div>`);
    fillContent(a);
  }
  S.view.keep?.add(id); // keep it visible in "unread only" until you leave the view
  if (!isRead(id)) markRead(id);
}

function closeEntry(a) {
  a.classList.remove('open');
  a.querySelector('.body')?.remove();
}

function toggleEntry(a) {
  const idx = +a.dataset.idx;
  if (S.settings.mode === 'list' && a.classList.contains('open') && S.cur === idx) { closeEntry(a); return; }
  select(idx, { open: true, scroll: S.settings.mode === 'list' });
}

const readObserver = new IntersectionObserver((list) => {
  for (const e of list) {
    // In expanded view, an article is read once you've scrolled past its top.
    if (!e.isIntersecting && e.boundingClientRect.top < 0) {
      const id = e.target.dataset.id;
      S.view.keep?.add(id);
      if (!isRead(id)) markRead(id);
      readObserver.unobserve(e.target);
    }
  }
}, { threshold: 0 });

const moreObserver = new IntersectionObserver((list) => {
  if (list.some((e) => e.isIntersecting)) { moreObserver.disconnect(); renderList(false); }
}, { rootMargin: '600px' });

function surprise() {
  const pool = S.items.filter((i) => !isRead(i.id));
  const pick = (pool.length ? pool : S.items)[Math.floor(Math.random() * (pool.length || S.items.length))];
  if (!pick) { toast('Nothing to surprise you with yet'); return; }
  openItemAnywhere(pick.id);
}

function openItemAnywhere(id) {
  const it = S.byId.get(id);
  if (!it) return;
  go(`#/feed/${it.f}`);
  setTimeout(() => {
    S.view.keep?.add(id);
    renderList(true);
    const idx = S.list.findIndex((i) => i.id === id);
    if (idx < 0) return;
    while (idx >= S.shown) renderList(false);
    select(idx);
  }, 30);
}

// ---------- AI actions ----------

function needKey() {
  const { p, key } = ai();
  if (key) return false;
  toast(`Add your ${p.name} API key in ⚙ Settings to use ✨ AI features`, 4000);
  openSettings();
  $('#keyInput').focus();
  return true;
}

/** Streams an AI answer into box, with a "via" line naming the assistant. */
async function streamAI(box, { system, prompt, pool, working }) {
  const { p, key, model } = ai();
  box.hidden = false;
  box.innerHTML = `<p class="loading">✨ ${esc(working)} <span class="muted">(${esc(p.name)})</span></p>`;
  let acc = '';
  try {
    const res = await askAI({
      providerId: p.id, apiKey: key, model, system, prompt,
      onText: (t) => { acc += t; box.innerHTML = formatAI(acc, pool); },
    });
    box.innerHTML = formatAI(res.text, pool) + `<p class="via">✨ ${esc(p.name)} · ${esc(res.model)} · <button class="linkish" data-act="switchai">switch assistant</button></p>`;
  } catch (e) {
    const msg = /dynamically imported module|Importing a module script failed/i.test(e.message) ? "Couldn't load the AI library. Check your connection or ad blocker and try again." : e.message;
    box.innerHTML = `<p class="error">${esc(msg)}</p><p class="via"><button class="linkish" data-act="switchai">Change assistant or key</button></p>`;
  }
}

async function summarize(article) {
  if (needKey()) return;
  const it = S.byId.get(article.dataset.id) || S.starred[article.dataset.id];
  const out = article.querySelector('.ai-out');
  const html = it.c ?? (await feedContent(it.f))[it.id] ?? it.s;
  const text = strip(html || it.s).slice(0, 30000);
  await streamAI(out, {
    working: 'Reading it for you…',
    system: 'You summarize articles for a busy reader of an RSS reader. Reply with 3 short bullet points ("- " at the start of each) covering what happened and why it matters, then one line starting "Worth reading in full if:". Plain text, no headings.',
    prompt: `Title: ${it.t}\nSource: ${S.feedById.get(it.f)?.title || ''}\n\n${text || '(only the title is available)'}`,
  });
}

async function brief() {
  if (needKey()) return;
  const box = $('#brief');
  const pool = (S.view.type === 'home' ? S.items : S.list).filter((i) => S.view.type === 'search' || S.view.type === 'starred' || !isRead(i.id)).slice(0, 40);
  if (!pool.length) { box.hidden = false; box.innerHTML = '<p>Nothing unread to brief you on. 🎉</p>'; return; }
  const listing = pool.map((it, k) => `[${k + 1}] ${it.t} (${S.feedById.get(it.f)?.title || ''}, ${ago(it.d)}): ${it.s.slice(0, 200)}`).join('\n');
  await streamAI(box, {
    pool,
    working: 'Reading the headlines…',
    system: 'You write a quick, friendly briefing for someone opening their RSS reader. Group related stories into 3-6 short themed points ("- " bullets). Cite stories by their number in square brackets like [3]. Start with one sentence on the overall picture. Plain text, under 200 words.',
    prompt: `${S.view.type === 'search' ? `They searched for: ${S.view.q}\n` : S.view.type === 'topic' ? `Topic: ${viewTitle()}\n` : ''}Stories:\n${listing}`,
  });
}

function switchProvider(id) {
  S.settings.aiProvider = id;
  saveSettings();
  const { p, key } = ai();
  toast(`✨ AI assistant: ${p.name}${key ? '' : ' (add its key in ⚙ Settings)'}`);
}

function formatAI(text, pool) {
  let html = esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .split('\n').map((line) => (/^\s*[-•]\s+/.test(line) ? `<li>${line.replace(/^\s*[-•]\s+/, '')}</li>` : line.trim() ? `<p>${line}</p>` : '')).join('');
  html = html.replace(/(<li>.*?<\/li>)+/g, (m) => `<ul>${m}</ul>`);
  if (pool) html = html.replace(/\[(\d+)\]/g, (m, n) => { const it = pool[n - 1]; return it ? `<a href="#" class="cite" data-open="${esc(it.id)}" title="${esc(it.t)}">${n}</a>` : m; });
  return html;
}

async function related(article) {
  const it = S.byId.get(article.dataset.id) || S.starred[article.dataset.id];
  const box = article.querySelector('.related');
  box.hidden = false;
  box.innerHTML = '<p class="loading">Finding similar articles…</p>';
  try {
    await ensureVectors([it, ...S.items.filter((i) => i.f.startsWith('L'))], (p) => { box.innerHTML = `<p class="loading">Downloading the AI model (first time only)… ${Math.round(p * 100)}%</p>`; });
    const v = S.vectors.get(it.id);
    const scored = S.items.filter((o) => o.id !== it.id && S.vectors.has(o.id)).map((o) => [o, dot(v, S.vectors.get(o.id))]).filter(([, s]) => s > 0.45).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (!scored.length) { box.innerHTML = '<p>No similar articles in your feeds right now.</p>'; return; }
    box.innerHTML = `<h3>More like this</h3><ul>${scored.map(([o, s]) => `<li><a href="#" data-open="${esc(o.id)}">${esc(o.t)}</a> <span class="muted">${esc(S.feedById.get(o.f)?.title || '')} · ${ago(o.d)}${s > 0.8 && o.f !== it.f ? ' · same story' : ''}</span></li>`).join('')}</ul>`;
  } catch (e) {
    console.warn(e);
    box.innerHTML = "<p class=\"error\">Couldn't load the AI model.</p>";
  }
}

async function share(article) {
  const it = S.byId.get(article.dataset.id) || S.starred[article.dataset.id];
  try {
    if (navigator.share) { await navigator.share({ title: it.t, url: it.l }); return; }
    await navigator.clipboard.writeText(it.l);
    toast('Link copied');
  } catch { /* cancelled */ }
}

// ---------- fun ----------

function celebrate() {
  toast('🎉 Inbox zero! You read everything.', 4000);
  const c = $('#confetti');
  const ctx = c.getContext('2d');
  c.width = innerWidth; c.height = innerHeight;
  c.classList.add('on');
  const colors = ['#1a73e8', '#ea4335', '#fbbc04', '#34a853', '#a142f4', '#ff6d01'];
  const parts = Array.from({ length: 160 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 200, y: innerHeight / 3,
    vx: (Math.random() - 0.5) * 14, vy: Math.random() * -14 - 4,
    r: Math.random() * 6 + 3, c: colors[Math.floor(Math.random() * colors.length)], a: Math.random() * 6,
  }));
  const start = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const p of parts) {
      p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.a += 0.15;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore();
    }
    if (t - start < 2600) requestAnimationFrame(frame);
    else { ctx.clearRect(0, 0, c.width, c.height); c.classList.remove('on'); }
  })(start);
}

// ---------- dialogs ----------

function openSettings() {
  const d = $('#settingsDialog');
  $('#themeSel').value = S.settings.theme;
  renderAISettings();
  $('#thresholdRange').value = S.settings.threshold;
  $('#thresholdVal').textContent = `(${Math.round(S.settings.threshold * 100)}%)`;
  $('#updatesInfo').innerHTML = `The starter catalog is refreshed on GitHub whenever cron-job.org calls it. ${S.index.updated ? `Last update: <b>${esc(new Date(S.index.updated).toLocaleString())}</b> (${agoText(S.index.updated)}).` : 'No update has run yet.'} Your own feeds are fetched by this page when you open it, and every 30 minutes while it's open.`;
  for (const r of document.querySelectorAll('input[name="relayMode"]')) r.checked = r.value === S.settings.relayMode;
  $('#ownRelay').hidden = S.settings.relayMode !== 'own';
  $('#relayInput').value = S.settings.relay;
  $('#relayToken').value = S.settings.relayToken;
  $('#relayStatus').textContent = '';
  $('#includeKeys').checked = false;
  if (!d.open) d.showModal();
}

function renderAISettings() {
  const { p, key, model } = ai();
  $('#providerSel').innerHTML = PROVIDERS.map((x, i) => `<option value="${x.id}"${x.id === p.id ? ' selected' : ''}>${esc(x.name)}${S.settings.keys[x.id] ? ' ✓' : ''} (Alt+${i + 1})</option>`).join('');
  $('#keyLabel').textContent = `${p.name} API key`;
  $('#keyInput').value = key;
  $('#keyInput').placeholder = p.keyHint;
  $('#keyLink').href = p.keyUrl;
  $('#keyLink').textContent = `Get your ${p.name} key`;
  $('#keyNote').textContent = p.id === 'gemini' ? ' (free from Google AI Studio)' : p.id === 'openrouter' ? ' (one key for models from many companies)' : '';
  $('#orSignIn').hidden = !p.signIn;
  const listed = S.modelLists?.[p.id] || [];
  const opts = p.models
    ? p.models
    : [['auto', p.auto ? `Auto (${p.auto})` : 'Auto (the newest general model your key can use)'], ...[...new Set([model, ...listed])].filter((m) => m && m !== 'auto').map((m) => [m, m])];
  $('#modelSel').innerHTML = opts.map(([id, label]) => `<option value="${esc(id)}"${id === model || (p.models && model === 'auto' && id === p.models[0][0]) ? ' selected' : ''}>${esc(label)}</option>`).join('');
  $('#listModelsBtn').hidden = !!p.models;
  $('#modelStatus').textContent = '';
}

function applyTheme() {
  const t = S.settings.theme;
  try { localStorage.setItem('sr.theme', t); } catch { /* blocked: the theme just applies a moment later */ }
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportOPML() {
  const folders = new Map();
  for (const f of S.feeds) { const k = f.folder || ''; if (!folders.has(k)) folders.set(k, []); folders.get(k).push(f); }
  const x = (s) => esc(s);
  const line = (f) => `      <outline type="rss" text="${x(f.title)}" title="${x(f.title)}" xmlUrl="${x(f.url)}"${f.site ? ` htmlUrl="${x(f.site)}"` : ''}/>`;
  const body = [...folders].map(([name, list]) => (name ? `    <outline text="${x(name)}" title="${x(name)}">\n${list.map(line).join('\n')}\n    </outline>` : list.map(line).join('\n').replace(/^ {2}/gm, ''))).join('\n');
  download('salareader.opml', `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Sala Reader subscriptions</title></head>\n  <body>\n${body}\n  </body>\n</opml>\n`, 'text/x-opml');
}

// ---------- backup: move everything to another device ----------

const BACKUP_KEYS = ['subs', 'read', 'starred', 'topics', 'collapsed', 'days', 'settings', 'ownItems'];

async function exportBackup(includeKeys) {
  await flush();
  const data = {};
  for (const k of BACKUP_KEYS) if (store.get(k) !== undefined) data[k] = store.get(k);
  if (data.settings && !includeKeys) { data.settings = { ...data.settings, keys: {}, relayToken: '' }; }
  const backup = { app: 'salareader', version: 1, exported: new Date().toISOString(), includesKeys: !!includeKeys, data };
  download(`salareader-backup-${today()}.json`, JSON.stringify(backup), 'application/json');
  toast(includeKeys ? 'Backup saved, including your API keys: keep the file private' : 'Backup saved (API keys left out)', 4000);
}

async function importBackup(file) {
  let backup;
  try { backup = JSON.parse(await file.text()); } catch { throw new Error("That file isn't a Sala Reader backup."); }
  if (backup?.app !== 'salareader' || typeof backup.data !== 'object') throw new Error("That file isn't a Sala Reader backup.");
  const n = backup.data.subs?.length ?? 0;
  if (!confirm(`Replace everything on this device with the backup from ${new Date(backup.exported).toLocaleString()} (${n} subscription${n === 1 ? '' : 's'})?`)) return false;
  const keepKeys = S.settings.keys;
  const keepRelayToken = S.settings.relayToken;
  for (const k of BACKUP_KEYS) store.del(k);
  for (const k of BACKUP_KEYS) if (k in backup.data) store.set(k, backup.data[k]);
  // A backup without keys keeps the keys already on this device.
  if (!backup.includesKeys) store.set('settings', { ...store.get('settings', {}), keys: keepKeys, relayToken: keepRelayToken });
  await flush();
  return true;
}

async function eraseEverything() {
  for (const k of store.keys()) store.del(k);
  await flush();
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith('sr.')) localStorage.removeItem(k); } } catch { /* blocked */ }
}

async function importOPML(file) {
  const doc = new DOMParser().parseFromString(await file.text(), 'text/xml');
  const found = [];
  for (const o of doc.querySelectorAll('outline[xmlUrl]')) {
    const parent = o.parentElement?.closest('outline:not([xmlUrl])');
    found.push({ url: o.getAttribute('xmlUrl'), title: o.getAttribute('title') || o.getAttribute('text') || host(o.getAttribute('xmlUrl')), folder: parent?.getAttribute('title') || parent?.getAttribute('text') || '' });
  }
  const have = new Set(S.feeds.map((f) => f.url));
  const fresh = found.filter((f) => !have.has(f.url));
  const catalog = catalogByUrl();
  S.subs ??= [];
  for (const f of fresh) {
    const c = catalog.get(f.url);
    S.subs.push(c ? { id: c.id, url: c.url, title: c.title, folder: f.folder } : { id: 'L' + hash(f.url), url: f.url, title: f.title, titleSet: true, folder: f.folder, own: true, site: '' });
  }
  saveSubs();
  toast(`Imported ${fresh.length} feed${fresh.length === 1 ? '' : 's'}${found.length > fresh.length ? ` (${found.length - fresh.length} you already had)` : ''}. Fetching…`, 4000);
  rebuild(); render();
  await refreshOwnFeeds();
  rebuild(); render();
  const blocked = S.feeds.filter((f) => f.own && f.error).length;
  if (blocked && !relayUrl()) toast(`${blocked} feed${blocked === 1 ? '' : 's'} need a relay to be read. See ⚙ Settings → Your feeds.`, 6000);
}

// ---------- sidebar on phones ----------

function openSidebar() { document.body.classList.add('nav-open'); $('#scrim').hidden = false; }
function closeSidebar() { document.body.classList.remove('nav-open'); $('#scrim').hidden = true; }

// ---------- events ----------

function wire() {
  addEventListener('hashchange', route);

  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#q').value.trim();
    if (q) go(`#/search/${encodeURIComponent(q)}`);
    $('#q').blur();
  });
  $('#menuBtn').addEventListener('click', () => (document.body.classList.contains('nav-open') ? closeSidebar() : openSidebar()));
  $('#scrim').addEventListener('click', closeSidebar);
  $('#surpriseBtn').addEventListener('click', surprise);
  $('#refreshBtn').addEventListener('click', refresh);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());

  $('#sidebar').addEventListener('click', (e) => {
    const tw = e.target.closest('.twisty');
    if (tw) {
      const name = tw.dataset.folder;
      S.collapsed[name] = !S.collapsed[name];
      if (!S.collapsed[name]) delete S.collapsed[name];
      store.set('collapsed', S.collapsed);
      renderSidebar();
      return;
    }
    if (e.target.closest('#addBtn')) openAdd();
    if (e.target.closest('#addTopicBtn, #addTopicBtn2')) openTopic();
  });

  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-open]');
    if (opener) { e.preventDefault(); openItemAnywhere(opener.dataset.open); return; }
    const btn = e.target.closest('[data-act]');
    const article = e.target.closest('article.entry');
    if (btn) {
      const act = btn.dataset.act;
      if (article && act === 'star') { e.stopPropagation(); toggleStar(article.dataset.id); return; }
      if (article && act === 'unread') { S.view.keep?.add(article.dataset.id); markRead(article.dataset.id, !isRead(article.dataset.id)); return; }
      if (article && act === 'summarize') { summarize(article); return; }
      if (article && act === 'related') { related(article); return; }
      if (article && act === 'share') { share(article); return; }
      switch (act) {
        case 'unread': S.settings.unreadOnly = true; saveSettings(); render(); return;
        case 'allitems': S.settings.unreadOnly = false; saveSettings(); render(); return;
        case 'list': setMode('list'); return;
        case 'expanded': setMode('expanded'); return;
        case 'markall': markAllRead(sourceItems()); return;
        case 'brief': brief(); return;
        case 'surprise': surprise(); closeSidebar(); return;
        case 'refresh': refresh(); return;
        case 'switchai': openSettings(); return;
        case 'backup': openSettings(); $('#exportBackup').scrollIntoView({ block: 'center' }); $('#exportBackup').focus(); return;
        case 'dismissnote': store.set('deviceNoteDismissed', true); render(); return;
        case 'newtopic': openTopic(); return;
        case 'more': renderList(false); return;
        case 'savetopic': openTopic(S.view.q); return;
        case 'deltopic':
          if (confirm('Delete this topic?')) { S.topics = S.topics.filter((t) => t.id !== S.view.id); store.set('topics', S.topics); go('#/home'); }
          return;
        case 'unsub': {
          const f = S.feedById.get(S.view.id);
          if (f && confirm(`Unsubscribe from ${f.title}?`)) { unsubscribe(f.id); go('#/home'); }
          return;
        }
      }
    }
    if (article && e.target.closest('.row') && !e.target.closest('a')) {
      if (S.settings.mode === 'expanded') select(+article.dataset.idx, { open: true, scroll: false });
      else toggleEntry(article);
    }
  });

  // Add-feed dialog
  $('#discoverList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sub]');
    if (!b) return;
    const c = S.index.feeds.find((x) => x.id === b.dataset.sub);
    if (c) { subscribeCatalog(c); renderDiscover(); renderSidebar(); toast(`Subscribed to ${c.title}`); }
  });
  $('#addForm').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const btn = $('#addSubmit');
    btn.disabled = true;
    try {
      const feed = await addFeed($('#addUrl').value, $('#addFolder').value);
      $('#addDialog').close();
      toast(`Subscribed to ${feed.title}`);
      go(`#/feed/${feed.id}`);
    } catch (err) {
      $('#addStatus').textContent = err.message || "Couldn't add that feed.";
    } finally { btn.disabled = false; }
  });

  // Topic dialog
  $('#topicForm').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      const t = await createTopic($('#topicQuery').value.trim());
      $('#topicDialog').close();
      go(`#/topic/${t.id}`);
    } catch (err) {
      console.warn(err);
      $('#topicStatus').textContent = "Couldn't load the AI model. Check your connection and try again.";
    }
  });
  $('#topicIdeas').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) $('#topicQuery').value = c.textContent; });

  // Settings
  $('#themeSel').addEventListener('change', (e) => { S.settings.theme = e.target.value; saveSettings(); applyTheme(); });
  $('#providerSel').addEventListener('change', (e) => { S.settings.aiProvider = e.target.value; saveSettings(); renderAISettings(); });
  $('#keyInput').addEventListener('change', (e) => {
    const { p } = ai();
    const v = e.target.value.trim();
    if (v) S.settings.keys[p.id] = v; else delete S.settings.keys[p.id];
    saveSettings();
    renderAISettings();
  });
  $('#modelSel').addEventListener('change', (e) => { S.settings.models[ai().p.id] = e.target.value; saveSettings(); });
  $('#listModelsBtn').addEventListener('click', async () => {
    const { p, key } = ai();
    if (!key) { $('#modelStatus').textContent = `Add your ${p.name} key first.`; return; }
    $('#modelStatus').textContent = 'Asking for the list…';
    try {
      const models = await listModels(p.id, key);
      S.modelLists = { ...S.modelLists, [p.id]: models };
      renderAISettings();
      $('#modelStatus').textContent = `${models.length} models`;
    } catch (err) { $('#modelStatus').textContent = err.message; }
  });
  $('#orSignInBtn').addEventListener('click', () => startOpenRouterSignIn());
  $('#thresholdRange').addEventListener('input', (e) => { S.settings.threshold = +e.target.value; $('#thresholdVal').textContent = `(${Math.round(S.settings.threshold * 100)}%)`; saveSettings(); });
  $('#settingsDialog').addEventListener('close', () => render());
  $('#opmlFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) { $('#settingsDialog').close(); importOPML(f); } e.target.value = ''; });
  $('#exportOpml').addEventListener('click', exportOPML);
  $('#relayModes').addEventListener('change', (e) => {
    if (e.target.name !== 'relayMode') return;
    S.settings.relayMode = e.target.value;
    saveSettings();
    $('#ownRelay').hidden = S.settings.relayMode !== 'own';
    $('#relayStatus').textContent = '';
  });
  $('#relayInput').addEventListener('change', (e) => { S.settings.relay = e.target.value.trim(); saveSettings(); });
  $('#relayToken').addEventListener('change', (e) => { S.settings.relayToken = e.target.value.trim(); saveSettings(); });
  $('#testRelay').addEventListener('click', async () => {
    const st = $('#relayStatus');
    if (!relayUrl()) { st.textContent = S.settings.relayMode === 'off' ? 'The relay is turned off.' : 'Enter your relay address first.'; return; }
    st.textContent = 'Testing…';
    try {
      const xml = await fetchFeedText('https://xkcd.com/atom.xml', { relayOnly: true });
      st.textContent = parseFeedXML(xml, 'https://xkcd.com/atom.xml', 'x') ? `✓ ${S.settings.relayMode === 'own' ? 'Your' : 'The shared'} relay works.` : 'The relay answered, but not with a feed.';
    } catch (err) { st.textContent = err.message; }
  });
  $('#exportBackup').addEventListener('click', () => exportBackup($('#includeKeys').checked));
  $('#backupFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { if (await importBackup(f)) location.reload(); } catch (err) { toast(err.message, 5000); }
  });
  $('#eraseAll').addEventListener('click', async () => {
    if (!confirm('Erase all Sala Reader data on this device: subscriptions, read and starred articles, topics, settings and keys? Export a backup first if you want to keep it.')) return;
    await eraseEverything();
    location.reload();
  });
  $('#resetRead').addEventListener('click', () => { if (confirm('Mark every article as unread?')) { S.read = {}; store.set('read', S.read); render(); } });

  // Keyboard
  let gPending = false;
  document.addEventListener('keydown', (e) => {
    // Alt+1–6 switches the AI assistant, like ⌥⌘1–6 in jamalterm.
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-6]$/.test(e.code)) {
      e.preventDefault();
      switchProvider(PROVIDERS[+e.code.slice(5) - 1].id);
      if ($('#settingsDialog').open) renderAISettings();
      return;
    }
    if (e.target.closest('input, textarea, select, dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) {
      if (e.key === 'Escape' && e.target === $('#q')) $('#q').blur();
      return;
    }
    const k = e.key;
    if (gPending) {
      gPending = false;
      if (k === 'h') go('#/home'); else if (k === 'a') go('#/all'); else if (k === 's') go('#/starred');
      return;
    }
    const all = entries();
    const curEl = all[S.cur];
    switch (k) {
      case 'j': select(S.cur + 1); break;
      case 'k': select(Math.max(0, S.cur - 1)); break;
      case 'n': select(S.cur + 1, { open: S.settings.mode === 'expanded' }); break;
      case 'p': select(Math.max(0, S.cur - 1), { open: S.settings.mode === 'expanded' }); break;
      case 'o': case 'Enter': if (curEl) toggleEntry(curEl); else select(0); break;
      case 's': if (curEl) toggleStar(curEl.dataset.id); break;
      case 'm': if (curEl) { S.view.keep?.add(curEl.dataset.id); markRead(curEl.dataset.id, !isRead(curEl.dataset.id)); } break;
      case 'v': if (curEl) { const it = S.byId.get(curEl.dataset.id) || S.starred[curEl.dataset.id]; window.open(it.l, '_blank', 'noopener'); } break;
      case 'A': if (e.shiftKey && S.view.type !== 'home') markAllRead(sourceItems()); break;
      case '/': e.preventDefault(); $('#q').focus(); $('#q').select(); break;
      case 'x': surprise(); break;
      case 'r': refresh(); break;
      case 'u': document.body.classList.toggle(innerWidth < 860 ? 'nav-open' : 'nav-hidden'); break;
      case '1': setMode('list'); break;
      case '2': setMode('expanded'); break;
      case 'g': gPending = true; setTimeout(() => { gPending = false; }, 1200); break;
      case '?': $('#helpDialog').showModal(); break;
      default: return;
    }
    e.preventDefault();
  });
}

function setMode(mode) {
  S.settings.mode = mode;
  saveSettings();
  if (S.view.type !== 'home') render();
}

function openAdd() {
  $('#addUrl').value = '';
  $('#addFolder').value = S.view.type === 'folder' ? S.view.id : '';
  $('#addStatus').textContent = '';
  $('#folderList').innerHTML = [...new Set(S.feeds.map((f) => f.folder).filter(Boolean))].map((f) => `<option value="${esc(f)}">`).join('');
  renderDiscover();
  $('#addDialog').showModal();
  closeSidebar();
}

function renderDiscover() {
  const have = new Set(S.feeds.map((f) => f.url));
  const avail = S.index.feeds.filter((c) => !have.has(c.url));
  $('#discover').hidden = !avail.length;
  $('#discoverList').innerHTML = avail.map((c) => `<li>${avatar(c)}<span class="name">${esc(c.title)}<span class="muted"> · ${esc(c.folder || host(c.site || c.url))}</span></span><button type="button" class="ghost" data-sub="${esc(c.id)}">＋ Add</button></li>`).join('');
}

function openTopic(prefill = '') {
  $('#topicQuery').value = prefill;
  $('#topicStatus').textContent = '';
  const ideas = ['AI agents', 'space exploration', 'electric cars', 'open source', 'climate tech', 'video games', 'privacy and security', 'startups and funding'];
  $('#topicIdeas').innerHTML = ideas.filter((i) => !S.topics.some((t) => t.query === i)).slice(0, 6).map((i) => `<button type="button" class="chip">${i}</button>`).join('');
  $('#topicDialog').showModal();
  closeSidebar();
}

async function refresh() {
  const btn = $('#refreshBtn');
  btn.classList.add('spin');
  const before = S.index.updated;
  await Promise.all([loadIndex(true), refreshOwnFeeds()]);
  S.vectorsState = 'none';
  rebuild();
  if (S.topics.length) loadVectors().then(() => { renderSidebar(); if (S.view.type === 'topic' || S.view.type === 'home') render(); });
  render();
  btn.classList.remove('spin');
  toast(S.index.updated !== before ? 'Fresh articles loaded' : `Up to date (feeds updated ${agoText(S.index.updated)})`);
}

// ---------- start ----------

async function start() {
  await loadStore();
  loadState();
  applyTheme();
  wire();
  finishOpenRouterSignIn().then((key) => {
    if (!key) return;
    S.settings.keys.openrouter = key;
    S.settings.aiProvider = 'openrouter';
    saveSettings();
    toast('✨ Signed in to OpenRouter', 4000);
  }).catch((e) => toast(e.message, 6000));
  await loadIndex(false);
  renderStreak();
  route();
  if (S.topics.length) loadVectors().then(() => { renderSidebar(); if (S.view.type === 'topic' || S.view.type === 'home') render(); });
  const quietOwnRefresh = () => refreshOwnFeeds().then(() => { rebuild(); renderSidebar(); renderHeaderCounts(); });
  if (S.feeds.some((f) => f.own)) quietOwnRefresh();
  setInterval(() => { if (document.visibilityState === 'visible' && S.feeds.some((f) => f.own)) quietOwnRefresh(); }, 30 * 60 * 1000);
}

start();
