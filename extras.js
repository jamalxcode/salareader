// Sala Reader extras: the parts of "For you", developing stories, mutes,
// achievements and the weekly recap that don't touch the reader's state.
// Everything here runs on this device; nothing is sent anywhere.

import { dot } from './ai.js';

// ---------- words ----------

const STOP = new Set(`the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were what into year also back after first about would there their which could other these those then while where being under again said says says says
les des une pour dans sur avec par est qui que pas plus aux ses son
der die das und mit von für den dem ist ein eine auf sich nicht auch als
los las del por con una para que más`.split(/\s+/));

/** The meaningful words of a headline: lower case, 3+ letters, no common words. */
export function tokens(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(w);
  }
  return [...out];
}

// ---------- learning what you like ----------

/** An empty taste: per-feed and per-word weights, and a vector per AI model. */
export const newTaste = () => ({ feeds: {}, words: {}, vec: {}, n: 0 });

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const MAX_WORDS = 3000;

/**
 * Learns from one thing you did with an article: w > 0 means more like this
 * (opened, starred, kept), w < 0 less (skipped).
 */
export function learn(taste, it, w, vec, model) {
  taste.n = (taste.n || 0) + 1;
  taste.feeds[it.f] = clamp((taste.feeds[it.f] || 0) + w, -15, 40);
  for (const t of tokens(it.t)) taste.words[t] = clamp((taste.words[t] || 0) + w, -10, 20);
  const keys = Object.keys(taste.words);
  if (keys.length > MAX_WORDS) {
    keys.sort((a, b) => Math.abs(taste.words[a]) - Math.abs(taste.words[b]));
    for (const k of keys.slice(0, keys.length - MAX_WORDS)) delete taste.words[k];
  }
  if (vec && model) {
    // A running average that leans towards recent choices.
    const old = taste.vec[model];
    const next = new Array(vec.length);
    for (let i = 0; i < vec.length; i++) next[i] = +(((old ? old[i] * 0.95 : 0) + vec[i] * w * 0.05)).toFixed(5);
    taste.vec[model] = next;
  }
}

/** How much you'd want this article, roughly -1…2. */
export function tasteScore(taste, it, vec, model, now = Date.now()) {
  const feed = Math.tanh((taste.feeds[it.f] || 0) / 6);
  let words = 0;
  for (const t of tokens(it.t)) words += taste.words[t] || 0;
  words = Math.tanh(words / 5);
  let sim = 0;
  const tv = taste.vec?.[model];
  if (vec && tv) {
    let n = 0;
    for (let i = 0; i < tv.length; i++) n += tv[i] * tv[i];
    if (n > 1e-9) sim = dot(vec, tv) / Math.sqrt(n);
  }
  const ageH = Math.max(0, (now - it.d) / 36e5);
  const fresh = Math.exp(-ageH / 36);
  return feed * 0.55 + words * 0.35 + sim * 0.9 + fresh * 0.45 + (it.i ? 0.05 : 0);
}

// ---------- developing stories: the same news from several feeds ----------

/**
 * Groups recent articles about the same story. Candidates share rare
 * headline words; a match is confirmed by the AI vectors when both articles
 * have one (so it works across languages too), or by enough shared words.
 */
