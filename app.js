// Sala Reader: a Google Reader-style RSS reader with AI search.
//
// Privacy: everything about the reader (subscriptions, folders, read and
// starred articles, topics, settings, keys) is stored only on this device,
// in IndexedDB. The site serves one shared catalog of feeds (data/), the
// same files for everyone, so it can't tell what anyone follows or reads.
// Feeds you add yourself are fetched by this page, straight from the feed's
// site or through your own relay (relay/worker.js). Backup → export/import
// moves everything to another device.

import { classify, smartInfo, wordCount, mediaKind, LANGS, TOPICS, META } from './smart.js';
import { decodeVector, encodeVector, dot, embed as embedWith, embedText, EMBED_MODELS, askAI, askGrokLive, PROVIDERS, provider, listModels, startOpenRouterSignIn, finishOpenRouterSignIn } from './ai.js';

const PAGE = 60;
const OWN_ITEMS_PER_FEED = 80;   // at most, per feed of your own
const OWN_KEEP_DAYS = 30;         // older articles are dropped…
const OWN_KEEP_MIN = 20;          // …except a feed's newest 20 (quiet blogs still show something)

// ---------- storage: IndexedDB on this device ----------
// A synchronous in-memory copy for the app, written back to IndexedDB
// shortly after each change (localStorage if IndexedDB isn't available).

const DB_NAME = 'salareader';
const KV = 'kv';
const BODIES = 'bodies';
const cache = new Map();
const dirty = new Set();
let dbPromise = null;
let useLocalStorage = false;
let flushTimer;

function openDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    // v2 adds "bodies": article text, one record per feed, read only when you open an
    // article (keeping it out of memory lets the reader start fast with 1,000+ feeds).
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(BODIES)) db.createObjectStore(BODIES);
    };
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

// Other open tabs of the reader hear about every save and reload those keys.
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('salareader') : null;
let frozen = false;      // set while erasing or importing, so nothing writes old data back
let warnedSaveFail = false;

async function flush() {
  if (typeof lazySaves !== 'undefined' && lazySaves.size) runLazySaves();
  clearTimeout(flushTimer);
  if (!dirty.size) return;
  const keys = [...dirty];
  dirty.clear();
  if (useLocalStorage) {
    for (const k of keys) {
      try { if (cache.has(k)) localStorage.setItem('sr.' + k, JSON.stringify(cache.get(k))); else localStorage.removeItem('sr.' + k); } catch { saveFailed(); }
    }
    channel?.postMessage({ keys });
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
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
    channel?.postMessage({ keys });
  } catch (e) {
    console.warn('Saving failed', e);
    keys.forEach((k) => { if (!dirty.has(k)) dirty.add(k); });
    saveFailed();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 30_000); // try again later
  }
}
function saveFailed() {
  if (warnedSaveFail) return;
  warnedSaveFail = true;
  toast("⚠ Couldn't save on this device. Storage may be full. Unsubscribing from some feeds or clearing space helps.", 8000);
}
function scheduleFlush() { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 300); }

