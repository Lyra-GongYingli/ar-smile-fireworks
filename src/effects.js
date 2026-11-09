// Turns expression state into effects.
//
// Smile: a small cloud forms above the head and rains on it; drops splash on
//        the crown and some stay as beads that crawl down and drip off. A
//        bigger smile widens the cloud and spreads rain across the screen.
// Laugh: the cloud is blown apart, rockets rise and break above the head
//        (peony, chrysanthemum, ring, heart, willow) and light up the scene.
//        A long laugh ends in golden willows whose embers settle on the head.
//
// Fixed-size state only: nothing is allocated per frame or per burst.

import { KIND, ellipseDepth, headTop } from './particles.js';
import { PALETTES, GOLD, LOVE } from './config.js';
import { SHAPE, Sprites } from './sprites.js';

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;

export const SHELL = Object.freeze({ PEONY: 0, CHRYS: 1, RING: 2, HEART: 3, WILLOW: 4 });
export const SHELL_NAME = ['peony', 'chrysanthemum', 'ring', 'heart', 'willow'];
// Picks after the opening volley. Hearts are also rationed by a cooldown.
const BAG = [SHELL.PEONY, SHELL.PEONY, SHELL.CHRYS, SHELL.CHRYS, SHELL.RING, SHELL.RING, SHELL.WILLOW, SHELL.HEART];
const HEART_COOLDOWN_MS = 3000;

const MAX_PENDING = 16;
const MAX_ROCKETS = 12;

// Cloud puffs in cloud units (width 1): [u, v, r]. Flat base, bumpy top.
// They pop in in this order (base first), so the cloud visibly forms.
const PUFFS = [
  [-0.33, 0.06, 0.17],
  [-0.12, 0.08, 0.19],
  [0.1, 0.08, 0.19],
  [0.31, 0.06, 0.16],
  [-0.2, -0.05, 0.19],
  [0.03, -0.09, 0.23],
  [0.23, -0.04, 0.18],
];
const DRAW_ORDER = [4, 5, 6, 0, 1, 2, 3]; // base row last: its lit tops overlap the upper row
// Visible extent in cloud units: puff centre +- 0.95 r (alpha ~0.1 there), plus breathing.
const CLOUD_TOP = -0.32;
const CLOUD_BASE = 0.27;

/** easeOutBack: a small overshoot, so puffs "boing" into place. */
function pop(t) {
  const c1 = 1.70158;
  const u = t - 1;
  return 1 + (c1 + 1) * u * u * u + c1 * u * u;
}

export class Effects {
  constructor(ps, cfg) {
    this.ps = ps;
    this.cfg = cfg;
    this.tier = cfg.tiers[1];
    this.sprites = new Sprites(48); // cloud puffs + rocket heads, redrawn every frame
    this.maxSprite = Infinity; // CSS px; the GPU caps point size (often 511 device px), set by main.js
    this.now = 0;

    // rain
    this.screen = 0; // smoothed 0..1 screen-wide rain
    this.screenAcc = 0;
    this.cloudAcc = 0;
    this.wind = 0;
    this.windTarget = 0;
    this.cloud = { amt: 0, x: 0, y: 0, w: 0, vx: 0, t: 0, placed: false, disperse: 0 };

    // fireworks
    this.nextVolleyAt = Infinity;
    this.laughSince = -1;
    this.finaleDone = false;
    this.lastShell = -1;
    this.lastHeartAt = -1e9;
    this.slot = 0;
    this.paletteIx = 0;
    this.pAt = new Float64Array(MAX_PENDING); // pending launches, swap-removed when due
    this.pShell = new Uint8Array(MAX_PENDING);
    this.pSlot = new Int8Array(MAX_PENDING);
    this.pFlight = new Float32Array(MAX_PENDING);
    this.pN = 0;
    // Rockets in flight: straight line, constant deceleration, position solved
    // from the flight time (stepping it frame by frame landed 30-150 px short
    // when frames were long).
    this.rx0 = new Float32Array(MAX_ROCKETS);
    this.ry0 = new Float32Array(MAX_ROCKETS);
    this.rux = new Float32Array(MAX_ROCKETS);
    this.ruy = new Float32Array(MAX_ROCKETS);
    this.rv0 = new Float32Array(MAX_ROCKETS);
    this.rDec = new Float32Array(MAX_ROCKETS);
    this.rT = new Float32Array(MAX_ROCKETS);
    this.rAge = new Float32Array(MAX_ROCKETS);
    this.rShell = new Uint8Array(MAX_ROCKETS);
    this.rN = 0;
    this.bursts = 0;
    this.shellCount = new Uint32Array(SHELL_NAME.length);
    this.lastBurst = { x: 0, y: 0, shell: -1 };
    // Bright burst cores in the last second (WCAG 2.3.1: at most 3 flashes per second).
    this.flashAt = new Float64Array(cfg.fireworks.maxFlashesPerSec).fill(-1e9);
    this.flashIx = 0;
    this.flashes = 0;
    // Scene light from the latest bursts, drawn by the renderer as a soft wash.
    this.light = { x: 0, y: 0, r: 255, g: 255, b: 255, i: 0 };

    this._top = { x: 0, y: 0 };
    this._t = { x: 0, y: 0 };
  }

