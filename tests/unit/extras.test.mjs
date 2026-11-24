// For you, developing stories and achievements (extras.js): the parts without the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokens, newTaste, learn, tasteScore, clusterStories, BADGES, newBadges } from '../../extras.js';

const unit = (arr) => { const v = Float32Array.from(arr); const n = Math.hypot(...v); return v.map((x) => x / n); };

test('tokens keeps meaningful words only', () => {
  assert.deepEqual(tokens('The SpaceX rocket and the 2026 launch'), ['spacex', 'rocket', 'launch']);
  assert.deepEqual(tokens('Землетрясение в Армении'), ['землетрясение', 'армении']);
});

test('learning: liked feeds and words rank higher, skipped ones lower', () => {
  const now = Date.UTC(2026, 10, 24);
  const taste = newTaste();
  for (let i = 0; i < 4; i++) learn(taste, { f: 'a', t: 'Electric cars get cheaper' }, 2);
  learn(taste, { f: 'b', t: 'Celebrity gossip roundup' }, -1.5);
  const liked = { f: 'a', t: 'New electric cars this week', d: now };
  const neutral = { f: 'c', t: 'Weather update', d: now };
  const skipped = { f: 'b', t: 'More celebrity gossip', d: now };
  assert.ok(tasteScore(taste, liked, null, 'en', now) > tasteScore(taste, neutral, null, 'en', now));
  assert.ok(tasteScore(taste, neutral, null, 'en', now) > tasteScore(taste, skipped, null, 'en', now));
});

test('learning: meaning counts when vectors are there', () => {
  const now = Date.UTC(2026, 10, 24);
  const taste = newTaste();
  learn(taste, { f: 'a', t: 'x' }, 2, unit([1, 0, 0]), 'en');
  const near = { f: 'z', t: 'one', d: now };
  const far = { f: 'z', t: 'two', d: now };
  assert.ok(tasteScore(taste, near, unit([0.9, 0.1, 0]), 'en', now) > tasteScore(taste, far, unit([0, 0, 1]), 'en', now));
});

test('stories: the same news from several feeds is one story; one feed alone is not', () => {
  const now = Date.UTC(2026, 10, 24, 12);
  const h = 36e5;
  const items = [
    { id: '1', f: 'bbc', t: 'Earthquake hits Yerevan, buildings damaged', d: now - 1 * h },
    { id: '2', f: 'cnn', t: 'Strong earthquake shakes Yerevan', d: now - 2 * h },
    { id: '3', f: 'npr', t: 'Yerevan earthquake: what we know', d: now - 3 * h },
    { id: '4', f: 'bbc', t: 'Football: late winner in derby', d: now - 1 * h },
    { id: '5', f: 'bbc', t: 'Football derby ends with late winner', d: now - 2 * h },
    { id: '6', f: 'xyz', t: 'Unrelated recipe for soup', d: now - 1 * h },
  ];
  const st = clusterStories(items, () => null, { now });
  assert.equal(st.length, 1);
  assert.deepEqual(st[0].items.map((i) => i.id), ['3', '2', '1']);
  assert.equal(st[0].feeds, 3);
});

test('stories: vectors match across languages', () => {
  const now = Date.UTC(2026, 10, 24, 12);
  const vec = { a: unit([1, 0.05, 0]), b: unit([1, 0, 0.05]), c: unit([0, 1, 0]) };
  const items = [
    { id: 'a', f: 'en', t: 'Summit in Geneva ends', d: now - 36e5 },
    { id: 'b', f: 'fr', t: 'Le sommet de Geneva se termine', d: now - 2 * 36e5 },
    { id: 'c', f: 'de', t: 'Geneva Wetter heute', d: now - 36e5 },
  ];
  const st = clusterStories(items, (id) => vec[id], { now });
  assert.equal(st.length, 1);
  assert.deepEqual(st[0].items.map((i) => i.id).sort(), ['a', 'b']);
});

test('achievements: earned once', () => {
  const stats = { opened: 120, starred: 3, bestStreak: 8, langs: { en: 5, fr: 1, ar: 2 } };
  const got = newBadges(stats, {}).map((b) => b.id);
  assert.deepEqual(got, ['first', 'reader100', 'streak7', 'polyglot']);
  assert.deepEqual(newBadges(stats, Object.fromEntries(got.map((id) => [id, 1]))), []);
  assert.equal(new Set(BADGES.map((b) => b.id)).size, BADGES.length);
});
