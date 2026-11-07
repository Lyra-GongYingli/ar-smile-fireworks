// Blendshapes -> NONE / SMILE / LAUGH, with per-user baseline, hysteresis and
// leaky evidence. Pure logic (no DOM) so it runs under `node --test`.

export const EXPR = Object.freeze({ NONE: 0, SMILE: 1, LAUGH: 2 });
export const EXPR_NAME = ['none', 'smile', 'laugh'];

// Names exactly as the face_landmarker blendshape head reports them.
export const NEEDED_BLENDSHAPES = [
  'mouthSmileLeft',
  'mouthSmileRight',
  'jawOpen',
  'mouthFunnel',
  'mouthPucker',
];

/**
 * Resolve blendshape names to category indices once. Categories may arrive
 * sorted by score, so array positions are never trusted; `index` is.
 */
export function resolveBlendshapeIndices(categories) {
  const byName = Object.create(null);
  for (const c of categories) byName[c.categoryName] = c.index;
  const idx = {};
  const missing = [];
  for (const name of NEEDED_BLENDSHAPES) {
    if (name in byName) idx[name] = byName[name];
    else missing.push(name);
  }
  let size = 0;
  for (const c of categories) size = Math.max(size, c.index + 1);
  return { idx, missing, size };
}

/** Copy scores into a reusable Float32Array by category index (no allocation). */
export function scoresByIndex(categories, out) {
  for (let k = 0; k < categories.length; k++) {
    const c = categories[k];
    if (c.index < out.length) out[c.index] = c.score;
  }
  return out;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function trackBaseline(base, x, dtMs, riseTau, fallTau, cap, allowRise) {
  if (base < 0) return Math.min(x, cap); // first sample
  if (x > base && !allowRise) return base;
  const tau = x < base ? fallTau : riseTau;
  const a = 1 - Math.exp(-dtMs / tau);
  return Math.min(cap, base + (x - base) * a);
}

export class ExpressionMachine {
  constructor(cfg) {
    this.cfg = cfg;
    this.baseSmile = -1;
    this.baseJaw = -1;
    this.reset();
  }

  reset() {
    this.state = EXPR.NONE;
    this.smile = 0;
    this.jaw = 0;
    this.smileEv = 0;
    this.laughEv = 0;
    this.releaseMs = 0;
    this.lostMs = 0;
    this.unreliableMs = 0;
    this.sinceLaughEndMs = 1e9;
    this.reliable = true;
  }

  /**
   * @param {number} dtMs time since the previous update
   * @param {null|{smileRaw:number,jawRaw:number,funnel:number,pucker:number}} sig
   *        null when no face is visible
   * @param {number} yaw -1..1, 0 = frontal
   * @returns {null|'smile'|'laugh'|'none'} the transition that happened, if any
   */
  update(dtMs, sig, yaw = 0) {
    const c = this.cfg;
    this.sinceLaughEndMs += dtMs;

    if (!sig) {
      this.lostMs += dtMs;
      if (this.lostMs >= c.lostResetMs && this.state !== EXPR.NONE) {
        this.reset();
        return 'none';
      }
      return null;
    }
    this.lostMs = 0;

    // Per-user baseline: falls fast, rises slowly, only while at rest, capped.
    const atRest = this.state === EXPR.NONE;
    this.baseSmile = trackBaseline(this.baseSmile, sig.smileRaw, dtMs, c.baselineRiseTauMs, c.baselineFallTauMs, c.baselineCap, atRest);
    this.baseJaw = trackBaseline(this.baseJaw, sig.jawRaw, dtMs, c.baselineRiseTauMs, c.baselineFallTauMs, c.baselineCap, atRest);

    const s = clamp01((sig.smileRaw - this.baseSmile) / (1 - this.baseSmile));
    const j = clamp01((sig.jawRaw - this.baseJaw) / (1 - this.baseJaw));
    const a = 1 - Math.exp(-dtMs / c.smoothTauMs);
    this.smile += (s - this.smile) * a;
    this.jaw += (j - this.jaw) * a;

    // Side views make blendshapes unreliable: hold state, accumulate nothing.
    this.reliable = Math.abs(yaw) <= c.yawMax;
    if (!this.reliable) {
      this.unreliableMs += dtMs;
      this.smileEv = Math.max(0, this.smileEv - dtMs);
      this.laughEv = Math.max(0, this.laughEv - dtMs * c.laughDecay);
      if (this.unreliableMs >= c.unreliableTimeoutMs && this.state !== EXPR.NONE) {
        this.state = EXPR.NONE;
        this.releaseMs = 0;
        return 'none';
      }
      return null;
    }
    this.unreliableMs = 0;

    const vetoed = sig.funnel > c.vetoFunnel || sig.pucker > c.vetoPucker;
    const laughCond = !vetoed && this.smile >= c.laughSmileMin && this.jaw >= c.laughJawOn;
    this.laughEv = laughCond
      ? Math.min(this.laughEv + dtMs, c.laughAccumMs * 2)
      : Math.max(0, this.laughEv - dtMs * c.laughDecay);
    const smileCond = this.smile >= c.smileOn;
    this.smileEv = smileCond ? Math.min(this.smileEv + dtMs, c.smileHoldMs * 2) : Math.max(0, this.smileEv - dtMs);

    const laughReady = this.laughEv >= c.laughAccumMs && this.sinceLaughEndMs >= c.laughRefractoryMs;

    switch (this.state) {
      case EXPR.NONE:
        if (laughReady) return this._enter(EXPR.LAUGH);
        if (this.smileEv >= c.smileHoldMs) return this._enter(EXPR.SMILE);
        return null;

      case EXPR.SMILE:
        if (laughReady) return this._enter(EXPR.LAUGH);
        if (this.smile < c.smileOff) {
          this.releaseMs += dtMs;
          if (this.releaseMs >= c.smileReleaseMs) return this._enter(EXPR.NONE);
        } else this.releaseMs = 0;
        return null;

      case EXPR.LAUGH: {
        const keep = this.jaw >= c.laughJawOff && this.smile >= c.laughSmileKeep;
        if (!keep) {
          this.releaseMs += dtMs;
          if (this.releaseMs >= c.laughReleaseMs) {
            this.laughEv = 0;
            this.sinceLaughEndMs = 0;
            return this._enter(this.smile >= c.smileOff ? EXPR.SMILE : EXPR.NONE);
          }
        } else this.releaseMs = 0;
        return null;
      }
    }
    return null;
  }

  _enter(state) {
    this.state = state;
    this.releaseMs = 0;
    if (state === EXPR.NONE) this.smileEv = 0;
    return EXPR_NAME[state];
  }

  /** 0..1 rain intensity: grows with the smile, ducks under fireworks. */
  rainLevel() {
    const c = this.cfg;
    if (this.state === EXPR.SMILE) return 0.35 + 0.65 * clamp01((this.smile - c.smileOff) / (0.9 - c.smileOff));
    if (this.state === EXPR.LAUGH) return 0.3;
    return 0;
  }

  /** 0..1 how big the laugh is, drives firework cadence. */
  laughLevel() {
    if (this.state !== EXPR.LAUGH) return 0;
    return clamp01((this.jaw - this.cfg.laughJawOn) / (0.75 - this.cfg.laughJawOn));
  }
}
