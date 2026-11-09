import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { KIND, ParticleSystem, headTop } from '../src/particles.js';
import { Effects, SHELL } from '../src/effects.js';
import { SHAPE } from '../src/sprites.js';
import { makeCollider } from '../src/face.js';

const W = 390;
const H = 844;

function head(over = {}) {
  const h = makeCollider();
  Object.assign(h, { present: true, cx: 200, cy: 420, a: 100, b: 130, cos: 1, sin: 0, vx: 0, vy: 0 }, over);
  h.r2 = Math.max(h.a, h.b) ** 2;
  return h;
}

function setup(cap = 5000) {
  const ps = new ParticleSystem(cap);
  const fx = new Effects(ps, CONFIG);
  fx.setTier(CONFIG.tiers[1]);
  return { ps, fx };
}

/** Run effects + physics for `ms` at 60 Hz. state: {smile, laugh, laughing} or a function of time. */
function run(ps, fx, h, ms, state, t0 = 0, each = null) {
  let t = t0;
  for (; t < t0 + ms; t += 1000 / 60) {
    const s = typeof state === 'function' ? state(t) : state;
    fx.update(1 / 60, t, s.smile || 0, s.laugh || 0, !!s.laughing, h, W, H);
    ps.step(1 / 60, h, W, H, CONFIG.physics);
    if (each) each(t);
  }
  return t;
}

const puffs = (fx) => {
  const out = [];
  for (let i = 0; i < fx.sprites.n; i++) if (fx.sprites.shape[i] === SHAPE.PUFF) out.push(i);
  return out;
};

test('a smile grows a cloud above the head that rains on it', () => {
  const { ps, fx } = setup();
  const h = head();
  run(ps, fx, h, 2000, { smile: 0.7 });
  const c = fx.cloud;
  assert.ok(c.amt > 0.95, `cloud amount ${c.amt}`);
  const top = headTop(h, { x: 0, y: 0 });
  assert.ok(Math.abs(c.x - top.x) < 2, 'centred over the crown');
  const p = puffs(fx);
  assert.equal(p.length, 7);
  for (const i of p) assert.ok(fx.sprites.y[i] < top.y, 'puffs stay above the head');
  assert.ok(ps.splashes > 20, `only ${ps.splashes} drops landed on the head`);
});

test('the cloud follows a moving head with a little lag', () => {
  const { ps, fx } = setup();
  const h = head();
  run(ps, fx, h, 1500, { smile: 0.7 });
  h.cx += 80;
  run(ps, fx, h, 50, { smile: 0.7 }, 1500);
  const lagging = fx.cloud.x;
  assert.ok(lagging > 200 && lagging < 270, `after 50 ms: ${lagging}`);
  run(ps, fx, h, 800, { smile: 0.7 }, 1550);
  assert.ok(Math.abs(fx.cloud.x - 280) < 2, `caught up: ${fx.cloud.x}`);
});

test('close-up: with no room above the head the cloud shrinks first and never covers the forehead', () => {
  for (const cy of [160, 330, 440]) {
    const { ps, fx } = setup();
    const h = head({ cy, a: 190, b: 320 }); // face filling a laptop frame
    run(ps, fx, h, 1500, { smile: 1 });
    const top = headTop(h, { x: 0, y: 0 });
    const forehead = top.y + 0.46 * h.b; // forehead landmark: the ellipse adds 30% of the face height above it
    let lowest = -Infinity;
    for (const i of puffs(fx)) lowest = Math.max(lowest, fx.sprites.y[i] + (fx.sprites.size[i] / 2) * 0.85);
    assert.ok(lowest <= top.y + h.b * CONFIG.rain.hairOverlap + 1, `cy ${cy}: cloud reaches ${lowest.toFixed(0)}, crown ${top.y.toFixed(0)}`);
    assert.ok(lowest < forehead, 'never over the forehead');
    assert.ok(fx.cloud.w >= 2 * h.a * CONFIG.rain.minWidth - 1, 'shrinks, but stays a readable size');
  }
});

test('with room above the head the cloud keeps its full size and gap', () => {
  const { ps, fx } = setup();
  const h = head({ cy: 520 });
  run(ps, fx, h, 1500, { smile: 0.35 });
  assert.ok(Math.abs(fx.cloud.w - 2 * h.a * CONFIG.rain.cloudWidth[0]) < 1, `w ${fx.cloud.w}`);
});

test('a laugh blows the cloud away, stops the rain and launches three rockets', () => {
  const { ps, fx } = setup();
  const h = head();
  let t = run(ps, fx, h, 1500, { smile: 0.8 });
  fx.onLaugh(t);
  assert.equal(fx.pN, 3);
  let rainAfter = 0;
  t = run(ps, fx, h, 900, { smile: 0, laugh: 0.3, laughing: true }, t, () => {
    for (let i = 0; i < ps.n; i++) if (ps.kind[i] === KIND.RAIN && ps.age[i] === 0) rainAfter++;
  });
  assert.equal(fx.cloud.amt, 0, 'cloud gone');
  assert.equal(puffs(fx).length, 0);
  assert.ok(rainAfter < 60, `rain kept falling: ${rainAfter} new drops`);
  assert.equal(fx.bursts, 3);
});