  setTier(tier) {
    this.tier = tier;
    this.ps.trailRate = tier.trailRate;
  }

  /** Transition into LAUGH: blow the cloud away and open with three rockets. */
  onLaugh(nowMs) {
    const f = this.cfg.fireworks;
    const c = this.cloud;
    if (c.placed && c.amt > 0.02 && c.disperse === 0) c.disperse = 1e-6;
    // The centre rocket is fast so the payoff comes quickly; the sides follow.
    this.queue(nowMs, Math.random() < 0.5 ? SHELL.PEONY : SHELL.CHRYS, 0, f.firstFlightS);
    for (let k = 1; k < f.volleyBursts; k++) {
      this.queue(nowMs + k * f.volleyStaggerMs, this.pick(nowMs), k % 2 ? -1 : 1, rand(f.flightS[0], f.flightS[1]));
    }
    this.nextVolleyAt = nowMs + f.intervalMs[0];
    this.laughSince = nowMs;
    this.finaleDone = false;
  }

  /**
   * @param {number} dt seconds
   * @param {number} smileLevel 0..1 while smiling, else 0
   * @param {number} laughLevel 0..1 while laughing, else 0
   */
  update(dt, nowMs, smileLevel, laughLevel, laughing, head, W, H) {
    this.now = nowMs;
    this.sprites.clear();
    const R = this.cfg.rain;
    const f = this.cfg.fireworks;

    if (Math.random() < dt * 0.5) this.windTarget = rand(-90, 90);
    this.wind += (this.windTarget - this.wind) * (1 - Math.exp(-dt / 1.5));

    // Rain: the cloud shower is the focus; screen-wide rain builds up behind it.
    this.updateCloud(dt, smileLevel, head, W);
    const target = smileLevel > 0 ? 0.15 + 0.85 * clamp((smileLevel - 0.35) / 0.65, 0, 1) : 0;
    this.screen += (target - this.screen) * (1 - Math.exp(-dt / (target > this.screen ? R.screenInTauS : R.screenOutTauS)));
    if (this.screen > 0.02) this.spawnScreenRain(dt, W, H);

    const L = this.light;
    L.i *= Math.exp(-dt / f.light.tauS);
    if (L.i < 0.002) L.i = 0;

    // Fireworks: keep shells coming while the laugh lasts; bigger laugh, faster cadence.
    if (laughing) {
      if (this.laughSince < 0) this.laughSince = nowMs;
      if (!this.finaleDone && nowMs - this.laughSince >= f.finaleAfterMs) {
        this.finale(nowMs);
      } else if (nowMs >= this.nextVolleyAt) {
        this.queue(nowMs, this.pick(nowMs), this.nextSlot(), rand(f.flightS[0], f.flightS[1]));
        if (laughLevel > 0.5) this.queue(nowMs + f.volleyStaggerMs, this.pick(nowMs), this.nextSlot(), rand(f.flightS[0], f.flightS[1]));
        const [slow, fast] = f.intervalMs;
        this.nextVolleyAt = nowMs + slow + (fast - slow) * laughLevel;
      }
    } else {
      this.nextVolleyAt = Infinity;
      this.laughSince = -1;
    }

    for (let q = 0; q < this.pN; ) {
      if (this.pAt[q] <= nowMs) {
        this.launch(this.pShell[q], this.pSlot[q], this.pFlight[q], head, W, H);
        const last = --this.pN;
        this.pAt[q] = this.pAt[last];
        this.pShell[q] = this.pShell[last];
        this.pSlot[q] = this.pSlot[last];
        this.pFlight[q] = this.pFlight[last];
      } else q++;
    }
    this.updateRockets(dt, head, W, H);
  }