/** Another tab saved these keys: reload them, unless this tab has unsaved changes to them. */
async function reloadKeys(keys) {
  if (frozen || useLocalStorage) return;
  const db = await openDB();
  await new Promise((resolve) => {
    const tx = db.transaction(KV, 'readonly');
    const os = tx.objectStore(KV);
    for (const k of keys) {
      if (dirty.has(k)) continue;
      const req = os.get(k);
      req.onsuccess = () => { if (req.result === undefined) cache.delete(k); else cache.set(k, req.result); };
    }
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

// ---------- article text (separate from the rest, loaded on demand) ----------

const bodyCache = new Map(); // feedId -> {itemId: html}, for feeds opened this session

async function bodiesTx(mode, fn) {
  if (useLocalStorage) return undefined;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BODIES, mode);
    const result = fn(tx.objectStore(BODIES));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
async function readBodies(feedId) {
  if (bodyCache.has(feedId)) return bodyCache.get(feedId);
  const map = (await bodiesTx('readonly', (os) => os.get(feedId)).catch(() => undefined)) || {};
  bodyCache.set(feedId, map);
  return map;
}
async function writeBodies(feedId, map) {
  if (frozen) return;
  bodyCache.set(feedId, map);
  await bodiesTx('readwrite', (os) => os.put(map, feedId)).catch((e) => { console.warn('Saving article text failed', e); saveFailed(); });
}
async function deleteBodies(feedId) {
  bodyCache.delete(feedId);
  await bodiesTx('readwrite', (os) => os.delete(feedId)).catch(() => {});
}
async function clearBodies() {
  bodyCache.clear();
  await bodiesTx('readwrite', (os) => os.clear()).catch(() => {});
}

/** Earlier versions kept article text inside each feed's list: move it to the text store. */
async function moveBodiesOut() {
  for (const [fid, items] of Object.entries(S.ownItems)) {
    if (!items.some((i) => i.c != null)) continue;
    const map = { ...(await readBodies(fid)) };
    for (const it of items) if (it.c) map[it.id] = it.c;
    await writeBodies(fid, map);
    S.ownItems[fid] = items.map(({ c, ...rest }) => rest);
    store.set('own:' + fid, S.ownItems[fid]);
  }
}

/** Keeps a feed's recent articles: the last 30 days, at least the newest 20, at most 80. */
function keepRecent(items) {
  const cutoff = Date.now() - OWN_KEEP_DAYS * 864e5;
  return items.filter((it, k) => k < OWN_KEEP_MIN || it.d > cutoff).slice(0, OWN_ITEMS_PER_FEED);
}

const store = {
  // structuredClone keeps the stored copy separate from objects the app keeps changing.
  get(key, fallback) { return cache.has(key) ? structuredClone(cache.get(key)) : fallback; },
  set(key, value) { if (frozen) return; cache.set(key, structuredClone(value)); dirty.add(key); scheduleFlush(); },
  del(key) { if (frozen) return; cache.delete(key); dirty.add(key); scheduleFlush(); },
  keys() { return [...cache.keys()]; },
};

// The shared relay everyone uses unless they pick their own (relay/worker.js).
const SHARED_RELAY = 'https://salareader-relay.jamal-akuna-matata.workers.dev';
const DEFAULT_SETTINGS = { theme: 'auto', unreadOnly: true, mode: 'list', sort: 'newest', viewPrefs: {}, threshold: 0.4, aiModel: 'en', aiProvider: 'anthropic', keys: {}, models: {}, relayMode: 'shared', relay: '', relayToken: '', read: {} };

const S = {
  index: { feeds: [], items: [], updated: 0 },
  feeds: [],            // your subscriptions (catalog + your own)
  feedById: new Map(),
  items: [],            // their items, newest first
  uniq: [],             // the same, each story once (copies in other feeds left out)
  byId: new Map(),
  content: null,        // Promise<{itemId: html}> for the catalog
  vectors: new Map(),   // itemId -> Float32Array
  vectorsState: 'none', // none | loading | ready | missing
  subs: null,           // [{id, url, title, folder, own?, site?, error?, ok?}] (null until first run)
  ownItems: {},         // feedId -> items[] for feeds this page fetches itself (stored as own:<feedId>)
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
  unread: 0,            // running count of unread articles in your feeds
  version: 0,           // bumped whenever items or vectors change (topic results are cached per version)
};

function loadState() {
  S.subs = store.get('subs', null);
  S.ownItems = {};
  for (const k of store.keys()) if (k.startsWith('own:')) S.ownItems[k.slice(4)] = store.get(k, []);
  // Earlier versions kept every feed's articles in one record.
  const allOwn = store.get('ownItems', null);
  if (allOwn) {
    for (const [id, items] of Object.entries(allOwn)) if (!S.ownItems[id]) { S.ownItems[id] = items; store.set('own:' + id, items); }
    store.del('ownItems');
  }
  S.read = store.get('read', {});
  S.starred = store.get('starred', {});
  S.topics = store.get('topics', []);
  S.invs = store.get('investigations', []).map((x) => ({ ...x }));
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
  // Articles saved twice by earlier versions (same article under two ids): keep one.
  for (const [fid, items] of Object.entries(S.ownItems)) {
    const clean = dedupeArticles(items);
    if (clean.length !== items.length) { S.ownItems[fid] = clean; store.set('own:' + fid, clean); }
  }
  // YouTube channels saved as web pages (Feedly) failed before they were read through
  // YouTube's feed: fetch them again now rather than after the failure back-off.
  if (S.subs && !store.get('ytRetried', false)) {
    for (const sub of S.subs) if (fetchAddress(sub.url) !== sub.url) { delete sub.ok; delete sub.lastTry; delete sub.failSince; sub.error = ''; }
    store.set('ytRetried', true);
    saveSubs();
  }
  // Feeds that were gone before the reader could find moved feeds: try once now.
  if (S.subs && !store.get('movesRetried', false)) {
    for (const sub of S.subs) if (sub.error && /404|410|Not an RSS|refuses requests|HTTP 53\d|HTTP 52\d/.test(sub.error)) { delete sub.lastTry; delete sub.ok; }
    store.set('movesRetried', true);
    saveSubs();
  }
  // News searches with OR got nothing from Bing before searches were split by term: fetch them again.
  if (S.subs && !store.get('orRetried', false)) {
    for (const sub of S.subs) if (/\s+OR\s+/.test(googleNewsQuery(sub.url) || bingNewsQuery(sub.url))) delete sub.ok;
    store.set('orRetried', true);
    saveSubs();
  }
  // Feeds already failing as gone (or for over a week) move to Retired feeds.
  if (S.subs && !store.get('retiredOnce', false)) {
    for (const sub of S.subs) {
      if (!sub.own || !sub.error || sub.retired || sub.keep) continue;
      // (Replaced by the dead-or-alive rules below.)
    }
    store.set('retiredOnce', true);
    saveSubs();
  }
  // Feeds retired by the old rule (any failure for a week) get the dead-or-alive rules:
  // only gone ones stay retired; the rest come back and are tried again.
  if (S.subs && !store.get('deadRulesReview', false)) {
    const now = Date.now();
    for (const sub of S.subs) {
      if (!sub.own || !sub.error) continue;
      const kind = failKind({ message: sub.error });
      if (kind === 'relay') { delete sub.failSince; sub.relayIssue = now; }
      else { sub.failKind ??= kind; sub.kindSince ??= sub.failSince || now; sub.kindTries ??= 2; }
      if (sub.retired && !sub.keep) {
        const why = deadVerdict(sub, now);
        if (why) sub.retiredWhy = why;
        else { delete sub.retired; delete sub.lastTry; delete sub.probedAt; }
      }
    }
    store.set('deadRulesReview', true);
    saveSubs();
  }
  // Google News searches fetched before the Bing fallback existed: fetch them again now.
  if (S.subs && !store.get('gnRetried', false)) {
    for (const sub of S.subs) if (googleNewsQuery(sub.url) && !sub.via) delete sub.ok;
    store.set('gnRetried', true);
    saveSubs();
  }
  // Earlier versions kept browser-added feeds separately. Keep them until
  // they're safely in the subscription list.
  const oldFeeds = store.get('localFeeds', null);
  if (oldFeeds) {
    const moved = oldFeeds.map((f) => ({ id: f.id, url: f.url, title: f.title, folder: f.folder || '', own: true, site: f.site || '' }));
    for (const [id, items] of Object.entries(store.get('localItems', {}))) if (!S.ownItems[id]) { S.ownItems[id] = items; store.set('own:' + id, items); }
    store.del('localItems');
    if (S.subs) {
      for (const f of moved) if (!S.subs.some((s) => s.url === f.url)) S.subs.push(f);
      saveSubs();
      store.del('localFeeds');
    } else {
      S.pendingOwn = moved; // added to the list when it's first made (loadIndex)
    }
  }
}
// For diagnosing on your own device: open the reader with ?debug to inspect its state in the console.
if (new URLSearchParams(location.search).has('debug')) window.__salareader = S;
const saveSettings = () => store.set('settings', S.settings);
// Saving copies the whole list; with many feeds that's costly, so saves of the
// subscription list are gathered and done once, shortly after (and always before
// the page closes or anything reads the stored copy).
const lazySaves = new Map();
let lazyTimer = 0;
function runLazySaves() { clearTimeout(lazyTimer); lazyTimer = 0; for (const [k, get] of lazySaves) store.set(k, get()); lazySaves.clear(); }
function saveSoon(key, get) { lazySaves.set(key, get); if (!lazyTimer) lazyTimer = setTimeout(runLazySaves, 800); }
const saveSubs = () => saveSoon('subs', () => S.subs);
const saveOwnFeed = (id) => { if (S.ownItems[id]) store.set('own:' + id, S.ownItems[id]); else store.del('own:' + id); };
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
/** Only web links: a feed's javascript: or data: "link" would otherwise run code here. */
const safeUrl = (u, base) => { if (!u) return ''; try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
const isRead = (id) => id in S.read;
const inertParser = new DOMParser();
/** Text of some HTML. Parsed into an inert document: nothing in it runs or loads. */
const strip = (html) => { if (!/[<&]/.test(html)) return String(html ?? '').replace(/\s+/g, ' ').trim(); return (inertParser.parseFromString(String(html), 'text/html').body.textContent || '').replace(/\s+/g, ' ').trim(); };

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

/** Loads the shared catalog. Returns false if it couldn't (a catalog already loaded is kept). */
async function loadIndex(bust) {
  try {
    // no-cache: always check for a newer copy (a stale one could look like feeds left the catalog).
    const res = await fetch(`data/index.json${bust ? `?t=${Date.now()}` : ''}`, { cache: bust ? 'no-store' : 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    S.index = await res.json();
  } catch {
    if (!S.index.missing && S.index.feeds.length) return false; // keep what you have
    S.index = { feeds: [], items: [], updated: 0, missing: true };
    rebuild();
    return false;
  }
  S.content = null;
  // First visit: start with every catalog feed (you can unsubscribe any).
  if (!S.subs && S.index.feeds.length) {
    S.subs = S.index.feeds.map((f) => ({ id: f.id, url: f.url, title: f.title, folder: f.folder || '' }));
    if (S.pendingOwn) S.subs.push(...S.pendingOwn.filter((o) => !S.subs.some((s) => s.url === o.url)));
    saveSubs();
    if (S.pendingOwn) { store.del('localFeeds'); S.pendingOwn = null; }
  }
  if (!S.index.missing && S.subs) {
    // A feed taken out of the catalog (or moved to another address there) keeps
    // working for you: this page fetches it from now on.
    const inCatalog = catalogByUrl();
    let moved = 0;
    for (const sub of S.subs) {
      if (sub.own || inCatalog.has(sub.url)) continue;
      const oldId = sub.id;
      Object.assign(sub, { own: true, id: 'L' + hash(sub.url), convertedAt: S.index.updated || Date.now() });
      for (const st of Object.values(S.starred)) if (st.f === oldId) st.f = sub.id;
      moved++;
    }
    if (moved) { saveSubs(); store.set('starred', S.starred); }
    // Articles stored for feeds that aren't your own any more (unsubscribed, or now in the catalog).
    const catalog = catalogByUrl();
    const ownIds = new Set(S.subs.filter((x) => x.own && !catalog.has(x.url)).map((x) => x.id));
    for (const id of Object.keys(S.ownItems)) if (!ownIds.has(id)) { delete S.ownItems[id]; store.del('own:' + id); store.del('vec:' + id); }
  }
  rebuild();
  return true;
}

const catalogByUrl = () => new Map(S.index.feeds.map((f) => [f.url, f]));

/** The folders a feed is in (like Google Reader and Feedly, a feed can be in several). */
const RETIRED = '__retired';
/** Folders are open unless closed; Retired feeds starts closed. */
const folderClosed = (name) => (name === RETIRED ? S.collapsed[name] !== false : !!S.collapsed[name]);
function feedFolders(f) {
  if (f.retired) return [RETIRED];
  const list = [...new Set([f.folder || '', ...(f.folders || [])])];
  return list.length > 1 ? list.filter(Boolean) : list;
}
/** Adds folders to a subscription; true if anything changed. */
function addFolders(sub, names) {
  const have = new Set(feedFolders(sub));
  const add = names.filter((n) => n && !have.has(n));
  if (!add.length) return false;
  if (!sub.folder) sub.folder = add.shift();
  if (add.length) sub.folders = [...new Set([...(sub.folders || []), ...add])];
  return true;
}

/** One subscription per feed address (a feed added twice showed every article twice); its folders are kept. */
function dedupeSubs() {
  if (!S.subs) return false;
  const byUrl = new Map();
  const before = S.subs.length;
  S.subs = S.subs.filter((s) => {
    const kept = byUrl.get(s.url);
    if (!kept) { byUrl.set(s.url, s); return true; }
    addFolders(kept, feedFolders(s));
    return false;
  });
  return S.subs.length !== before;
}

function rebuild() {
  const catalog = catalogByUrl();
  if (dedupeSubs()) saveSubs();
  S.feeds = (S.subs || S.pendingOwn || []).map((s) => {
    const c = catalog.get(s.url);
    // Catalog feeds come from the shared data; the rest is fetched by this page.
    if (c) return { ...c, title: s.title || c.title, folder: s.folder ?? c.folder, folders: s.folders };
    // Your own feed, fetched by this page. A catalog feed whose data didn't load
    // stays a catalog feed (no articles until it does), never an "own" one.
    return s.own ? s : { ...s, catalogMissing: true };
  });
  S.feedById = new Map(S.feeds.map((f) => [f.id, f]));
  const catIds = new Set(S.feeds.filter((f) => !f.own).map((f) => f.id));
  const own = S.feeds.filter((f) => f.own).flatMap((f) => S.ownItems[f.id] || []);
  // Each article once, even if something above ever lists it twice.
  const seenIds = new Set();
  S.items = [...S.index.items.filter((i) => catIds.has(i.f)), ...own]
    .filter((i) => { if (seenIds.has(i.id)) return false; seenIds.add(i.id); return true; })
    .sort((a, b) => b.d - a.d);
  S.byId = new Map(S.items.map((i) => [i.id, i]));
  findTwins();
  // Forget read marks for items that are long gone.
  const cutoff = Date.now() - 90 * 864e5;
  let changed = false;
  for (const [id, t] of Object.entries(S.read)) if (t < cutoff && !S.byId.has(id)) { delete S.read[id]; changed = true; }
  if (changed) store.set('read', S.read);
  S.unread = unreadOf(S.uniq);
  buildSmart();
  S.version++;
}

// ---------- the same story in several feeds ----------
// Sites often publish one article in several of their feeds (Paris-Match's
// main, People and News feeds). Each feed still lists its copy, but views that
// mix feeds (All items, folders, smart folders, topics, search, Home) show it
// once, and reading one copy reads them all.

/** Groups copies by link and title; S.uniq is every article once (the newest copy). */
function findTwins() {
  const groups = new Map();
  for (const it of S.items) {
    const lk = linkKey(it);
    if (!lk) continue;
    const k = `${lk}|${(it.t || '').trim().toLowerCase()}`;
    const g = groups.get(k);
    if (g) g.push(it.id); else groups.set(k, [it.id]);
  }
  S.twinsOf = new Map();
  S.dupHidden = new Set();
  let changed = false;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (const id of g) S.twinsOf.set(id, g);
    for (const id of g.slice(1)) S.dupHidden.add(id);
    // Read in one feed = read in all.
    const readAt = g.map((id) => S.read[id]).find(Boolean);
    if (readAt) for (const id of g) if (!(id in S.read)) { S.read[id] = readAt; changed = true; }
  }
  if (changed) store.set('read', S.read);
  S.uniq = S.dupHidden.size ? S.items.filter((i) => !S.dupHidden.has(i.id)) : S.items;
}
const twinsOf = (id) => S.twinsOf?.get(id) || [id];

// ---------- smart folders ----------

/**
 * Every article sorted into smart folders (language, topic, kind); the views
 * show only unread ones. Done in small chunks so a big reader never freezes,
 * and remembered per article, so later passes are quick.
 */
let smartRun = 0;
function buildSmart() {
  const run = ++smartRun;
  const items = S.uniq;
  (async () => {
    const smart = new Map();
    const metaOf = new Map();
    for (let i = 0; i < items.length; i++) {
      if (i && i % 1500 === 0) { await new Promise((r) => setTimeout(r, 0)); if (run !== smartRun) return; }
      const it = items[i];
      let fm = metaOf.get(it.f);
      if (!fm) { const f = S.feedById.get(it.f); fm = { lang: f?.lang || '', folders: f ? feedFolders(f) : [] }; metaOf.set(it.f, fm); }
      for (const id of classify(it, fm)) {
        let list = smart.get(id);
        if (!list) smart.set(id, (list = []));
        list.push(it);
      }
    }
    if (run !== smartRun) return;
    const first = !S.smart;
    S.smart = smart;
    // Draw a smart folder's list only the first time (it was empty until now);
    // later passes just update counts, so an article you opened stays open.
    if (first) { renderSidebar(); if (S.view.type === 'smart') render(); } else scheduleCounts();
  })();
}

async function feedContent(feedId) {
  const feed = S.feedById.get(feedId);
  if (feed?.own) return readBodies(feedId);
  // One file with every catalog article, so the server can't tell which feeds you read.
  S.content ??= fetch(`data/content.json?u=${S.index.updated}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return S.content;
}

// ---------- AI model choice: English (small) or multilingual ----------

const modelKey = () => (S.settings.aiModel === 'multi' ? 'multi' : 'en');
/** Embeds with the model chosen in Settings. */
const embed = (texts, onProgress, onEmbedded) => embedWith(texts, onProgress, modelKey(), onEmbedded);
/** A topic's vector for the chosen model (en: qv, multi: qvm), or null until worked out. */
const topicVec = (t) => { const a = modelKey() === 'multi' ? t.qvm : t.qv; return a ? Float32Array.from(a) : null; };
/** Per-feed vector records: English ones are plain {id: b64}; others are tagged {_m, v}. */
const vecRecord = (rec) => (rec && rec._m ? (rec._m === modelKey() ? rec.v : {}) : (modelKey() === 'en' ? rec || {} : {}));

/** Works out topic vectors missing for the chosen model (after switching models). */
let topicQvRunning = false;
async function topicVectorsForModel() {
  const field = modelKey() === 'multi' ? 'qvm' : 'qv';
  const todo = S.topics.filter((t) => !t[field]);
  if (!todo.length || topicQvRunning) return;
  topicQvRunning = true;
  try {
    const vecs = await embed(todo.map((t) => t.query));
    todo.forEach((t, k) => { t[field] = Array.from(vecs[k], (x) => +x.toFixed(4)); });
    store.set('topics', S.topics);
    S.version++;
    renderSidebar();
    if (S.view.type === 'home') refreshHome(); else if (S.view.type === 'topic') render();
  } catch (e) { console.warn('Topic vectors', e); } finally { topicQvRunning = false; }
}

async function setAIModel(key) {
  if (key === modelKey()) return;
  S.settings.aiModel = key;
  saveSettings();
  S.vectors.clear();
  S.vectorsState = 'none';
  S.version++;
  if (S.topics.length) { topicVectorsForModel().then(vectorsForTopics); loadVectors(); }
}

async function loadVectors() {
  if (S.vectorsState === 'ready' || S.vectorsState === 'loading') return S.vectorsPromise;
  S.vectorsState = 'loading';
  S.vectorsPromise = (async () => {
    try {
      // Vectors for your own feeds' articles, worked out earlier on this device.
      for (const k of store.keys()) {
        if (!k.startsWith('vec:')) continue;
        for (const [id, b64] of Object.entries(vecRecord(store.get(k, {})))) S.vectors.set(id, decodeVector(b64));
      }
      const res = await fetch(`${EMBED_MODELS[modelKey()].vectors}?u=${S.index.updated}`);
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      for (const [id, b64] of Object.entries(data.v || {})) S.vectors.set(id, decodeVector(b64));
      S.vectorsState = S.vectors.size ? 'ready' : 'missing';
    } catch {
      S.vectorsState = S.vectors.size ? 'ready' : 'missing';
    }
    S.version++;
  })();
  return S.vectorsPromise;
}

/**
 * With AI topics, your own feeds' articles need vectors too, or topics only
 * catch them by exact words. Worked out in the background (the model is
 * already on the device from making the topic) and kept, so it's done once.
 */
let topicVectorsRunning = false;
async function vectorsForTopics() {
  // Also once you've used AI search: then new articles are ready before you search.
  if ((!S.topics.length && !S.settings.aiUsed) || topicVectorsRunning) return;
  await loadVectors();
  const missing = S.items.filter((i) => S.feedById.get(i.f)?.own && !S.vectors.has(i.id));
  if (!missing.length) return;
  topicVectorsRunning = true;
  try {
    // In steps (newest first), each kept on the device as it's done.
    for (let k = 0; k < missing.length; k += 1500) {
      await ensureVectors(missing.slice(k, k + 1500));
      if (S.topics.length) {
        renderSidebar();
        if (S.view.type === 'home') refreshHome();
      else if (S.view.type === 'health') { renderHeader(); if (final) renderHealth(); }
        else if (S.view.type === 'topic') { renderHeaderCounts(); offerNew(); }
      }
    }
  } catch (e) { console.warn('Topic vectors', e); } finally { topicVectorsRunning = false; }
}

/** Makes sure every item has a vector, embedding in the browser where needed. */
const vecInFlight = new Map(); // article id -> promise, so two callers never work out the same article
async function ensureVectors(items, onProgress, onEmbedded) {
  await loadVectors();
  const others = new Set();
  const todo = items.filter((i) => {
    if (S.vectors.has(i.id)) return false;
    if (vecInFlight.has(i.id)) { others.add(vecInFlight.get(i.id)); return false; }
    return true;
  });
  if (!todo.length) { await Promise.allSettled(others); return; }
  const key = modelKey();
  const job = embed(todo.map(embedText), onProgress, onEmbedded);
  for (const it of todo) vecInFlight.set(it.id, job);
  let vecs;
  try { vecs = await job; } finally { for (const it of todo) vecInFlight.delete(it.id); }
  await Promise.allSettled(others);
  if (key !== modelKey()) return; // the model was switched meanwhile
  todo.forEach((it, k) => S.vectors.set(it.id, vecs[k]));
  S.version++;
  // Keep your own feeds' vectors on the device, one record per feed, so they're worked out only once.
  for (const fid of new Set(todo.filter((i) => S.feedById.get(i.f)?.own).map((i) => i.f))) {
    const rec = {};
    for (const it of S.ownItems[fid] || []) { const v = S.vectors.get(it.id); if (v) rec[it.id] = encodeVector(v); }
    store.set('vec:' + fid, modelKey() === 'en' ? rec : { _m: modelKey(), v: rec });
  }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The relay allows 60 requests a minute per person, so requests to it are
// paced to just under that, one after another.
const RELAY_GAP_MS = 1100;
let relayQueue = Promise.resolve();
let relayNextAt = 0;
function relayTurn() {
  const turn = relayQueue.then(async () => {
    const wait = relayNextAt - Date.now();
    if (wait > 0) await sleep(wait);
    relayNextAt = Date.now() + RELAY_GAP_MS;
  });
  relayQueue = turn.catch(() => {});
  return turn;
}

async function fetchFeedText(url, { relayOnly = false, feed = null } = {}) {
  // Fetched in the background by the installed app since the last update: use that copy.
  if (feed && !relayOnly) { const pre = await takePrefetched(url, feed); if (pre) return pre; }
  // Try the site directly, unless we already know it blocks web pages.
  if (!relayOnly && feed?.direct !== false) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      if (res.ok) { if (feed) feed.direct = true; return decodeFeed(await res.arrayBuffer(), res.headers.get('content-type') || ''); }
    } catch { /* the site doesn't let web pages read it: use the relay */ }
    if (feed) feed.direct = false;
  }
  const relay = relayUrl();
  const own = S.settings.relayMode === 'own';
  if (!relay) {
    throw new NeedsRelay(S.settings.relayMode === 'own'
      ? "This site doesn't let web pages read its feed. Enter your relay's address in ⚙ Settings → Your feeds."
      : "This site doesn't let web pages read its feed, and the relay is turned off in ⚙ Settings → Your feeds.");
  }
  const name = own ? 'your relay' : 'the shared relay';
  let res;
  for (let attempt = 0; ; attempt++) {
    await relayTurn();
    res = await fetch(`${relay}/?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(20000),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: own && S.settings.relayToken ? { 'X-Relay-Token': S.settings.relayToken } : {},
    }).catch(() => { throw new Error(`Couldn't reach ${name}.${own ? ' Check its address in ⚙ Settings.' : ' Try again in a moment.'}`); });
    if (res.status !== 429 || attempt >= 2) break;
    // Over the limit: everyone waits a minute, then carries on.
    relayNextAt = Math.max(relayNextAt, Date.now() + 61_000);
  }
  if (res.status === 401) throw new Error('Your relay rejected the token. Check it in ⚙ Settings.');
  if (res.status === 403) throw new Error(own ? "Your relay doesn't allow this site. Check ALLOWED_ORIGIN in the Worker." : 'The shared relay refused this request.');
  if (res.status === 429) throw new Error(`${own ? 'Your' : 'The shared'} relay is busy. Try again in a minute.`);
  if (res.status === 415) throw new Error("That address isn't a feed, or a page that links to one.");
  if (res.status === 413) throw new Error('That feed is too big.');
  if (res.status === 404) throw Object.assign(new Error('Nothing was found at that address (404). The feed may have moved or closed.'), { gone: true });
  if (!res.ok) {
    // The relay says what the feed's site answered.
    const site = Number(/site answered HTTP (\d+)/.exec(await res.text().catch(() => ''))?.[1]);
    if (/(^|\.)google\.com$/.test(host(url)) && [403, 429, 503].includes(site)) throw new Error('Google blocks requests from relays, so this Google feed can\'t be read here.');
    if (site === 404 || site === 410) throw Object.assign(new Error(`The feed is gone (HTTP ${site}). The site may have moved or closed it.`), { gone: true });
    if (site === 401 || site === 403) throw new Error(`The site refuses automated readers (HTTP ${site}).`);
    if (site === 429) throw new Error('The site is limiting requests (HTTP 429). It will be tried again later.');
    // 52x are Cloudflare's codes for a site that refuses or can't be reached from cloud servers.
    if ([520, 521, 522, 523, 525, 526, 530].includes(site)) throw new Error(`The site refuses requests from cloud servers, so the relay can't read it (HTTP ${site}). It may be blocked for good; it will be tried again daily.`);
    if (site >= 500) throw new Error(`The site is having problems (HTTP ${site}). It will be tried again later.`);
    if (site) throw new Error(`The site answered HTTP ${site}.`);
    throw new Error(`The feed couldn't be fetched (HTTP ${res.status}).`);
  }
  return res.text();
}

// ---------- full article (for feeds that only send a summary) ----------

const fullArticles = new Map(); // article id -> HTML (this session only)

/** Asks the relay for just the article text of a page, as JSON blocks. */
async function fetchFullArticle(it) {
  const url = safeUrl(it.l);
  if (!url) throw new Error('This article has no web address.');
  const relay = relayUrl();
  if (!relay) throw new Error('Full articles come through the relay, which is turned off in ⚙ Settings → Your feeds.');
  const own = S.settings.relayMode === 'own';
  await relayTurn();
  const res = await fetch(`${relay}/?mode=article&url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(25000), credentials: 'omit', referrerPolicy: 'no-referrer',
    headers: own && S.settings.relayToken ? { 'X-Relay-Token': S.settings.relayToken } : {},
  }).catch(() => { throw new Error(`Couldn't reach ${own ? 'your' : 'the shared'} relay. Try again in a moment.`); });
  if (res.status === 422) throw new Error("Couldn't find the article text on that page. Use Open original ↗.");
  if (res.status === 429) throw new Error('The relay is busy. Try again in a minute.');
  if (!res.ok) {
    const site = Number(/site answered HTTP (\d+)/.exec(await res.text().catch(() => ''))?.[1]);
    throw new Error(site ? `The site answered HTTP ${site}. Use Open original ↗.` : "Couldn't get the full article. Use Open original ↗.");
  }
  if (res.headers.get('X-Relay-Kind') !== 'article') {
    throw new Error(own ? 'Your relay is an older version without full articles. Paste the new relay/worker.js into your Worker.' : 'The relay is an older version without full articles.');
  }
  const data = await res.json();
  let html = '';
  let list = false;
  for (const b of data.blocks || []) {
    if (b.t === 'li' && !list) { html += '<ul>'; list = true; }
    if (b.t !== 'li' && list) { html += '</ul>'; list = false; }
    if (b.t === 'img') { const src = safeUrl(b.src); if (src) html += `<img src="${esc(src)}" alt="${esc(b.alt || '')}" loading="lazy" referrerpolicy="no-referrer">`; continue; }
    const tag = ['p', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre'].includes(b.t) ? b.t : 'p';
    html += `<${tag}>${esc(b.x || '').replace(/\n/g, '<br>')}</${tag}>`;
  }
  if (list) html += '</ul>';
  return html;
}

async function showFullArticle(article, btn) {
  const it = S.byId.get(article.dataset.id) || S.starred[article.dataset.id];
  const box = article.querySelector('[data-content]');
  if (!it || !box) return;
  if (btn.dataset.state === 'full') { // back to the feed's version
    delete box.dataset.filled; btn.dataset.state = ''; btn.textContent = '📄 Full article';
    await fillContent(article); return;
  }
  btn.disabled = true; btn.textContent = '📄 Getting the article…';
  try {
    if (!fullArticles.has(it.id)) fullArticles.set(it.id, await fetchFullArticle(it));
    box.innerHTML = sanitize(fullArticles.get(it.id), safeUrl(it.l) || location.href);
    box.dataset.filled = '1';
    btn.dataset.state = 'full'; btn.textContent = '📄 Feed version';
  } catch (e) {
    btn.textContent = '📄 Full article';
    toast(e.message, 5000);
  } finally { btn.disabled = false; }
}

/** Turns HTML-only entities (&nbsp; …) and stray & into ones XML accepts. */
function repairXML(xml) {
  const ta = document.createElement('textarea');
  return xml
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, name) => {
      if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(name)) return m;
      ta.innerHTML = m;
      const ch = ta.value;
      return ch === m ? `&amp;${name};` : [...ch].map((c) => `&#${c.codePointAt(0)};`).join('');
    })
    .replace(/&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, '&amp;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function parseFeedXML(xml, feedUrl, feedId) {
  let doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) {
    doc = new DOMParser().parseFromString(repairXML(xml), 'text/xml');
    if (doc.querySelector('parsererror')) return null;
  }
  const root = doc.documentElement;
  const name = root.localName;
  if (!['rss', 'feed', 'RDF'].includes(name)) return null;
  const atom = name === 'feed';
  const child = (el, tag) => [...el.children].find((c) => c.localName === tag || c.tagName === tag);
  const txt = (el, ...tags) => { for (const t of tags) { const c = child(el, t); if (c && c.textContent.trim()) return c.textContent.trim(); } return ''; };
  const channel = atom ? root : child(root, 'channel') || root;
  const linkOf = (el) => {
    if (!atom) {
      // An RSS guid is a link only if it isn't isPermaLink="false" and is a web address.
      const g = child(el, 'guid');
      const guidLink = g && g.getAttribute('isPermaLink') !== 'false' && /^https?:\/\//i.test(g.textContent.trim()) ? g.textContent.trim() : '';
      return txt(el, 'link') || guidLink;
    }
    const links = [...el.children].filter((c) => c.localName === 'link');
    const alt = links.find((l) => (l.getAttribute('rel') || 'alternate') === 'alternate') || links[0];
    return alt?.getAttribute('href') || '';
  };
  const abs = (u, base) => safeUrl(u, base);
  const site = abs(linkOf(channel), feedUrl);
  // Atom's xml:base sets the address relative links are resolved against.
  const feedBase = abs(root.getAttribute('xml:base'), feedUrl) || feedUrl;
  /** Article HTML; Atom type="xhtml" holds real markup, so take it as markup. */
  const htmlOf = (el) => {
    for (const t of ['content:encoded', 'encoded', 'content', 'description', 'summary']) {
      const c = child(el, t);
      if (!c) continue;
      const v = c.getAttribute('type') === 'xhtml' ? c.innerHTML.trim() : c.textContent.trim();
      if (v) return v;
    }
    // YouTube and podcasts: <media:group><media:description>, plain text.
    const md = [...el.getElementsByTagName('*')].find((x) => x.localName === 'description' && x.namespaceURI?.includes('mrss'));
    if (md?.textContent.trim()) return md.textContent.trim().split(/\n{2,}/).map((para) => `<p>${esc(para).replace(/\n/g, '<br>')}</p>`).join('');
    return '';
  };
  const entries = atom ? [...root.children].filter((c) => c.localName === 'entry') : [...doc.getElementsByTagName('item')];
  const guidCount = new Map();
  for (const el of entries.slice(0, 60)) { const g = txt(el, 'guid', 'id'); if (g) guidCount.set(g, (guidCount.get(g) || 0) + 1); }
  const items = entries.slice(0, 60).map((el, idx) => {
    const html = htmlOf(el);
    const base = atom ? abs(el.getAttribute('xml:base'), feedBase) || feedBase : site || feedUrl;
    const link = unwrapLink(abs(linkOf(el), base));
    let guid = txt(el, 'guid', 'id') || link || txt(el, 'title');
    // Items sharing an id would collapse into one: tell every copy apart by its link.
    if (guidCount.get(guid) > 1) guid = `${guid}|${link || txt(el, 'title')}`;
    let d = Date.parse(txt(el, 'pubDate', 'published', 'updated', 'dc:date', 'date'));
    if (!Number.isFinite(d) || d > Date.now()) d = NaN;
    const media = [...el.getElementsByTagName('*')].find((c) => /^(thumbnail|content)$/.test(c.localName) && c.getAttribute('url') && /image|^$/.test(c.getAttribute('medium') || c.getAttribute('type') || ''));
    const imgMatch = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
    const img = media?.getAttribute('url') || (imgMatch ? imgMatch[1] : '');
    // Categories, and audio or video attached (podcasts, YouTube), for smart folders.
    const cats = [...el.children].filter((c) => c.localName === 'category').map((c) => (c.getAttribute('term') || c.textContent || '').trim()).filter((x) => x && x.length < 50).slice(0, 8);
    const types = [...el.getElementsByTagName('*')].filter((c) => /^(enclosure|content|group)$/.test(c.localName)).map((c) => c.getAttribute('type') || (c.getAttribute('medium') ? c.getAttribute('medium') + '/' : ''));
    if ([...el.getElementsByTagName('*')].some((c) => c.namespaceURI?.includes('youtube'))) types.push('video/youtube');
    const m = mediaKind(types, link);
    const w = wordCount(html);
    return {
      ...(cats.length ? { g: cats } : {}),
      ...(m ? { m } : {}),
      ...(w > 150 ? { w } : {}),
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
  const lang = (txt(channel, 'language', 'dc:language') || root.getAttribute('xml:lang') || '').toLowerCase().slice(0, 5);
  return { title: strip(txt(channel, 'title')), site, lang, items };
}

function discoverFeed(html, pageUrl) {
  // The relay sends a page's feed links instead of the page.
  if (/^\s*\{/.test(html)) { try { return JSON.parse(html).feeds?.[0] || ''; } catch { return ''; } }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const link = doc.querySelector('link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]');
  if (!link) return '';
  try { return new URL(link.getAttribute('href'), pageUrl).href; } catch { return ''; }
}

/**
 * The address to fetch for a feed. Feedly saved YouTube channels as web
 * pages (youtube.com/playlist?list=UU…); YouTube has a real feed for each.
 */
function fetchAddress(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)youtube\.com$/.test(u.hostname) || u.pathname.startsWith('/feeds/')) return url;
    const list = u.searchParams.get('list');
    if (u.pathname === '/playlist' && list) return `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(list)}`;
    const ch = /^\/channel\/(UC[\w-]+)/.exec(u.pathname);
    if (ch) return `https://www.youtube.com/feeds/videos.xml?channel_id=${ch[1]}`;
    const user = /^\/user\/([\w.-]+)/.exec(u.pathname);
    if (user) return `https://www.youtube.com/feeds/videos.xml?user=${user[1]}`;
  } catch { /* not a URL */ }
  return url;
}

/** Sites that moved without leaving a forwarding address. [old address pattern, new address] */
const KNOWN_MOVES = [
  [/^https?:\/\/(www\.)?tasnimnews\.com\/en\//i, 'https://www.tasnimnews.ir/en/rss/feed/0/0/0/0/AllStories'],
  [/^https?:\/\/(www\.)?panarmenian\.net\/(stickers\/news\/news_eng|eng\/)/i, 'https://www.pan.am/en/newsfeed/rss'],
  [/^https?:\/\/english\.aljazeera\.net\//i, 'https://www.aljazeera.com/xml/rss/all.xml'],
  [/^https?:\/\/feeds\.feedburner\.com\/BitcoinMagazine\b/i, 'https://bitcoinmagazine.com/feed'],
];

/**
 * A gone feed's new address: the page its old address now shows may link to
 * it, a known move, or the usual feed paths on the same site (tried at most
 * once a week per feed, to spare the relay). '' if none.
 */
async function findNewAddress(feed, answer) {
  const tryUrl = async (url) => {
    try {
      const t = await fetchFeedText(url);
      if (parseFeedXML(t, url, 'x')) return url;
      const linked = /^\s*\{/.test(t) ? JSON.parse(t).feeds?.[0] : discoverFeed(t, url);
      if (linked && linked !== url) { const t2 = await fetchFeedText(linked); if (parseFeedXML(t2, linked, 'x')) return linked; }
    } catch { /* not there */ }
    return '';
  };
  // The old address now shows a page that says where its feed is.
  if (answer && /^\s*\{/.test(answer)) {
    try { const linked = JSON.parse(answer).feeds?.[0]; if (linked) { const ok = await tryUrl(linked); if (ok) return ok; } } catch { /* not JSON */ }
  }
  for (const [re, to] of KNOWN_MOVES) if (re.test(feed.url)) { const ok = await tryUrl(to); if (ok) return ok; }
  const live = liveSub(feed.url) || feed;
  if (live.probedAt && Date.now() - live.probedAt < 7 * 864e5) return '';
  live.probedAt = Date.now();
  let u;
  try { u = new URL(feed.url); } catch { return ''; }
  const lang = /^\/(en|eng|english)(\/|$)/i.exec(u.pathname)?.[1];
  const paths = [...new Set([...(lang ? [`/${lang}/rss`, `/${lang}/feed`] : []), '/rss', '/feed', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml'])];
  // The same address over https, or with/without www (old Google Reader-era addresses).
  const variants = new Set();
  if (u.protocol === 'http:') variants.add('https://' + u.host + u.pathname + u.search);
  const flip = u.hostname.startsWith('www.') ? u.hostname.slice(4) : 'www.' + u.hostname;
  variants.add('https://' + flip + (u.port ? ':' + u.port : '') + u.pathname + u.search);
  for (const v of variants) { const ok = await tryUrl(v); if (ok) return ok; }
  if (live.site) { const ok = await tryUrl(live.site); if (ok) return ok; }
  else { const ok = await tryUrl(u.origin + '/'); if (ok) return ok; }
  for (const path of paths) { const ok = await tryUrl(u.origin + path); if (ok) return ok; }
  return '';
}

/** The search words of a Google News search feed (old Google Reader-era or current address), else ''. */
function googleNewsQuery(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'news.google.com') return '';
    // ?q=… (Google Reader-era /news?…&output=rss, /news/feeds?…, today's /rss/search?…)
    if (u.searchParams.get('q')) return u.searchParams.get('q');
    // 2017–2019 addresses put the words in the path: /news/rss/search/section/q/<words>/<words>
    const m = /\/search\/section\/q\/([^/]+)/.exec(u.pathname);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  } catch { return ''; }
}
/** News-search links go through a click-tracking redirect; use the article's own address. */
function unwrapLink(link) {
  try {
    const u = new URL(link);
    if (/(^|\.)bing\.com$/.test(u.hostname) && u.searchParams.get('url')) return safeUrl(u.searchParams.get('url')) || link;
  } catch { /* not a URL */ }
  return link;
}

/** The search words of a Bing News search feed (a news search added from Subscribe), else ''. */
function bingNewsQuery(url) {
  try { const u = new URL(url); return /(^|\.)bing\.com$/.test(u.hostname) && u.pathname.startsWith('/news/search') ? u.searchParams.get('q') || '' : ''; } catch { return ''; }
}

/**
 * Runs a news search. Bing's RSS returns nothing for "a OR b", so each OR
 * term is searched on its own and the results merged (each article once).
 */
async function newsSearch(q, feed) {
  const terms = q.split(/\s+OR\s+/).map((t) => t.trim()).filter(Boolean);
  const parts = [];
  let lastErr;
  for (const term of terms) {
    try {
      const p = parseFeedXML(await fetchFeedTextRetry(newsSearchUrl(term)), feed.url, feed.id);
      if (p) parts.push(p);
    } catch (e) { lastErr = e; }
  }
  if (!parts.length) throw lastErr || new Error("The news search didn't answer.");
  const seen = new Set();
  const items = parts.flatMap((p) => p.items).filter((it) => { const k = articleKey(it); if (seen.has(k)) return false; seen.add(k); return true; });
  return { title: parts[0].title, site: parts[0].site, items };
}

/** Bing News has RSS for any search, and unlike Google it answers the relay. */
const newsSearchUrl = (q) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`;

/** The subscription with this address as it is now (another tab may have replaced the list). */
const liveSub = (url) => (S.subs || []).find((s) => s.url === url);

/**
 * Fetches one of your own feeds and merges its new articles. With adding,
 * the feed isn't in your list yet; otherwise nothing is written if you
 * unsubscribed while it was being fetched.
 */
/**
 * What makes two items the same article: the same link (without tracking
 * bits, http/https or www) and the same title. Both, because some feeds point
 * every item at one page.
 */
function articleKey(it) {
  return `${linkKey(it)}|${(it.t || '').trim().toLowerCase()}`;
}
const linkKeys = new Map();
function linkKey(it) {
  if (!it.l) return '';
  let k = linkKeys.get(it.l);
  if (k === undefined) {
    if (linkKeys.size > 300000) linkKeys.clear();
    k = linkKeyOf(it.l);
    linkKeys.set(it.l, k);
  }
  return k;
}
function linkKeyOf(l) {
  try {
    const u = new URL(l);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_|ncid$|guccounter$|ref$|src$|cmpid$)/i.test(k)) u.searchParams.delete(k);
    const q = u.searchParams.toString();
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${q ? '?' + q : ''}`.toLowerCase();
  } catch { return ''; }
}

/** Read and starred marks follow an article to its new id. */
function moveMarks(fromId, toId) {
  if (fromId === toId) return;
  if (fromId in S.read) { S.read[toId] = S.read[fromId]; delete S.read[fromId]; store.set('read', S.read); }
  if (S.starred[fromId]) { S.starred[toId] = { ...S.starred[fromId], id: toId }; delete S.starred[fromId]; store.set('starred', S.starred); }
}

/** Keeps the newest copy of each article (list sorted newest first); marks move to it. */
function dedupeArticles(items) {
  const seen = new Map();
  const out = [];
  for (const it of items) {
    const k = articleKey(it);
    const kept = seen.get(k);
    if (kept) {
      // Read if either copy was read; starred if either was starred.
      if (it.id in S.read && !(kept.id in S.read)) { S.read[kept.id] = S.read[it.id]; store.set('read', S.read); }
      if (S.starred[it.id] && !S.starred[kept.id]) { S.starred[kept.id] = { ...S.starred[it.id], id: kept.id }; store.set('starred', S.starred); }
      continue;
    }
    seen.set(k, it);
    out.push(it);
  }
  return out;
}

/** News searches sometimes get a non-feed answer for a moment: one retry. */
async function fetchFeedTextRetry(url, opts) {
  const text = await fetchFeedText(url, opts);
  if (parseFeedXML(text, url, 'x') || !/bing\.com\/news/.test(url)) return text;
  // Bing now and then answers the relay with a "are you a robot" page instead of
  // the feed, at random per request. A few more tries, a moment apart, each
  // slightly different (settings Bing ignores for the results).
  for (const extra of ['&mkt=en-US', '&setlang=en-US', '&cc=US', `&_=${Date.now() % 100000}`]) {
    await sleep(2000);
    const again = await fetchFeedText(url + extra, opts).catch(() => '');
    if (parseFeedXML(again, url, 'x')) return again;
  }
  throw new Error("The news search didn't answer with results just now. It will be tried again.");
}

async function fetchOwnFeed(feed, xml, { adding = false } = {}) {
  let via = '';
  let movedTo = '';
  let parsed = null;
  const q = googleNewsQuery(feed.url);
  const bq = bingNewsQuery(feed.url);
  // A feed found at a new address is read from there (its identity stays the same).
  const address = feed.fetchUrl || fetchAddress(feed.url);
  // A news search with OR: one search per term, merged (Bing can't do OR).
  if (xml == null && bq && /\s+OR\s+/.test(bq)) { parsed = await newsSearch(bq, feed); xml = ''; }
  if (xml == null) {
    try {
      xml = await fetchFeedTextRetry(address, { feed });
    } catch (e) {
      if (q) {
        // Google blocks relays: a Google News search comes from Bing News instead.
        parsed = await newsSearch(q, feed);
        xml = '';
        via = 'Bing News';
      } else if (e.gone && /(^|\.)youtube\.com$/.test(host(address))) {
        throw Object.assign(new Error("YouTube has no public feed for this channel. It may have no public videos left, or be hidden or closed."), { permanent: true });
      } else if (e.gone || KNOWN_MOVES.some(([re]) => re.test(feed.url))) {
        movedTo = await findNewAddress(feed);
        if (!movedTo) throw Object.assign(new Error(`${e.message} No new address could be found on the site.`), { permanent: e.gone });
        xml = await fetchFeedText(movedTo);
      } else throw e;
    }
  }
  if (!parsed && xml) parsed = parseFeedXML(xml, feed.url, feed.id);
  // The address now shows a web page instead of the feed: look for where it went.
  if (!parsed && !q && !bq && !movedTo) {
    movedTo = await findNewAddress(feed, xml);
    if (movedTo) parsed = parseFeedXML(await fetchFeedText(movedTo), feed.url, feed.id);
  }
  // Google sometimes answers with an empty list (or a page that isn't a feed): ask Bing too.
  if (q && !via && (!parsed || !parsed.items.length)) {
    const bing = await newsSearch(q, feed);
    if (bing.items.length) { parsed = { ...bing, title: parsed?.title || bing.title }; via = 'Bing News'; }
  }
  if (!parsed) throw new Error(movedTo === '' && !q ? "This address now shows a web page, not a feed, and no new address could be found on the site." : 'Not an RSS or Atom feed');
  const target = adding ? feed : liveSub(feed.url);
  if (!target) return parsed;
  // Article text goes to its own store; the list keeps titles, summaries, links.
  const newBodies = {};
  parsed.items = parsed.items.map(({ c, ...it }) => { if (c) newBodies[it.id] = c; return it; });
  const old = new Map((S.ownItems[target.id] || []).map((i) => [i.id, i]));
  // The same article can come back under a new id (feeds change their guids,
  // http → https…). Match by link too, so it replaces the old copy instead of
  // showing twice, and keeps your read and starred marks.
  const byKey = new Map([...old.values()].map((i) => [articleKey(i), i]));
  for (const it of parsed.items) {
    let prev = old.get(it.id);
    const twin = !prev && byKey.get(articleKey(it));
    if (twin) { old.delete(twin.id); moveMarks(twin.id, it.id); prev = twin; }
    // Undated items keep the time we first saw them.
    old.set(it.id, { ...prev, ...it, d: it.dated ? it.d : prev?.d ?? it.d });
  }
  S.ownItems[target.id] = keepRecent(dedupeArticles([...old.values()].sort((a, b) => b.d - a.d)));
  {
    const keepIds = new Set(S.ownItems[target.id].map((i) => i.id));
    const prevBodies = await readBodies(target.id);
    const bodies = {};
    for (const [k, v] of Object.entries({ ...prevBodies, ...newBodies })) if (keepIds.has(k)) bodies[k] = v;
    await writeBodies(target.id, bodies);
  }
  // A feed that left the catalog: what came before isn't news to you.
  if (target.convertedAt) {
    for (const it of S.ownItems[target.id]) if (it.d < target.convertedAt && !isRead(it.id)) S.read[it.id] = Date.now();
    store.set('read', S.read);
    delete target.convertedAt;
  }
  target.site = parsed.site || target.site;
  if (parsed.lang) target.lang = parsed.lang; else delete target.lang;
  if (!target.titleSet && parsed.title) target.title = parsed.title;
  target.ok = Date.now();
  delete target.retired;
  target.every = fetchInterval(S.ownItems[target.id]);
  target.error = '';
  delete target.failSince;
  delete target.failKind; delete target.kindSince; delete target.kindTries; delete target.retiredWhy; delete target.relayIssue;
  if (via) target.via = via; else delete target.via;
  if (movedTo) target.fetchUrl = movedTo;
  if ('direct' in feed) target.direct = feed.direct;
  if (!adding) { saveOwnFeed(target.id); saveSubs(); }
  return parsed;
}

/*
 * Dead or alive? Every failure is sorted into a kind, and only a dead feed is retired:
 *  - relay:   the relay (or this browser's connection) had a problem. Not the feed's fault: nothing counts.
 *  - gone:    the address is gone (404/410, a closed YouTube channel) and no new address was found.
 *             Dead once it has stayed gone for a day (at least two tries).
 *  - notfeed: the address now shows a web page or something that isn't a feed, with no feed found.
 *             Dead once that has lasted 3 days.
 *  - down:    the site is down or unreachable (5xx, timeouts). Left alone; dead after 30 days.
 *  - blocked: the site refuses readers (401/403/429, cloud blocks). It exists, so it's left alone;
 *             dead after 30 days of never being readable.
 * A feed that works but hasn't posted in a long time is never retired: it's just quiet.
 */
const DEAD_AFTER = { gone: 864e5, notfeed: 3 * 864e5, down: 30 * 864e5, blocked: 30 * 864e5 };
const FAIL_LABEL = {
  relay: 'Waiting for the relay',
  gone: 'Gone',
  notfeed: 'No longer a feed',
  down: 'Site down',
  blocked: 'Blocked by the site',
};

function failKind(e) {
  if (e?.kind) return e.kind;
  const m = String(e?.message ?? e ?? '');
  if (e instanceof NeedsRelay || /Couldn't reach (the shared|your) relay|relay is busy|relay rejected|relay refused|relay doesn't allow|relay is turned off|Enter your relay/i.test(m)) return 'relay';
  if (/shows a web page, not a feed|isn't a feed|Not an RSS or Atom feed/i.test(m)) return 'notfeed';
  if (e?.permanent || e?.gone || /\b(404|410)\b|is gone|no public feed|No new address/i.test(m)) return 'gone';
  if (/refuses|blocks requests|limiting requests|\b(401|403|429)\b/i.test(m)) return 'blocked';
  return 'down';
}

/** Whether a failing feed is now judged dead (and why), or null to leave it alone. */
function deadVerdict(sub, now = Date.now()) {
  const kind = sub.failKind;
  if (!kind || kind === 'relay' || !sub.failSince) return null;
  if (kind === 'gone' || kind === 'notfeed') {
    if (now - (sub.kindSince || now) >= DEAD_AFTER[kind] && (sub.kindTries || 0) >= 2) return kind === 'gone' ? 'gone' : 'no longer a feed';
    return null;
  }
  return now - sub.failSince >= DEAD_AFTER.down ? (kind === 'blocked' ? 'unreadable for a month' : 'down for a month') : null;
}

function noteFeedError(feed, e) {
  const target = liveSub(feed.url);
  if (!target) return;
  const now = Date.now();
  const kind = failKind(e);
  target.error = e.message || 'Could not fetch';
  target.lastTry = now;
  if ('direct' in feed) target.direct = feed.direct;
  if (kind === 'relay') {
    // Not the feed's fault: don't count it against the feed.
    target.relayIssue = now;
    saveSubs();
    return;
  }
  delete target.relayIssue;
  if (target.failKind !== kind) { target.failKind = kind; target.kindSince = now; target.kindTries = 0; }
  target.kindTries = (target.kindTries || 0) + 1;
  target.failSince ??= now;
  // Dead: retired (not fetched; Keep trying brings it back). A feed you chose to keep stays, tried daily.
  const why = deadVerdict(target, now);
  if (why && !target.keep) { target.retired ??= now; target.retiredWhy = why; }
  saveSubs();
}

/** Redraws Home after a background update, unless you're reading a briefing there. */
function refreshHome() {
  const brief = $('#brief');
  if (brief && !brief.hidden) { renderSidebar(); return; }
  render();
}

/** New articles arrived while you're reading a list: a button shows them, nothing jumps. */
function offerNew() {
  const shown = new Set(S.list.map((x) => x.id));
  const fresh = viewItems().filter((it) => !shown.has(it.id));
  const head = $('#viewHeader');
  head.querySelector('.new-items')?.remove();
  if (!fresh.length || S.view.type === 'search' || S.view.type === 'starred') return;
  head.insertAdjacentHTML('beforeend', `<button class="new-items" data-act="shownew">↑ ${fresh.length} new article${fresh.length === 1 ? '' : 's'}</button>`);
}

const OWN_REFRESH_MS = 25 * 60 * 1000;

/**
 * When a feed is next fetched. Busy feeds every 30 minutes, quiet ones up to
 * twice a day, long-silent ones daily; failing feeds back off (1 h, 6 h,
 * then daily). With hundreds of feeds this keeps the shared relay within its
 * daily allowance.
 */
function nextFetchAt(s) {
  if (s.error && s.relayIssue && !s.failSince) return s.relayIssue + 3600e3;
  if (s.error) {
    const failing = Date.now() - (s.failSince || Date.now());
    const wait = failing < 6 * 3600e3 ? 3600e3 : failing < 3 * 864e5 ? 6 * 3600e3 : 864e5;
    return (s.lastTry || 0) + wait;
  }
  if (!s.ok) return 0;
  return s.ok + (s.every || OWN_REFRESH_MS);
}

/** How often to fetch a feed, from how often it has been posting. */
function fetchInterval(items) {
  const dates = items.filter((i) => i.dated !== false).map((i) => i.d).sort((a, b) => b - a).slice(0, 8);
  if (dates.length < 2) return 2 * 3600e3;
  if (Date.now() - dates[0] > 30 * 864e5) return 864e5;
  const gaps = dates.slice(1).map((d, k) => dates[k] - d).sort((a, b) => a - b);
  const typical = gaps[Math.floor(gaps.length / 2)];
  return Math.min(12 * 3600e3, Math.max(30 * 60e3, typical / 2));
}
let ownRefreshing = null;
let stopRefresh = false;

/**
 * Fetches your own feeds that are due (or all of them with force), a few at
 * a time. Articles show up as each feed arrives. Only one open tab does
 * this at a time; the others get the results when it saves.
 */
function refreshOwnFeeds({ force = false, wait = false, includeRetired = false } = {}) {
  // One run at a time; a request during a run runs again right after it.
  if (ownRefreshing) return ownRefreshing.then(() => refreshOwnFeeds({ force, wait, includeRetired }));
  const run = async () => {
    const catalog = catalogByUrl();
    const now = Date.now();
    const due = (S.subs || []).filter((s) => {
      if (!s.own || catalog.has(s.url) || (s.retired && !includeRetired)) return false;
      return force || now >= nextFetchAt(s);
    });
    if (!due.length || stopRefresh) return;
    // The feeds you read most come first, so the stories you care about arrive first.
    const score = feedPriority();
    due.sort((a, b) => (score.get(b.id) || 0) - (score.get(a.id) || 0));
    S.ownProgress = { done: 0, total: due.length };
    renderSidebar();
    let lastPaint = 0;
    let paintCost = 0;
    const paint = (final) => {
      // Redraw at most every 1.5 s, and less often when a redraw is costly (many feeds),
      // so the page stays responsive while feeds arrive.
      if (stopRefresh || (!final && Date.now() - lastPaint < Math.max(1500, paintCost * 12))) return;
      const t0 = performance.now();
      lastPaint = Date.now();
      rebuild();
      saveSubs();
      renderSidebar();
      // Fill an empty list or Home; otherwise leave what you're reading alone
      // and offer the new articles.
      if (S.view.type === 'home') refreshHome();
      else if (!document.querySelector('#list article.entry')) render();
      else { renderHeaderCounts(); if (final) offerNew(); }
      if (final) vectorsForTopics();
      paintCost = performance.now() - t0;
    };
    let next = 0;
    // Requests to the relay are paced anyway; more at once lets sites that can be read
    // directly (without the relay) arrive in parallel.
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < due.length && !stopRefresh) {
        const f = due[next++];
        try { await fetchOwnFeed(f); } catch (e) { noteFeedError(f, e); }
        if (S.ownProgress) S.ownProgress.done++;
        paint(false);
      }
    }));
    S.ownProgress = null;
    paint(true);
    savePrefetchPlan();
  };
  ownRefreshing = (navigator.locks
    // Background refreshes skip if another tab is fetching; an import waits its turn.
    ? navigator.locks.request('salareader-refresh', wait ? {} : { ifAvailable: true }, (lock) => (lock ? run() : null))
    : run()
  ).finally(() => { ownRefreshing = null; });
  return ownRefreshing;
}

function subscribeCatalog(c, folder) {
  S.subs ??= [];
  if (S.subs.some((s) => s.url === c.url)) return;
  S.subs.push({ id: c.id, url: c.url, title: c.title, folder: folder ?? c.folder ?? '' });
  saveSubs();
  rebuild();
}

const addingNow = new Set();

async function addFeed(url, folder) {
  url = url.trim();
  // A second Enter or click while the first is still fetching must not add it twice.
  if (addingNow.has(url)) throw new Error('Already adding this feed…');
  addingNow.add(url);
  try { return await addFeedOnce(url, folder); } finally { addingNow.delete(url); }
}

async function addFeedOnce(url, folder) {
  // Words rather than an address: follow a news search for them.
  if (!/^https?:\/\//i.test(url) && (/\s/.test(url) || !/^[^\s]+\.[a-z]{2,}([/:?#]|$)/i.test(url))) {
    const q = url;
    const feedUrl = newsSearchUrl(q);
    if (S.feeds.some((f) => f.url === feedUrl)) throw new Error("You're already following this search.");
    $('#addStatus').textContent = `Searching the news for “${q}”…`;
    const feed = { id: 'L' + hash(feedUrl), url: feedUrl, title: `“${q}” · News search`, titleSet: true, folder: folder.trim() || 'Searches', own: true, site: '' };
    await fetchOwnFeed(feed, undefined, { adding: true });
    S.subs ??= [];
    if (S.subs.some((x) => x.url === feed.url)) throw new Error("You're already subscribed to this feed.");
    S.subs.push(feed);
    saveSubs();
    saveOwnFeed(feed.id);
    rebuild();
    return feed;
  }
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
  await fetchOwnFeed(feed, text, { adding: true });
  S.subs ??= [];
  if (S.subs.some((x) => x.url === feed.url)) throw new Error("You're already subscribed to this feed.");
  S.subs.push(feed);
  saveSubs();
  saveOwnFeed(feed.id);
  rebuild();
  return feed;
}

function unsubscribe(id) {
  const f = S.feedById.get(id);
  if (!f) return;
  S.subs = S.subs.filter((s) => s.url !== f.url);
  delete S.ownItems[id];
  saveSubs();
  saveOwnFeed(id);
  store.del('vec:' + id);
  deleteBodies(id);
  rebuild();
}

// ---------- read state, stars, streak ----------

// Counts in the sidebar, header and tab title are redrawn once you pause,
// not on every key press (that took ~60 ms with tens of thousands of articles).
let countsTimer;
function scheduleCounts() {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(() => { renderSidebar(); renderHeaderCounts(); updateTitle(); }, 150);
}

function markRead(id, read = true) {
  const was = isRead(id);
  if (was === read) return;
  // Every copy of the story (the same article in other feeds) goes with it.
  for (const x of twinsOf(id)) {
    if (isRead(x) === read) continue;
    if (read) S.read[x] = Date.now(); else delete S.read[x];
    // The running unread total counts each story once, in your current feeds.
    if (S.byId.has(x) && !S.dupHidden?.has(x)) S.unread += read ? -1 : 1;
    if (x !== id) updateEntryDom(x);
  }
  store.set('read', S.read);
  if (read) noteActivity();
  updateEntryDom(id);
  scheduleCounts();
  if (read && S.byId.has(id) && S.unread === 0) celebrate();
}

function markAllRead(items) {
  const before = totalUnread();
  const t = Date.now();
  let n = 0;
  for (const it of items) if (!isRead(it.id)) { for (const x of twinsOf(it.id)) S.read[x] ??= t; n++; }
  store.set('read', S.read);
  S.unread = unreadOf(S.uniq);
  if (n) noteActivity();
  render();
  if (n) toast(`Marked ${n} as read`);
  if (before > 0 && totalUnread() === 0) celebrate();
}

function toggleStar(id) {
  const it = S.byId.get(id) || S.starred[id];
  if (!it) return;
  if (S.starred[id]) delete S.starred[id];
  else {
    S.starred[id] = { ...it, starredAt: Date.now() };
    // Keep the full text with the star, so it outlives the feed's own copy.
    if (!it.c) feedContent(it.f).then((m) => { if (S.starred[id] && m?.[id]) { S.starred[id].c = m[id]; store.set('starred', S.starred); } }).catch(() => {});
  }
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
const totalUnread = () => S.unread;

// ---------- topics ----------

const topicCache = new Map();

/** Articles matching a topic. Cached until items, vectors or the threshold change. */
function topicMatches(topic) {
  const key = `${S.version}|${S.settings.threshold}|${modelKey()}|${topic.query}`;
  const hit = topicCache.get(topic.id);
  if (hit?.key === key) return hit.result;
  const result = computeTopic(topic);
  topicCache.set(topic.id, { key, result });
  return result;
}

/** Word matching for topics and search. */
const wordRe = (text) => {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Words must start at a word edge ("AI" not in "said"; "agent" still finds "agents").
  // Chinese, Japanese, Thai, Arabic… don't separate words with spaces: match anywhere.
  const spaced = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]/u.test(text);
  return new RegExp(spaced ? `(?<![\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Greek}\\p{N}])${escaped}` : escaped, 'iu');
};

function computeTopic(topic) {
  const words = topic.query.trim().split(/\s+/).filter((w) => w.length > 2).map(wordRe);
  const phrase = wordRe(topic.query.trim());
  const qv = topicVec(topic);
  const out = [];
  const scores = {};
  for (const it of S.uniq) {
    const hay = `${it.t} ${it.s}`.toLowerCase();
    let score = 0;
    const v = S.vectors.get(it.id);
    if (qv && v) score = dot(qv, v);
    if (phrase.test(hay)) score = Math.max(score, 0.99);
    else if (words.length > 1 && words.every((w) => w.test(hay))) score = Math.max(score, S.settings.threshold + 0.05);
    if (score >= S.settings.threshold) { out.push(it); scores[it.id] = score; }
  }
  return { items: out, scores };
}

async function createTopic(query) {
  const status = $('#topicStatus');
  status.textContent = `Teaching the AI what you mean… (the first time downloads the model, ${EMBED_MODELS[modelKey()].size})`;
  const [qv] = await embed([query], (p) => { status.textContent = `Downloading the AI model… ${Math.round(p * 100)}%`; });
  const topic = { id: hash(query + Date.now()), name: query.replace(/^./, (c) => c.toUpperCase()), query, [modelKey() === 'multi' ? 'qvm' : 'qv']: Array.from(qv, (x) => +x.toFixed(4)) };
  S.topics.push(topic);
  store.set('topics', S.topics);
  await loadVectors();
  vectorsForTopics(); // your own feeds' articles, in the background
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
      const ids = new Set(S.feeds.filter((f) => feedFolders(f).includes(v.id)).map((f) => f.id));
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
    case 'smart': items = S.smart?.get(v.id) || []; break;
    default: items = [];
  }
  // Views that mix feeds show each story once.
  if (S.dupHidden?.size && !['feed', 'starred'].includes(v.type)) items = items.filter((i) => !S.dupHidden.has(i.id));
  // Smart folders show only unread articles (and ones opened while you're there).
  const showAll = v.type === 'starred' || v.type === 'search' || (v.type !== 'smart' && !S.settings.unreadOnly);
  const shown = showAll ? items : items.filter((i) => !isRead(i.id) || v.keep?.has(i.id));
  // Oldest first (search keeps best matches first).
  return S.settings.sort === 'oldest' && v.type !== 'search' ? [...shown].sort((a, b) => a.d - b.d) : shown;
}

function viewTitle() {
  const v = S.view;
  switch (v.type) {
    case 'all': return 'All items';
    case 'starred': return 'Starred';
    case 'health': return '🩺 Feed health';
    case 'feed': return S.feedById.get(v.id)?.title || 'Feed';
    case 'folder': return v.id === RETIRED ? '📦 Retired feeds' : v.id || 'Unfiled';
    case 'topic': return '✨ ' + (S.topics.find((t) => t.id === v.id)?.name || 'Topic');
    case 'search': return `“${v.q}”`;
    case 'smart': { const i = smartInfo(v.id); return i ? `${i.icon} ${i.name}` : 'Smart folder'; }
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

// Each view (a folder, a feed, All items, a topic) remembers List/Expanded,
// Unread/All and newest/oldest first. New views start as List, Unread, newest.
const VIEW_DEFAULTS = { mode: 'list', unreadOnly: true, sort: 'newest' };
const viewKey = () => `${S.view.type}:${S.view.id ?? ''}`;
function applyViewPrefs() {
  const p = S.settings.viewPrefs?.[viewKey()] || {};
  for (const k of Object.keys(VIEW_DEFAULTS)) S.settings[k] = (k === 'mode' ? S.settings.defaultMode : p[k]) ?? VIEW_DEFAULTS[k];
}
function setViewPref(k, value) {
  S.settings[k] = value;
  S.settings.viewPrefs ??= {};
  const key = viewKey();
  S.settings.viewPrefs[key] = { ...S.settings.viewPrefs[key], [k]: value };
  saveSettings();
}

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const [type, ...rest] = parts;
  let arg = rest.join('/');
  try { arg = decodeURIComponent(arg); } catch { /* a stray % typed in the address */ }
  const prevKey = JSON.stringify([S.view.type, S.view.id, S.view.q]);
  const prevKeep = S.view.keep;
  if (type === 'all' || type === 'starred' || type === 'health') S.view = { type };
  else if (type === 'feed' || type === 'folder' || type === 'topic' || type === 'smart') S.view = { type, id: arg };
  else if (type === 'search' && arg) {
    if (S.view.type !== 'search' || S.view.q !== arg) { S.view = { type: 'search', q: arg }; runSearch(arg); }
  } else S.view = { type: 'home' };
  // Articles you opened stay visible in "Unread" until you go to another view.
  S.view.keep = JSON.stringify([S.view.type, S.view.id, S.view.q]) === prevKey && prevKeep ? prevKeep : new Set();
  applyViewPrefs();
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
  const wordTests = words.map(wordRe);
  const keyword = (it) => { const hay = `${it.t} ${it.s} ${S.feedById.get(it.f)?.title || ''}`; return wordTests.every((w) => w.test(hay)); };
  // 1) Instant keyword results.
  v.results = S.uniq.filter(keyword).slice(0, 200);
  v.scores = null;
  v.status = 'Finding articles by meaning…';
  render();
  // 2) Meaning-based results, at once with the articles that already have
  // vectors; your own feeds' newer articles are worked out in the background
  // (in a worker, so the page stays usable) and added when they're ready.
  const rank = (qv) => {
    const scores = {};
    const ranked = [];
    for (const it of S.uniq) {
      const vec = S.vectors.get(it.id);
      const kw = keyword(it);
      // Word matches not worked out yet still count (as a good match).
      let s = vec ? dot(qv, vec) + (kw ? 0.2 : 0) : kw ? 0.6 : 0;
      if (s >= 0.3) { scores[it.id] = s; ranked.push(it); }
    }
    ranked.sort((a, b) => scores[b.id] - scores[a.id]);
    return { results: ranked.slice(0, 150), scores };
  };
  let qv;
  if (!S.settings.aiUsed) { S.settings.aiUsed = true; saveSettings(); }
  try {
    await loadVectors();
    [qv] = await embed([q], (p) => { if (S.view === v) { v.status = `Downloading the AI model (first time only)… ${Math.round(p * 100)}%`; renderHeaderCounts(); } });
    if (S.view !== v) return;
    const ranked = rank(qv);
    // You opened a word match while the AI was starting: keep it open and offer the AI's order.
    if (S.cur >= 0) v.pending = ranked; else Object.assign(v, ranked);
    v.status = S.vectors.size ? (v.pending ? 'Best matches by meaning are ready' : '') : 'AI search needs the next feed update to finish its first run; showing word matches.';
  } catch (e) {
    console.warn(e);
    if (S.view !== v) return;
    v.status = "Couldn't load the AI model, so these are word matches only.";
    render();
    return;
  }
  // Newest first, in steps, so recent matches show up early.
  const missing = S.items.filter((i) => !S.vectors.has(i.id) && S.feedById.get(i.f)?.own);
  if (missing.length) v.status = `Best matches first · checking ${missing.length} more articles from your feeds…`;
  if (v.pending) renderHeaderCounts(); else render();
  if (!missing.length) return;
  const STEP = 1500;
  for (let start = 0; start < missing.length; start += STEP) {
    try {
      await ensureVectors(missing.slice(start, start + STEP), null, (done) => {
        if (S.view === v && !v.pending) { v.status = `Best matches first · checking your feeds' articles… ${Math.round(((start + done) / missing.length) * 100)}%`; renderHeaderCounts(); }
      });
    } catch (e) { console.warn(e); break; }
    if (S.view !== v) return;
    const next = rank(qv);
    const added = next.results.filter((it) => !(v.pending || v).scores?.[it.id]).length;
    const last = start + STEP >= missing.length;
    if (!added) { if (last) { v.status = ''; renderHeaderCounts(); } continue; }
    // Don't reshuffle the list under an article you're reading: offer the new matches instead.
    if (S.cur >= 0) {
      v.pending = next;
      v.status = `${added} more matches found in your feeds${last ? '' : ' (still checking)'}`;
      renderHeaderCounts();
      continue;
    }
    Object.assign(v, next);
    if (last) v.status = '';
    render();
  }
  if (S.view === v && !v.pending) { v.status = ''; renderHeaderCounts(); }
}

// ---------- rendering ----------

function renderSidebar() {
  const nav = $('#sidebar');
  const folders = new Map();
  for (const f of S.feeds) {
    for (const k of feedFolders(f)) {
      if (!folders.has(k)) folders.set(k, []);
      folders.get(k).push(f);
    }
  }
  const unreadByFeed = new Map();
  const uniqByFeed = new Map(); // for folder totals: a story in two of a folder's feeds counts once
  for (const it of S.items) if (!isRead(it.id)) {
    unreadByFeed.set(it.f, (unreadByFeed.get(it.f) || 0) + 1);
    if (!S.dupHidden?.has(it.id)) uniqByFeed.set(it.f, (uniqByFeed.get(it.f) || 0) + 1);
  }
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
    ${smartSidebarHTML(active, count)}
    <div class="nav-section"><span>AI topics</span><button class="mini" id="addTopicBtn" title="New AI topic" aria-label="New AI topic">＋</button></div>`;
  if (!S.topics.length) html += `<button class="nav-empty" id="addTopicBtn2">Follow a topic across all feeds →</button>`;
  for (const t of S.topics) {
    let n = '';
    if (S.vectorsState === 'ready' || S.vectorsState === 'missing') n = count(unreadOf(topicMatches(t).items));
    html += `<a class="nav-item${active('topic', t.id)}" data-hue="${hueOf('t' + t.id)}" href="#/topic/${t.id}"><span class="ico">✨</span><span class="name">${esc(t.name)}</span>${n}</a>`;
  }
  html += invSidebarHTML(active, count);
  // Like Google Reader: feeds with nothing unread, and feeds that can't be read, are hidden
  // (and folders left empty by that) unless "Show all" is on. The open feed or folder always shows.
  const showAll = !!S.settings.showAllFeeds;
  const unreadable = (f) => f.retired || (f.error && !f.relayIssue);
  const visible = (f) => showAll || active('feed', f.id) || (!unreadable(f) && (unreadByFeed.get(f.id) || 0) > 0);

  const shownFolders = [];
  const names = [...folders.keys()].sort((a, b) => (a === RETIRED) - (b === RETIRED) || (a === '') - (b === '') || a.localeCompare(b));
  for (const name of names) {
    const all = folders.get(name).sort((a, b) => a.title.localeCompare(b.title));
    const list = all.filter(visible);
    if (list.length || active('folder', name)) shownFolders.push([name, list]);
  }
  const hiddenFeeds = showAll ? 0 : new Set(S.feeds.filter((f) => !visible(f)).map((f) => f.id)).size;
  html += `<div class="nav-section subs-section"><span>Subscriptions</span>${hiddenFeeds || showAll ? `<button class="mini-link" data-act="toggleallfeeds" title="${showAll ? 'Hide feeds with nothing unread, and feeds that can\'t be read' : `Show the ${hiddenFeeds} feeds with nothing unread or that can\'t be read`}">${showAll ? 'Hide read' : `Show all (${hiddenFeeds} hidden)`}</button>` : ''}</div>`;
  for (const [name, list] of shownFolders) {
    const feedRow = (f) => `<a class="nav-item feed${active('feed', f.id)}${f.error && !f.relayIssue ? ' broken' : ''}" href="#/feed/${f.id}" draggable="true" data-feed="${esc(f.id)}" data-from="${esc(name)}" title="${esc(f.error && !f.relayIssue ? `Couldn't fetch: ${f.error}` : f.url)}">
        ${avatar(f)}<span class="name">${esc(f.title)}</span>${f.error && !f.relayIssue ? '<span class="warn" aria-label="Fetch problem">!</span>' : ''}${count(unreadByFeed.get(f.id) || 0)}</a>`;
    if (!name) { html += list.map(feedRow).join(''); continue; }
    const n = folders.get(name).reduce((s, f) => s + (uniqByFeed.get(f.id) || 0), 0);
    const closed = folderClosed(name);
    const retired = name === RETIRED;
    html += `<div class="folder${closed ? ' closed' : ''}${retired ? ' retired' : ''}">
      <div class="nav-item folder-row${active('folder', name)}" data-drop="${esc(name)}"><button class="twisty" data-folder="${esc(name)}" aria-label="${closed ? 'Expand' : 'Collapse'} ${esc(retired ? 'Retired feeds' : name)}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14l-7 9z" fill="currentColor"/></svg></button><a href="#/folder/${encodeURIComponent(name)}" class="name">${retired ? '📦 Retired feeds' : `📁 ${esc(name)}`}</a>${retired ? `<span class="count muted">${folders.get(name).length}</span>` : count(n)}</div>
      <div class="folder-feeds">${list.map(feedRow).join('')}</div></div>`;
  }
  if (S.feeds.length && !shownFolders.length) html += `<p class="nav-note">All caught up. <button class="linkish" data-act="toggleallfeeds">Show all feeds</button></p>`;
  if (!S.feeds.length) html += `<p class="nav-note">No subscriptions yet. Press ＋ Subscribe to pick some.</p>`;
  if (S.ownProgress) html += `<p class="nav-note progress">⟳ Fetching your feeds… ${S.ownProgress.done} of ${S.ownProgress.total}</p>`;
  if (S.abPaused && abState()?.name) html += `<p class="nav-note warn">⏸ Automatic backup paused · <button class="linkish" data-act="resumebackup">Resume</button></p>`;
  html += `<p class="nav-note">${S.index.updated ? `Updated ${agoText(S.index.updated)}` : S.index.missing ? 'Waiting for the first feed update' : ''} · <button class="linkish" data-act="refresh">Refresh</button> · <a href="#/health" class="linkish">🩺 Feed health</a></p>`;
  // Nothing changed (common while feeds refresh): leave the DOM alone.
  if (html !== S.sidebarHTML) { S.sidebarHTML = html; nav.innerHTML = html; }
}

// Each topic's colour (see [data-hue] in style.css).
const HUES = ['blue', 'purple', 'green', 'orange', 'teal', 'pink', 'indigo', 'amber', 'red'];
const SMART_HUES = {
  'topic:politics': 'indigo', 'topic:conflict': 'red', 'topic:business': 'green', 'topic:tech': 'blue', 'topic:ai': 'purple',
  'topic:crypto': 'amber', 'topic:science': 'teal', 'topic:health': 'pink', 'topic:climate': 'green', 'topic:security': 'orange',
  'topic:sport': 'teal', 'topic:games': 'purple', 'topic:culture': 'pink', 'topic:programming': 'indigo',
  'meta:today': 'blue', 'meta:video': 'red', 'meta:audio': 'purple', 'meta:long': 'teal', 'meta:opinion': 'amber',
};
const hueOf = (id) => SMART_HUES[id] || HUES[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length];

/** Smart folders under Starred: languages, topics and kinds, each with its unread count (empty ones hidden). */
function smartSidebarHTML(active, count) {
  if (!S.smart) return '';
  const unreadIn = (id) => { let n = 0; for (const it of S.smart.get(id) || []) if (!isRead(it.id)) n++; return n; };
  const row = (id) => {
    const n = unreadIn(id);
    if (!n && !active('smart', id)) return '';
    const i = smartInfo(id);
    return `<a class="nav-item smart${active('smart', id)}" data-hue="${hueOf(id)}" href="#/smart/${encodeURIComponent(id)}"><span class="ico">${i.icon}</span><span class="name">${esc(i.name)}</span>${count(n)}</a>`;
  };
  const langs = Object.keys(LANGS).map((k) => 'lang:' + k).map((id) => [id, unreadIn(id)]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).map(([id]) => row(id)).join('');
  const groups = [
    ['__smart_lang', '🌐 Languages', langs],
    ['__smart_topic', '🧭 Topics', TOPICS.map((t) => row('topic:' + t.id)).join('')],
    ['__smart_kind', '🔎 By kind', META.map((m) => row('meta:' + m.id)).join('')],
  ].filter(([, , rows]) => rows);
  if (!groups.length) return '';
  return `<div class="nav-section"><span>Smart folders</span></div>` + groups.map(([key, label, rows]) => {
    const closed = folderClosed(key);
    return `<div class="folder smart-group${closed ? ' closed' : ''}">
      <div class="nav-item folder-row"><button class="twisty" data-folder="${key}" aria-label="${closed ? 'Expand' : 'Collapse'} ${esc(label.slice(3))}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14l-7 9z" fill="currentColor"/></svg></button><button class="name linkish group-name" data-folder-toggle="${key}">${label}</button></div>
      <div class="folder-feeds">${rows}</div></div>`;
  }).join('');
}

// The header line, plus "Show them" when a search found more matches while you read.
const headerSubHTML = () => (S.view.type === 'health' ? esc(healthCounts().line) : esc(headerSub())) + (S.view.pending ? ' · <button class="linkish" data-act="showpending">Show them</button>' : '');
function renderHeaderCounts() {
  const el = $('#viewHeader .sub');
  if (el) el.innerHTML = headerSubHTML();
}

function headerSub() {
  const all = sourceItems();
  const unread = unreadOf(all);
  const v = S.view;
  if (v.type === 'starred') return `${all.length} starred`;
  if (v.type === 'smart') return `${unread} unread · smart folder`;
  if (v.type === 'search') return v.status || `${all.length} results, best matches first`;
  if (v.type === 'feed') {
    const f = S.feedById.get(v.id);
    if (f?.retired) return `📦 Retired: ${f.retiredWhy || 'dead'}, so it's no longer fetched. ${f.error || ''}`;
    if (f?.error) return `⚠ ${healthNote(f)}`;
    if (f && quietSince(f)) return `${unread} unread · 💤 Quiet: ${quietSince(f) === -1 ? 'nothing posted yet' : `last post on ${new Date(quietSince(f)).toLocaleDateString(undefined, { dateStyle: 'medium' })}`}. It still works, so it stays.`;
    if (f?.fetchUrl && !f.error) return `${unread} unread · This feed moved; it's now read from ${host(f.fetchUrl)}.`;
    if (f?.via) return `${unread} unread · Google News can't be read through the relay, so this search comes from ${f.via}.`;
  }
  return `${unread} unread${all.length !== unread ? ` of ${all.length}` : ''}`;
}

function renderHeader() {
  const v = S.view;
  const h = $('#viewHeader');
  if (v.type === 'home') { h.innerHTML = ''; return; }
  if (v.type === 'health') {
    h.innerHTML = `<div class="vh-title"><h1>🩺 Feed health</h1><p class="sub">${esc(healthCounts().line)}</p></div>
      <div class="vh-actions"><button data-act="checkfeeds" class="ai" ${S.ownProgress ? 'disabled' : ''} title="Fetch every feed now and apply the dead-or-alive rules">${S.ownProgress ? `Checking… ${S.ownProgress.done} of ${S.ownProgress.total}` : '⟳ Check all feeds now'}</button></div>`;
    return;
  }
  const feed = v.type === 'feed' ? S.feedById.get(v.id) : null;
  const filterable = !['starred', 'search', 'smart'].includes(v.type);
  h.innerHTML = `
    <div class="vh-title">
      <h1>${feed ? avatar(feed, true) : ''}${esc(viewTitle())}</h1>
      <p class="sub">${headerSubHTML()}</p>
      ${feed ? `<p class="feed-addr"><span title="This feed's address">${esc(feed.url)}</span>${feed.fetchUrl ? ` <span class="muted">→ now ${esc(feed.fetchUrl)}</span>` : ''}${feed.via ? ` <span class="muted">· from ${esc(feed.via)}</span>` : ''} <button class="linkish" data-act="copyaddr">Copy</button></p>` : ''}
    </div>
    <div class="vh-actions">
      ${filterable ? `<div class="seg" role="group" aria-label="Show"><button data-act="unread" class="${S.settings.unreadOnly ? 'on' : ''}">Unread</button><button data-act="allitems" class="${S.settings.unreadOnly ? '' : 'on'}">All</button></div>` : ''}
      <div class="seg" role="group" aria-label="View"><button data-act="list" class="${S.settings.mode === 'list' ? 'on' : ''}" title="List view (1)">☰ List</button><button data-act="expanded" class="${S.settings.mode === 'expanded' ? 'on' : ''}" title="Expanded view (2)">▤ Expanded</button>${innerWidth >= PANE_MIN_WIDTH ? `<button data-act="pane" class="${S.settings.mode === 'pane' ? 'on' : ''}" title="Reading pane: the list on the left, the article on the right (3)">◫ Pane</button>` : ''}</div>
      ${v.type !== 'search' ? `<div class="seg" role="group" aria-label="Order"><button data-act="newest" class="${S.settings.sort !== 'oldest' ? 'on' : ''}" title="Newest first">↓ Newest</button><button data-act="oldest" class="${S.settings.sort === 'oldest' ? 'on' : ''}" title="Oldest first">↑ Oldest</button></div>` : ''}
      ${v.type !== 'starred' ? `<details class="menu"><summary class="button" title="Mark as read (Shift+A marks all)">✓ Mark read ▾</summary><div class="menu-list"><button data-act="markall">All</button><button data-act="markold" data-days="1">Older than a day</button><button data-act="markold" data-days="7">Older than a week</button></div></details>` : ''}
      ${v.type === 'topic' ? `<button data-act="renametopic">✎ Rename topic</button>` : ''}
      <button data-act="brief" class="ai" title="Ask your AI assistant for a short briefing on this list">✨ Brief me</button>
      ${v.type === 'search' || v.type === 'topic' || (v.type === 'feed' && !!(bingNewsQuery(feed?.url) || googleNewsQuery(feed?.url))) ? `<button data-act="investigate" class="ai" title="Dig into this with an AI assistant on the side (Grok can search X)">🕵️ Investigate</button>` : ''}
      ${v.type === 'search' ? `<button data-act="savetopic" title="Follow this search as an AI topic">＋ Save as topic</button>` : ''}
      ${v.type === 'topic' ? `<button data-act="deltopic" class="ghost" title="Delete this topic">Delete topic</button>` : ''}
      ${v.type === 'folder' && v.id === RETIRED && S.feeds.some((f) => f.retired) ? `<button data-act="unsubretired" class="ghost danger">Delete all retired feeds</button>` : ''}
      ${feed?.retired && feed.own ? `<button data-act="keepfeed" data-id="${esc(feed.id)}">↻ Keep trying</button>` : feed?.own && feed.error ? `<button data-act="retry">⟳ Try again</button>` : ''}
      ${feed ? `<button data-act="editfeed">✎ Edit</button>` : ''}
      ${v.type === 'folder' && v.id && v.id !== RETIRED ? `<button data-act="renamefolder">✎ Rename</button><button data-act="sharefolder" title="Save this folder's feeds as an OPML file to share">⇪ Share folder</button><button data-act="deletefolder" class="ghost danger">Delete folder</button>` : ''}
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
    <div class="row">
      <button class="star${star ? ' on' : ''}" data-act="star" aria-label="${star ? 'Unstar' : 'Star'}" title="Star (s)">${star ? '★' : '☆'}</button>
      <span class="src">${avatar(f)}${esc(f?.title || '')}</span>
      <button type="button" class="line" data-act="toggle" aria-expanded="${expanded}"><span class="t">${esc(it.t)}</span><span class="snip"> – ${esc(it.s)}</span></button>
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
    <h2><a href="${esc(safeUrl(it.l) || '#')}" target="_blank" rel="noopener noreferrer">${esc(it.t)} <span class="ext">↗</span></a></h2>
    <p class="meta">from <a href="#/feed/${esc(it.f)}">${esc(f?.title || 'a feed')}</a>${it.a ? ` by ${esc(it.a)}` : ''} · ${esc(new Date(it.d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</p>
    <div class="content" data-content><p class="loading">${esc(it.s || '')}</p></div>
    <div class="actions">
      <button data-act="star" class="${star ? 'on' : ''}">${star ? '★ Starred' : '☆ Star'}</button>
      <button data-act="unread">${isRead(it.id) ? '◌ Keep unread' : '● Mark read'}</button>
      <a class="button" href="${esc(safeUrl(it.l) || '#')}" target="_blank" rel="noopener noreferrer">Open original ↗</a>
      <button data-act="fullarticle" title="Get the whole article through the relay, without ads or trackers">📄 Full article</button>
      <button data-act="summarize" class="ai">✨ Summarize</button>
      <button data-act="related">🔗 More like this</button>
      <button data-act="digdeeper" class="ai" title="Investigate this story with an AI assistant on the side (Grok can search X)">🕵️ Dig deeper</button>
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
  if (!html) { box.innerHTML = `<p>${esc(it.s || '')}</p>${safeUrl(it.i) ? `<img src="${esc(safeUrl(it.i))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}`; return; }
  box.innerHTML = sanitize(html, safeUrl(it.l) || location.href);
  if (safeUrl(it.i) && !box.querySelector('img')) box.insertAdjacentHTML('afterbegin', `<img class="lead" src="${esc(safeUrl(it.i))}" alt="" loading="lazy" referrerpolicy="no-referrer">`);
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
    if (!img.hasAttribute('alt')) img.alt = ''; // no description from the feed: decorative, so screen readers skip it
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
  if (reset) { S.list = viewItems(); S.shown = 0; S.cur = -1; list.innerHTML = ''; list.scrollTop = 0; if (paneOn()) readerEmpty(); }
  if (!S.list.length) {
    list.innerHTML = emptyHTML();
    return;
  }
  const next = S.list.slice(S.shown, S.shown + PAGE);
  list.querySelector('.more')?.remove();
  const from = S.shown;
  list.insertAdjacentHTML('beforeend', next.map((it, k) => entryHTML(it, S.shown + k)).join(''));
  S.shown += next.length;
  // Only the articles just added: ones above that you kept unread must stay unread.
  if (S.settings.mode === 'expanded') list.querySelectorAll('article.expanded').forEach((a) => { if (+a.dataset.idx >= from) { fillContent(a); readObserver.observe(a); } });
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
  if (v.type === 'smart') return `<div class="empty"><p class="big">🎉</p><p><b>All caught up.</b> No unread articles here.</p><p><button data-act="surprise">🎲 Surprise me</button></p></div>`;
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
  const unread = S.uniq.filter((i) => !isRead(i.id));
  const fresh = unread.filter((i) => i.i).slice(0, 6);
  const freshIds = new Set(fresh.map((i) => i.id));
  const latest = unread.filter((i) => !freshIds.has(i.id)).slice(0, 8);
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
        return `<a class="card" href="#/feed/${esc(it.f)}" data-open="${esc(it.id)}"><img src="${esc(safeUrl(it.i))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"><span class="card-src">${esc(f?.title || '')} · ${ago(it.d)}</span><span class="card-t">${esc(it.t)}</span></a>`;
      }).join('')}</div>` : ''}
      ${latest.length ? `<h2 class="home-h">Latest</h2><div class="mini-list">${latest.map((it) => `<a href="#/feed/${esc(it.f)}" data-open="${esc(it.id)}"><span class="src">${esc(S.feedById.get(it.f)?.title || '')}</span><span class="t">${esc(it.t)}</span><time>${ago(it.d)}</time></a>`).join('')}</div>` : ''}
      <h2 class="home-h">AI topics</h2>
      <p class="hint">Follow a subject across every feed. The AI matches articles by meaning, not just keywords.</p>
      <div class="chips">${S.topics.map((t) => `<a class="chip" href="#/topic/${t.id}">✨ ${esc(t.name)}${S.vectorsState !== 'loading' ? ` <b>${unreadOf(topicMatches(t).items)}</b>` : ''}</a>`).join('')}<button class="chip add" data-act="newtopic">＋ New topic</button></div>
      ${healthSummaryHTML()}
      ${store.get('deviceNoteDismissed', false) ? deviceNoteHTML(false) : ''}
    </section>`;
}

function updateTitle() {
  const n = S.unread;
  document.title = (S.view.type === 'home' ? 'Sala Reader' : `${viewTitle()} · Sala Reader`) + (n ? ` (${n > 999 ? '999+' : n})` : '');
  // The installed app's Dock or taskbar icon shows the unread count.
  if (navigator.setAppBadge && n !== S.badge) { S.badge = n; (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); }
}

// ---------- organising: rename and move feeds, rename and delete folders ----------

const allFolderNames = () => [...new Set(S.feeds.flatMap(feedFolders))].filter((n) => n && n !== RETIRED).sort((a, b) => a.localeCompare(b));

/** Puts a feed in exactly these folders. */
function setFeedFolders(sub, names) {
  const list = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  sub.folder = list[0] || '';
  if (list.length > 1) sub.folders = list.slice(1); else delete sub.folders;
}

function openEditFeed(id) {
  const f = S.feedById.get(id);
  const sub = f && liveSub(f.url);
  if (!sub) return;
  S.editing = sub.url;
  $('#editFeedName').value = f.title;
  const mine = new Set(feedFolders(f).filter((n) => n !== RETIRED));
  $('#editFeedFolders').innerHTML = allFolderNames().map((n) => `<label class="check"><input type="checkbox" value="${esc(n)}"${mine.has(n) ? ' checked' : ''}> 📁 ${esc(n)}</label>`).join('') || '<p class="hint">No folders yet.</p>';
  $('#editFeedNewFolder').value = '';
  $('#editFeedAddr').textContent = f.url;
  $('#editFeedDialog').showModal();
}

function saveEditFeed() {
  const sub = liveSub(S.editing);
  if (!sub) return;
  const name = $('#editFeedName').value.trim();
  if (name) { sub.title = name; sub.titleSet = true; }
  const picked = [...document.querySelectorAll('#editFeedFolders input:checked')].map((c) => c.value);
  const extra = $('#editFeedNewFolder').value.trim();
  if (extra) picked.push(extra);
  setFeedFolders(sub, picked);
  saveSubs();
  rebuild();
  render();
  toast('Saved');
}

/** Moves a feed out of one folder into another (drag and drop in the sidebar). */
function moveFeed(id, from, to) {
  const sub = liveSub(S.feedById.get(id)?.url);
  if (!sub || from === to || to === RETIRED) return;
  const names = feedFolders(sub).filter((n) => n && n !== from && n !== RETIRED);
  setFeedFolders(sub, [to, ...names]);
  saveSubs();
  rebuild();
  renderSidebar();
  toast(`Moved ${sub.title} to ${to}`);
}

function openFolderDialog(name, mode) {
  S.folderEditing = name;
  const n = S.feeds.filter((f) => feedFolders(f).includes(name)).length;
  $('#folderDialogTitle').textContent = mode === 'rename' ? 'Rename folder' : `Delete “${name}”?`;
  $('#folderRename').hidden = mode !== 'rename';
  $('#folderDelete').hidden = mode !== 'delete';
  $('#folderName').value = name;
  $('#folderName').required = mode === 'rename';
  $('#folderDeleteText').textContent = `It has ${n} feed${n === 1 ? '' : 's'}. Keep them (they stay in any other folders, or go unfiled), or unsubscribe from them?`;
  $('#folderDialog').showModal();
}

function renameFolder(from, to) {
  to = to.trim();
  if (!to || to === from) return;
  for (const sub of S.subs || []) if (feedFolders(sub).includes(from)) setFeedFolders(sub, feedFolders(sub).map((n) => (n === from ? to : n)));
  if (from in S.collapsed) { S.collapsed[to] = S.collapsed[from]; delete S.collapsed[from]; store.set('collapsed', S.collapsed); }
  saveSubs();
  rebuild();
  go(`#/folder/${encodeURIComponent(to)}`);
  toast(`Renamed to ${to}`);
}

function deleteFolder(name, unsubscribeToo) {
  const inside = S.feeds.filter((f) => feedFolders(f).includes(name));
  if (unsubscribeToo) for (const f of inside) unsubscribe(f.id);
  else for (const f of inside) { const sub = liveSub(f.url); if (sub) setFeedFolders(sub, feedFolders(sub).filter((n) => n !== name)); }
  saveSubs();
  rebuild();
  go('#/home');
  toast(unsubscribeToo ? `Deleted ${name} and unsubscribed from ${inside.length} feed${inside.length === 1 ? '' : 's'}` : `Deleted ${name}; its feeds were kept`);
}

// ---------- feed health: which feeds work, which are quiet, which are dead ----------

const QUIET_DAYS = 90;
/** When a working feed last posted, if that's over 90 days ago (-1: it has never posted); else 0. */
function quietSince(f) {
  if (f.error || f.retired || !f.own || !f.ok) return 0;
  const items = S.ownItems[f.id] || [];
  const last = items.reduce((m, i) => (i.dated === false ? m : Math.max(m, i.d)), 0);
  if (!items.length) return -1;
  return last && Date.now() - last > QUIET_DAYS * 864e5 ? last : 0;
}

/** One line on a failing feed: what's wrong, and what will happen. */
function healthNote(f) {
  const kind = f.failKind || failKind({ message: f.error });
  const span = (t) => { const ms = Date.now() - t; return ms < 36e5 ? `${Math.max(1, Math.round(ms / 6e4))} min` : ms < 2 * 864e5 ? `${Math.round(ms / 36e5)} h` : `${Math.round(ms / 864e5)} days`; };
  const since = f.failSince ? ` for ${span(f.failSince)}` : '';
  const left = (ms) => { const d = Math.ceil(ms / 864e5); return d <= 1 ? 'within a day' : `in ${d} days`; };
  const now = Date.now();
  const plan = f.keep ? 'You chose to keep it: tried daily, never retired.'
    : kind === 'relay' ? "Not the feed's fault; tried again within the hour."
    : kind === 'gone' || kind === 'notfeed' ? `Retired ${left((f.kindSince || now) + DEAD_AFTER[kind] - now)} if it stays like this.`
    : `Left alone and tried again automatically; retired ${left((f.failSince || now) + DEAD_AFTER.down - now)} if it never works by then.`;
  return `${FAIL_LABEL[kind]}${kind === 'relay' ? '' : since}: ${f.error} ${plan}`;
}

function healthCounts() {
  // Your own feeds are judged here; the shared catalog's feeds by its daily update, with the same rules.
  const all = S.feeds;
  const retired = all.filter((f) => f.retired);
  const trouble = all.filter((f) => !f.retired && f.error);
  const quiet = all.filter((f) => quietSince(f));
  const working = all.length - retired.length - trouble.length;
  const line = `${all.length} feeds · ${working} working${quiet.length ? ` (${quiet.length} quiet)` : ''} · ${trouble.length} having trouble · ${retired.length} retired`;
  return { retired, trouble, quiet, working, line };
}

function healthSummaryHTML() {
  const { trouble, retired, quiet } = healthCounts();
  if (!trouble.length && !retired.length && !quiet.length) return '';
  return `<h2 class="home-h">Feed health</h2><p class="hint">${trouble.length ? `⚠ <b>${trouble.length}</b> having trouble (left alone and retried automatically) · ` : ''}${retired.length ? `📦 <b>${retired.length}</b> retired as dead · ` : ''}${quiet.length ? `💤 <b>${quiet.length}</b> quiet but working · ` : ''}<a href="#/health">See feed health →</a></p>`;
}

function renderHealth() {
  const { trouble, retired, quiet } = healthCounts();
  const row = (f, note) => `<li><div class="r-main">${avatar(f)}<a href="#/feed/${esc(f.id)}" class="r-title">${esc(f.title)}</a><span class="muted r-why">${esc(note)}</span><span class="muted r-addr">${esc(f.url)}</span></div></li>`;
  const byKind = (k) => trouble.filter((f) => (f.failKind || failKind({ message: f.error })) === k);
  const group = (title, hint, list, note) => (list.length ? `<h2 class="home-h">${title} <span class="muted">${list.length}</span></h2><p class="hint">${hint}</p><ul class="retired-list health-list">${list.sort((a, b) => a.title.localeCompare(b.title)).map((f) => row(f, note(f))).join('')}</ul>` : '');
  $('#list').innerHTML = `<section class="health">
    <p class="hint">Every feed that stops working gets a decision. <b>Dead</b> feeds are retired: their address is gone (404/410) for a day, or no longer a feed for 3 days, or they haven't worked at all for a month. Everything else is <b>left alone</b> and tried again automatically: a site that's down or blocking readers for now, or a feed that simply hasn't posted in a while. Problems with the relay never count against a feed.</p>
    ${group('⚠ Gone, being confirmed', 'The address answers “not found” and no new address was found. Retired after a day if it stays that way.', byKind('gone'), healthNote)}
    ${group('⚠ No longer a feed, being confirmed', 'The address shows a web page (or something else) and no feed was found on the site. Retired after 3 days.', byKind('notfeed'), healthNote)}
    ${group('⏳ Site down', 'Left alone: tried hourly, then every 6 hours, then daily. Retired only after a month.', byKind('down'), healthNote)}
    ${group('🚫 Blocked by the site', 'The site exists but refuses feed readers right now. Left alone and tried again; retired only after a month of never being readable.', byKind('blocked'), healthNote)}
    ${group('🔌 Waiting for the relay', "The relay was busy or unreachable. Not the feeds' fault; they're tried again within the hour.", byKind('relay'), healthNote)}
    ${group('📦 Retired as dead', 'No longer fetched. Open <a href="#/folder/' + RETIRED + '">Retired feeds</a> to keep trying any of them, or unsubscribe.', retired, (f) => `${f.retiredWhy ? f.retiredWhy[0].toUpperCase() + f.retiredWhy.slice(1) : 'Dead'}: ${f.error || ''}`)}
    ${group('💤 Quiet but working', `They still answer, but nothing new in ${QUIET_DAYS}+ days. Left alone; they're checked daily.`, quiet, (f) => (quietSince(f) === -1 ? 'Nothing posted yet' : `Last post on ${new Date(quietSince(f)).toLocaleDateString(undefined, { dateStyle: 'medium' })}`))}
    ${!trouble.length && !retired.length && !quiet.length ? '<div class="empty"><p class="big">✅</p><p>Every feed works.</p></div>' : ''}
  </section>`;
}

/** Fetches every one of your feeds now (retired ones too) and applies the rules. */
async function checkAllFeeds() {
  for (const sub of S.subs || []) if (sub.own && sub.error) delete sub.probedAt; // look for moved feeds again
  toast('Checking every feed. With many feeds this takes a while; the relay allows 60 a minute.', 5000);
  const run = refreshOwnFeeds({ force: true, wait: true, includeRetired: true });
  renderHeader();
  await run;
  rebuild();
  if (S.view.type === 'health') render(); else renderSidebar();
  const { trouble, retired } = healthCounts();
  toast(`✓ Checked. ${trouble.length} having trouble, ${retired.length} retired.`, 5000);
}

/** The Retired feeds page: each feed, why it was retired, and what you can do. */
function renderRetired() {
  const list = S.feeds.filter((f) => f.retired).sort((a, b) => a.title.localeCompare(b.title));
  $('#list').innerHTML = list.length
    ? `<p class="hint retired-intro">These feeds are dead: their address is gone (404/410) or no longer a feed, or they haven't worked for a month. They're no longer fetched. Keep trying the ones you want back; unsubscribe from the rest. <a href="#/health">🩺 Feed health</a></p>
       <ul class="retired-list">${list.map((f) => `<li data-feed="${esc(f.id)}">
         <div class="r-main">${avatar(f)}<a href="#/feed/${esc(f.id)}" class="r-title">${esc(f.title)}</a>
           <span class="muted r-why">${f.retiredWhy ? `<b>${esc(f.retiredWhy[0].toUpperCase() + f.retiredWhy.slice(1))}</b>${f.failSince ? ` since ${esc(new Date(f.failSince).toLocaleDateString())}` : ''}: ` : ''}${esc(f.error || '')}</span><span class="muted r-addr">${esc(f.url)}</span></div>
         <div class="r-actions">${f.own ? `<button data-act="keepfeed" data-id="${esc(f.id)}">↻ Keep trying</button>` : '<span class="muted">Shared catalog feed: checked again weekly</span>'}<button data-act="unsubone" data-id="${esc(f.id)}" class="ghost danger">Unsubscribe</button></div></li>`).join('')}</ul>`
    : `<div class="empty"><p class="big">📦</p><p>No retired feeds.</p></div>`;
}

/** Brings a retired feed back: it returns to its folders and is fetched now. */
function keepFeed(id) {
  const sub = liveSub(S.feedById.get(id)?.url);
  if (!sub) return;
  delete sub.retired; delete sub.lastTry; delete sub.probedAt;
  sub.keep = true; // you chose it: not retired again (tried daily while it fails)
  saveSubs();
  rebuild();
  render();
  toast(`Trying ${sub.title} again…`);
  refreshOwnFeeds();
}

function render() {
  document.body.classList.toggle('pane', paneOn());
  renderSidebar();
  renderHeader();
  if (S.view.type === 'home') renderHome();
  else if (S.view.type === 'health') renderHealth();
  else if (S.view.type === 'folder' && S.view.id === RETIRED) renderRetired();
  else renderList();
  updateTitle();
}

function updateEntryDom(id) {
  for (const a of document.querySelectorAll(`article.entry[data-id="${CSS.escape(id)}"]`)) {
    a.classList.toggle('read', isRead(id));
    const star = !!S.starred[id];
    const sb = a.querySelector('.row .star');
    if (sb) { sb.classList.toggle('on', star); sb.textContent = star ? '★' : '☆'; }
    const bs = a.querySelector('.actions [data-act="star"]');
    if (bs) { bs.classList.toggle('on', star); bs.textContent = star ? '★ Starred' : '☆ Star'; }
    const bu = a.querySelector('.actions [data-act="unread"]');
    if (bu) bu.textContent = isRead(id) ? '◌ Keep unread' : '● Mark read';
  }
  updateTitle();
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
    if (listMode()) closeEntry(prev);
  }
  S.cur = idx;
  const a = all[idx];
  a.classList.add('current');
  if (open) openEntry(a);
  if (scroll && paneOn()) {
    // Only the list scrolls (scrollIntoView would also move the page around it).
    const list = $('#list');
    const top = a.offsetTop, bottom = top + a.offsetHeight; // #list is the offset parent in the pane
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }
  else if (scroll) {
    // Scroll so the article sits just below the sticky top bar and view header.
    const offset = $('.top').offsetHeight + $('#viewHeader').offsetHeight + 8;
    const r = a.getBoundingClientRect();
    if (open && listMode()) window.scrollTo({ top: r.top + scrollY - offset, behavior: 'smooth' });
    else if (r.top < offset || r.bottom > innerHeight) window.scrollTo({ top: r.top + scrollY - offset, behavior: 'smooth' });
  }
}

function openEntry(a) {
  const id = a.dataset.id;
  if (paneOn()) showInReader(id);
  else if (listMode() && !a.classList.contains('open')) {
    a.classList.add('open');
    a.querySelector('.line')?.setAttribute('aria-expanded', 'true');
    a.insertAdjacentHTML('beforeend', `<div class="body">${bodyHTML(S.byId.get(id) || S.starred[id])}</div>`);
    fillContent(a);
  }
  S.view.keep?.add(id); // keep it visible in "unread only" until you leave the view
  if (!isRead(id)) markRead(id);
}

function closeEntry(a) {
  a.classList.remove('open');
  a.querySelector('.line')?.setAttribute('aria-expanded', 'false');
  a.querySelector('.body')?.remove();
}

function toggleEntry(a) {
  const idx = +a.dataset.idx;
  if (paneOn()) { select(idx, { open: true, scroll: false }); return; }
  if (listMode() && a.classList.contains('open') && S.cur === idx) { closeEntry(a); return; }
  select(idx, { open: true, scroll: listMode() });
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
  const pool = S.uniq.filter((i) => !isRead(i.id));
  const pick = (pool.length ? pool : S.uniq)[Math.floor(Math.random() * (pool.length || S.uniq.length))];
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
    const scored = S.uniq.filter((o) => !twinsOf(it.id).includes(o.id) && S.vectors.has(o.id)).map((o) => [o, dot(v, S.vectors.get(o.id))]).filter(([, s]) => s > 0.45).sort((a, b) => b[1] - a[1]).slice(0, 6);
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
    const url = safeUrl(it.l);
    if (!url) return;
    if (navigator.share) { await navigator.share({ title: it.t, url }); return; }
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch { /* cancelled */ }
}

// ---------- investigations: dig into a subject with an AI assistant ----------
//
// An investigation is a subject you're digging into: a side panel where you
// question an assistant about the articles in your reader, with Grok also
// searching X and the web; and it can follow the subject (an AI topic, a news
// search feed, and an X watch), opening with what's new since you last looked.
// Everything is kept on this device. Questions go only to the assistant you use.

const INV_ARTICLES = 15;      // articles given to the assistant with each question
const X_RECHECK_MS = 30 * 60e3; // an X watch checks again on opening after 30 minutes

const invById = (id) => S.invs.find((x) => x.id === id);
// Only what's worth keeping: not the working state of a question in progress.
const saveInvs = () => store.set('investigations', S.invs.map(({ _pool, abort, busy, busyText, sinceLast, ...keep }) => keep));
const grokKey = () => S.settings.keys.xai || '';

/** The assistant an investigation uses: Grok when you have its key (it can search X), else your pick. */
function invAssistant() {
  if (grokKey()) return { p: provider('xai'), key: grokKey(), model: S.settings.models.xai || 'auto', live: true };
  return { ...ai(), live: false };
}

/** Articles in your reader about the investigation, best first (cached until articles change). */
function invPool(inv) {
  const key = `${S.version}|${S.settings.threshold}|${modelKey()}`;
  if (inv._pool?.key === key) return inv._pool.items;
  const qv = inv.qv && inv.qvModel === modelKey() ? Float32Array.from(inv.qv) : null;
  const phrase = wordRe(inv.query.trim());
  const words = inv.query.trim().split(/\s+/).filter((w) => w.length > 2).map(wordRe);
  const scored = [];
  for (const it of S.uniq) {
    const hay = `${it.t} ${it.s}`;
    let score = 0;
    const v = qv && S.vectors.get(it.id);
    if (v) score = dot(qv, v);
    if (phrase.test(hay)) score = Math.max(score, 0.99);
    else if (words.length > 1 && words.every((w) => w.test(hay))) score = Math.max(score, 0.6);
    if (it.id === inv.seed) score = 2;
    if (inv.follow?.feedId && it.f === inv.follow.feedId) score = Math.max(score, 0.7);
    if (score >= S.settings.threshold) scored.push([it, score]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  inv._pool = { key, items: scored.map(([it]) => it) };
  return inv._pool.items;
}

/** New articles about it since you last looked. */
const invNew = (inv) => (inv.lastOpened ? invPool(inv).filter((it) => it.d > inv.lastOpened) : []);

/** Starts (or reopens) an investigation of a search, a topic or an article. */
async function startInvestigation({ query, name, articleId }) {
  query = query.trim();
  let inv = S.invs.find((x) => x.query.toLowerCase() === query.toLowerCase());
  if (!inv) {
    inv = { id: hash(query + Date.now()), name: (name || query).replace(/^./, (c) => c.toUpperCase()).slice(0, 80), query, created: Date.now(), lastOpened: 0, follow: {}, thread: [], ...(articleId ? { seed: articleId } : {}) };
    S.invs.unshift(inv);
    saveInvs();
  }
  openInvestigation(inv.id);
  // Its meaning, for finding related articles (in the background; word matches work meanwhile).
  if (!inv.qv || inv.qvModel !== modelKey()) {
    try {
      const seed = articleId && (S.byId.get(articleId) || S.starred[articleId]);
      const [qv] = await embed([seed ? embedText(seed) : query]);
      inv.qv = Array.from(qv, (x) => +x.toFixed(4));
      inv.qvModel = modelKey();
      delete inv._pool;
      saveInvs();
      if (S.invOpen === inv.id) renderInv();
      renderSidebar();
    } catch (e) { console.warn('Investigation vector', e); }
  }
}

function openInvestigation(id) {
  const inv = invById(id);
  if (!inv) return;
  S.invOpen = id;
  $('#invFab').hidden = true;
  document.body.classList.add('inv-open');
  // What changed since last time, worked out before it's marked as seen.
  inv.sinceLast = inv.lastOpened ? { at: inv.lastOpened, items: invNew(inv).slice(0, 12) } : null;
  inv.lastOpened = Date.now();
  saveInvs();
  renderInv();
  renderSidebar();
  setInvWidth(savedInvWidth(), false);
  $('#invPanel').focus();
  // Watching X: check for news there too, at most every 30 minutes.
  if (inv.follow?.x && grokKey() && Date.now() - (inv.xChecked || 0) > X_RECHECK_MS && !inv.busy) askInv(inv, '', 'updates');
}

function minimizeInvestigation() {
  const inv = invById(S.invOpen);
  closeInvestigation();
  if (!inv) return;
  const fab = $('#invFab');
  fab.dataset.inv = inv.id;
  fab.textContent = `🕵️ Back to “${inv.name.length > 28 ? inv.name.slice(0, 27) + '…' : inv.name}”`;
  fab.hidden = false;
}

function closeInvestigation() {
  const fab = $('#invFab');
  if (fab) fab.hidden = true;
  S.invOpen = null;
  document.body.classList.remove('inv-open');
  $('#invPanel').innerHTML = '';
  renderSidebar();
}

/* Separators beside the articles: drag one (or focus it and use the arrow
   keys) to make the sidebar or an investigation wider or narrower. Widths
   are a preference for this device only. Double-click puts one back. */
const MAIN_MIN = 460;
// Device-only preferences use the srl. prefix (sr. keys are moved into the database at start).
const PANES = {
  inv: { handle: '#invResizer', pane: '#invPanel', cssVar: '--inv-w', key: 'srl.invWidth', min: 280, side: 'right' },
  nav: { handle: '#navResizer', pane: '#sidebar', cssVar: '--nav-w', key: 'srl.navWidth', min: 180, maxCap: 440, side: 'left' },
  list: { handle: '#listResizer', pane: '#list', cssVar: '--list-w', key: 'srl.listWidth', min: 260, side: 'left' },
};
/** Width the pane is showing as a column (0 when hidden or floating over the page). */
function columnWidth(sel) {
  const el = $(sel);
  return el && el.offsetParent && getComputedStyle(el).position !== 'fixed' ? el.offsetWidth : 0;
}
function paneMax(name) {
  const c = PANES[name];
  // The article list leaves the reading pane at least 380px.
  if (name === 'list') return Math.max(c.min, ($('main')?.clientWidth || innerWidth) - 20 - 9 - 380);
  const other = name === 'inv' ? '#sidebar' : '#invPanel';
  const room = window.innerWidth - columnWidth(other) - (paneOn() ? 700 : MAIN_MIN);
  return Math.max(c.min, Math.min(room, c.maxCap || window.innerWidth * 0.7));
}
function savedWidth(name) { try { const w = +localStorage.getItem(PANES[name].key); return w > 0 ? w : null; } catch { return null; } }
function setPaneWidth(name, w, save = true) {
  const c = PANES[name], root = document.documentElement.style;
  if (w == null) {
    root.removeProperty(c.cssVar);
    if (save) try { localStorage.removeItem(c.key); } catch {}
  } else {
    w = Math.round(Math.min(paneMax(name), Math.max(c.min, w)));
    root.setProperty(c.cssVar, w + 'px');
    if (save) try { localStorage.setItem(c.key, String(w)); } catch {}
  }
  const h = $(c.handle), now = $(c.pane)?.offsetWidth || w || c.min;
  if (h) { h.setAttribute('aria-valuenow', String(now)); h.setAttribute('aria-valuemin', String(c.min)); h.setAttribute('aria-valuemax', String(Math.round(paneMax(name)))); }
}
const restorePane = (name) => { const w = savedWidth(name); if (w) setPaneWidth(name, w, false); };
const setInvWidth = (w, save) => setPaneWidth('inv', w, save);
const savedInvWidth = () => savedWidth('inv');
function initResizer(name) {
  const c = PANES[name], h = $(c.handle);
  if (!h) return;
  // Dragging toward the articles makes the pane wider.
  const grow = (dx) => (c.side === 'right' ? -dx : dx);
  setPaneWidth(name, savedWidth(name), false); // also gives the handle its aria values
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    const startX = e.clientX, startW = $(c.pane).offsetWidth;
    document.body.classList.add('resizing');
    h.classList.add('dragging');
    let raf = 0, x = startX;
    const move = (ev) => { x = ev.clientX; if (!raf) raf = requestAnimationFrame(() => { raf = 0; setPaneWidth(name, startW + grow(x - startX), false); }); };
    const up = () => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', up);
      cancelAnimationFrame(raf);
      document.body.classList.remove('resizing');
      h.classList.remove('dragging');
      if (x !== startX) setPaneWidth(name, startW + grow(x - startX));
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  });
  h.addEventListener('dblclick', () => setPaneWidth(name, null));
  h.addEventListener('keydown', (e) => {
    const w = $(c.pane).offsetWidth, step = e.shiftKey ? 80 : 24;
    if (e.key === 'ArrowLeft') setPaneWidth(name, w + grow(-step));
    else if (e.key === 'ArrowRight') setPaneWidth(name, w + grow(step));
    else if (e.key === 'Home') setPaneWidth(name, paneMax(name));
    else if (e.key === 'End') setPaneWidth(name, c.min);
    else return;
    e.preventDefault(); e.stopPropagation();
  });
}
function initResizers() {
  initResizer('nav');
  initResizer('inv');
  initResizer('list');
  // A smaller window shouldn't leave the side columns crowding out the articles.
  let paneTimer = 0;
  window.addEventListener('resize', () => {
    restorePane('nav'); restorePane('inv'); restorePane('list');
    hideMenu(false);
    // Crossing the reading pane's minimum width switches the layout (and the header's Pane button).
    clearTimeout(paneTimer);
    paneTimer = setTimeout(() => {
      const paneBtn = !!$('#viewHeader [data-act="pane"]') !== innerWidth >= PANE_MIN_WIDTH;
      if (S.view.type !== 'home' && (document.body.classList.contains('pane') !== paneOn() || paneBtn)) render();
    }, 150);
  });
}

/** Plain text answers with [n] article citations, links, bullets, headings and bold. */
function formatInv(text, articles) {
  const links = [];
  let t = esc(text)
    // Markdown links and bare links, kept aside so other formatting leaves them alone.
    .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => { links.push([label, url]); return `\u0000${links.length - 1}\u0000`; })
    .replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, (m, pre, url) => { links.push([null, url.replace(/[.,;:]+$/, '')]); return `${pre}\u0000${links.length - 1}\u0000`; });
  t = t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)\*(\S[^*\n]*?)\*(?=\s|$)/g, '$1<i>$2</i>');
  let html = t.split('\n').map((line) => {
    if (/^\s*#{1,4}\s+/.test(line)) return `<h4>${line.replace(/^\s*#{1,4}\s+/, '')}</h4>`;
    if (/^\s*([-•*]|\d+[.)])\s+/.test(line)) return `<li>${line.replace(/^\s*([-•*]|\d+[.)])\s+/, '')}</li>`;
    return line.trim() ? `<p>${line}</p>` : '';
  }).join('');
  html = html.replace(/(<li>.*?<\/li>)+/g, (m) => `<ul>${m}</ul>`);
  html = html.replace(/\[(\d+)\]/g, (m, n) => { const it = articles?.[n - 1]; return it ? `<a href="#" class="cite" data-open="${esc(it.id)}" title="${esc(it.t)}">${n}</a>` : m; });
  return html.replace(/\u0000(\d+)\u0000/g, (m, k) => {
    const [label, raw] = links[+k];
    const url = safeUrl(raw.replace(/&amp;/g, '&'));
    if (!url) return esc(label || raw);
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label || esc(linkLabel(url))}</a>`;
  });
}

/** A short name for a link: @handle for X posts, the site otherwise. */
function linkLabel(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)(x|twitter)\.com$/.test(u.hostname)) { const h = u.pathname.split('/')[1]; return h && !['i', 'search', 'hashtag'].includes(h) ? '@' + h : 'X'; }
    return u.hostname.replace(/^www\./, '');
  } catch { return url; }
}
/** The video id of a YouTube link ('' if it isn't one). */
function ytId(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^(www|m|music)\./, '');
    const id = h === 'youtu.be' ? u.pathname.slice(1) : h === 'youtube.com' ? (u.searchParams.get('v') || (/^\/(shorts|live|embed)\/([\w-]{11})/.exec(u.pathname) || [])[2] || '') : '';
    return /^[\w-]{11}$/.test(id) ? id : '';
  } catch { return ''; }
}
const isXLink = (url) => /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\//i.test(url);

function invSourcesHTML(msg) {
  const arts = (msg.articles || []).map((id) => S.byId.get(id) || S.starred[id]).filter(Boolean);
  const cited = new Set([...msg.text.matchAll(/\[(\d+)\]/g)].map((m) => +m[1]));
  const usedArts = arts.map((it, k) => [it, k + 1]).filter(([, n]) => cited.has(n));
  const links = msg.links || [];
  if (!usedArts.length && !links.length) return '';
  // Videos without a title: take the name the answer gives it (its bold title or link text).
  const vids = links.filter((l) => ytId(l.url)).map((l) => {
    if (l.title) return l;
    const line = msg.text.split('\n').find((x) => x.includes(ytId(l.url))) || '';
    const name = /\*\*(.+?)\*\*/.exec(line)?.[1] || /\[([^\]]+)\]\(/.exec(line)?.[1] || line.replace(/^\s*[-*•\d.)]+\s*/, '').split(/\s+[—–-]\s+|https?:/)[0].trim();
    return { ...l, title: name.slice(0, 120) };
  });
  const xs = links.filter((l) => isXLink(l.url));
  const web = links.filter((l) => !isXLink(l.url) && !ytId(l.url));
  const li = (l, ico) => `<li><a href="${esc(safeUrl(l.url) || '#')}" target="_blank" rel="noopener noreferrer"><span class="src-ico">${ico}</span>${esc(l.title || linkLabel(l.url))}</a>${l.title ? ` <span class="muted">${esc(linkLabel(l.url))}</span>` : ''}</li>`;
  return `<details class="inv-sources"${msg === S.invs.find((x) => x.id === S.invOpen)?.thread.at(-1) ? ' open' : ''}><summary>Sources: ${[
    usedArts.length ? `${usedArts.length} from your feeds` : '', vids.length ? `${vids.length} video${vids.length === 1 ? '' : 's'}` : '', xs.length ? `${xs.length} on X` : '', web.length ? `${web.length} on the web` : '',
  ].filter(Boolean).join(' · ')}</summary>
    ${vids.length ? `<div class="yt-grid">${vids.map((l) => { const id = ytId(l.url); return `<div class="yt-item"><button class="yt-card" data-act="invplay" data-yt="${id}" aria-label="Play ${esc(l.title || 'video')}"><img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="yt-play" aria-hidden="true">▶</span></button><a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${esc(l.title || 'Watch on YouTube')}</a></div>`; }).join('')}</div>` : ''}
    <ul>
    ${usedArts.map(([it, n]) => `<li><a href="#" data-open="${esc(it.id)}"><span class="src-ico">${n}</span>${esc(it.t)}</a> <span class="muted">${esc(S.feedById.get(it.f)?.title || '')} · ${ago(it.d)}</span></li>`).join('')}
    ${xs.map((l) => li(l, '𝕏')).join('')}${web.map((l) => li(l, '🌐')).join('')}</ul></details>`;
}

const INV_PROMPTS = [
  ['x', "𝕏 What's X saying?", "What are people on X saying about this right now? Eyewitnesses, officials, journalists and experts first. Quote the key posts with their account and time, and say what's confirmed and what's only claimed."],
  ['youtube', '▶️ YouTube videos', 'Search YouTube for videos about this: news reports, eyewitness footage, official briefings and expert analysis. List up to 8, newest first, each with its title, channel, date and youtube.com link, and one line on what it shows and how trustworthy it looks. Flag re-uploads, old footage passed off as new, and AI-made videos.'],
  ['', '🧭 Timeline', 'Build a timeline of what happened, with dates and times, citing a source for each step.'],
  ['', '👥 Who & what', 'Who and what are involved: people, organisations, places, vehicles or aircraft, companies? One line each on their role, with sources.'],
  ['', '⚖️ Where sources disagree', 'Where do the sources disagree or contradict each other (numbers, causes, names, timing)? Which seems most reliable and why?'],
  ['', '❓ Still unknown', "What isn't known yet, and what should I look for next? Suggest primary sources (official statements, records, data) I can check."],
];

function renderInv() {
  const box = $('#invPanel');
  const inv = invById(S.invOpen);
  if (!box || !inv) return;
  const a = invAssistant();
  const pool = invPool(inv);
  const f = inv.follow || {};
  const since = inv.sinceLast;
  const topic = f.topicId && S.topics.find((t) => t.id === f.topicId);
  const feed = f.feedId && S.feedById.get(f.feedId);
  box.innerHTML = `
    <header class="inv-head">
      <div class="inv-title"><span aria-hidden="true">🕵️</span><h2>${esc(inv.name)}</h2><button class="mini" data-act="invrename" title="Rename" aria-label="Rename investigation">✎</button></div>
      <button class="icon-btn" data-act="invclose" aria-label="Close investigation" title="Close (Esc)">✕</button>
    </header>
    <div class="inv-scroll" id="invScroll">
      <p class="inv-meta">${pool.length} article${pool.length === 1 ? '' : 's'} in your reader · <a href="#/search/${encodeURIComponent(inv.query)}">show them</a></p>
      <div class="inv-follow" role="group" aria-label="Follow this subject">
        <span class="muted">Follow:</span>
        <button class="chip${topic ? ' on' : ''}" data-act="invfollow" data-what="topic" aria-pressed="${!!topic}" title="An AI topic in the sidebar collects new articles about this from all your feeds">✨ AI topic</button>
        <button class="chip${feed ? ' on' : ''}" data-act="invfollow" data-what="feed" aria-pressed="${!!feed}" title="A news search feed for “${esc(inv.query)}”">📰 News feed</button>
        <button class="chip${f.x ? ' on' : ''}" data-act="invfollow" data-what="x" aria-pressed="${!!f.x}" title="${grokKey() ? 'Grok checks X and the web for news when you open this' : 'Needs a Grok (xAI) key in ⚙ Settings'}">𝕏 Watch X</button>
      </div>
      ${since ? `<div class="inv-card"><h3>Since you last looked <span class="muted">(${agoText(since.at)})</span></h3>
        ${since.items.length ? `<ul>${since.items.map((it) => `<li><a href="#" data-open="${esc(it.id)}">${esc(it.t)}</a> <span class="muted">${esc(S.feedById.get(it.f)?.title || '')} · ${ago(it.d)}</span></li>`).join('')}</ul>` : '<p class="muted">No new articles in your feeds.</p>'}
        ${grokKey() ? `<button data-act="invupdates" ${inv.busy ? 'disabled' : ''}>𝕏 What's new on X & the web</button>` : ''}</div>` : ''}
      ${inv.thread.length ? '' : `<div class="inv-card intro"><p>Ask anything about <b>${esc(inv.name)}</b>. ${a.live
        ? 'Grok reads the articles in your reader and <b>searches X and the web</b> live, with links to every post and page it used.'
        : `${esc(a.p.name)} answers from the articles in your reader. <b>To search X and the web live, add a Grok (xAI) key</b> in ⚙ Settings.`}</p></div>`}
      <div class="inv-thread">${inv.thread.map((m, k) => m.role === 'user'
        ? `<div class="inv-q">${esc(m.label || m.text)}</div>`
        : `<div class="inv-a${m.error ? ' error' : ''}" data-k="${k}">${m.error ? `<p>${esc(m.text)}</p>` : formatInv(m.text, (m.articles || []).map((id) => S.byId.get(id) || S.starred[id]))}
          ${m.error ? '' : invSourcesHTML(m)}<p class="via">${esc(m.by || '')}${m.searches ? ` · ${m.searches} live search${m.searches === 1 ? '' : 'es'}` : ''} · ${ago(m.at)}</p></div>`).join('')}
        ${inv.busy ? `<div class="inv-a working" id="invLive"><p class="loading">${esc(inv.busyText || 'Thinking…')}</p></div>` : ''}</div>
    </div>
    <div class="inv-ask">
      <div class="inv-prompts">${INV_PROMPTS.filter(([x]) => !x || a.live).map(([, label, q], k) => `<button class="chip" data-act="invprompt" data-k="${k}" ${inv.busy ? 'disabled' : ''}>${label}</button>`).join('')}</div>
      <form id="invForm" class="inv-form">
        <textarea id="invInput" rows="2" placeholder="Ask about ${esc(inv.name)}…" aria-label="Your question"></textarea>
        ${inv.busy ? '<button type="button" data-act="invstop">Stop</button>' : '<button type="submit" class="primary">Ask</button>'}
      </form>
      <p class="inv-foot">${a.live ? '🔒 Questions go only to xAI with your key. Grok bills each X or web search it makes.' : `🔒 Questions go only to ${esc(a.p.name)} with your key.`}
        <button class="linkish" data-act="invexport">Export notes</button> · <button class="linkish danger" data-act="invdelete">Delete</button></p>
    </div>`;
  const sc = $('#invScroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
}

/** Asks the investigation's assistant. mode: '' (a question), 'updates' (what's new). */
async function askInv(inv, question, mode = '', label) {
  const a = invAssistant();
  if (!a.key) { needKey(); return; }
  if (inv.busy) return;
  const pool = invPool(inv);
  const articles = pool.slice(0, INV_ARTICLES);
  const since = inv.xChecked || inv.created;
  if (mode === 'updates') {
    question = `What's new about this since ${new Date(since).toUTCString()}? Search X and the web for anything newer, and check the articles below. Lead with what changed; say plainly if nothing important did.`;
    label = `𝕏 What's new since ${agoText(since)}?`;
  }
  const listing = articles.map((it, k) => `[${k + 1}] ${it.t} — ${S.feedById.get(it.f)?.title || ''}, ${new Date(it.d).toUTCString()}\n${safeUrl(it.l) || ''}\n${(it.s || '').slice(0, 300)}`).join('\n\n');
  const system = `You are an open-source intelligence (OSINT) research assistant inside Sala Reader, an RSS reader. The reader is investigating: "${inv.query}".
Today is ${new Date().toUTCString()}.
Be precise and sceptical: separate what's confirmed (by officials or several independent sources) from claims and rumours, give dates and times, name who said what, and point out contradictions. Prefer primary sources.
Cite the reader's articles by number in square brackets, like [2].${a.live ? ' You can search X and the web: do so when it helps, and give the link of every post or page you rely on (X posts as their x.com links, with the account name).' : ' You cannot browse; answer from the articles below and say when they don\'t cover something.'}
Write plain text with short paragraphs, "- " bullets and **bold** for key facts. No tables.

Articles in the reader about this (newest information may be on X or the web):
${listing || '(none yet)'}`;
  const history = inv.thread.filter((m) => !m.error).slice(-10).map((m) => ({ role: m.role, content: m.text }));
  inv.thread.push({ role: 'user', text: question, label, at: Date.now() });
  inv.busy = true;
  inv.busyText = a.live ? (mode === 'youtube' ? 'Grok is searching YouTube…' : mode === 'updates' ? 'Grok is checking X and the web…' : 'Grok is reading and searching X and the web…') : `${a.p.name} is reading your articles…`;
  inv.abort = new AbortController();
  saveInvs();
  if (S.invOpen === inv.id) renderInv();
  let acc = '';
  const live = () => {
    const el = S.invOpen === inv.id && $('#invLive');
    if (el) { el.innerHTML = formatInv(acc, articles); const sc = $('#invScroll'); if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 200) sc.scrollTop = sc.scrollHeight; }
  };
  try {
    const messages = [...history, { role: 'user', content: question }];
    let res;
    if (a.live) {
      const fromDate = mode === 'updates' ? new Date(since - 864e5).toISOString().slice(0, 10) : undefined;
      const yt = mode === 'youtube' ? { x: false, webDomains: ['youtube.com', 'youtu.be'] } : {};
      res = await askGrokLive({ apiKey: a.key, model: a.model, system, messages, fromDate, ...yt, onText: (t) => { acc += t; live(); }, signal: inv.abort.signal });
    } else {
      res = await askAI({ providerId: a.p.id, apiKey: a.key, model: a.model, system, messages, onText: (t) => { acc += t; live(); }, signal: inv.abort.signal });
    }
    inv.thread.push({ role: 'assistant', text: res.text, at: Date.now(), by: `${a.p.name} · ${res.model}`, articles: articles.map((it) => it.id), links: res.citations || [], searches: res.searches || 0 });
    if (a.live) inv.xChecked = Date.now();
  } catch (e) {
    if (e?.name === 'AbortError') {
      if (acc) inv.thread.push({ role: 'assistant', text: acc + '\n\n(stopped)', at: Date.now(), by: a.p.name, articles: articles.map((it) => it.id) });
      else inv.thread.pop();
    } else {
      const msg = /dynamically imported module|Importing a module script failed/i.test(e.message) ? "Couldn't load the AI library. Check your connection or ad blocker and try again." : e.message;
      inv.thread.push({ role: 'assistant', text: msg, at: Date.now(), error: true });
    }
  } finally {
    inv.busy = false;
    delete inv.abort;
    saveInvs();
    if (S.invOpen === inv.id) renderInv();
    renderSidebar();
  }
}

