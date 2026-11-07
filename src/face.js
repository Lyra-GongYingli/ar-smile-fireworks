// Face landmarks -> a head collider (rotated ellipse) in screen space.
// Pure math, no DOM, so it runs under `node --test`.

// Face mesh landmark indices (MediaPipe 468/478-point topology).
export const LM = Object.freeze({
  FOREHEAD: 10,
  CHIN: 152,
  CHEEK_A: 234, // image-left side of the face (subject's right)
  CHEEK_B: 454,
  NOSE_TIP: 1,
});

/**
 * The video is shown with `object-fit: cover`, so the visible picture is a
 * scaled, centre-cropped copy of the camera frame. Landmarks are normalised to
 * the full frame and must go through the same transform, or the collider
 * drifts away from the head (badly on portrait phones, where most of a 4:3
 * landscape frame is cropped off).
 */
export function coverTransform(videoW, videoH, viewW, viewH) {
  const s = Math.max(viewW / videoW, viewH / videoH);
  const dw = videoW * s;
  const dh = videoH * s;
  return { s, dw, dh, ox: (viewW - dw) / 2, oy: (viewH - dh) / 2 };
}

export function mapPoint(t, nx, ny, mirror, out) {
  out.x = t.ox + (mirror ? 1 - nx : nx) * t.dw;
  out.y = t.oy + ny * t.dh;
  return out;
}

const _top = { x: 0, y: 0 };
const _chin = { x: 0, y: 0 };
const _ca = { x: 0, y: 0 };
const _cb = { x: 0, y: 0 };

/**
 * Head ellipse from four landmarks. The ellipse bottom sits on the chin and it
 * extends above the forehead landmark to cover the skull and hair.
 * Local frame: +y points from the crown down to the chin.
 */
export function headFromLandmarks(lms, t, mirror, cfg, out) {
  mapPoint(t, lms[LM.FOREHEAD].x, lms[LM.FOREHEAD].y, mirror, _top);
  mapPoint(t, lms[LM.CHIN].x, lms[LM.CHIN].y, mirror, _chin);
  mapPoint(t, lms[LM.CHEEK_A].x, lms[LM.CHEEK_A].y, mirror, _ca);
  mapPoint(t, lms[LM.CHEEK_B].x, lms[LM.CHEEK_B].y, mirror, _cb);

  const faceH = Math.hypot(_top.x - _chin.x, _top.y - _chin.y) || 1;
  const faceW = Math.hypot(_cb.x - _ca.x, _cb.y - _ca.y) || 1;
  const ux = (_top.x - _chin.x) / faceH; // unit vector chin -> forehead
  const uy = (_top.y - _chin.y) / faceH;

  const a = faceW * 0.5 * cfg.widthScale;
  const b = faceH * 0.5 * cfg.heightScale;
  out.cx = _chin.x + ux * b;
  out.cy = _chin.y + uy * b;
  out.a = a;
  out.b = b;
  // local +y = -u  =>  (-sin, cos) = (-ux, -uy)
  out.theta = Math.atan2(ux, -uy);

  // Yaw from where the nose sits between the cheeks (image space, unmirrored).
  const nx = lms[LM.NOSE_TIP].x;
  const dl = nx - lms[LM.CHEEK_A].x;
  const dr = lms[LM.CHEEK_B].x - nx;
  out.yaw = dl + dr !== 0 ? (dl - dr) / (dl + dr) : 0;
  return out;
}

function lpAlpha(dt, cutoff) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** One Euro filter: smooth when still, responsive when moving. */
export class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  reset() {
    this.x = NaN;
    this.dx = 0;
  }
  filter(x, dt) {
    if (Number.isNaN(this.x)) {
      this.x = x;
      return x;
    }
    const d = (x - this.x) / dt;
    this.dx += lpAlpha(dt, this.dCutoff) * (d - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += lpAlpha(dt, cutoff) * (x - this.x);
    return this.x;
  }
}

/** Smoothed head state with velocity, sampled (and lightly extrapolated) per render frame. */
export class HeadTracker {
  constructor(cfg) {
    this.cfg = cfg;
    this.fx = new OneEuro(1.5, 0.01);
    this.fy = new OneEuro(1.5, 0.01);
    this.fa = new OneEuro(1.0, 0.004);
    this.fb = new OneEuro(1.0, 0.004);
    this.ft = new OneEuro(1.5, 0.3);
    this.present = false;
    this.lostAt = -1e9;
    this.t = 0;
    this.cx = 0;
    this.cy = 0;
    this.a = 0;
    this.b = 0;
    this.theta = 0;
    this.vx = 0;
    this.vy = 0;
  }

  update(raw, tMs) {
    const c = this.cfg;
    const fresh = !this.present && tMs - this.lostAt > c.resetAfterLostMs;
    if (fresh) {
      for (const f of [this.fx, this.fy, this.fa, this.fb, this.ft]) f.reset();
      this.vx = this.vy = 0;
    }
    const dt = this.present ? Math.max((tMs - this.t) / 1000, 1 / 240) : 1 / 30;
    const px = this.cx;
    const py = this.cy;
    this.cx = this.fx.filter(raw.cx, dt);
    this.cy = this.fy.filter(raw.cy, dt);
    this.a = this.fa.filter(raw.a, dt);
    this.b = this.fb.filter(raw.b, dt);
    this.theta = this.ft.filter(raw.theta, dt);
    if (this.present && !fresh) {
      const k = 0.5;
      this.vx += k * ((this.cx - px) / dt - this.vx);
      this.vy += k * ((this.cy - py) / dt - this.vy);
      const sp = Math.hypot(this.vx, this.vy);
      if (sp > c.maxSpeed) {
        this.vx *= c.maxSpeed / sp;
        this.vy *= c.maxSpeed / sp;
      }
    }
    this.t = tMs;
    this.present = true;
  }

  lost(tMs) {
    if (this.present) this.lostAt = tMs;
    this.present = false;
    this.vx = this.vy = 0;
  }

  /** Collider for this render frame: extrapolate a little to hide detection latency. */
  sample(nowMs, out) {
    out.present = this.present;
    if (!this.present) return out;
    const ahead = Math.min(Math.max(nowMs - this.t, 0), this.cfg.extrapolateMs) / 1000;
    out.cx = this.cx + this.vx * ahead;
    out.cy = this.cy + this.vy * ahead;
    out.a = this.a;
    out.b = this.b;
    out.cos = Math.cos(this.theta);
    out.sin = Math.sin(this.theta);
    out.vx = this.vx;
    out.vy = this.vy;
    out.r2 = Math.max(this.a, this.b) ** 2;
    return out;
  }
}

export function makeCollider() {
  return { present: false, cx: 0, cy: 0, a: 1, b: 1, cos: 1, sin: 0, vx: 0, vy: 0, r2: 1 };
}