  // ------------------------------------------------------------- rain

  updateCloud(dt, level, head, W) {
    const R = this.cfg.rain;
    const c = this.cloud;
    c.t += dt;
    if (c.disperse > 0) {
      c.disperse += dt / R.disperseS;
      if (c.disperse >= 1) {
        c.disperse = 0;
        c.amt = 0;
      }
    } else {
      const want = level > 0 ? 1 : 0;
      c.amt += (want - c.amt) * (1 - Math.exp(-dt / (want > c.amt ? R.formTauS : R.fadeTauS)));
      if (want === 0 && c.amt < 0.01) c.amt = 0;
    }
    if (c.amt === 0 && c.disperse === 0) {
      c.placed = false;
      return;
    }

    if (head.present) {
      const top = headTop(head, this._top);
      const span = 2 * head.a;
      const grow = clamp((level - 0.35) / 0.65, 0, 1);
      // The biggest puff is ~0.52 w across at its overshoot; past the GPU's point-size cap
      // it would be clipped and the cloud would fall apart, so shrink the whole cloud instead.
      let w = Math.min(span * (R.cloudWidth[0] + (R.cloudWidth[1] - R.cloudWidth[0]) * grow), W * 0.92, this.maxSprite / 0.52);
      // The base sits cloudGap above the crown. Without room above the head
      // (a close-up, the face filling the frame) the cloud first shrinks, down
      // to minWidth; only then may it sink, at most hairOverlap into the hair.
      // It never comes down over the forehead.
      const margin = 6;
      const tall = CLOUD_BASE - CLOUD_TOP;
      let base = top.y - head.b * R.cloudGap;
      if (base - margin < tall * w) {
        const wMin = Math.min(w, span * R.minWidth);
        w = Math.max((base - margin) / tall, wMin);
        base = Math.max(base, Math.min(margin + tall * w, top.y + head.b * R.hairOverlap));
      }
      const tx = top.x;
      const ty = base - CLOUD_BASE * w;
      if (!c.placed) {
        c.x = tx;
        c.y = ty;
        c.w = w;
        c.vx = 0;
        c.placed = true;
      } else if (c.disperse === 0) {
        const k = 1 - Math.exp(-dt / R.followTauS);
        const nx = c.x + (tx - c.x) * k;
        c.vx += ((nx - c.x) / Math.max(dt, 1e-3) - c.vx) * 0.2;
        c.x = nx;
        c.y += (ty - c.y) * k;
        c.w += (w - c.w) * k;
      }
    }
    if (!c.placed) return;
    if (c.disperse === 0 && level > 0) this.spawnCloudRain(dt, level);
    this.drawCloud();
  }