async function toggleInvFollow(inv, what) {
  inv.follow ??= {};
  const f = inv.follow;
  try {
    if (what === 'topic') {
      const existing = f.topicId && S.topics.find((t) => t.id === f.topicId);
      if (existing) { S.topics = S.topics.filter((t) => t.id !== existing.id); store.set('topics', S.topics); delete f.topicId; toast('Stopped following as an AI topic'); }
      else { toast('Making an AI topic…'); const t = await createTopic(inv.query); t.name = inv.name; store.set('topics', S.topics); f.topicId = t.id; toast(`✨ “${inv.name}” is now an AI topic in the sidebar`); }
    } else if (what === 'feed') {
      if (f.feedId && S.feedById.get(f.feedId)) { unsubscribe(f.feedId); delete f.feedId; toast('Unsubscribed from the news search'); }
      else { toast(`Adding a news search for “${inv.query}”…`); const feed = await addFeed(inv.query, 'Investigations'); f.feedId = feed.id; toast(`📰 Following news about “${inv.query}” (folder Investigations)`); }
    } else if (what === 'x') {
      if (!f.x && !grokKey()) { toast('Watching X needs a Grok (xAI) API key: add it in ⚙ Settings.', 5000); return; }
      f.x = !f.x;
      toast(f.x ? '𝕏 Watching X: Grok checks for news when you open this (every 30 minutes at most)' : 'Stopped watching X');
    }
  } catch (e) {
    const existing = /already following this search/i.test(e.message) && S.feeds.find((x) => x.url === newsSearchUrl(inv.query));
    if (existing) f.feedId = existing.id; else toast(e.message, 5000);
  }
  delete inv._pool;
  saveInvs();
  renderSidebar();
  if (S.invOpen === inv.id) renderInv();
}