export function clusterStories(items, vecOf, { now = Date.now(), hours = 48, max = 2000 } = {}) {
  const recent = items.filter((i) => now - i.d < hours * 36e5).slice(0, max);
  const toks = recent.map((i) => tokens(i.t));
  const df = new Map();
  for (const ts of toks) for (const t of ts) df.set(t, (df.get(t) || 0) + 1);
  const rareLimit = Math.max(4, Math.round(recent.length * 0.02));
  const clusters = [];
  const byWord = new Map(); // word -> cluster indexes
  for (let k = 0; k < recent.length; k++) {
    const it = recent[k];
    const ts = toks[k];
    const rare = ts.filter((t) => df.get(t) <= rareLimit && df.get(t) > 1);
    const v = vecOf(it.id);
    const cands = new Set();
    for (const t of rare) for (const c of byWord.get(t) || []) cands.add(c);
    let best = -1, bestScore = 0;
    for (const c of cands) {
      const cl = clusters[c];
      if (cl.feeds.has(it.f) && cl.items.length > 6) continue;
      const lead = cl.items[0];
      const lv = cl.vec;
      let s;
      if (v && lv) s = dot(v, lv);
      else {
        const lt = new Set(cl.toks);
        const shared = ts.filter((t) => lt.has(t)).length;
        s = shared >= 3 ? 0.8 : shared >= 2 && shared / Math.min(ts.length, lt.size) >= 0.5 ? 0.79 : 0;
      }
      if (lead.f === it.f && s < 0.9) continue; // one feed repeating itself isn't a story
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (best >= 0 && bestScore >= 0.78) {
      const cl = clusters[best];
      cl.items.push(it);
      cl.feeds.add(it.f);
      for (const t of rare) { const l = byWord.get(t) || []; if (!l.includes(best)) l.push(best); byWord.set(t, l); }
    } else {
      const idx = clusters.length;
      clusters.push({ items: [it], feeds: new Set([it.f]), vec: v || null, toks: ts });
      for (const t of rare) { const l = byWord.get(t) || []; l.push(idx); byWord.set(t, l); }
    }
  }
  return clusters
    .filter((c) => c.feeds.size >= 2)
    .map((c) => {
      const sorted = [...c.items].sort((a, b) => a.d - b.d);
      const newest = sorted[sorted.length - 1];
      return { id: 's' + sorted[0].id, items: sorted, feeds: c.feeds.size, first: sorted[0].d, last: newest.d, lead: c.items.find((i) => i.i) || c.items[0], heat: c.feeds.size * 2 + c.items.length + Math.exp(-(now - newest.d) / 216e5) * 3 };
    })
    .sort((a, b) => b.heat - a.heat);
}

// ---------- achievements ----------

/** Each badge: what it takes, checked against your counters (stats). */
export const BADGES = [
  { id: 'first', icon: '📖', name: 'First page', desc: 'Open your first article', test: (s) => s.opened >= 1 },
  { id: 'reader100', icon: '📚', name: 'Bookworm', desc: 'Open 100 articles', test: (s) => s.opened >= 100 },
  { id: 'reader1000', icon: '🏛️', name: 'Library card', desc: 'Open 1,000 articles', test: (s) => s.opened >= 1000 },
  { id: 'collector', icon: '⭐', name: 'Collector', desc: 'Star 10 articles', test: (s) => s.starred >= 10 },
  { id: 'zero', icon: '🎉', name: 'Inbox zero', desc: 'Read everything', test: (s) => s.zeros >= 1 },
  { id: 'zero7', icon: '🧘', name: 'Zen master', desc: 'Reach inbox zero on 7 different days', test: (s) => (s.zeroDays || []).length >= 7 },
  { id: 'streak7', icon: '🔥', name: 'On fire', desc: 'Read 7 days in a row', test: (s) => s.bestStreak >= 7 },
  { id: 'streak30', icon: '🌋', name: 'Unstoppable', desc: 'Read 30 days in a row', test: (s) => s.bestStreak >= 30 },
  { id: 'polyglot', icon: '🌍', name: 'Polyglot', desc: 'Read articles in 3 languages', test: (s) => Object.keys(s.langs || {}).length >= 3 },
  { id: 'owl', icon: '🦉', name: 'Night owl', desc: 'Read between midnight and 5 am', test: (s) => s.owl >= 1 },
  { id: 'bird', icon: '🐦', name: 'Early bird', desc: 'Read between 5 and 7 am', test: (s) => s.bird >= 1 },
  { id: 'explorer', icon: '🧭', name: 'Explorer', desc: 'Read from 25 different feeds', test: (s) => Object.keys(s.feedsRead || {}).length >= 25 },
  { id: 'swiper', icon: '⚡', name: 'Swipe master', desc: 'Sort 100 articles in swipe rounds', test: (s) => s.swipes >= 100 },
  { id: 'speedrun', icon: '⏱️', name: 'Speed run', desc: 'Finish a 20-card round in under a minute', test: (s) => s.bestRound > 0 && s.bestRound < 60000 },
  { id: 'highlighter', icon: '🖍️', name: 'Highlighter', desc: 'Save 10 highlights or notes', test: (s) => s.highlights >= 10 },
  { id: 'curator', icon: '🔇', name: 'Curator', desc: 'Mute a subject you don\'t want to see', test: (s) => s.mutes >= 1 },
  { id: 'tidy', icon: '🧹', name: 'Spring cleaning', desc: 'Unsubscribe from a feed you never read', test: (s) => s.tidied >= 1 },
  { id: 'storyteller', icon: '🧵', name: 'Story follower', desc: 'Open a developing story', test: (s) => s.stories >= 1 },
];

/** Badges newly earned (not yet in `have`). */
export const newBadges = (stats, have) => BADGES.filter((b) => !have[b.id] && b.test(stats));

// ---------- the weekly recap card (drawn on this device) ----------

/** Draws the recap as a 1080×1350 picture, for saving or sharing. */
export function drawRecap(canvas, r) {
  const W = 1080, H = 1350;
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  const g = c.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1a3fa0'); g.addColorStop(0.55, '#6b2bb8'); g.addColorStop(1, '#c2185b');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  const font = (w, s) => `${w} ${s}px Inter, system-ui, -apple-system, "Segoe UI", sans-serif`;
  c.fillStyle = '#fff';
  c.font = font(600, 40); c.fillText('Sala Reader · my week in reading', 80, 120);
  c.font = font(400, 34); c.globalAlpha = 0.85; c.fillText(r.range, 80, 172); c.globalAlpha = 1;
  c.font = font(800, 200); c.fillText(String(r.opened), 80, 420);
  c.font = font(600, 48); c.fillText(r.opened === 1 ? 'article read' : 'articles read', 80, 490);
  // Bars: one per day.
  const max = Math.max(1, ...r.days.map((d) => d.n));
  const bw = 100, gap = 30, x0 = 80, base = 800;
  r.days.forEach((d, i) => {
    const h = Math.round((d.n / max) * 220);
    c.globalAlpha = 0.25; c.fillRect(x0 + i * (bw + gap), base - 220, bw, 220);
    c.globalAlpha = 1; c.fillRect(x0 + i * (bw + gap), base - h, bw, h);
    c.font = font(600, 30); c.fillText(d.label, x0 + i * (bw + gap) + 22, base + 46);
  });
  let y = 940;
  const line = (label, value) => {
    c.font = font(400, 34); c.globalAlpha = 0.85; c.fillText(label, 80, y); c.globalAlpha = 1;
    c.font = font(700, 40); c.fillText(value.length > 34 ? value.slice(0, 33) + '…' : value, 420, y);
    y += 70;
  };
  if (r.topFeed) line('Top feed', r.topFeed);
  if (r.topTopic) line('Top topic', r.topTopic);
  line('Streak', `🔥 ${r.streak} day${r.streak === 1 ? '' : 's'}`);
  if (r.badges) line('Achievements', `🏅 ${r.badges}`);
  c.font = font(500, 30); c.globalAlpha = 0.8; c.fillText('reader.sala.company', 80, H - 70); c.globalAlpha = 1;
}