  spawnCloudRain(dt, level) {
    const c = this.cloud;
    const ps = this.ps;
    const formed = clamp(c.amt * 1.4 - 0.3, 0, 1); // rain starts once the cloud has mostly formed
    this.cloudAcc += this.tier.cloudDrops * clamp(c.w / 250, 0.6, 1.4) * (0.5 + 0.5 * level) * formed * dt;
    const [v0, v1] = this.cfg.physics.rainSpeed;
    while (this.cloudAcc >= 1) {
      this.cloudAcc -= 1;
      const i = ps.spawn(
        KIND.RAIN,
        c.x + c.w * rand(-0.36, 0.36),
        c.y + c.w * rand(0.04, 0.12),
        c.vx * 0.3 + this.wind * 0.15 + rand(-12, 12),
        rand(v0, v1) * 0.6,
        3,
        rand(16, 24),
        200,
        224,
        255,
        rand(0.6, 0.85),
      );
      if (i < 0) {
        this.cloudAcc = 0;
        break;
      }
      ps.aux[i] = 1.25; // streak width, CSS px
    }
  }

  spawnScreenRain(dt, W, H) {
    const ps = this.ps;
    const farShare = this.cfg.rain.farShare;
    this.screenAcc += this.tier.rainPer1000px * (W / 1000 + 0.45) * this.screen * dt; // narrow phones still get a visible shower
    const [v0, v1] = this.cfg.physics.rainSpeed;
    const speedScale = clamp(H / 800, 0.7, 1.3);
    while (this.screenAcc >= 1) {
      this.screenAcc -= 1;
      // Two depths: far drops are slower, thinner, dimmer and pass behind the head.
      const far = Math.random() < farShare;
      const depth = far ? rand(0.45, 0.7) : 1;
      const vy = rand(v0, v1) * speedScale * depth;
      const vx = (this.wind + rand(-25, 25)) * depth;
      const i = ps.spawn(
        far ? KIND.RAIN_FAR : KIND.RAIN,
        rand(-0.1 * W, 1.1 * W) - vx * 0.3, // pre-compensate drift
        rand(-80, -10),
        vx,
        vy,
        3,
        far ? rand(10, 16) : rand(20, 30),
        190,
        215,
        255,
        far ? rand(0.22, 0.34) : rand(0.4, 0.6),
      );
      if (i < 0) {
        this.screenAcc = 0;
        break;
      }
      ps.aux[i] = far ? 0.75 : 1.1;
    }
  }

  drawCloud() {
    const c = this.cloud;
    const d = c.disperse;
    const fade = d > 0 ? (1 - d) * (1 - d) : 1;
    for (let o = 0; o < DRAW_ORDER.length; o++) {
      const k = DRAW_ORDER[o];
      const p = PUFFS[k];
      const t0 = (k / PUFFS.length) * 0.55;
      const g = clamp((c.amt - t0) / 0.45, 0, 1);
      if (g <= 0) continue;
      const bob = 0.012 * Math.sin(c.t * 1.7 + k * 1.3); // the cloud breathes
      let x = c.x + p[0] * c.w;
      let y = c.y + (p[1] + bob) * c.w;
      let size = 2 * p[2] * c.w * pop(g) * (1 + 0.03 * Math.sin(c.t * 2.3 + k));
      if (d > 0) {
        // Blown apart by the laugh: puffs fly outward, swell and fade.
        const ex = p[0];
        const ey = p[1] - 0.12;
        const len = Math.hypot(ex, ey) || 1;
        x += (ex / len) * d * c.w * 0.7;
        y += (ey / len) * d * c.w * 0.7;
        size *= 1 + 0.6 * d;
      }
      const low = p[1] > 0.02; // the base row is a touch greyer
      this.sprites.push(SHAPE.PUFF, x, y, size, 0, low ? 0.3 : 0.18, low ? 226 : 250, low ? 233 : 252, low ? 245 : 255, 0.95 * fade * Math.min(1, g * 1.5));
    }
  }

