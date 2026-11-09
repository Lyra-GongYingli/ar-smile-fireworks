// Fixed-capacity particle pool (struct of typed arrays) with a tiny physics
// step and an analytic head collider. Nothing in the hot loop allocates.

export const KIND = Object.freeze({
  RAIN: 0, // near rain: lands on the head and splashes
  SPLASH: 1, // splash droplet, ballistic
  SPARK: 2, // firework star: bounces off the head
  GLITTER: 3, // twinkling star; some crackle when they burn out
  FLASH: 4, // burst core: stationary, ages out
  RAIN_FAR: 5, // background rain: passes behind the head
  BEAD: 6, // water left on the head: clings, crawls down, drips off the sides
  EMBER: 7, // willow ember: floats down, lands, slides off; leaves a trail
  TRAIL: 8, // dust left by embers and rockets
  GLINT: 9, // small star where a spark strikes the head
  RING: 10, // flattened ring where a raindrop lands on the crown
});

/** flags bit: inside the head's silhouette this step, i.e. behind it, so not drawn. */
export const HIDDEN = 1;

const TAU = Math.PI * 2;

export class ParticleSystem {
  constructor(capacity) {
    this.cap = capacity;
    this.limit = capacity; // lowered by the quality governor
    this.n = 0;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.ttl = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.seed = new Float32Array(capacity);
    this.aux = new Float32Array(capacity); // per kind: streak width, comet tail factor, ring angle
    this.kind = new Uint8Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.r = new Uint8Array(capacity);
    this.g = new Uint8Array(capacity);
    this.b = new Uint8Array(capacity);
    this.hits = 0; // head contacts so far (the HUD reads deltas)
    this.splashes = 0; // raindrops that landed on the head
    this.glints = 0;
    this.beads = 0; // live beads, recounted every step
    this.trailRate = 8; // ember trail motes per second; set per quality tier
  }

  free() {
    return this.limit - this.n;
  }

  spawn(kind, x, y, vx, vy, ttl, size, r, g, b, alpha) {
    if (this.n >= this.limit) return -1;
    const i = this.n++;
    this.kind[i] = kind;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.ttl[i] = ttl;
    this.size[i] = size;
    this.r[i] = r;
    this.g[i] = g;
    this.b[i] = b;
    this.alpha[i] = alpha;
    this.seed[i] = Math.random() * TAU;
    this.aux[i] = 0;
    this.flags[i] = 0;
    return i;
  }

  /** O(1) removal: move the last live particle into slot i. */
  killAt(i) {
    const j = --this.n;
    if (i === j) return;
    this.kind[i] = this.kind[j];
    this.x[i] = this.x[j];
    this.y[i] = this.y[j];
    this.vx[i] = this.vx[j];
    this.vy[i] = this.vy[j];
    this.age[i] = this.age[j];
    this.ttl[i] = this.ttl[j];
    this.size[i] = this.size[j];
    this.r[i] = this.r[j];
    this.g[i] = this.g[j];
    this.b[i] = this.b[j];
    this.alpha[i] = this.alpha[j];
    this.seed[i] = this.seed[j];
    this.aux[i] = this.aux[j];
    this.flags[i] = this.flags[j];
  }