test('rockets break where they were aimed, above the head, at any frame rate', () => {
  for (const hz of [60, 20]) {
    const { ps, fx } = setup();
    const h = head();
    let aim = null;
    const orig = fx.target.bind(fx);
    fx.target = (...a) => (aim = { ...orig(...a) });
    fx.queue(0, SHELL.PEONY, 0, 0.4);
    for (let t = 0; fx.bursts === 0 && t < 2000; t += 1000 / hz) {
      fx.update(1 / hz, t, 0, 0, false, h, W, H);
    }
    assert.ok(Math.hypot(fx.lastBurst.x - aim.x, fx.lastBurst.y - aim.y) < 0.5, `${hz} Hz: off by ${fx.lastBurst.y - aim.y}`);
    assert.ok(fx.lastBurst.y < headTop(h, { x: 0, y: 0 }).y, 'breaks above the crown');
  }
});

test('a long laugh ends in golden willows; hearts are rationed', () => {
  const { ps, fx } = setup();
  const h = head();
  fx.onLaugh(0);
  run(ps, fx, h, 6000, { laugh: 0.9, laughing: true });
  assert.ok(fx.shellCount[SHELL.WILLOW] >= 3, `willows: ${fx.shellCount[SHELL.WILLOW]}`);
  assert.ok(fx.shellCount[SHELL.HEART] <= 2, `hearts: ${fx.shellCount[SHELL.HEART]} in 6 s`);
  assert.ok(fx.bursts >= 10, `bursts: ${fx.bursts}`);
});

test('photosensitivity: <= 3 bright flashes per second, scene light under the 10% flash threshold', () => {
  const { ps, fx } = setup();
  const times = [];
  let t = 0;
  for (; t < 3000; t += 1000 / 60) {
    // far denser than any laugh produces: a burst every 50 ms
    if (Math.round(t) % 50 < 17) {
      const before = fx.flashes;
      fx.burst(SHELL.PEONY, 200, 200, 390);
      if (fx.flashes > before) times.push(t);
    }
    fx.update(1 / 60, t, 0, 0, false, makeCollider(), W, H);
    ps.step(1 / 60, makeCollider(), W, H, CONFIG.physics);
    assert.ok(fx.light.i <= CONFIG.fireworks.light.max + 1e-9, `light ${fx.light.i}`);
    assert.ok(CONFIG.fireworks.light.max < 0.1);
  }
  for (let k = 3; k < times.length; k++) assert.ok(times[k] - times[k - 3] >= 1000, `4 flashes within ${times[k] - times[k - 3]} ms`);
});

test('every shell type works when the pool is nearly full', () => {
  const { ps, fx } = setup(60);
  for (let s = 0; s < 5; s++) {
    fx.burst(s, 200, 200, 390);
    assert.ok(ps.n <= ps.limit);
  }
  for (let k = 0; k < 120; k++) ps.step(1 / 60, makeCollider(), W, H, CONFIG.physics);
});

test('the heart shell keeps its shape while it grows and sinks', () => {
  const { ps, fx } = setup();
  fx.burst(SHELL.HEART, 200, 200, 390);
  // Particles are swap-removed (the core flash dies first), so match stars by their random seed.
  const snap = () => {
    const m = new Map();
    for (let i = 0; i < ps.n; i++) if (ps.kind[i] === KIND.SPARK) m.set(ps.seed[i], [ps.x[i], ps.y[i]]);
    return m;
  };
  for (let k = 0; k < 6; k++) ps.step(1 / 60, makeCollider(), W, H, CONFIG.physics);
  const A = snap();
  for (let k = 0; k < 24; k++) ps.step(1 / 60, makeCollider(), W, H, CONFIG.physics);
  const B = snap();
  const keys = [...A.keys()].filter((key) => B.has(key));
  assert.ok(keys.length > 50);
  const a = keys.map((key) => A.get(key));
  const b = keys.map((key) => B.get(key));
  const centroid = (p) => p.reduce((s, q) => [s[0] + q[0] / p.length, s[1] + q[1] / p.length], [0, 0]);
  const spread = (p, c) => Math.sqrt(p.reduce((s, q) => s + (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2, 0) / p.length);
  const ca = centroid(a);
  const cb = centroid(b);
  const k = spread(b, cb) / spread(a, ca);
  let err = 0;
  for (let i = 0; i < a.length; i++) err = Math.max(err, Math.hypot(b[i][0] - cb[0] - (a[i][0] - ca[0]) * k, b[i][1] - cb[1] - (a[i][1] - ca[1]) * k));
  assert.ok(k > 1.2, 'it grows');
  assert.ok(err < 1, `shape distorted by ${err.toFixed(2)} px`);
  assert.ok(cb[1] > ca[1], 'and sinks');
});

test('the cloud shrinks to fit the GPU point-size cap instead of being clipped', () => {
  const { ps, fx } = setup();
  fx.maxSprite = 120; // e.g. a 240 px point-size cap at 2x
  const h = head({ a: 160, b: 200, cy: 600 });
  run(ps, fx, h, 1500, { smile: 1 });
  let biggest = 0;
  for (const i of puffs(fx)) biggest = Math.max(biggest, fx.sprites.size[i]);
  assert.ok(biggest <= 120, `puff ${biggest.toFixed(1)} px > cap`);
});
