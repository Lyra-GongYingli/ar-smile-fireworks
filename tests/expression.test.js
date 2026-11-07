import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { EXPR, ExpressionMachine, resolveBlendshapeIndices, scoresByIndex } from '../src/expression.js';

const DT = 1000 / 30; // detection at 30 Hz

/** Feed `fn(tMs) -> sig|null` for `ms` milliseconds; return events and time spent per state. */
function run(m, ms, fn, yawFn = () => 0) {
  const events = [];
  const timeIn = [0, 0, 0];
  for (let t = 0; t < ms; t += DT) {
    const ev = m.update(DT, fn(t), yawFn(t));
    if (ev) events.push([Math.round(t), ev]);
    timeIn[m.state] += DT;
  }
  return { events, timeIn };
}

const face = (smileRaw, jawRaw, funnel = 0.02, pucker = 0.02) => ({ smileRaw, jawRaw, funnel, pucker });
const neutral = () => face(0.04, 0.03);
const fresh = () => {
  const m = new ExpressionMachine(CONFIG.expr);
  run(m, 1000, neutral); // settle the baseline on a resting face
  return m;
};

test('resting face never triggers', () => {
  const m = fresh();
  const r = run(m, 5000, (t) => face(0.04 + 0.03 * Math.sin(t / 90), 0.03 + 0.02 * Math.sin(t / 70)));
  assert.deepEqual(r.events, []);
  assert.equal(m.state, EXPR.NONE);
});

test('a smile starts rain within 250 ms and stops after it ends', () => {
  const m = fresh();
  const r = run(m, 1500, () => face(0.75, 0.06));
  assert.equal(r.events[0][1], 'smile');
  assert.ok(r.events[0][0] <= 250, `smile took ${r.events[0][0]} ms`);
  assert.ok(m.rainLevel() > 0.6);
  const r2 = run(m, 1000, neutral);
  assert.equal(r2.events.at(-1)[1], 'none');
  assert.equal(m.rainLevel(), 0);
});

test('a laugh fires once, within 300 ms', () => {
  const m = fresh();
  const r = run(m, 2000, () => face(0.8, 0.5));
  const laughs = r.events.filter(([, e]) => e === 'laugh');
  assert.equal(laughs.length, 1);
  assert.ok(laughs[0][0] <= 300, `laugh took ${laughs[0][0]} ms`);
  assert.equal(m.state, EXPR.LAUGH);
});

test('"ha-ha-ha" jaw pulses keep one continuous laugh', () => {
  const m = fresh();
  const r = run(m, 4000, (t) => face(0.78, 0.38 + 0.2 * Math.sin((t / 1000) * 2 * Math.PI * 4)));
  const laughs = r.events.filter(([, e]) => e === 'laugh');
  assert.equal(laughs.length, 1, JSON.stringify(r.events));
  assert.equal(m.state, EXPR.LAUGH);
});

test('talking without smiling triggers nothing', () => {
  const m = fresh();
  const r = run(m, 5000, (t) => face(0.08, 0.15 + 0.15 * Math.abs(Math.sin((t / 1000) * Math.PI * 5))));
  assert.deepEqual(r.events, []);
});

test('talking while smiling is a smile, not a laugh', () => {
  const m = fresh();
  const r = run(m, 5000, (t) => face(0.62, 0.12 + 0.14 * Math.abs(Math.sin((t / 1000) * Math.PI * 5))));
  assert.ok(r.events.some(([, e]) => e === 'smile'));
  assert.ok(!r.events.some(([, e]) => e === 'laugh'), JSON.stringify(r.events));
});

test('a yawn (open mouth, no smile) is not a laugh', () => {
  const m = fresh();
  const r = run(m, 3000, () => face(0.05, 0.85));
  assert.deepEqual(r.events, []);
});

test('surprise "O" mouth is vetoed even with some smile', () => {
  const m = fresh();
  const r = run(m, 3000, () => face(0.4, 0.5, 0.55, 0.1));
  assert.ok(!r.events.some(([, e]) => e === 'laugh'));
});

test('a single-frame spike does not trigger', () => {
  const m = fresh();
  const r = run(m, 2000, (t) => (t > 500 && t < 500 + DT ? face(0.95, 0.7) : neutral()));
  assert.deepEqual(r.events, []);
});

test('a high resting smile is absorbed by the baseline, a real smile still counts', () => {
  const m = new ExpressionMachine(CONFIG.expr);
  const r0 = run(m, 3000, () => face(0.26, 0.05)); // this person looks "smiley" at rest
  assert.deepEqual(r0.events, []);
  const r1 = run(m, 1000, () => face(0.86, 0.07));
  assert.equal(r1.events[0][1], 'smile');
});

test('a long smile is not absorbed into the baseline', () => {
  const m = fresh();
  run(m, 60000, () => face(0.7, 0.06));
  assert.equal(m.state, EXPR.SMILE);
});

test('side view holds still, then times out', () => {
  const m = fresh();
  const r = run(m, 3000, () => face(0.8, 0.06), () => 0.7);
  assert.deepEqual(r.events, []);
  run(m, 500, () => face(0.8, 0.06));
  assert.equal(m.state, EXPR.SMILE);
  const r2 = run(m, 2000, () => face(0.8, 0.06), () => 0.8);
  assert.equal(r2.events.at(-1)[1], 'none');
});

test('losing the face resets after 400 ms', () => {
  const m = fresh();
  run(m, 800, () => face(0.8, 0.5));
  assert.equal(m.state, EXPR.LAUGH);
  const r = run(m, 1000, () => null);
  assert.equal(r.events[0][1], 'none');
  assert.ok(r.events[0][0] >= 350 && r.events[0][0] <= 450);
});

test('categories sorted by score are still read by index', () => {
  const names = ['_neutral', 'jawOpen', 'mouthFunnel', 'mouthPucker', 'mouthSmileLeft', 'mouthSmileRight'];
  const cats = names.map((n, i) => ({ categoryName: n, index: i, score: i / 10, displayName: '' }));
  const sorted = [...cats].sort((a, b) => b.score - a.score);
  const { idx, missing } = resolveBlendshapeIndices(sorted);
  assert.deepEqual(missing, []);
  const out = scoresByIndex(sorted, new Float32Array(8));
  assert.equal(out[idx.jawOpen], Math.fround(0.1));
  assert.equal(out[idx.mouthSmileRight], Math.fround(0.5));
});
