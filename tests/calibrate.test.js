import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Calibration, PHASES, quantile } from '../src/calibrate.js';
import { EXPR } from '../src/expression.js';

test('quantile interpolates and ignores input order', () => {
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([0, 10], 0.1), 1);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});

test('the script walks every phase, records only after the reading gap, then finishes', () => {
  const c = new Calibration('zh');
  c.begin(0);
  const fake = { smile: 0.5, jaw: 0.1, state: EXPR.SMILE };
  const sig = { smileRaw: 0.6, jawRaw: 0.1, funnel: 0.01, pucker: 0.02 };
  const seen = new Set();
  let done = false;
  for (let t = 0; t < 60000 && !done; t += 33) {
    const ui = c.tick(t);
    if (ui.done) done = true;
    else seen.add(ui.step);
    c.record(t, t % 330 === 0 ? null : sig, 0.05, fake);
  }
  assert.ok(done, 'never finished');
  assert.equal(seen.size, PHASES.length);
  const s = c.summary();
  assert.deepEqual(s.map((x) => x.phase), PHASES.map((p) => p.key));
  for (const row of s) {
    const p = PHASES.find((q) => q.key === row.phase);
    // ~30 detections per second of recording, none during the 2 s reading gap
    assert.ok(Math.abs(row.frames - p.ms / 33) <= 2, `${row.phase}: ${row.frames} frames`);
    assert.ok(row.noFace > 0, 'no-face frames are counted separately');
    assert.equal(row.smileRaw[1], 0.6);
    assert.equal(row.states.smile, 1);
  }
  assert.equal(s.find((x) => x.phase === 'smile').hit, 1);
  assert.equal(s.find((x) => x.phase === 'laugh').hit, 0);
});
