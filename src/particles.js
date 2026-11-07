// Fixed-capacity particle pool (struct of typed arrays) with a tiny physics
// step and an analytic head collider. Nothing in the hot loop allocates.

export const KIND = Object.freeze({ RAIN: 0, SPLASH: 1, SPARK: 2, GLITTER: 3, FLASH: 4 });

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
    this.kind = new Uint8Array(capacity);
    this.r = new Uint8Array(capacity);
    this.g = new Uint8Array(capacity);
    this.b = new Uint8Array(capacity);
    this.hits = 0; // collisions since last read (for the HUD)
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
    this.seed[i] = Math.random() * 6.283;
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
  }

  /**
   * @param {number} dt seconds
   * @param {object} head collider from HeadTracker.sample()
   * @param {number} W view width (CSS px)
   * @param {number} H view height (CSS px)
   * @param {object} phys CONFIG.physics
   */
  step(dt, head, W, H, phys) {
    const g = phys.gravity;
    const drag = Math.exp(-phys.sparkDrag * dt);
    const sg = phys.splashGravity;
    const useHead = head.present;
    let i = 0;
    while (i < this.n) {
      const age = (this.age[i] += dt);
      if (age >= this.ttl[i]) {
        this.killAt(i);
        continue;
      }
      const k = this.kind[i];
      if (k === KIND.FLASH) {
        i++; // stationary, no collision; only ages out
        continue;
      }
      let vx = this.vx[i];
      let vy = this.vy[i];
      if (k === KIND.SPARK || k === KIND.GLITTER) {
        vx *= drag;
        vy = vy * drag + g * dt;
      } else if (k === KIND.SPLASH) {
        vy += sg * dt;
      } // RAIN falls at terminal velocity
      const x = this.x[i] + vx * dt;
      const y = this.y[i] + vy * dt;
      this.x[i] = x;
      this.y[i] = y;
      this.vx[i] = vx;
      this.vy[i] = vy;

      if (useHead) {
        const dx = x - head.cx;
        const dy = y - head.cy;
        if (dx * dx + dy * dy < head.r2) {
          if (k === KIND.RAIN) {
            if (ellipseDepth(head, x, y) < 1) {
              this.splash(x, y, vx, vy, head);
              this.killAt(i);
              continue;
            }
          } else if (collideEllipse(this, i, head, phys.restitution, phys.friction)) {
            this.hits++;
          }
        }
      }

      if (y > H + 40 || x < -80 || x > W + 80) {
        this.killAt(i);
        continue;
      }
      i++;
    }
  }

  splash(x, y, vx, vy, head) {
    // Two droplets kicked back along the surface normal, born on the surface
    // (not inside the head, where the collider would shove them around).
    const n = surfaceNormal(head, x, y, _n);
    const p = projectToSurface(head, x, y, _p);
    for (let s = 0; s < 2; s++) {
      const spread = (Math.random() - 0.5) * 260;
      const up = 120 + Math.random() * 160;
      this.spawn(
        KIND.SPLASH,
        p.x + n.x,
        p.y + n.y,
        n.x * up + -n.y * spread + head.vx * 0.5 + vx * 0.05,
        n.y * up + n.x * spread + head.vy * 0.5 - 60,
        0.28 + Math.random() * 0.2,
        3 + Math.random() * 2,
        200,
        225,
        255,
        0.75,
      );
    }
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

/**
 * Particle vs moving rotated ellipse. Pushes the particle to the surface and
 * reflects its velocity relative to the head, so a moving head bats sparks away.
 * @returns {boolean} true if a collision was resolved
 */
export function collideEllipse(P, i, h, restitution, friction) {
  const dx = P.x[i] - h.cx;
  const dy = P.y[i] - h.cy;
  const lx = dx * h.cos + dy * h.sin;
  const ly = -dx * h.sin + dy * h.cos;
  const qx = lx / h.a;
  const qy = ly / h.b;
  const d2 = qx * qx + qy * qy;
  if (d2 >= 1) return false;

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
  if (vn < 0) {
    const tx = rvx - vn * wnx;
    const ty = rvy - vn * wny;
    const keep = 1 - friction;
    P.vx[i] = h.vx + tx * keep - vn * restitution * wnx;
    P.vy[i] = h.vy + ty * keep - vn * restitution * wny;
  }
  return true;
}