function exportInv(inv) {
  const lines = [`# ${inv.name}`, '', `Investigation of “${inv.query}”, started ${new Date(inv.created).toLocaleString()}. Exported from Sala Reader ${new Date().toLocaleString()}.`, ''];
  for (const m of inv.thread) {
    if (m.role === 'user') { lines.push(`## ${m.label || m.text}`, ''); continue; }
    lines.push(m.text, '');
    const arts = (m.articles || []).map((id) => S.byId.get(id) || S.starred[id]);
    const cited = [...new Set([...m.text.matchAll(/\[(\d+)\]/g)].map((x) => +x[1]))].sort((x, y) => x - y);
    const src = [...cited.map((n) => arts[n - 1] && `[${n}] ${arts[n - 1].t}: ${arts[n - 1].l}`).filter(Boolean), ...(m.links || []).map((l) => `- ${l.title || linkLabel(l.url)}: ${l.url}`)];
    if (src.length) lines.push('Sources:', ...src, '');
    if (m.by) lines.push(`_${m.by}, ${new Date(m.at).toLocaleString()}_`, '');
  }
  download(`${inv.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'investigation'}.md`, lines.join('\n'), 'text/markdown');
}

function invAction(act, btn) {
  const inv = invById(S.invOpen);
  if (!inv) return false;
  switch (act) {
    case 'invclose': closeInvestigation(); return true;
    case 'invrename': { const n = prompt('Name this investigation', inv.name); if (n?.trim()) { inv.name = n.trim().slice(0, 80); saveInvs(); renderInv(); renderSidebar(); } return true; }
    case 'invfollow': toggleInvFollow(inv, btn.dataset.what); return true;
    case 'invupdates': askInv(inv, '', 'updates'); return true;
    case 'invprompt': { const [kind, label, q] = INV_PROMPTS.filter(([x]) => !x || invAssistant().live)[+btn.dataset.k]; askInv(inv, q, kind === 'youtube' ? 'youtube' : '', label); return true; }
    case 'invplay': {
      // Plays in the panel from YouTube's no-cookie player, only when you ask.
      const id = btn.dataset.yt;
      if (/^[\w-]{11}$/.test(id)) btn.outerHTML = `<div class="yt-frame"><iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1" title="YouTube video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`;
      return true;
    }
    case 'invstop': inv.abort?.abort(); return true;
    case 'invexport': exportInv(inv); return true;
    case 'invdelete':
      if (confirm(`Delete the investigation “${inv.name}” and its notes? (Its AI topic and news feed, if any, stay.)`)) { S.invs = S.invs.filter((x) => x.id !== inv.id); saveInvs(); closeInvestigation(); }
      return true;
    default: return false;
  }
}