  // ------------------------------------------------------------- fireworks

  queue(atMs, shell, slot, flightS) {
    if (this.pN >= MAX_PENDING) return;
    const q = this.pN++;
    this.pAt[q] = atMs;
    this.pShell[q] = shell;
    this.pSlot[q] = slot;
    this.pFlight[q] = flightS;
  }

  pick(nowMs) {
    for (let tries = 0; tries < 8; tries++) {
      const s = BAG[(Math.random() * BAG.length) | 0];
      if (s === this.lastShell) continue;
      if (s === SHELL.HEART && nowMs - this.lastHeartAt < HEART_COOLDOWN_MS) continue;
      if (s === SHELL.HEART) this.lastHeartAt = nowMs;
      this.lastShell = s;
      return s;
    }
    this.lastShell = SHELL.PEONY;
    return SHELL.PEONY;
  }

  nextSlot() {
    this.slot = (this.slot + 1) % 3;
    return this.slot - 1; // left, centre, right, left, ...
  }

  /** A long laugh: three golden willows over the head; their embers settle on it. */
  finale(nowMs) {
    this.finaleDone = true;
    this.queue(nowMs, SHELL.WILLOW, 0, 0.4);
    this.queue(nowMs + 150, SHELL.WILLOW, -1, 0.42);
    this.queue(nowMs + 300, SHELL.WILLOW, 1, 0.42);
    this.nextVolleyAt = nowMs + 1500; // let the gold fall before the next shell
  }

  /** Where a shell breaks: above the head, left / centre / right of it. */
  target(slot, head, W, H, out) {
    if (head.present) {
      const top = headTop(head, this._top);
      const spread = Math.max(head.a * 1.5, W * 0.16);
      out.x = top.x + slot * spread * rand(0.85, 1.15) + rand(-0.2, 0.2) * head.a;
      out.y = top.y - head.b * (slot === 0 ? rand(1.3, 1.8) : rand(0.8, 1.3));
    } else {
      out.x = W * (0.5 + slot * 0.26 + rand(-0.06, 0.06));
      out.y = H * rand(0.16, 0.32);
    }
    out.x = clamp(out.x, 0.12 * W, 0.88 * W);
    out.y = clamp(out.y, 0.1 * H, 0.5 * H);
    return out;
  }

  launch(shell, slot, flightS, head, W, H) {
    const t = this.target(slot, head, W, H, this._t);
    if (this.rN >= MAX_ROCKETS) return this.burst(shell, t.x, t.y, Math.min(W, H));
    const x0 = t.x + rand(-0.05, 0.05) * W;
    const y0 = H + 12;
    const dx = t.x - x0;
    const dy = t.y - y0;
    const d = Math.hypot(dx, dy) || 1;
    // Constant deceleration, arriving at a quarter of the launch speed:
    // distance = 0.625 * v0 * T.
    const v0 = d / (0.625 * flightS);
    const r = this.rN++;
    this.rx0[r] = x0;
    this.ry0[r] = y0;
    this.rux[r] = dx / d;
    this.ruy[r] = dy / d;
    this.rv0[r] = v0;
    this.rDec[r] = (0.75 * v0) / flightS;
    this.rT[r] = flightS;
    this.rAge[r] = 0;
    this.rShell[r] = shell;
  }