  /**
   * @param {number} dt seconds
   * @param {object} head collider from HeadTracker.sample()
   * @param {number} W view width (CSS px)
   * @param {number} H view height (CSS px)
   * @param {object} phys CONFIG.physics
   */
  step(dt, head, W, H, phys) {
    const g = phys.gravity * dt;
    const drag = Math.exp(-phys.sparkDrag * dt);
    const em = phys.ember;
    const emDrag = Math.exp(-em.drag * dt);
    const emG = em.gravity * dt;
    const sg = phys.splashGravity * dt;
    const tg = phys.trailGravity * dt;
    const bg = phys.bead.gravity * dt;
    // Friction is a loss per contact. Resolved particles sit 0.5 px off the
    // surface, so contacts recur at a rate set by gravity, not by the frame
    // rate, and sliding speed stays the same at 60 and 120 Hz (tested).
    const fSpark = phys.friction;
    const fEmber = em.friction;
    const fBead = phys.bead.friction;
    const trailP = this.trailRate * dt;
    const crackleBelow = phys.crackleShare * TAU; // seed is uniform in [0, TAU)
    const useHead = head.present;
    let glints = 0;
    let beads = 0;
    let i = 0;
    while (i < this.n) {
      const k = this.kind[i];
      const age = (this.age[i] += dt);
      if (age >= this.ttl[i]) {
        if (k === KIND.GLITTER && this.seed[i] < crackleBelow) this.crackle(i);
        this.killAt(i);
        continue;
      }
      if (k === KIND.FLASH) {
        i++; // stationary, no collision; only ages out
        continue;
      }
      let vx = this.vx[i];
      let vy = this.vy[i];
      if (k === KIND.SPARK || k === KIND.GLITTER) {
        vx *= drag;
        vy = vy * drag + g;
      } else if (k === KIND.EMBER) {
        vx *= emDrag;
        vy = vy * emDrag + emG;
        if (Math.random() < trailP) this.trail(i);
      } else if (k === KIND.SPLASH) {
        vy += sg;
      } else if (k === KIND.TRAIL) {
        vx *= drag;
        vy = vy * drag + tg;
      } else if (k === KIND.BEAD) {
        vy += bg;
        beads++;
      } // RAIN falls at terminal velocity; GLINT and RING drift with the head that made them
      const x = this.x[i] + vx * dt;
      const y = this.y[i] + vy * dt;
      this.x[i] = x;
      this.y[i] = y;
      this.vx[i] = vx;
      this.vy[i] = vy;

      if (useHead) {
        const dx = x - head.cx;
        const dy = y - head.cy;
        const near = dx * dx + dy * dy < head.r2;
        if (k === KIND.RAIN_FAR) {
          this.flags[i] = near && ellipseDepth(head, x, y) < 1 ? HIDDEN : 0;
        } else if (near) {
          if (k === KIND.RAIN) {
            if (ellipseDepth(head, x, y) < 1) {
              this.splash(x, y, vx, head, phys);
              this.killAt(i);
              continue;
            }
          } else if (k === KIND.SPARK || k === KIND.GLITTER || k === KIND.EMBER || k === KIND.BEAD) {
            const ember = k === KIND.EMBER;
            const bead = k === KIND.BEAD;
            const rest = ember ? em.restitution : bead ? 0 : phys.restitution;
            const fric = ember ? fEmber : bead ? fBead : fSpark;
            const impact = collideEllipse(this, i, head, rest, fric);
            if (impact >= 0) {
              this.hits++;
              // Sparks and embers burn out on the head instead of piling up
              // along the collider's edge (which showed as a glowing headband).
              if (!bead) this.age[i] += phys.contactAge;
              if (!bead && impact > phys.glintMinSpeed && glints < phys.glintsPerStep) {
                glints++;
                this.glint(i, head);
              }
            }
          }
        }
      } else if (k === KIND.RAIN_FAR) {
        this.flags[i] = 0;
      }

      if (y > H + 40 || x < -80 || x > W + 80) {
        this.killAt(i);
        continue;
      }
      i++;
    }
    this.beads = beads;
  }

  /** A raindrop lands: a crown of droplets, a ring on upward-facing spots, sometimes a bead that stays. */
  splash(x, y, vx, head, phys) {
    this.splashes++;
    // Born on the surface (not inside the head, where the collider would shove them around).
    const n = surfaceNormal(head, x, y, _n);
    const p = projectToSurface(head, x, y, _p);
    const px = p.x + n.x;
    const py = p.y + n.y;
    for (let s = 0; s < 3; s++) {
      const spread = (Math.random() - 0.5) * 320;
      const up = 120 + Math.random() * 180;
      this.spawn(
        KIND.SPLASH,
        px,
        py,
        n.x * up - n.y * spread + head.vx * 0.5 + vx * 0.04,
        n.y * up + n.x * spread + head.vy * 0.5 - 50,
        0.22 + Math.random() * 0.18,
        2.5 + Math.random() * 1.5,
        215,
        235,
        255,
        0.95,
      );
    }
    if (n.y > -0.35) return; // a side hit: no ring, no bead
    if (Math.random() < 0.6) {
      // Rings sit a few px into the hair at random depths: on the exact edge they
      // traced the collider ellipse as a dotted arc.
      const sink = 1 + Math.random() * 7;
      const j = this.spawn(KIND.RING, px - n.x * sink, py - n.y * sink, head.vx, head.vy, 0.26, 12 + Math.random() * 6, 220, 238, 255, 0.5);
      if (j >= 0) this.aux[j] = Math.atan2(n.x, -n.y); // lies along the surface tangent
    }
    if (this.beads < phys.maxBeads && Math.random() < phys.beadChance) {
      const side = (Math.random() - 0.5) * 80; // a nudge along the surface, so beads do not park on the crown
      const b = this.spawn(KIND.BEAD, px, py, head.vx - n.y * side, head.vy + n.x * side, 2.6 + Math.random() * 1.6, 3.2 + Math.random() * 1.6, 215, 235, 255, 0.95);
      if (b >= 0) this.beads++;
    }
  }

  /** A spark strikes the head: a short star at the contact point, tinted by the spark. */
  glint(i, head) {
    const j = this.spawn(
      KIND.GLINT,
      this.x[i],
      this.y[i],
      head.vx,
      head.vy,
      0.16,
      15 + Math.random() * 8,
      (this.r[i] + 255) >> 1,
      (this.g[i] + 255) >> 1,
      (this.b[i] + 255) >> 1,
      1,
    );
    if (j >= 0) this.glints++;
  }