/** Sidebar rows: each investigation with the count of new articles since you last looked. */
function invSidebarHTML(active, count) {
  if (!S.invs?.length) return '';
  // Unread new articles in each (since you last opened it); the ones with news come first,
  // the newest news on top, and ones you're caught up on drop below.
  const rows = S.invs.map((inv) => {
    const fresh = S.invOpen === inv.id ? [] : invNew(inv).filter((it) => !isRead(it.id));
    return { inv, n: fresh.length, latest: fresh.reduce((m, it) => Math.max(m, it.d), 0) };
  }).sort((a, b) => (b.n > 0) - (a.n > 0) || b.latest - a.latest || (b.inv.lastOpened || b.inv.created || 0) - (a.inv.lastOpened || a.inv.created || 0));
  const total = rows.reduce((t, r) => t + r.n, 0);
  const closed = folderClosed('__invs');
  return `<div class="folder inv-group${closed ? ' closed' : ''}">
    <div class="nav-section inv-section"><button class="twisty" data-folder="__invs" aria-expanded="${!closed}" aria-label="${closed ? 'Expand' : 'Collapse'} investigations"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14l-7 9z" fill="currentColor"/></svg></button><button class="linkish group-name" data-folder-toggle="__invs">Investigations</button>${closed ? count(total) : ''}</div>
    <div class="folder-feeds">${rows.map(({ inv, n }) => `<a class="nav-item inv${S.invOpen === inv.id ? ' active' : ''}" data-hue="${hueOf('i' + inv.id)}" href="#" data-inv="${esc(inv.id)}"><span class="ico">🕵️</span><span class="name">${esc(inv.name)}</span>${inv.follow?.x ? '<span class="muted" title="Watching X">𝕏</span>' : ''}${count(n)}</a>`).join('')}</div></div>`;
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
  S.settingsAtOpen = { threshold: S.settings.threshold, relayMode: S.settings.relayMode, aiModel: modelKey() };
  $('#themeSel').value = S.settings.theme;
  renderAISettings();
  $('#thresholdRange').value = S.settings.threshold;
  $('#aiModelSel').value = modelKey();
  $('#thresholdVal').textContent = `(${Math.round(S.settings.threshold * 100)}%)`;
  $('#updatesInfo').innerHTML = `The starter catalog is refreshed on GitHub whenever cron-job.org calls it. ${S.index.updated ? `Last update: <b>${esc(new Date(S.index.updated).toLocaleString())}</b> (${agoText(S.index.updated)}).` : 'No update has run yet.'} Your own feeds are fetched by this page: when you open it, and again about every 25 minutes while it's open. Requests to the relay are paced to its limit of 60 a minute, so a big import takes a few minutes; articles appear as each feed arrives.`;
  for (const r of document.querySelectorAll('input[name="relayMode"]')) r.checked = r.value === S.settings.relayMode;
  $('#ownRelay').hidden = S.settings.relayMode !== 'own';
  $('#relayInput').value = S.settings.relay;
  $('#relayToken').value = S.settings.relayToken;
  $('#relayStatus').textContent = '';
  $('#includeKeys').checked = false;
  renderAppInfo();
  renderABSettings();
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

/** OPML of all your feeds, or of one folder (to share it). Only feed addresses and names, nothing about your reading. */
function exportOPML(onlyFolder) {
  const folders = new Map();
  for (const f of S.feeds) for (const k of feedFolders(f)) {
    if (k === RETIRED || (onlyFolder && k !== onlyFolder)) continue;
    if (!folders.has(k)) folders.set(k, []);
    folders.get(k).push(f);
  }
  const x = (s) => esc(s);
  const line = (f) => `      <outline type="rss" text="${x(f.title)}" title="${x(f.title)}" xmlUrl="${x(f.url)}"${f.site ? ` htmlUrl="${x(f.site)}"` : ''}/>`;
  const body = [...folders].map(([name, list]) => (name ? `    <outline text="${x(name)}" title="${x(name)}">\n${list.map(line).join('\n')}\n    </outline>` : list.map(line).join('\n').replace(/^ {2}/gm, ''))).join('\n');
  const fileName = onlyFolder ? `${onlyFolder.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'folder'}.opml` : 'salareader.opml';
  if (onlyFolder) toast('Saved this folder as an OPML file. Send it to anyone; they import it in ⚙ Settings → Import OPML.', 5000);
  download(fileName, `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>${onlyFolder ? esc(onlyFolder) : 'Sala Reader subscriptions'}</title></head>\n  <body>\n${body}\n  </body>\n</opml>\n`, 'text/x-opml');
}

// ---------- backup: move everything to another device ----------

const BACKUP_KEYS = ['subs', 'read', 'starred', 'topics', 'investigations', 'collapsed', 'days', 'settings'];
const isPerFeedKey = (k) => k.startsWith('own:') || k.startsWith('vec:');

async function buildBackup(includeKeys) {
  await flush();
  const data = {};
  for (const k of BACKUP_KEYS) if (store.get(k) !== undefined) data[k] = store.get(k);
  data.ownItems = {};
  for (const k of store.keys()) if (k.startsWith('own:')) data.ownItems[k.slice(4)] = store.get(k);
  if (data.settings && !includeKeys) { data.settings = { ...data.settings, keys: {}, relayToken: '' }; }
  return { app: 'salareader', version: 1, exported: new Date().toISOString(), includesKeys: !!includeKeys, data };
}

async function exportBackup(includeKeys) {
  const backup = await buildBackup(includeKeys);
  download(`salareader-backup-${today()}.json`, JSON.stringify(backup), 'application/json');
  toast(includeKeys ? 'Backup saved, including your API keys: keep the file private' : 'Backup saved (API keys left out)', 4000);
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

async function importBackup(file) {
  let backup;
  try { backup = JSON.parse(await file.text()); } catch { throw new Error("That file isn't a Sala Reader backup."); }
  if (backup?.app === 'salareader' && backup.encrypted) {
    const pass = await askPass({ title: 'Encrypted backup', hint: 'Type the passphrase you chose for your automatic backups.' });
    if (!pass) return false;
    backup = await decryptBackup(backup, pass);
  }
  const d = backup?.data;
  const bad = backup?.app !== 'salareader' || !isObj(d)
    || ('subs' in d && !Array.isArray(d.subs)) || ['read', 'starred', 'collapsed', 'settings', 'ownItems'].some((k) => k in d && !isObj(d[k]))
    || ['topics', 'days', 'investigations'].some((k) => k in d && !Array.isArray(d[k]))
    || (d.subs || []).some((s) => !isObj(s) || typeof s.url !== 'string' || typeof s.id !== 'string');
  if (bad) throw new Error("That file isn't a Sala Reader backup, or it's damaged.");
  const n = d.subs?.length ?? 0;
  if (!confirm(`Replace everything on this device with the backup from ${new Date(backup.exported).toLocaleString()} (${n} subscription${n === 1 ? '' : 's'})?`)) return false;
  const keepKeys = S.settings.keys;
  const keepRelayToken = S.settings.relayToken;
  stopRefresh = true; // a feed refresh still running must not write old data back
  for (const k of store.keys()) if (BACKUP_KEYS.includes(k) || isPerFeedKey(k)) store.del(k);
  await clearBodies(); // articles' full text is fetched again; the backup holds titles and summaries
  for (const k of BACKUP_KEYS) if (k in d) store.set(k, d[k]);
  for (const [id, items] of Object.entries(d.ownItems || {})) if (Array.isArray(items)) store.set('own:' + id, items);
  // A backup without keys keeps the keys already on this device.
  if (!backup.includesKeys) store.set('settings', { ...store.get('settings', {}), keys: keepKeys, relayToken: keepRelayToken });
  frozen = true; // nothing else is written until the page reloads
  await flush();
  return true;
}

async function eraseEverything() {
  stopRefresh = true;
  try { indexedDB.deleteDatabase('salareader-folder'); } catch { /* none */ }
  for (const k of store.keys()) store.del(k);
  await clearBodies();
  frozen = true;
  await flush();
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith('sr.') || k?.startsWith('srl.')) localStorage.removeItem(k); } } catch { /* blocked */ }
}

