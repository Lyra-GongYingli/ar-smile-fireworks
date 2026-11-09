import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { HIDDEN, KIND, ParticleSystem, collideEllipse, ellipseDepth, headTop } from '../src/particles.js';
import { makeCollider } from '../src/face.js';

const phys = CONFIG.physics;

function head(over = {}) {
  const h = makeCollider();
  Object.assign(h, { present: true, cx: 200, cy: 300, a: 80, b: 104, cos: 1, sin: 0, vx: 0, vy: 0 }, over);
  h.r2 = Math.max(h.a, h.b) ** 2;
  return h;
}

test('a spark dropped on the crown bounces up and stays outside', () => {
  const ps = new ParticleSystem(16);
  const h = head();
  ps.spawn(KIND.SPARK, 200, 150, 0, 300, 5, 10, 255, 255, 255, 1);
  let bounced = false;
  for (let s = 0; s < 120; s++) {
    ps.step(1 / 60, h, 400, 800, phys);
    assert.ok(ellipseDepth(h, ps.x[0], ps.y[0]) >= 0.99, `inside at step ${s}`);
    if (ps.vy[0] < 0) bounced = true;
  }
  assert.ok(bounced, 'never bounced');
  assert.ok(ps.hits > 0);
});

test('a spark landing off-centre slides off the side', () => {
  const ps = new ParticleSystem(4);
  const h = head();
  ps.spawn(KIND.SPARK, 240, 170, 0, 200, 8, 10, 255, 255, 255, 1);
  for (let s = 0; s < 240; s++) ps.step(1 / 60, h, 400, 800, phys);
  assert.ok(ps.n === 0 || ps.x[0] > h.cx + h.a * 0.9, 'should have slid off to the right');
});

test('a moving head bats a resting spark away', () => {
  const ps = new ParticleSystem(4);
  const h = head({ vx: 900 });
  ps.spawn(KIND.SPARK, 200 + 79, 300, 0, 0, 5, 10, 255, 255, 255, 1); // just inside the right edge
  const impact = collideEllipse(ps, 0, h, phys.restitution, phys.friction);
  assert.ok(impact >= 900, `impact speed ${impact}`); // the head runs into the spark at 900 px/s
  assert.ok(ps.vx[0] >= 900, `vx ${ps.vx[0]}`);
  assert.ok(ellipseDepth(h, ps.x[0], ps.y[0]) >= 1);
});

test('rotated ellipse: collision follows the rotation', () => {
  const t = Math.PI / 2; // head lying on its side: long axis horizontal
  const h = head({ cos: Math.cos(t), sin: Math.sin(t) });
  assert.ok(ellipseDepth(h, 200 + 100, 300) < 1, 'inside along the rotated long axis');
  assert.ok(ellipseDepth(h, 200, 300 + 100) > 1, 'outside along the rotated short axis');
});

test('a particle at the exact centre is pushed out without NaN', () => {
  const ps = new ParticleSystem(2);
  const h = head();
  ps.spawn(KIND.SPARK, 200, 300, 0, 0, 5, 10, 255, 255, 255, 1);
  collideEllipse(ps, 0, h, phys.restitution, phys.friction);
  assert.ok(Number.isFinite(ps.x[0]) && Number.isFinite(ps.y[0]));
  assert.ok(ellipseDepth(h, ps.x[0], ps.y[0]) >= 1);
  assert.ok(ps.y[0] < h.cy, 'pushed towards the crown');
});

test('rain on the crown splashes on the surface; rings sink a little into the hair', () => {
  const ps = new ParticleSystem(400);
  const h = head();
  for (let k = 0; k < 20; k++) ps.spawn(KIND.RAIN, 170 + k * 3, 150, 0, 1200, 3, 24, 190, 215, 255, 0.6);
  for (let s = 0; s < 12; s++) ps.step(1 / 60, h, 400, 800, phys);
  assert.equal(ps.splashes, 20);
  let rings = 0;
  for (let i = 0; i < ps.n; i++) {
    const k = ps.kind[i];
    assert.ok([KIND.SPLASH, KIND.RING, KIND.BEAD].includes(k), `unexpected kind ${k}`);
    const d = Math.sqrt(ellipseDepth(h, ps.x[i], ps.y[i])); // ~ distance from the centre in radii
    if (k === KIND.RING) {
      rings++;
      assert.ok(d < 1 && d > 1 - 9 / h.b, `ring should sit 1-8 px inside, depth ${d}`);
    } else if (ps.age[i] < 0.02) {
      assert.ok(d >= 0.99, 'droplets and beads are born on the surface, not inside the head');
    }
    assert.ok(ps.y[i] < h.cy - h.b * 0.75, 'should start near the crown');
  }
  assert.ok(rings > 0 && rings < 20, `rings on some drops, not all (${rings})`);
  assert.ok(ps.beads <= phys.maxBeads);
});

