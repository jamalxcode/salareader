// The shared catalog's dead-or-alive rules (scripts/fetch.mjs): node --test tests/unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failKind, judge, DEAD_AFTER } from '../../scripts/fetch.mjs';

const day = 864e5;
const t0 = Date.UTC(2026, 10, 1);

test('failures are sorted by kind', () => {
  assert.equal(failKind({ status: 404 }), 'gone');
  assert.equal(failKind({ status: 410 }), 'gone');
  assert.equal(failKind({ status: 403 }), 'blocked');
  assert.equal(failKind({ status: 429 }), 'blocked');
  assert.equal(failKind({ status: 500 }), 'down');
  assert.equal(failKind({ network: true }), 'down');
  assert.equal(failKind(new Error('Not an RSS or Atom feed')), 'notfeed');
});

test('a gone feed is retired after a day, not before', () => {
  const f = {};
  assert.equal(judge(f, 'gone', t0), '');
  assert.equal(judge(f, 'gone', t0 + day / 2), '');
  assert.equal(judge(f, 'gone', t0 + DEAD_AFTER.gone), 'gone');
  assert.ok(f.retired);
});

test('a feed that is no longer a feed is retired after 3 days', () => {
  const f = {};
  judge(f, 'notfeed', t0);
  assert.equal(judge(f, 'notfeed', t0 + 2 * day), '');
  assert.equal(judge(f, 'notfeed', t0 + 3 * day), 'no longer a feed');
});

test('down or blocked sites are left alone for a month', () => {
  const down = {};
  judge(down, 'down', t0);
  assert.equal(judge(down, 'down', t0 + 29 * day), '');
  assert.equal(down.retired, undefined);
  assert.equal(judge(down, 'down', t0 + 30 * day), 'down for a month');
  const blocked = {};
  judge(blocked, 'blocked', t0);
  assert.equal(judge(blocked, 'blocked', t0 + 30 * day), 'unreadable for a month');
});

test('a change of kind restarts the clock for gone, but not the month for down', () => {
  const f = {};
  judge(f, 'down', t0);
  judge(f, 'gone', t0 + 20 * day); // first time gone
  assert.equal(judge(f, 'gone', t0 + 20.5 * day), '');
  assert.equal(judge(f, 'gone', t0 + 21 * day), 'gone');
});