async function importOPML(file) {
  const doc = new DOMParser().parseFromString(await file.text(), 'text/xml');
  const found = [];
  for (const o of doc.querySelectorAll('outline[xmlUrl]')) {
    const parent = o.parentElement?.closest('outline:not([xmlUrl])');
    found.push({ url: o.getAttribute('xmlUrl'), site: safeUrl(o.getAttribute('htmlUrl') || ''), title: o.getAttribute('title') || o.getAttribute('text') || host(o.getAttribute('xmlUrl')), folder: parent?.getAttribute('title') || parent?.getAttribute('text') || '' });
  }
  // One entry per address with all its folders (Feedly lists a feed once per folder it's in).
  const byUrl = new Map();
  for (const f of found) {
    if (!safeUrl(f.url)) continue;
    const g = byUrl.get(f.url);
    if (g) { if (!g.folders.includes(f.folder)) g.folders.push(f.folder); } else byUrl.set(f.url, { ...f, folders: [f.folder] });
  }
  const catalog = catalogByUrl();
  S.subs ??= [];
  const fresh = [];
  let foldersAdded = 0;
  for (const f of byUrl.values()) {
    const existing = S.subs.find((s) => s.url === f.url);
    // A feed you already have joins any folders it's in in the file.
    if (existing) {
      if (addFolders(existing, f.folders)) foldersAdded++;
      if (!existing.site && f.site) {
        existing.site = f.site;
        // With its website known, a broken feed can be looked for there: try now.
        if (existing.error) { delete existing.lastTry; delete existing.probedAt; }
      }
      continue;
    }
    const c = catalog.get(f.url);
    const [folder, ...more] = f.folders;
    const sub = c ? { id: c.id, url: c.url, title: c.title, folder } : { id: 'L' + hash(f.url), url: f.url, title: f.title, titleSet: true, folder, own: true, site: f.site || '' };
    if (more.length) sub.folders = more.filter(Boolean);
    S.subs.push(sub);
    fresh.push(f);
  }
  saveSubs();
  if (foldersAdded) toast(`${foldersAdded} feed${foldersAdded === 1 ? '' : 's'} you already had joined more folders.`, 4000);
  const mins = Math.ceil(fresh.filter((f) => !catalog.has(f.url)).length / 55);
  const already = byUrl.size - fresh.length;
  toast(`Imported ${fresh.length} feed${fresh.length === 1 ? '' : 's'}${already ? ` (${already} you already had)` : ''}. Fetching them${mins > 1 ? `, about ${mins} minutes` : ''}; articles appear as they arrive.`, 6000);
  rebuild(); render();
  await refreshOwnFeeds({ wait: true });
  rebuild(); render();
  const blocked = S.feeds.filter((f) => f.own && f.error).length;
  if (blocked && !relayUrl()) toast(`${blocked} feed${blocked === 1 ? '' : 's'} need a relay to be read. See ⚙ Settings → Your feeds.`, 6000);
}

// ---------- sidebar on phones ----------

function openSidebar() { document.body.classList.add('nav-open'); $('#scrim').hidden = false; }
function closeSidebar() { document.body.classList.remove('nav-open'); $('#scrim').hidden = true; }

// ---------- events ----------

/** Puts the saved values of these keys back into the app state (after another tab saved them). */
function applyKeys(keys) {
  const fields = { subs: 'subs', read: 'read', starred: 'starred', topics: 'topics', investigations: 'invs', collapsed: 'collapsed', days: 'days' };
  for (const k of keys) {
    if (fields[k]) S[fields[k]] = store.get(k, k === 'subs' ? null : Array.isArray(S[fields[k]]) ? [] : {});
    else if (k === 'settings') { S.settings = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) }; applyTheme(); }
    else if (k.startsWith('own:')) { bodyCache.delete(k.slice(4)); const v = store.get(k, null); if (v) S.ownItems[k.slice(4)] = v; else delete S.ownItems[k.slice(4)]; }
  }
}

