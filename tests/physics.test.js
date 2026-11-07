import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { KIND, ParticleSystem, collideEllipse, ellipseDepth } from '../src/particles.js';
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
  assert.ok(collideEllipse(ps, 0, h, phys.restitution, phys.friction));
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

test('rain that hits the head becomes a splash born on the surface', () => {
  const ps = new ParticleSystem(16);
  const h = head();
  ps.spawn(KIND.RAIN, 200, 150, 0, 1200, 3, 24, 190, 215, 255, 0.6);
  let s = 0;
  while (ps.n > 0 && ps.kind[0] === KIND.RAIN && s++ < 30) ps.step(1 / 60, h, 400, 800, phys);
  assert.ok(ps.n >= 1, 'no splash');
  for (let i = 0; i < ps.n; i++) {
    assert.equal(ps.kind[i], KIND.SPLASH);
    assert.ok(ellipseDepth(h, ps.x[i], ps.y[i]) >= 0.98, 'splash born inside the head');
    assert.ok(ps.y[i] < h.cy - h.b * 0.8, 'splash should start near the crown');
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