  /** A burning-out glitter star pops: a tiny white speck (small, so not a "flash"). */
  crackle(i) {
    this.spawn(KIND.FLASH, this.x[i], this.y[i], 0, 0, 0.07, 9 + Math.random() * 5, 255, 250, 235, 0.95);
  }

  /** Willow embers shed a mote now and then: the drooping trail. */
  trail(i) {
    this.spawn(
      KIND.TRAIL,
      this.x[i],
      this.y[i],
      this.vx[i] * 0.15 + (Math.random() - 0.5) * 16,
      this.vy[i] * 0.15 + (Math.random() - 0.5) * 16,
      0.35 + Math.random() * 0.3,
      2.5 + Math.random() * 1.5,
      this.r[i],
      this.g[i],
      this.b[i],
      0.45 * this.alpha[i],
    );
  }
}

const _n = { x: 0, y: 0 };
const _p = { x: 0, y: 0 };

/** Point on the ellipse along the ray from its centre through (x, y). */
export function projectToSurface(h, x, y, out) {
  const dx = x - h.cx;
  const dy = y - h.cy;
  const lx = dx * h.cos + dy * h.sin;
  const ly = -dx * h.sin + dy * h.cos;
  const d = Math.sqrt((lx / h.a) ** 2 + (ly / h.b) ** 2);
  const sx = d > 1e-9 ? lx / d : 0;
  const sy = d > 1e-9 ? ly / d : -h.b;
  out.x = h.cx + sx * h.cos - sy * h.sin;
  out.y = h.cy + sx * h.sin + sy * h.cos;
  return out;
}

/** Squared normalised distance in the ellipse frame: < 1 means inside. */
export function ellipseDepth(h, x, y) {
  const dx = x - h.cx;
  const dy = y - h.cy;
  const lx = (dx * h.cos + dy * h.sin) / h.a;
  const ly = (-dx * h.sin + dy * h.cos) / h.b;
  return lx * lx + ly * ly;
}

/** Outward unit normal of the ellipse at (or near) a point. */
export function surfaceNormal(h, x, y, out) {
  const dx = x - h.cx;
  const dy = y - h.cy;
  const lx = dx * h.cos + dy * h.sin;
  const ly = -dx * h.sin + dy * h.cos;
  let nx = lx / (h.a * h.a);
  let ny = ly / (h.b * h.b);
  const len = Math.hypot(nx, ny);
  if (len < 1e-9) {
    nx = 0;
    ny = -1; // dead centre: push towards the crown
  } else {
    nx /= len;
    ny /= len;
  }
  out.x = nx * h.cos - ny * h.sin;
  out.y = nx * h.sin + ny * h.cos;
  return out;
}

/** World-space top of the head ellipse and the crown point's x (the cloud and rockets aim from here). */
export function headTop(h, out) {
  out.y = h.cy - Math.sqrt((h.a * h.sin) ** 2 + (h.b * h.cos) ** 2);
  out.x = h.cx + h.b * h.sin;
  return out;
}

/**
 * Particle vs moving rotated ellipse. Pushes the particle to the surface and
 * reflects its velocity relative to the head, so a moving head bats sparks away.
 * @param {number} friction share of the tangential velocity lost in this step
 * @returns {number} -1 if not touching, else the impact speed along the normal (0 for resting contact)
 */
export function collideEllipse(P, i, h, restitution, friction) {
  const dx = P.x[i] - h.cx;
  const dy = P.y[i] - h.cy;
  const lx = dx * h.cos + dy * h.sin;
  const ly = -dx * h.sin + dy * h.cos;
  const qx = lx / h.a;
  const qy = ly / h.b;
  const d2 = qx * qx + qy * qy;
  if (d2 >= 1) return -1;

  // Surface point along the ray from the centre (in scaled space), plus 0.5px.
  let sx;
  let sy;
  if (d2 < 1e-12) {
    sx = 0;
    sy = -h.b;
  } else {
    const inv = 1 / Math.sqrt(d2);
    sx = lx * inv;
    sy = ly * inv;
  }
  let nx = sx / (h.a * h.a);
  let ny = sy / (h.b * h.b);
  const nl = Math.hypot(nx, ny);
  nx /= nl;
  ny /= nl;
  const wnx = nx * h.cos - ny * h.sin;
  const wny = nx * h.sin + ny * h.cos;
  P.x[i] = h.cx + sx * h.cos - sy * h.sin + wnx * 0.5;
  P.y[i] = h.cy + sx * h.sin + sy * h.cos + wny * 0.5;

  const rvx = P.vx[i] - h.vx;
  const rvy = P.vy[i] - h.vy;
  const vn = rvx * wnx + rvy * wny;
  if (vn >= 0) return 0;
  const tx = rvx - vn * wnx;
  const ty = rvy - vn * wny;
  const keep = 1 - friction;
  P.vx[i] = h.vx + tx * keep - vn * restitution * wnx;
  P.vy[i] = h.vy + ty * keep - vn * restitution * wny;
  return -vn;
}
