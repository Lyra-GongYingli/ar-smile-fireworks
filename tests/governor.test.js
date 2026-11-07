import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { Governor } from '../src/governor.js';

/** Feed frames at a fixed interval for `ms`; return the tier moves seen. */
function feed(g, startMs, ms, interval, work = 2) {
  const moves = [];
  for (let t = startMs; t < startMs + ms; t += interval) {
    const d = g.update(t, interval, work);
    if (d) moves.push([Math.round(t), d]);
  }
  return moves;
}

test('a 30 Hz-capped display (iOS Low Power Mode) is not treated as overload', () => {
  const g = new Governor(CONFIG.governor, 2, 2);
  const moves = feed(g, 0, 20000, 33.3, 3);
  assert.deepEqual(moves, []);
  assert.equal(g.tier, 2);
});

test('falling from 60 to ~35 fps drops a tier after ~1.5 s, then another', () => {
  const g = new Governor(CONFIG.governor, 2, 2);
  feed(g, 0, 3000, 16.7); // learn the 60 Hz display
  const moves = feed(g, 3000, 8000, 28, 12);
  assert.ok(moves.length >= 1, 'should shed load');
  assert.equal(moves[0][1], -1);
  assert.ok(moves[0][0] - 3000 < 3000, `took ${moves[0][0] - 3000} ms`);
});

test('a phone stuck at 30 fps from the first frame because of our own work still sheds load', () => {
  const g = new Governor(CONFIG.governor, 1, 2);
  const moves = feed(g, 0, 5000, 33.3, 20);
  assert.equal(moves[0]?.[1], -1, JSON.stringify(moves));
});

test('a single long frame (GC pause, tab switch) does not drop a tier', () => {
  const g = new Governor(CONFIG.governor, 2, 2);
  feed(g, 0, 3000, 16.7);
  assert.equal(g.update(3100, 180, 2), 0);
  assert.equal(g.update(3117, 300, 2), 0); // >250 ms is ignored outright
  const moves = feed(g, 3134, 5000, 16.7);
  assert.deepEqual(moves, []);
});

test('headroom raises the tier back after the settle time, never above max', () => {
  const g = new Governor(CONFIG.governor, 0, 1);
  const moves = feed(g, 0, 20000, 16.7, 1);
  assert.deepEqual(moves.map(([, d]) => d), [1]);
  assert.equal(g.tier, 1);
});