  updateRockets(dt, head, W, H) {
    const ps = this.ps;
    for (let r = 0; r < this.rN; ) {
      const T = this.rT[r];
      const t = Math.min((this.rAge[r] += dt), T);
      const s = this.rv0[r] * t - 0.5 * this.rDec[r] * t * t;
      const x = this.rx0[r] + this.rux[r] * s;
      const y = this.ry0[r] + this.ruy[r] * s;
      if (t >= T) {
        this.burst(this.rShell[r], x, y, Math.min(W, H));
        const last = --this.rN;
        this.rx0[r] = this.rx0[last];
        this.ry0[r] = this.ry0[last];
        this.rux[r] = this.rux[last];
        this.ruy[r] = this.ruy[last];
        this.rv0[r] = this.rv0[last];
        this.rDec[r] = this.rDec[last];
        this.rT[r] = this.rT[last];
        this.rAge[r] = this.rAge[last];
        this.rShell[r] = this.rShell[last];
        continue;
      }
      // Rockets rise behind the person: hidden while inside the head's silhouette.
      if (!(head.present && ellipseDepth(head, x, y) < 1)) {
        this.sprites.push(SHAPE.GLOW, x, y, 12, 0, 0, 255, 236, 205, 0.85 + 0.15 * Math.random());
        const v = this.rv0[r] - this.rDec[r] * t;
        for (let k = (dt * 110 + Math.random()) | 0; k > 0; k--) {
          ps.spawn(KIND.TRAIL, x + rand(-1.5, 1.5), y + rand(0, 4), rand(-25, 25) - this.rux[r] * v * 0.04, rand(20, 80), rand(0.25, 0.5), rand(2.5, 4), 255, 200, 140, 0.8);
        }
      }
      r++;
    }
  }

  burst(shell, x, y, minSide) {
    const ps = this.ps;
    const f = this.cfg.fireworks;
    const n = Math.min(this.tier.sparksPerBurst, ps.free());
    if (n <= 0) return;
    this.bursts++;
    this.shellCount[shell]++;
    this.lastBurst.x = x;
    this.lastBurst.y = y;
    this.lastBurst.shell = shell;
    const scale = clamp(minSide / 700, 0.65, 1.4);
    const vmax = rand(f.speed[0], f.speed[1]) * scale;
    const pal = shell === SHELL.WILLOW ? GOLD : shell === SHELL.HEART ? LOVE : PALETTES[this.paletteIx++ % PALETTES.length];
    this.flash(x, y, scale, pal[1]);
    this.lightUp(x, y, pal[0]);
    if (shell === SHELL.PEONY) this.sphere(x, y, n, vmax, pal, 0.09, 0.1);
    else if (shell === SHELL.CHRYS) this.sphere(x, y, n, vmax * 1.05, pal, 0.17, 0.05);
    else if (shell === SHELL.RING) this.ring(x, y, n, Math.max(vmax, 220 * scale), pal);
    else if (shell === SHELL.HEART) this.heart(x, y, n, Math.max(vmax, 260 * scale), pal);
    else this.willow(x, y, n, scale, pal);
  }

  /** A short bright core. Past 3 in a rolling second, a dim one (not a flash). */
  flash(x, y, scale, c) {
    const bright = this.now - this.flashAt[this.flashIx] >= 1000;
    if (bright) {
      this.flashAt[this.flashIx] = this.now;
      this.flashIx = (this.flashIx + 1) % this.flashAt.length;
      this.flashes++;
    }
    const size = Math.min(110 * scale, 120) * (bright ? 1 : 0.55);
    this.ps.spawn(KIND.FLASH, x, y, 0, 0, bright ? 0.2 : 0.15, size, c[0], c[1], c[2], bright ? 0.55 : 0.25);
  }

  /** The burst lights up the scene. Capped below a 10% luminance change, so it never counts as a flash. */
  lightUp(x, y, c) {
    const L = this.light;
    const cfg = this.cfg.fireworks.light;
    const w = L.i > 0 ? 0.6 : 1;
    L.x += (x - L.x) * w;
    L.y += (y - L.y) * w;
    L.r += ((c[0] + 255) / 2 - L.r) * w; // firelight looks paler than the stars
    L.g += ((c[1] + 255) / 2 - L.g) * w;
    L.b += ((c[2] + 255) / 2 - L.b) * w;
    L.i = Math.min(cfg.max, L.i + cfg.add);
  }

