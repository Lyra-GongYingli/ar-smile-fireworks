// Turns expression state into particles: rain while smiling, firework volleys
// while laughing. Bursts are aimed above the head so sparks land on it.

import { KIND } from './particles.js';
import { PALETTES } from './config.js';

const rand = (a, b) => a + Math.random() * (b - a);
const MAX_PENDING = 16;

export class Effects {
  constructor(ps, cfg) {
    this.ps = ps;
    this.cfg = cfg;
    this.tier = cfg.tiers[1];
    this.rain = 0; // smoothed 0..1
    this.rainAcc = 0;
    this.wind = 0;
    this.windTarget = 0;
    this.nextVolleyAt = Infinity;
    this.paletteIx = 0;
    // pending bursts ring (no per-burst allocation)
    this.pAt = new Float64Array(MAX_PENDING);
    this.pN = 0;
    this.bursts = 0;
  }

  setTier(tier) {
    this.tier = tier;
  }

  /** Called on the transition into LAUGH. */
  onLaugh(nowMs) {
    const f = this.cfg.fireworks;
    for (let k = 0; k < f.volleyBursts; k++) this.queue(nowMs + k * f.volleyStaggerMs);
    this.nextVolleyAt = nowMs + f.intervalMs[0];
  }

  queue(atMs) {
    if (this.pN < MAX_PENDING) this.pAt[this.pN++] = atMs;
  }

  update(dt, nowMs, rainTarget, laughLevel, laughing, head, W, H) {
    // Rain fades in fast, out slower.
    const k = 1 - Math.exp(-dt / (rainTarget > this.rain ? 0.25 : 0.6));
    this.rain += (rainTarget - this.rain) * k;
    if (Math.random() < dt * 0.5) this.windTarget = rand(-90, 90);
    this.wind += (this.windTarget - this.wind) * (1 - Math.exp(-dt / 1.5));
    if (this.rain > 0.02) this.spawnRain(dt, W, H);

    // Keep volleys going while the laugh lasts; bigger laugh, faster cadence.
    if (laughing) {
      if (nowMs >= this.nextVolleyAt) {
        this.queue(nowMs);
        if (laughLevel > 0.5) this.queue(nowMs + this.cfg.fireworks.volleyStaggerMs);
        const [slow, fast] = this.cfg.fireworks.intervalMs;
        this.nextVolleyAt = nowMs + slow + (fast - slow) * laughLevel;
      }
    } else this.nextVolleyAt = Infinity;

    // Fire due bursts (swap-remove from the small ring).
    for (let q = 0; q < this.pN; ) {
      if (this.pAt[q] <= nowMs) {
        this.burstNearHead(head, W, H);
        this.pAt[q] = this.pAt[--this.pN];
      } else q++;
    }
  }

  spawnRain(dt, W, H) {
    const ps = this.ps;
    this.rainAcc += this.tier.rainPer1000px * (W / 1000 + 0.45) * this.rain * dt; // narrow phones still get a visible shower
    const [v0, v1] = this.cfg.physics.rainSpeed;
    const speedScale = Math.max(0.7, Math.min(1.3, H / 800));
    while (this.rainAcc >= 1) {
      this.rainAcc -= 1;
      const vy = rand(v0, v1) * speedScale;
      const vx = this.wind + rand(-25, 25);
      const x = rand(-0.1 * W, 1.1 * W) - vx * 0.3; // pre-compensate drift
      if (
        ps.spawn(KIND.RAIN, x, rand(-80, -10), vx, vy, 3, rand(18, 30), 190, 215, 255, rand(0.35, 0.7)) < 0
      ) {
        this.rainAcc = 0;
        break;
      }
    }
  }

  burstNearHead(head, W, H) {
    let x;
    let y;
    if (head.present) {
      x = head.cx + rand(-1.5, 1.5) * head.a;
      y = head.cy - head.b * rand(1.3, 2.4);
    } else {
      x = rand(0.2, 0.8) * W;
      y = rand(0.15, 0.4) * H;
    }
    x = Math.min(Math.max(x, 0.1 * W), 0.9 * W);
    y = Math.min(Math.max(y, 0.08 * H), 0.55 * H);
    this.burst(x, y, Math.min(W, H));
  }

  burst(x, y, minSide) {
    const ps = this.ps;
    const f = this.cfg.fireworks;
    const pal = PALETTES[this.paletteIx++ % PALETTES.length];
    const n = Math.min(this.tier.sparksPerBurst, ps.free());
    if (n <= 0) return;
    this.bursts++;
    const scale = Math.max(0.65, Math.min(1.4, minSide / 700));
    const vmax = rand(f.speed[0], f.speed[1]) * scale;
    // A short, small flash at the core: reads as an explosion. Kept to one per
    // burst (<= ~3/s) and ~120 px, well under WCAG 2.3.1 flash limits.
    const lc = pal[1];
    ps.spawn(KIND.FLASH, x, y, 0, 0, 0.2, 120 * scale, lc[0], lc[1], lc[2], 0.55);
    for (let s = 0; s < n; s++) {
      // Uniform direction on a sphere, projected to the screen: a 3D-looking peony.
      const z = rand(-1, 1);
      const t = Math.random() * 6.283185;
      const rxy = Math.sqrt(1 - z * z);
      const sp = vmax * rand(0.92, 1.0);
      const vx = Math.cos(t) * rxy * sp;
      const vy = Math.sin(t) * rxy * sp - 40 * scale;
      const glitter = Math.random() < 0.1;
      const c = glitter ? null : pal[Math.random() < 0.7 ? 0 : 1];
      ps.spawn(
        glitter ? KIND.GLITTER : KIND.SPARK,
        x,
        y,
        vx,
        vy,
        rand(f.ttl[0], f.ttl[1]),
        glitter ? rand(7, 10) : rand(6, 9),
        glitter ? 255 : c[0],
        glitter ? 250 : c[1],
        glitter ? 235 : c[2],
        1,
      );
    }
  }
}