function wire() {
  addEventListener('hashchange', route);

  // Another tab of the reader saved something: pick it up without losing your place.
  channel?.addEventListener('message', async (e) => {
    const keys = e.data?.keys;
    if (!Array.isArray(keys) || frozen) return;
    await reloadKeys(keys);
    // Keys this tab is about to save itself (or saving lazily) keep this tab's version.
    applyKeys(keys.filter((k) => !dirty.has(k) && !lazySaves.has(k)));
    rebuild();
    renderSidebar();
    renderHeaderCounts();
    renderStreak();
    for (const a of document.querySelectorAll('#list article.entry')) updateEntryDom(a.dataset.id);
    if (S.view.type === 'home') refreshHome();
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'invForm') return;
    e.preventDefault();
    const inv = invById(S.invOpen);
    const q = $('#invInput').value.trim();
    if (inv && q) askInv(inv, q);
  });

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
    const tw = e.target.closest('.twisty') || e.target.closest('[data-folder-toggle]')?.parentElement.querySelector('.twisty');
    if (tw) {
      const name = tw.dataset.folder;
      S.collapsed[name] = !folderClosed(name);
      store.set('collapsed', S.collapsed);
      renderSidebar();
      return;
    }
    const invRow = e.target.closest('[data-inv]');
    if (invRow) { e.preventDefault(); if (S.invOpen === invRow.dataset.inv) closeInvestigation(); else openInvestigation(invRow.dataset.inv); closeSidebar(); return; }
    if (e.target.closest('#addBtn')) openAdd();
    if (e.target.closest('#addTopicBtn, #addTopicBtn2')) openTopic();
  });

  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-open]');
    if (opener) {
      e.preventDefault();
      // On a phone the panel covers the list: tuck it away, with a button to come back.
      if (S.invOpen && opener.closest('#invPanel') && matchMedia('(max-width: 860px)').matches) minimizeInvestigation();
      openItemAnywhere(opener.dataset.open);
      return;
    }
    if (e.target.closest('#invFab')) { const id = $('#invFab').dataset.inv; $('#invFab').hidden = true; openInvestigation(id); return; }
    const btn = e.target.closest('[data-act]');
    const article = e.target.closest('article.entry');
    if (btn) {
      const act = btn.dataset.act;
      if (article && act === 'star') { e.stopPropagation(); toggleStar(article.dataset.id); return; }
      if (article && act === 'unread') { S.view.keep?.add(article.dataset.id); markRead(article.dataset.id, !isRead(article.dataset.id)); return; }
      if (article && act === 'summarize') { summarize(article); return; }
      if (article && act === 'fullarticle') { showFullArticle(article, e.target.closest('[data-act]')); return; }
      if (article && act === 'related') { related(article); return; }
      if (article && act === 'digdeeper') { digDeeper(S.byId.get(article.dataset.id) || S.starred[article.dataset.id]); return; }
      if (act.startsWith('inv') && invAction(act, btn)) return;
      if (act === 'investigate') {
        const v = S.view;
        if (v.type === 'search') startInvestigation({ query: v.q });
        else if (v.type === 'topic') { const t = S.topics.find((x) => x.id === v.id); if (t) startInvestigation({ query: t.query, name: t.name }).then(() => { const inv = S.invs.find((x) => x.query === t.query); if (inv && !inv.follow?.topicId) { inv.follow = { ...inv.follow, topicId: t.id }; saveInvs(); renderInv(); } }); }
        else if (v.type === 'feed') { const f = S.feedById.get(v.id); const q = bingNewsQuery(f.url) || googleNewsQuery(f.url) || f.title; if (q) startInvestigation({ query: q }).then(() => { const inv = S.invs.find((x) => x.query === q); if (inv && !inv.follow?.feedId) { inv.follow = { ...inv.follow, feedId: f.id }; saveInvs(); renderInv(); } }); }
        return;
      }
      if (article && act === 'share') { share(article); return; }
      switch (act) {
        case 'unread': setViewPref('unreadOnly', true); render(); return;
        case 'allitems': setViewPref('unreadOnly', false); render(); return;
        case 'newest': setViewPref('sort', 'newest'); render(); return;
        case 'oldest': setViewPref('sort', 'oldest'); render(); return;
        case 'markold': {
          const days = +btn.dataset.days;
          const cutoff = Date.now() - days * 864e5;
          btn.closest('details')?.removeAttribute('open');
          markAllRead(sourceItems().filter((i) => i.d < cutoff));
          return;
        }
        case 'renametopic': {
          const t = S.topics.find((x) => x.id === S.view.id);
          const name = t && prompt('Topic name', t.name);
          if (name?.trim()) { t.name = name.trim(); store.set('topics', S.topics); render(); }
          return;
        }
        case 'list': setMode('list'); return;
        case 'expanded': setMode('expanded'); return;
        case 'pane': setMode('pane'); return;
        case 'resumebackup': abWrite(true); return;
        case 'markall': btn.closest('details')?.removeAttribute('open'); markAllRead(sourceItems()); return;
        case 'brief': brief(); return;
        case 'surprise': surprise(); closeSidebar(); return;
        case 'refresh': refresh(); return;
        case 'copyaddr': { const f = S.feedById.get(S.view.id); if (f) navigator.clipboard?.writeText(f.url).then(() => toast('Address copied')).catch(() => {}); return; }
        case 'retry': {
          const sub = liveSub(S.feedById.get(S.view.id)?.url);
          if (!sub) return;
          btn.disabled = true;
          btn.textContent = 'Trying…';
          fetchOwnFeed({ ...sub }).catch((err) => noteFeedError(sub, err)).finally(() => { rebuild(); render(); toast(sub.error ? sub.error : `✓ ${sub.title} works again`, 4000); });
          return;
        }
        case 'keepfeed': keepFeed(btn.dataset.id); return;
        case 'checkfeeds': checkAllFeeds(); return;
        case 'toggleallfeeds': S.settings.showAllFeeds = !S.settings.showAllFeeds; saveSettings(); renderSidebar(); return;
        case 'editfeed': openEditFeed(S.view.id); return;
        case 'renamefolder': openFolderDialog(S.view.id, 'rename'); return;
        case 'deletefolder': openFolderDialog(S.view.id, 'delete'); return;
        case 'sharefolder': exportOPML(S.view.id); return;
        case 'unsubone': {
          const f = S.feedById.get(btn.dataset.id);
          if (f && confirm(`Unsubscribe from ${f.title}?`)) { unsubscribe(f.id); render(); }
          return;
        }
        case 'unsubretired': {
          const gone = S.feeds.filter((f) => f.retired);
          if (!gone.length || !confirm(`Unsubscribe from all ${gone.length} retired feed${gone.length === 1 ? '' : 's'}?`)) return;
          for (const f of gone) unsubscribe(f.id);
          render();
          toast(`Unsubscribed from ${gone.length} retired feed${gone.length === 1 ? '' : 's'}`);
          return;
        }
        case 'unsubdead': {
          const dead = S.feeds.filter((f) => f.own && f.error && f.failSince && Date.now() - f.failSince > 7 * 864e5);
          if (!dead.length || !confirm(`Unsubscribe from ${dead.length} feed${dead.length === 1 ? '' : 's'} that ha${dead.length === 1 ? 's' : 've'} failed for over a week?\n\n${dead.map((f) => f.title).join('\n')}`)) return;
          for (const f of dead) unsubscribe(f.id);
          render();
          toast(`Unsubscribed from ${dead.length} broken feed${dead.length === 1 ? '' : 's'}`);
          return;
        }
        case 'shownew': render(); window.scrollTo(0, 0); return;
        case 'switchai': openSettings(); return;
        case 'backup': openSettings(); $('#exportBackup').scrollIntoView({ block: 'center' }); $('#exportBackup').focus(); return;
        case 'dismissnote': store.set('deviceNoteDismissed', true); render(); return;
        case 'newtopic': openTopic(); return;
        case 'more': renderList(false); return;
        case 'savetopic': openTopic(S.view.q); return;
        case 'showpending': if (S.view.pending) { Object.assign(S.view, S.view.pending); delete S.view.pending; S.view.status = /still checking/.test(S.view.status) ? 'Best matches first · still checking your feeds…' : ''; render(); } return;
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
    if (article && e.target.closest('.row') && !e.target.closest('a') && !S.swipedRecently?.()) {
      if (S.settings.mode === 'expanded') select(+article.dataset.idx, { open: true, scroll: false });
      else toggleEntry(article);
    }
  });

  // Clicking a title opens the article without keeping focus on it, so Space
  // still scrolls (Tab still reaches the titles).
  document.addEventListener('mousedown', (e) => { if (e.target.closest?.('button.line')) e.preventDefault(); });

  // Close/Cancel buttons (not submit buttons, so Enter in a field submits the form)
  document.addEventListener('click', (e) => { const c = e.target.closest('[data-close]'); if (c) c.closest('dialog')?.close(); });

  // Phones: swipe an article right to star it, left to mark it read or unread.
  let sw = null;
  let lastSwipe = 0;
  S.swipedRecently = () => Date.now() - lastSwipe < 450;
  $('#list').addEventListener('touchstart', (e) => {
    const row = e.target.closest('.row');
    if (!row || e.touches.length > 1) return;
    sw = { row, x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, axis: null };
  }, { passive: true });
  $('#list').addEventListener('touchmove', (e) => {
    if (!sw) return;
    const dx = e.touches[0].clientX - sw.x;
    const dy = e.touches[0].clientY - sw.y;
    if (!sw.axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) sw.axis = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'x' : 'y';
    if (sw.axis !== 'x') return;
    sw.dx = dx;
    sw.row.style.transform = `translateX(${Math.max(-140, Math.min(140, dx))}px)`;
    sw.row.classList.toggle('swipe-star', dx > 70);
    sw.row.classList.toggle('swipe-read', dx < -70);
  }, { passive: true });
  $('#list').addEventListener('touchend', () => {
    if (!sw) return;
    const { row, dx, axis } = sw;
    sw = null;
    row.style.transform = '';
    row.classList.remove('swipe-star', 'swipe-read');
    const a = row.closest('article.entry');
    if (axis !== 'x' || !a) return;
    lastSwipe = Date.now();
    if (dx > 70) { toggleStar(a.dataset.id); toast(S.starred[a.dataset.id] ? '★ Starred' : 'Star removed', 1200); }
    else if (dx < -70) { S.view.keep?.add(a.dataset.id); markRead(a.dataset.id, !isRead(a.dataset.id)); toast(isRead(a.dataset.id) ? 'Marked read' : 'Kept unread', 1200); }
  });

  // Phones: pull down at the top of the page to refresh.
  let pull = null;
  const ind = $('#pullIndicator');
  document.addEventListener('touchstart', (e) => {
    if (window.scrollY > 0 || e.target.closest('dialog, #sidebar, .row')) return;
    pull = { y: e.touches[0].clientY, d: 0 };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!pull) return;
    pull.d = e.touches[0].clientY - pull.y;
    if (pull.d <= 10 || window.scrollY > 0) { ind.hidden = true; return; }
    ind.hidden = false;
    ind.style.transform = `translate(-50%, ${Math.min(pull.d, 140) / 2}px)`;
    ind.classList.toggle('ready', pull.d > 90);
    ind.textContent = pull.d > 90 ? '⟳ Release to refresh' : '⟳ Pull to refresh';
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (!pull) return;
    const go = pull.d > 90 && window.scrollY <= 0;
    pull = null;
    ind.hidden = true;
    if (go) refresh();
  });

  // Edit feed / folder dialogs
  $('#editFeedForm').addEventListener('submit', (e) => { if (e.submitter?.value === 'ok') saveEditFeed(); });
  $('#folderForm').addEventListener('submit', (e) => {
    const v = e.submitter?.value;
    if (v === 'rename') renameFolder(S.folderEditing, $('#folderName').value);
    else if (v === 'deletekeep') deleteFolder(S.folderEditing, false);
    else if (v === 'deleteunsub') deleteFolder(S.folderEditing, true);
  });
  // Drag a feed onto a folder to move it there.
  $('#sidebar').addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('a.feed[data-feed]');
    if (!row) return;
    e.dataTransfer.setData('text/x-salareader-feed', JSON.stringify({ id: row.dataset.feed, from: row.dataset.from }));
    e.dataTransfer.effectAllowed = 'move';
  });
  $('#sidebar').addEventListener('dragover', (e) => {
    const target = e.target.closest?.('[data-drop]');
    if (!target || target.dataset.drop === RETIRED || !e.dataTransfer.types.includes('text/x-salareader-feed')) return;
    e.preventDefault();
    document.querySelectorAll('.drop-target').forEach((x) => x !== target && x.classList.remove('drop-target'));
    target.classList.add('drop-target');
  });
  $('#sidebar').addEventListener('dragleave', (e) => { e.target.closest?.('[data-drop]')?.classList.remove('drop-target'); });
  $('#sidebar').addEventListener('drop', (e) => {
    const target = e.target.closest?.('[data-drop]');
    document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
    if (!target) return;
    e.preventDefault();
    try { const { id, from } = JSON.parse(e.dataTransfer.getData('text/x-salareader-feed')); moveFeed(id, from, target.dataset.drop); } catch { /* not a feed */ }
  });

  // Add-feed dialog
  $('#dirFilter').addEventListener('input', () => renderDirectory());
  $('#dirCats').addEventListener('click', (e) => { const c = e.target.closest('[data-dircat]'); if (c) { dirCat = c.dataset.dircat; renderDirectory(); } });
  $('#dirList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-dirsub]');
    if (!b) return;
    b.disabled = true;
    b.textContent = 'Adding…';
    try {
      const feed = await addFeed(b.dataset.dirsub, $('#addFolder').value || b.dataset.cat);
      if (feed && b.dataset.title) { const sub = liveSub(feed.url); if (sub && !sub.titleSet) { sub.title = b.dataset.title; sub.titleSet = true; saveSubs(); } }
      rebuild(); renderSidebar(); renderDirectory();
      toast(`Subscribed to ${b.dataset.title}`);
    } catch (err) { b.disabled = false; b.textContent = '＋ Add'; toast(err.message, 5000); }
  });
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
      const q = $('#topicQuery').value.trim();
      if (!q) { $('#topicStatus').textContent = 'Type what the topic is about.'; return; }
      const t = await createTopic(q);
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
  $('#aiModelSel').addEventListener('change', (e) => {
    setAIModel(e.target.value);
    $('#aiModelNote').textContent = e.target.value === 'multi'
      ? 'Switched. The multilingual model (about 120 MB) downloads the next time you search; your topics are worked out again in the background.'
      : 'Switched to English.';
  });
  $('#thresholdRange').addEventListener('input', (e) => { S.version++; S.settings.threshold = +e.target.value; $('#thresholdVal').textContent = `(${Math.round(S.settings.threshold * 100)}%)`; saveSettings(); });
  $('#settingsDialog').addEventListener('close', () => {
    // Only redraw the list if a setting that changes it moved; keeps your open article and AI answers.
    const was = S.settingsAtOpen;
    const changed = was && (was.threshold !== S.settings.threshold || was.relayMode !== S.settings.relayMode || was.aiModel !== modelKey());
    if (changed && S.view.type !== 'home') render(); else renderSidebar();
  });
  $('#opmlFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) { $('#settingsDialog').close(); importOPML(f); } e.target.value = ''; });
  $('#exportOpml').addEventListener('click', () => exportOPML());
  $('#relayModes').addEventListener('change', (e) => {
    if (e.target.name !== 'relayMode') return;
    S.settings.relayMode = e.target.value;
    saveSettings();
    $('#ownRelay').hidden = S.settings.relayMode !== 'own';
    $('#relayStatus').textContent = '';
  });
  $('#relayInput').addEventListener('change', (e) => {
    let v = e.target.value.trim();
    if (v && !/^https?:\/\//i.test(v)) { v = 'https://' + v; e.target.value = v; }
    S.settings.relay = v;
    saveSettings();
  });
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
  $('#resetRead').addEventListener('click', () => { if (confirm('Mark every article as unread?')) { S.read = {}; store.set('read', S.read); S.unread = unreadOf(S.items); render(); } });

  // Keyboard
  let gPending = false;
  document.addEventListener('keydown', (e) => {
    // Keys pressed with nothing focused can come from the document itself.
    const el = e.target instanceof Element ? e.target : document.body;
    // In the investigation panel: Enter asks (Shift+Enter for a new line), Esc closes it.
    // Ctrl+K / ⌘K: the command palette, from anywhere.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if ($('#cmdk').open) $('#cmdk').close();
      else if (!document.querySelector('dialog[open]')) openCmd();
      return;
    }
    if (e.key === 'Escape' && !$('#aaPop').hidden) { closeAa(); return; }
    if (S.invOpen && el.closest('#invPanel')) {
      if (e.key === 'Enter' && !e.shiftKey && el.id === 'invInput') { e.preventDefault(); $('#invForm').requestSubmit(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeInvestigation(); }
      return;
    }
    if (S.invOpen && e.key === 'Escape' && !document.querySelector('dialog[open]')) { closeInvestigation(); return; }
    // Alt+1–6 switches the AI assistant, like ⌥⌘1–6 in jamalterm.
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-6]$/.test(e.code) && !el.closest('input, textarea, [contenteditable]')) {
      e.preventDefault();
      switchProvider(PROVIDERS[+e.code.slice(5) - 1].id);
      if ($('#settingsDialog').open) renderAISettings();
      return;
    }
    // Enter or Space on a focused link or button does what it normally does.
    if ((e.key === 'Enter' || e.key === ' ') && el.closest('a[href], button, label, summary')) return;
    if (el.closest('input, textarea, select, dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) {
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
      case 'v': if (curEl) { const it = S.byId.get(curEl.dataset.id) || S.starred[curEl.dataset.id]; if (safeUrl(it.l)) window.open(safeUrl(it.l), '_blank', 'noopener,noreferrer'); } break;
      case 'A': if (e.shiftKey && S.view.type !== 'home') markAllRead(sourceItems()); break;
      case '/': e.preventDefault(); $('#q').focus(); $('#q').select(); break;
      case 'x': surprise(); break;
      case 'r': refresh(); break;
      case 'u': toggleNav(); break;
      case '1': setMode('list'); break;
      case '2': setMode('expanded'); break;
      case '3': setMode('pane'); break;
      case '+': case '=': readSize(1); break;
      case '-': case '_': readSize(-1); break;
      case ' ': {
        // Reading pane: Space pages through the article, then moves to the next one.
        if (!paneOn() || e.target.closest?.('#list button, #list a')) return;
        const r = $('#reader');
        const atEnd = r.scrollTop + r.clientHeight >= r.scrollHeight - 4;
        if (e.shiftKey) r.scrollBy({ top: -r.clientHeight * 0.85, behavior: 'smooth' });
        else if (atEnd || !r.dataset.id) select(S.cur + 1);
        else r.scrollBy({ top: r.clientHeight * 0.85, behavior: 'smooth' });
        break;
      }
      case 'g': gPending = true; setTimeout(() => { gPending = false; }, 1200); break;
      case '?': $('#helpDialog').showModal(); break;
      default: return;
    }
    e.preventDefault();
  });
}

function setMode(mode) {
  // The layout (list, expanded, reading pane) applies everywhere.
  S.settings.mode = S.settings.defaultMode = mode;
  for (const p of Object.values(S.settings.viewPrefs || {})) delete p.mode;
  saveSettings();
  if (S.view.type !== 'home') render();
}

function openAdd() {
  $('#addUrl').value = '';
  $('#addFolder').value = S.view.type === 'folder' ? S.view.id : '';
  $('#addStatus').textContent = '';
  $('#folderList').innerHTML = [...new Set(S.feeds.flatMap(feedFolders).filter(Boolean))].map((f) => `<option value="${esc(f)}">`).join('');
  renderDiscover();
  $('#addDialog').showModal();
  closeSidebar();
}

// ---------- Discover: a directory of popular feeds (directory.json) ----------

let directory = null;
let dirCat = '';
async function loadDirectory() {
  directory ??= fetch('directory.json').then((r) => (r.ok ? r.json() : { categories: [] })).catch(() => ({ categories: [] }));
  return directory;
}

/** Popular feeds: suggested from your AI topics and folders, by category, or filtered by words. */
async function renderDirectory() {
  const dir = await loadDirectory();
  const all = dir.categories.flatMap((c) => c.feeds.map((f) => ({ ...f, cat: c.name })));
  const have = new Set(S.feeds.map((f) => f.url));
  // What you're into: your topic words and folder names.
  const interests = [...S.topics.map((t) => t.query), ...allFolderNames()].join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  const score = (f) => interests.filter((w) => `${f.title} ${f.tags} ${f.cat}`.toLowerCase().includes(w)).length;
  const q = ($('#dirFilter').value || '').trim().toLowerCase();
  const cats = ['For you', ...dir.categories.map((c) => c.name)];
  if (!dirCat) dirCat = interests.length ? 'For you' : dir.categories[0]?.name || '';
  $('#dirCats').innerHTML = q ? '' : cats.map((c) => `<button type="button" class="chip${c === dirCat ? ' on' : ''}" data-dircat="${esc(c)}">${esc(c)}</button>`).join('');
  let list;
  if (q) list = all.filter((f) => `${f.title} ${f.tags} ${f.cat}`.toLowerCase().includes(q));
  else if (dirCat === 'For you') list = all.map((f) => [f, score(f)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([f]) => f).slice(0, 12);
  else list = all.filter((f) => f.cat === dirCat);
  $('#dirList').innerHTML = list.length
    ? list.map((f) => `<li>${avatar(f)}<span class="name">${esc(f.title)}<span class="muted"> · ${esc(f.cat)}</span></span>${have.has(f.url) ? '<span class="muted">✓ Subscribed</span>' : `<button type="button" class="ghost" data-dirsub="${esc(f.url)}" data-title="${esc(f.title)}" data-cat="${esc(f.cat)}">＋ Add</button>`}</li>`).join('')
    : `<li class="muted">${dirCat === 'For you' && !q ? 'Create an AI topic or a folder, and suggestions show up here.' : 'Nothing matches.'}</li>`;
}

function renderDiscover() {
  renderDirectory();
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
  const ok = await loadIndex(true);
  refreshOwnFeeds(); // in the background: articles appear as feeds arrive
  if (ok === false) {
    btn.classList.remove('spin');
    toast("Couldn't reach Sala Reader to refresh. Check your connection; your articles are still here.", 5000);
    return;
  }
  S.vectorsState = 'none';
  rebuild();
  if (S.topics.length) loadVectors().then(() => { renderSidebar(); if (S.view.type === 'home') refreshHome(); else if (S.view.type === 'topic') { renderHeaderCounts(); offerNew(); } });
  render();
  btn.classList.remove('spin');
  toast(S.index.updated !== before ? 'Fresh articles loaded' : `Up to date (feeds updated ${agoText(S.index.updated)})`);
}

// ---------- desktop: reading pane ----------

/** Below this window width the reading pane falls back to the list view. */
const PANE_MIN_WIDTH = 1000;
const paneOn = () => S.settings.mode === 'pane' && innerWidth >= PANE_MIN_WIDTH && S.view.type !== 'home' && S.view.type !== 'health' && !(S.view.type === 'folder' && S.view.id === RETIRED);
/** Articles open inside the list (list view, or the pane on a narrow window). */
const listMode = () => S.settings.mode === 'list' || (S.settings.mode === 'pane' && !paneOn());

function readerEmpty() {
  const r = $('#reader');
  if (!r) return;
  delete r.dataset.id;
  r.innerHTML = `<div class="reader-empty"><p class="big" aria-hidden="true">📖</p><p>Pick an article, or press <kbd>j</kbd>.</p><p class="hint"><kbd>Space</kbd> pages through it, then on to the next.</p></div>`;
}

function showInReader(id) {
  const r = $('#reader');
  const it = S.byId.get(id) || S.starred[id];
  if (!r || !it || r.dataset.id === id) return;
  r.dataset.id = id;
  // Same markup as an open article in the list, so every button works the same.
  r.innerHTML = `<article class="entry open pane-article" data-id="${esc(id)}"><div class="body">${bodyHTML(it)}</div></article>`;
  r.scrollTop = 0;
  fillContent(r.firstElementChild);
}

function toggleNav() {
  if (innerWidth < 860 || (document.body.classList.contains('inv-open') && innerWidth <= 1360)) {
    if (document.body.classList.contains('nav-open')) closeSidebar(); else openSidebar();
  } else document.body.classList.toggle('nav-hidden');
}

function digDeeper(it) {
  if (it) startInvestigation({ query: it.t.replace(/\s+[-–|]\s+[^-–|]{2,40}$/, '').slice(0, 120), name: it.t.slice(0, 80), articleId: it.id });
}

const copyText = (text, msg) => navigator.clipboard?.writeText(text).then(() => toast(msg)).catch(() => toast("Couldn't copy"));

// ---------- desktop: fresher feeds ----------

/** How much you read each feed lately (reads in the last 2 weeks, and stars): the refresh order. */
function feedPriority() {
  const score = new Map();
  const since = Date.now() - 14 * 864e5;
  for (const [id, t] of Object.entries(S.read)) {
    if (t < since) continue;
    const f = S.byId.get(id)?.f;
    if (f) score.set(f, (score.get(f) || 0) + 1);
  }
  for (const it of Object.values(S.starred)) if (it?.f) score.set(it.f, (score.get(it.f) || 0) + 3);
  return score;
}

const PREFETCH_CACHE = 'salareader-prefetch';
const PREFETCH_MAX_AGE = 12 * 3600e3;

/**
 * For the installed app's background refresh: the feeds to fetch (most read first)
 * and how. Kept in this browser's cache storage, which only this site can read.
 */
async function savePrefetchPlan() {
  if (!('caches' in window) || !navigator.serviceWorker?.controller) return;
  const score = feedPriority();
  const feeds = (S.subs || []).filter((s) => s.own && !s.retired && (!s.error || s.relayIssue) && !googleNewsQuery(s.url) && !bingNewsQuery(s.url))
    .sort((a, b) => (score.get(b.id) || 0) - (score.get(a.id) || 0)).slice(0, 300)
    .map((s) => ({ url: s.fetchUrl || fetchAddress(s.url), direct: s.direct === true }));
  const own = S.settings.relayMode === 'own';
  const plan = { relay: relayUrl(), token: own ? S.settings.relayToken || '' : '', feeds, saved: Date.now() };
  try { await (await caches.open(PREFETCH_CACHE)).put('/__prefetch-plan', new Response(JSON.stringify(plan), { headers: { 'Content-Type': 'application/json' } })); } catch { /* no cache storage */ }
}

/** A copy of this feed fetched in the background since it was last updated, if any (used once). */
async function takePrefetched(url, feed) {
  if (!('caches' in window)) return '';
  try {
    const cache = await caches.open(PREFETCH_CACHE);
    const key = '/__prefetch/' + encodeURIComponent(url);
    const res = await cache.match(key);
    if (!res) return '';
    await cache.delete(key);
    const at = +res.headers.get('X-Fetched-At') || 0;
    if (Date.now() - at > PREFETCH_MAX_AGE || at <= (liveSub(feed.url)?.ok || 0)) return '';
    return await res.text();
  } catch { return ''; }
}

/** Installed app (Chrome, Edge): ask to refresh feeds in the background now and then. */
async function registerBackgroundRefresh() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg?.periodicSync) return;
    const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (perm.state !== 'granted') return;
    await reg.periodicSync.register('feeds', { minInterval: 3 * 3600e3 });
    S.backgroundRefresh = true;
  } catch { /* not supported here */ }
}

// ---------- desktop: text size and font ----------

const READ_SIZES = [13, 14, 15, 16, 17, 18, 19, 20, 22, 24, 26, 28];
const readBase = () => (S.settings.theme === 'classic' ? 14 : 18);

function applyReading() {
  const r = S.settings.read || {};
  const st = document.documentElement.style;
  const set = (k, v) => (v ? st.setProperty(k, v) : st.removeProperty(k));
  set('--read-size', r.size ? r.size + 'px' : '');
  set('--read-family', r.font === 'sans' ? 'var(--font)' : r.font === 'serif' ? 'Georgia, "Iowan Old Style", "Times New Roman", serif' : '');
  set('--read-measure', { narrow: '64ch', wide: '108ch' }[r.width] || '');
  set('--read-lh', { tight: '1.45', loose: '1.9' }[r.lh] || '');
  renderAa();
}

function setReading(k, v) {
  S.settings.read = { ...S.settings.read, [k]: v };
  if (v == null) delete S.settings.read[k];
  saveSettings();
  applyReading();
}

function readSize(step) {
  const base = readBase();
  const cur = S.settings.read?.size || base;
  let next = base;
  if (step) {
    const i = READ_SIZES.indexOf(cur);
    const at = i >= 0 ? i : READ_SIZES.findIndex((x) => x > cur) - (step > 0 ? 1 : 0);
    next = READ_SIZES[Math.max(0, Math.min(READ_SIZES.length - 1, at + step))];
  }
  setReading('size', next === base ? null : next);
  toast(`Text size ${next}${next === base ? ' (normal)' : ''}`, 1000);
}

function renderAa() {
  const pop = $('#aaPop');
  if (!pop) return;
  const r = S.settings.read || {};
  $('#aaSize').textContent = r.size || readBase();
  for (const [attr, val] of [['font', r.font || 'auto'], ['width', r.width || 'medium'], ['lh', r.lh || 'normal']]) {
    for (const b of pop.querySelectorAll(`[data-aa-${attr}]`)) { const on = b.dataset[`aa${attr[0].toUpperCase()}${attr.slice(1)}`] === val; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
  }
}

function openAa() {
  const pop = $('#aaPop');
  const r = $('#aaBtn').getBoundingClientRect();
  pop.hidden = false;
  pop.style.top = r.bottom + 6 + 'px';
  pop.style.right = Math.max(8, innerWidth - r.right) + 'px';
  $('#aaBtn').setAttribute('aria-expanded', 'true');
  renderAa();
  pop.querySelector('button')?.focus();
}
function closeAa() {
  if ($('#aaPop').hidden) return;
  $('#aaPop').hidden = true;
  $('#aaBtn').setAttribute('aria-expanded', 'false');
  $('#aaBtn').focus();
}

// ---------- desktop: installable app, kept storage, app badge ----------

let installEvent = null;
const isInstalled = () => matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches || navigator.standalone === true;

function showInstall() {
  const can = !!installEvent && !isInstalled();
  $('#installBtn').hidden = !can;
  $('#installApp').hidden = !can;
}

async function installApp() {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
  showInstall();
}

/** Asks the browser never to clear this site's data to free space (Safari: nor after 7 days away). */
async function keepStorage(ask) {
  if (!navigator.storage?.persist) return null;
  if (await navigator.storage.persisted()) return true;
  // Firefox asks the person, so only when they press the button; the others decide quietly.
  if (!ask && /firefox/i.test(navigator.userAgent)) return false;
  return navigator.storage.persist().catch(() => false);
}

async function renderAppInfo() {
  const el = $('#appInfo');
  const kept = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => false) : null;
  const est = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const mb = est?.usage ? ` It uses about ${Math.max(1, Math.round(est.usage / 1048576))} MB.` : '';
  const safari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
  const app = isInstalled() ? 'Running as an installed app, in its own window.'
    : installEvent ? 'Install it to get its own window and a Dock or taskbar icon with your unread count. It opens offline too.'
    : safari ? 'To install it in Safari on a Mac: <b>File → Add to Dock</b>. Installed, Safari keeps your data even if you are away for a while.'
    : 'Chrome and Edge can install it as an app with its own window (look for the install icon in the address bar).';
  const store = kept === true ? '✓ Your data is kept permanently: the browser won\'t clear it to free space.'
    : kept === false ? 'The browser may clear your data if the disk runs low. Press <b>Keep my data permanently</b>, and keep a backup.'
    : '';
  el.innerHTML = `${app} ${store}${mb}`;
  $('#persistBtn').hidden = kept !== false;
}