test('a bead on the crown clings, crawls down the side and drips off', () => {
  const ps = new ParticleSystem(4);
  const h = head();
  ps.spawn(KIND.BEAD, 215, 300 - 103.5, 0, 0, 10, 4, 215, 235, 255, 1); // just right of the crown
  let leftAt = -1;
  for (let s = 0; s < 600 && ps.n; s++) {
    ps.step(1 / 60, h, 400, 800, phys);
    const d = ellipseDepth(h, ps.x[0], ps.y[0]);
    if (leftAt < 0) {
      assert.ok(d >= 0.99, `inside at step ${s}`);
      if (d > 1.1) leftAt = s; // off the surface: dripping
    }
  }
  assert.ok(leftAt > 30, `left the head too soon (step ${leftAt}): it should cling and crawl first`);
  assert.ok(leftAt < 400, 'never dripped off');
});

test('embers land softly: they barely bounce and slide off', () => {
  const ps = new ParticleSystem(4);
  const h = head();
  ps.spawn(KIND.EMBER, 230, 150, 0, 400, 10, 6, 255, 196, 92, 1);
  let up = 0;
  let touched = false;
  for (let s = 0; s < 300 && ps.n; s++) {
    ps.step(1 / 60, h, 400, 800, phys);
    if (ps.hits) touched = true;
    if (touched) up = Math.max(up, -ps.vy[0]);
  }
  assert.ok(touched, 'never landed');
  assert.ok(up < 60, `bounced up at ${up} px/s`);
});

test('sparks and embers burn out on the head instead of piling up there', () => {
  const ps = new ParticleSystem(4);
  const h = head();
  ps.spawn(KIND.EMBER, 200, 300 - 104.5, 0, 0, 3, 6, 255, 196, 92, 1); // resting on the crown
  let s = 0;
  while (ps.n && s < 400) {
    ps.step(1 / 60, h, 400, 800, phys);
    s++;
  }
  assert.ok(s < 0.6 * 180, `a resting ember lived ${s} of its 180 frames`);
});

test('far rain passes behind the head: hidden there, never splashes', () => {
  const ps = new ParticleSystem(4);
  const h = head();
  ps.spawn(KIND.RAIN_FAR, 200, 120, 0, 600, 3, 12, 190, 215, 255, 0.3);
  let hidden = 0;
  for (let s = 0; s < 60 && ps.n; s++) {
    ps.step(1 / 60, h, 400, 800, phys);
    if (ps.flags[0] & HIDDEN) {
      hidden++;
      assert.ok(ellipseDepth(h, ps.x[0], ps.y[0]) < 1);
    }
  }
  assert.equal(ps.splashes, 0);
  assert.ok(hidden > 10, 'should be hidden while crossing the head');
});

test('a fast spark striking the head leaves a glint; a resting one does not', () => {
  const fast = new ParticleSystem(8);
  fast.spawn(KIND.SPARK, 200, 160, 0, 600, 5, 8, 255, 120, 40, 1);
  for (let s = 0; s < 20; s++) fast.step(1 / 60, head(), 400, 800, phys);
  assert.ok(fast.glints >= 1, 'no glint on impact');
  const rest = new ParticleSystem(8);
  rest.spawn(KIND.SPARK, 200, 300 - 104.5, 0, 0, 5, 8, 255, 120, 40, 1);
  for (let s = 0; s < 20; s++) rest.step(1 / 60, head(), 400, 800, phys);
  assert.equal(rest.glints, 0);
});

test('sliding speed does not depend on the frame rate', () => {
  const slide = (hz) => {
    const ps = new ParticleSystem(4);
    const h = head();
    ps.spawn(KIND.SPARK, 240, 300 - 95, 0, 0, 10, 8, 255, 255, 255, 1); // on the right shoulder of the ellipse
    for (let s = 0; s < hz * 0.5; s++) ps.step(1 / hz, h, 400, 800, phys);
    return ps.x[0];
  };
  const a = slide(60) - 240;
  const b = slide(120) - 240;
  assert.ok(a > 5, `did not slide (${a})`);
  assert.ok(Math.abs(a - b) / a < 0.2, `60 Hz moved ${a.toFixed(1)} px, 120 Hz ${b.toFixed(1)} px`);
});

test('headTop: crown point and top of a tilted head', () => {
  const t = 0.3;
  const h = head({ cos: Math.cos(t), sin: Math.sin(t) });
  const top = headTop(h, { x: 0, y: 0 });
  assert.ok(Math.abs(top.x - (200 + 104 * Math.sin(t))) < 1e-6);
  // nothing on the ellipse is above top.y
  for (let k = 0; k < 360; k++) {
    const u = (k / 360) * Math.PI * 2;
    const lx = Math.cos(u) * h.a;
    const ly = Math.sin(u) * h.b;
    assert.ok(h.cy + lx * h.sin + ly * h.cos >= top.y - 1e-6);
  }
});

test('pool respects its limit and recycles in O(1)', () => {
  const ps = new ParticleSystem(100);
  ps.limit = 10;
  let made = 0;
  for (let i = 0; i < 50; i++) if (ps.spawn(KIND.SPARK, 0, 0, 0, 0, 0.01, 1, 0, 0, 0, 1) >= 0) made++;
  assert.equal(made, 10);
  ps.step(0.02, makeCollider(), 100, 100, phys);
  assert.equal(ps.n, 0);
});