  /** Stars spread evenly over a sphere, projected: a 3D-looking peony or chrysanthemum. */
  sphere(x, y, n, vmax, pal, tail, glitterShare) {
    const ps = this.ps;
    const [t0, t1] = this.cfg.fireworks.ttl;
    for (let s = 0; s < n; s++) {
      const z = rand(-1, 1);
      const t = Math.random() * TAU;
      const rxy = Math.sqrt(1 - z * z);
      const sp = vmax * rand(0.92, 1.0);
      const vx = Math.cos(t) * rxy * sp;
      const vy = Math.sin(t) * rxy * sp - vmax * 0.12;
      if (Math.random() < glitterShare) {
        ps.spawn(KIND.GLITTER, x, y, vx, vy, rand(t0, t1), rand(7, 10), 255, 250, 235, 1);
        continue;
      }
      const c = pal[Math.random() < 0.7 ? 0 : 1];
      const i = ps.spawn(KIND.SPARK, x, y, vx, vy, rand(t0, t1), rand(6, 9), c[0], c[1], c[2], 1);
      if (i >= 0) ps.aux[i] = tail;
    }
  }

  /** A tilted ring with a small pistil of another colour. */
  ring(x, y, n, vmax, pal) {
    const ps = this.ps;
    const [t0, t1] = this.cfg.fireworks.ttl;
    const rot = Math.random() * TAU;
    const squash = rand(0.35, 0.9); // how far the ring plane is tilted
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const m = Math.round(n * 0.7);
    for (let s = 0; s < m; s++) {
      const t = (s / m) * TAU + rand(-0.02, 0.02);
      const lx = Math.cos(t) * vmax;
      const ly = Math.sin(t) * vmax * squash;
      const c = pal[s % 4 === 0 ? 1 : 0];
      const i = ps.spawn(KIND.SPARK, x, y, lx * cr - ly * sr, lx * sr + ly * cr - vmax * 0.1, rand(t0, t1), rand(6, 8), c[0], c[1], c[2], 1);
      if (i >= 0) ps.aux[i] = 0.12;
    }
    this.sphere(x, y, n - m, vmax * 0.35, PALETTES[(this.paletteIx + 2) % PALETTES.length], 0.05, 0);
  }

  /**
   * Heart: velocities on the classic heart curve. Drag scales every velocity
   * by the same factor and gravity shifts every star equally, so the shape
   * holds while it grows and sinks.
   */
  heart(x, y, n, vmax, pal) {
    const ps = this.ps;
    const [t0, t1] = this.cfg.fireworks.ttl;
    const k = vmax / 17;
    for (let s = 0; s < n; s++) {
      const t = (s / n) * TAU;
      const st = Math.sin(t);
      const hx = 16 * st * st * st;
      const hy = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
      const j = rand(0.97, 1.03);
      const c = pal[s % 5 === 0 ? 1 : 0];
      const i = ps.spawn(KIND.SPARK, x, y, hx * k * j, hy * k * j - vmax * 0.08, rand(t0, t1) * 0.9, rand(6, 8), c[0], c[1], c[2], 1);
      if (i >= 0) ps.aux[i] = 0.07;
    }
  }

  /** Willow: gold embers that spread, hang, droop with trails and settle on the head. */
  willow(x, y, n, scale, pal) {
    const ps = this.ps;
    const m = Math.round(n * 0.7);
    for (let s = 0; s < m; s++) {
      const z = rand(-1, 1);
      const t = Math.random() * TAU;
      const rxy = Math.sqrt(1 - z * z);
      const sp = rand(330, 420) * scale * rand(0.9, 1);
      const c = pal[Math.random() < 0.8 ? 0 : 1];
      const i = ps.spawn(KIND.EMBER, x, y, Math.cos(t) * rxy * sp, Math.sin(t) * rxy * sp - 60 * scale, rand(2.6, 3.4), rand(5, 7), c[0], c[1], c[2], 1);
      if (i >= 0) ps.aux[i] = 0.25;
    }
  }
}