function initDesktop() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; showInstall(); });
  addEventListener('appinstalled', () => { installEvent = null; showInstall(); toast('Installed: Sala Reader now has its own window', 4000); });
  keepStorage(false);
  showInstall();
  registerBackgroundRefresh();
  $('#installBtn').addEventListener('click', installApp);
  $('#installApp').addEventListener('click', installApp);
  $('#persistBtn').addEventListener('click', async () => {
    const ok = await keepStorage(true);
    toast(ok ? '✓ Your data will be kept' : "The browser said no. Installing the app, or bookmarking the page, usually changes that.", 5000);
    renderAppInfo();
  });

  // Text size and font
  $('#aaBtn').addEventListener('click', () => ($('#aaPop').hidden ? openAa() : closeAa()));
  $('#aaPop').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.aa === 'bigger') readSize(1);
    else if (b.dataset.aa === 'smaller') readSize(-1);
    else if (b.dataset.aa === 'reset') readSize(0);
    else if (b.dataset.aaFont) setReading('font', b.dataset.aaFont === 'auto' ? null : b.dataset.aaFont);
    else if (b.dataset.aaWidth) setReading('width', b.dataset.aaWidth === 'medium' ? null : b.dataset.aaWidth);
    else if (b.dataset.aaLh) setReading('lh', b.dataset.aaLh === 'normal' ? null : b.dataset.aaLh);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('#aaPop').hidden && !e.target.closest('#aaPop, #aaBtn')) { $('#aaPop').hidden = true; $('#aaBtn').setAttribute('aria-expanded', 'false'); }
    if (!$('#ctxMenu').hidden && !e.target.closest('#ctxMenu')) hideMenu(false);
  });

  // Right-click menus
  document.addEventListener('contextmenu', onContextMenu);
  $('#ctxMenu').addEventListener('click', (e) => {
    const b = e.target.closest('.ctx-item');
    if (!b) return;
    const item = $('#ctxMenu')._items?.[+b.dataset.i];
    hideMenu(true);
    item?.run();
  });
  $('#ctxMenu').addEventListener('keydown', (e) => {
    const items = [...$('#ctxMenu').querySelectorAll('.ctx-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
    else if (e.key === 'Home') items[0].focus();
    else if (e.key === 'End') items[items.length - 1].focus();
    else if (e.key === 'Escape' || e.key === 'Tab') hideMenu(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  addEventListener('scroll', () => hideMenu(false), true);
  addEventListener('blur', () => hideMenu(false));

  // Command palette
  $('#cmdkInput').addEventListener('input', () => { cmdSel = 0; renderCmd(); });
  $('#cmdkInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cmdSel = (cmdSel + (e.key === 'ArrowDown' ? 1 : -1) + cmdShown.length) % Math.max(1, cmdShown.length);
      markCmd();
    } else if (e.key === 'Enter') { e.preventDefault(); runCmd(cmdShown[cmdSel]); }
  });
  $('#cmdkList').addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) runCmd(cmdShown[+li.dataset.i]); });
  $('#cmdk').addEventListener('click', (e) => { if (e.target === $('#cmdk')) $('#cmdk').close(); });

  // Automatic backup
  $('#abChoose').addEventListener('click', abChoose);
  $('#abNow').addEventListener('click', () => abWrite(true));
  $('#abStop').addEventListener('click', () => {
    if (!confirm('Stop the automatic backups? The files already in the folder stay.')) return;
    abStop().then(() => { renderABSettings(); renderSidebar(); });
  });
  $('#abEncrypt').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const pass = await askPass({ title: 'Encrypt your backups', hint: "Choose a passphrase. You'll need it to restore a backup, and it can't be recovered if you forget it.", twice: true });
      if (!pass) { e.target.checked = false; return; }
      saveAB({ encrypt: true, pass });
    } else saveAB({ encrypt: false, pass: '' });
    if (abState()?.name) abWrite(true); else renderABSettings();
  });
  abCheck();
  setInterval(() => abWrite(false), 36e5);
  setTimeout(() => abWrite(false), 20000);
}

// ---------- desktop: right-click menus ----------

let ctxReturn = null;

function showMenu(x, y, items) {
  const m = $('#ctxMenu');
  ctxReturn = document.activeElement;
  m._items = items;
  m.innerHTML = items.map((it, i) => (it === '-'
    ? '<div class="ctx-sep" role="separator"></div>'
    : `<button type="button" role="menuitem" tabindex="-1" class="ctx-item${it.danger ? ' danger' : ''}" data-i="${i}"><span>${esc(it.label)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</button>`)).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  m.querySelector('.ctx-item')?.focus({ preventScroll: true });
}

function hideMenu(restore) {
  const m = $('#ctxMenu');
  if (!m || m.hidden) return;
  m.hidden = true;
  m.innerHTML = '';
  if (restore) ctxReturn?.focus?.({ preventScroll: true });
}

function onContextMenu(e) {
  const t = e.target instanceof Element ? e.target : null;
  // Text, links inside articles, fields and selections keep the browser's own menu.
  if (!t || t.closest('input, textarea, select, [contenteditable], .content, .ai-out, .related, #invPanel, dialog, #ctxMenu') || String(getSelection()).trim()) return;
  const items = menuFor(t);
  if (!items?.length) return;
  e.preventDefault();
  let { clientX: x, clientY: y } = e;
  if (!x && !y) { const r = (t.closest('.row, .nav-item, h2') || t).getBoundingClientRect(); x = r.left + 24; y = r.bottom; }
  showMenu(x, y, items);
}

function menuFor(t) {
  const art = t.closest('#list article.entry, #reader article.entry');
  if (art) return articleMenu(art);
  const feedRow = t.closest('#sidebar a.feed[data-feed]');
  if (feedRow) return feedMenu(feedRow.dataset.feed);
  const folderRow = t.closest('#sidebar .folder-row[data-drop]');
  if (folderRow) return folderMenu(folderRow.dataset.drop);
  const invRow = t.closest('#sidebar [data-inv]');
  if (invRow) return invMenu(invRow.dataset.inv);
  const nav = t.closest('#sidebar a.nav-item[href^="#/"]');
  if (nav) return navMenu(nav.getAttribute('href'));
  return null;
}

function articleMenu(art) {
  const id = art.dataset.id;
  const it = S.byId.get(id) || S.starred[id];
  if (!it) return null;
  const inList = !!art.closest('#list');
  const idx = S.list.findIndex((x) => x.id === id);
  const link = safeUrl(it.l);
  const f = S.feedById.get(it.f);
  const items = [];
  if (inList && !(paneOn() && $('#reader').dataset.id === id)) items.push({ label: art.classList.contains('open') ? 'Close' : 'Open', key: 'o', run: () => (art.classList.contains('open') ? closeEntry(art) : toggleEntry(art)) });
  items.push(
    { label: S.starred[id] ? '★ Unstar' : '☆ Star', key: 's', run: () => toggleStar(id) },
    { label: isRead(id) ? 'Mark as unread' : 'Mark as read', key: 'm', run: () => { S.view.keep?.add(id); markRead(id, !isRead(id)); } },
  );
  if (idx >= 0) {
    if (idx > 0) items.push('-', { label: `Mark the ${idx} above as read`, run: () => markAllRead(S.list.slice(0, idx)) });
    if (idx < S.list.length - 1) items.push(idx > 0 ? null : '-', { label: `Mark the ${S.list.length - idx - 1} below as read`, run: () => markAllRead(S.list.slice(idx + 1)) });
  }
  if (link) items.push('-', { label: 'Open original in a new tab', key: 'v', run: () => window.open(link, '_blank', 'noopener,noreferrer') }, { label: 'Copy link', run: () => copyText(link, 'Link copied') });
  items.push('-', { label: '🕵️ Dig deeper', run: () => digDeeper(it) });
  if (f && !(S.view.type === 'feed' && S.view.id === f.id)) items.push({ label: `Go to ${f.title}`, run: () => go(`#/feed/${f.id}`) });
  return items.filter(Boolean);
}

function feedMenu(id) {
  const f = S.feedById.get(id);
  if (!f) return null;
  const sub = liveSub(f.url);
  return [
    { label: 'Open', run: () => go(`#/feed/${id}`) },
    { label: 'Mark all as read', run: () => markAllRead(S.items.filter((i) => i.f === id)) },
    ...(f.own && sub ? [{ label: '⟳ Refresh this feed', run: () => { toast(`Refreshing ${f.title}…`, 1500); fetchOwnFeed({ ...sub }).catch((err) => noteFeedError(sub, err)).finally(() => { rebuild(); renderSidebar(); renderHeaderCounts(); toast(sub.error ? sub.error : `✓ ${sub.title} is up to date`, 3000); }); } }] : []),
    '-',
    { label: '✎ Edit name and folders…', run: () => openEditFeed(id) },
    { label: 'Copy feed address', run: () => copyText(f.url, 'Address copied') },
    { label: '⇪ Share as OPML', run: () => exportFeedOPML(f) },
    '-',
    { label: 'Unsubscribe…', danger: true, run: () => { if (!confirm(`Unsubscribe from ${f.title}?`)) return; unsubscribe(id); if (S.view.type === 'feed' && S.view.id === id) go('#/home'); else render(); } },
  ];
}

function exportFeedOPML(f) {
  const x = (v) => esc(v);
  download(`${(f.title || 'feed').replace(/[^\w-]+/g, '-').slice(0, 40)}.opml`, `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>${x(f.title)}</title></head><body><outline type="rss" text="${x(f.title)}" title="${x(f.title)}" xmlUrl="${x(f.url)}"${f.site ? ` htmlUrl="${x(f.site)}"` : ''}/></body></opml>\n`, 'text/x-opml');
}

function folderMenu(name) {
  if (name === RETIRED) return [{ label: 'Open', run: () => go(`#/folder/${RETIRED}`) }];
  const ids = new Set(S.feeds.filter((f) => feedFolders(f).includes(name)).map((f) => f.id));
  return [
    { label: 'Open', run: () => go(`#/folder/${encodeURIComponent(name)}`) },
    { label: 'Mark all as read', run: () => markAllRead(S.items.filter((i) => ids.has(i.f))) },
    '-',
    { label: '✎ Rename…', run: () => openFolderDialog(name, 'rename') },
    { label: '⇪ Share folder (OPML)', run: () => exportOPML(name) },
    '-',
    { label: 'Delete folder…', danger: true, run: () => openFolderDialog(name, 'delete') },
  ];
}

function navMenu(href) {
  const [, type, raw] = href.match(/^#\/(\w+)\/?(.*)$/) || [];
  const id = decodeURIComponent(raw || '');
  if (type === 'all') return [{ label: 'Open', run: () => go(href) }, { label: 'Mark everything as read', run: () => { if (confirm('Mark every article as read?')) markAllRead(S.items); } }];
  if (type === 'starred') return [{ label: 'Open', run: () => go(href) }];
  if (type === 'smart') return [{ label: 'Open', run: () => go(href) }, { label: 'Mark all as read', run: () => markAllRead(S.smart?.get(id) || []) }];
  if (type === 'topic') {
    const t = S.topics.find((x) => x.id === id);
    if (!t) return null;
    return [
      { label: 'Open', run: () => go(href) },
      { label: 'Mark all as read', run: () => markAllRead(topicMatches(t).items) },
      { label: '🕵️ Investigate', run: () => startInvestigation({ query: t.query, name: t.name }) },
      '-',
      { label: '✎ Rename…', run: () => { const n = prompt('Topic name', t.name); if (n?.trim()) { t.name = n.trim(); store.set('topics', S.topics); render(); } } },
      { label: 'Delete topic…', danger: true, run: () => { if (!confirm(`Delete the topic “${t.name}”?`)) return; S.topics = S.topics.filter((x) => x.id !== t.id); store.set('topics', S.topics); if (S.view.type === 'topic' && S.view.id === t.id) go('#/home'); else renderSidebar(); } },
    ];
  }
  return null;
}

function invMenu(id) {
  const inv = invById(id);
  if (!inv) return null;
  return [
    S.invOpen === id ? { label: 'Close', run: closeInvestigation } : { label: 'Open', run: () => openInvestigation(id) },
    { label: 'Export notes (Markdown)', run: () => exportInv(inv) },
    '-',
    { label: 'Delete…', danger: true, run: () => { if (!confirm(`Delete the investigation “${inv.name}” and its notes?`)) return; S.invs = S.invs.filter((x) => x.id !== id); saveInvs(); if (S.invOpen === id) closeInvestigation(); else renderSidebar(); } },
  ];
}

// ---------- desktop: command palette (Ctrl+K / ⌘K) ----------

let cmdShown = [];
let cmdSel = 0;

function cmdItems(q) {
  const v = S.view;
  const out = [];
  const go_ = (label, hash, icon, kind, hint = '') => out.push({ label, icon, kind, hint, run: () => go(hash) });
  const act = (label, run, icon, key) => out.push({ label, icon, kind: 'Command', key, run });
  go_('Home', '#/home', '🏠', 'Go to', 'g h');
  go_('All items', '#/all', '📚', 'Go to', 'g a');
  go_('Starred', '#/starred', '⭐', 'Go to', 'g s');
  act('Refresh', refresh, '⟳', 'r');
  go_('Feed health', '#/health', '🩺', 'Go to');
  act('Check all feeds now', () => { go('#/health'); checkAllFeeds(); }, '🩺');
  act('Subscribe to a feed…', openAdd, '＋');
  act('New AI topic…', () => openTopic(), '✨');
  if (v.type !== 'home') {
    act('Mark all here as read', () => markAllRead(sourceItems()), '✓', 'Shift+A');
    act('Brief me on this list', brief, '✨');
  }
  act('Surprise me', surprise, '🎲', 'x');
  act('Layout: list', () => setMode('list'), '☰', '1');
  act('Layout: expanded', () => setMode('expanded'), '▤', '2');
  act('Layout: reading pane', () => setMode('pane'), '◫', '3');
  if (v.type !== 'home') {
    act('Sort: newest first', () => { setViewPref('sort', 'newest'); render(); }, '↓');
    act('Sort: oldest first', () => { setViewPref('sort', 'oldest'); render(); }, '↑');
    act('Show unread only', () => { setViewPref('unreadOnly', true); render(); }, '●');
    act('Show all articles', () => { setViewPref('unreadOnly', false); render(); }, '○');
  }
  act('Text: bigger', () => readSize(1), 'A', '+');
  act('Text: smaller', () => readSize(-1), 'A', '−');
  act('Text: normal size', () => readSize(0), 'A');
  act('Font: serif', () => setReading('font', 'serif'), 'A');
  act('Font: sans-serif', () => setReading('font', 'sans'), 'A');
  act('Text and font settings…', openAa, 'Aa');
  for (const [id, name] of [['auto', 'match my system'], ['light', 'light'], ['dark', 'dark'], ['paper', 'paper'], ['classic', 'Classic 2008']]) act(`Theme: ${name}`, () => { S.settings.theme = id; saveSettings(); applyTheme(); applyReading(); }, '🎨');
  act('Show or hide the sidebar', toggleNav, '◧', 'u');
  act(S.settings.showAllFeeds ? 'Sidebar: hide read and unreadable feeds' : 'Sidebar: show all feeds', () => { S.settings.showAllFeeds = !S.settings.showAllFeeds; saveSettings(); renderSidebar(); }, '☰');
  act('Settings', openSettings, '⚙');
  act('Keyboard shortcuts', () => $('#helpDialog').showModal(), '⌨', '?');
  act('Export backup', () => exportBackup(false), '💾');
  if (abState()?.name) act('Back up now to your folder', () => abWrite(true), '💾');
  act('Export subscriptions (OPML)', () => exportOPML(), '⇪');
  if (installEvent && !isInstalled()) act('Install Sala Reader as an app', installApp, '⤓');
  PROVIDERS.forEach((p, i) => act(`AI assistant: ${p.name}`, () => switchProvider(p.id), '🤖', `Alt+${i + 1}`));
  for (const name of allFolderNames()) go_(name, `#/folder/${encodeURIComponent(name)}`, '📁', 'Folder');
  for (const t of S.topics) go_(t.name, `#/topic/${t.id}`, '✨', 'AI topic');
  if (S.smart) for (const [id, items] of S.smart) if (items.some((i) => !isRead(i.id))) { const i = smartInfo(id); go_(i.name, `#/smart/${encodeURIComponent(id)}`, i.icon, 'Smart folder'); }
  for (const inv of S.invs || []) out.push({ label: inv.name, icon: '🕵️', kind: 'Investigation', run: () => openInvestigation(inv.id) });
  for (const f of S.feeds) out.push({ label: f.title, icon: '📰', kind: 'Feed', hint: feedFolders(f).filter(Boolean).join(', '), run: () => go(`#/feed/${f.id}`) });
  if (q) {
    out.push({ always: true, label: `Search by meaning: “${q}”`, icon: '🔍', kind: 'Search', run: () => go(`#/search/${encodeURIComponent(q)}`) });
    out.push({ always: true, label: `Investigate “${q}”`, icon: '🕵️', kind: 'Command', run: () => startInvestigation({ query: q }) });
    out.push({ always: true, label: `Follow news about “${q}”`, icon: '📰', kind: 'Command', run: () => addFeed(q, '').then((feed) => { toast(`Following ${feed.title}`); go(`#/feed/${feed.id}`); }).catch((err) => toast(err.message, 5000)) });
  }
  return out;
}

/** How well a label matches what was typed (-1: not at all). */
function cmdScore(label, q) {
  const s = label.toLowerCase();
  const i = s.indexOf(q);
  if (i === 0) return 100 - s.length / 100;
  if (i > 0) return (/[\s:(“/-]/.test(s[i - 1]) ? 80 : 60) - i / 50;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => s.includes(w))) return 50;
  let j = 0, gaps = 0, last = -1;
  for (let k = 0; k < s.length && j < q.length; k++) if (s[k] === q[j]) { if (last >= 0) gaps += k - last - 1; last = k; j++; }
  return j === q.length && gaps < 12 ? 30 - gaps : -1;
}

function renderCmd() {
  const q = $('#cmdkInput').value.trim().toLowerCase();
  const all = cmdItems($('#cmdkInput').value.trim());
  cmdShown = q
    ? [...all.filter((x) => !x.always).map((x) => [x, cmdScore(x.label, q)]).filter(([, n]) => n >= 0).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([x]) => x), ...all.filter((x) => x.always)]
    : all.filter((x) => x.kind === 'Go to' || x.kind === 'Command');
  cmdSel = Math.min(cmdSel, Math.max(0, cmdShown.length - 1));
  $('#cmdkList').innerHTML = cmdShown.length
    ? cmdShown.map((x, i) => `<li role="option" id="cmd-${i}" data-i="${i}" aria-selected="${i === cmdSel}"><span class="ci" aria-hidden="true">${esc(x.icon)}</span><span class="cl">${esc(x.label)}</span><span class="ck">${esc(x.hint || x.kind)}</span>${x.key ? `<kbd>${esc(x.key)}</kbd>` : ''}</li>`).join('')
    : '<li class="cmdk-none" role="presentation">Nothing matches.</li>';
  markCmd();
}

function markCmd() {
  for (const li of $('#cmdkList').querySelectorAll('[data-i]')) li.setAttribute('aria-selected', String(+li.dataset.i === cmdSel));
  const cur = $(`#cmd-${cmdSel}`);
  if (cur) { $('#cmdkInput').setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView({ block: 'nearest' }); }
  else $('#cmdkInput').removeAttribute('aria-activedescendant');
}

function openCmd() {
  hideMenu(false);
  $('#cmdkInput').value = '';
  cmdSel = 0;
  renderCmd();
  $('#cmdk').showModal();
  $('#cmdkInput').focus();
}

function runCmd(item) {
  if (!item) return;
  $('#cmdk').close();
  closeSidebar();
  item.run();
}

// ---------- desktop: automatic backup to a folder ----------

const AB_KEEP = 7;
const abSupported = () => 'showDirectoryPicker' in window;
const abState = () => store.get('autoBackup', null); // { name, last, encrypt, pass, error, broken }
const saveAB = (patch) => store.set('autoBackup', { ...abState(), ...patch });

// The folder itself lives in its own small database, read only when a backup runs:
// some private windows crash while reading a saved folder, and the reader must still open.
const HANDLE_DB = 'salareader-folder';
let abDir = null;
function handleOp(mode, fn) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(HANDLE_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('h');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction('h', mode);
      const req = fn(tx.objectStore('h'));
      tx.oncomplete = () => { db.close(); resolve(req?.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
async function abFolder() {
  if (abDir) return abDir;
  const ab = abState();
  if (!ab?.name || ab.broken) return null;
  // If the last read never finished (the window crashed), don't try again here.
  try {
    if (localStorage.getItem('srl.abReading')) { localStorage.removeItem('srl.abReading'); saveAB({ broken: true }); return null; }
    localStorage.setItem('srl.abReading', '1');
  } catch { /* blocked */ }
  try { abDir = (await handleOp('readonly', (st) => st.get('dir'))) || null; } catch { abDir = null; }
  try { localStorage.removeItem('srl.abReading'); } catch { /* blocked */ }
  return abDir;
}
async function setABFolder(dir) {
  abDir = dir;
  await handleOp('readwrite', (st) => (dir ? st.put(dir, 'dir') : st.delete('dir')));
}

/** At start: is the folder still allowed? (Browsers ask again after a restart unless the app is installed.) */
async function abCheck() {
  if (!abState()?.name || !abSupported()) return;
  const dir = await abFolder();
  if (!dir) { renderSidebar(); return; }
  try { S.abPaused = (await dir.queryPermission({ mode: 'readwrite' })) !== 'granted'; } catch { S.abPaused = true; }
  if (S.abPaused) renderSidebar();
}

async function abChoose() {
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'salareader-backup', mode: 'readwrite', startIn: 'documents' }); } catch { return; }
  try { await setABFolder(dir); } catch (err) { toast(`This browser can't remember the folder: ${err.message || err}`, 5000); return; }
  saveAB({ name: dir.name, last: 0, error: '', broken: false });
  await abWrite(true);
  if (!abState()?.error) toast(`✓ Backing up to “${dir.name}” every day`, 4000);
}

async function abStop() {
  store.del('autoBackup');
  abDir = null;
  S.abPaused = false;
  await setABFolder(null).catch(() => {});
}

/** Writes today's backup if it's due (or now, when asked). */
async function abWrite(force) {
  const ab = abState();
  if (!ab?.name || !abSupported()) return;
  if (!force && ab.last && Date.now() - ab.last < 20 * 36e5) return;
  const dir = await abFolder();
  if (!dir) { if (force) toast('Choose the backup folder again (Settings → Automatic backup)', 5000); renderABSettings(); return; }
  let perm = 'denied';
  try {
    perm = await dir.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted' && force) perm = await dir.requestPermission({ mode: 'readwrite' });
  } catch { /* the folder is gone */ }
  S.abPaused = perm !== 'granted';
  if (S.abPaused) { renderSidebar(); renderABSettings(); if (force) toast('The browser needs your OK to write to the backup folder', 4000); return; }
  try {
    const encrypt = !!(ab.encrypt && ab.pass);
    let text = JSON.stringify(await buildBackup(encrypt));
    if (encrypt) text = JSON.stringify(await encryptBackup(text, ab.pass));
    const put = async (name) => {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
    };
    await put(`salareader-backup-${today()}.json`);
    await put('salareader-backup.json');
    const dated = [];
    for await (const [name, h] of dir.entries()) if (h.kind === 'file' && /^salareader-backup-\d{4}-\d{2}-\d{2}\.json$/.test(name)) dated.push(name);
    for (const name of dated.sort().reverse().slice(AB_KEEP)) await dir.removeEntry(name).catch(() => {});
    saveAB({ last: Date.now(), error: '' });
    if (force) toast(`✓ Backed up to “${ab.name}”${encrypt ? ', encrypted' : ''}`);
  } catch (err) {
    saveAB({ error: err.message || String(err) });
    if (force) toast(`Backup failed: ${err.message || err}`, 5000);
  }
  renderSidebar();
  renderABSettings();
}

function renderABSettings() {
  const ok = abSupported();
  $('#abBox').hidden = !ok;
  $('#abUnsupported').hidden = ok;
  if (!ok) return;
  const ab = abState();
  const on = !!ab?.name;
  $('#abEncrypt').checked = !!(ab?.encrypt && ab.pass);
  $('#abChoose').textContent = on ? 'Change folder…' : 'Choose folder…';
  $('#abNow').hidden = $('#abStop').hidden = !on;
  $('#abStatus').textContent = !on ? 'Off.'
    : ab.broken ? `This window couldn't open the folder “${ab.name}” (private windows often can't). Choose it again in a normal window.`
    : `${S.abPaused ? '⏸ Paused until you press Back up now (the browser asks before writing to the folder again).' : '✓ On:'} backing up every day to the folder “${ab.name}”${ab.encrypt && ab.pass ? ', encrypted' : ''}.${ab.last ? ` Last backup ${agoText(ab.last)}.` : ''}${ab.error ? ` The last try failed: ${ab.error}` : ''}`;
}

/** A small passphrase dialog. Resolves to the passphrase, or null if cancelled. */
function askPass({ title, hint, twice = false }) {
  const d = $('#passDialog');
  $('#passTitle').textContent = title;
  $('#passHint').textContent = hint;
  $('#pass1').value = $('#pass2').value = '';
  $('#pass2Wrap').hidden = !twice;
  $('#passStatus').textContent = '';
  d.returnValue = '';
  d.showModal();
  $('#pass1').focus();
  return new Promise((resolve) => {
    const form = d.querySelector('form');
    const submit = (e) => {
      if (e.submitter?.value !== 'ok') return;
      const p = $('#pass1').value;
      if (p.length < 8) { e.preventDefault(); $('#passStatus').textContent = 'Use at least 8 characters.'; return; }
      if (twice && p !== $('#pass2').value) { e.preventDefault(); $('#passStatus').textContent = "The two don't match."; return; }
    };
    form.addEventListener('submit', submit);
    d.addEventListener('close', () => { form.removeEventListener('submit', submit); resolve(d.returnValue === 'ok' ? $('#pass1').value : null); $('#pass1').value = $('#pass2').value = ''; }, { once: true });
  });
}

// AES-GCM with a key from the passphrase (PBKDF2, SHA-256). Everything happens in this browser.
const b64 = (buf) => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function passKey(pass, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptBackup(text, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 310000;
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await passKey(pass, salt, iterations), new TextEncoder().encode(text));
  return { app: 'salareader', encrypted: 'AES-GCM/PBKDF2-SHA256', iterations, exported: new Date().toISOString(), salt: b64(salt), iv: b64(iv), data: b64(data) };
}
async function decryptBackup(env, pass) {
  try {
    const key = await passKey(pass, unb64(env.salt), +env.iterations || 310000);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.data))));
  } catch { throw new Error('Wrong passphrase, or the file is damaged.'); }
}

// ---------- start ----------

async function start() {
  await loadStore();
  loadState();
  initResizers();
  applyReading();
  initDesktop();
  await moveBodiesOut();
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
  if (S.topics.length) loadVectors().then(() => { renderSidebar(); if (S.view.type === 'topic') render(); else if (S.view.type === 'home') refreshHome(); topicVectorsForModel().then(vectorsForTopics); });
  // Your own feeds: those due now, then every few minutes while the page is open.
  if (S.feeds.some((f) => f.own)) refreshOwnFeeds();
  setInterval(() => { if (document.visibilityState === 'visible' && S.feeds.some((f) => f.own)) refreshOwnFeeds(); }, 5 * 60 * 1000);
}

start();
