// Quality governor: sheds load (particles, resolution) when frames run long and
// adds it back when there is headroom. It compares against the display's own
// frame interval, so a 30 Hz-capped phone (iOS Low Power Mode) is not mistaken
// for an overloaded one. Pure logic so it runs under `node --test`.

export class Governor {
  constructor(cfg, tierIx, maxTier) {
    this.cfg = cfg;
    this.tier = tierIx;
    this.maxTier = maxTier;
    // Shortest recent frame interval ~ the display's refresh period. Learned from
    // the first frames: a fixed 16.7 ms start took ~15 s to adapt on a 30 Hz-capped
    // phone and dropped tiers for nothing in between (caught by a unit test).
    this.base = Infinity;
    this.ema = 0;
    this.work = 0;
    this.over = -1;
    this.under = -1;
    this.since = 0;
  }

  /** @returns {number} -1 to drop a tier, +1 to raise one, 0 to stay */
  update(now, intervalMs, workMs) {
    if (intervalMs <= 0 || intervalMs > 250) return 0; // tab switch, first frame
    if (this.base === Infinity) {
      this.base = this.ema = intervalMs;
      this.work = workMs;
    }
    this.base = Math.min(this.base * 1.0015, intervalMs);
    this.ema += (intervalMs - this.ema) * 0.08;
    this.work += (workMs - this.work) * 0.08;
    if (now - this.since < 1000) return 0; // let a tier change settle
    const g = this.cfg;
    const limit = Math.max(this.base * 1.35, g.budgetMs);
    const roomy = Math.max(this.base * 1.12, g.headroomMs);
    // Overloaded if frames run long against the display's own pace, or if our
    // own main-thread work is too big (catches a phone stuck at 30 fps from frame 1).
    if (this.ema > limit || this.work > g.workBudgetMs) {
      this.under = -1;
      if (this.over < 0) this.over = now;
      if (now - this.over > g.downAfterMs && this.tier > 0) return this._move(now, -1);
    } else if (this.ema < roomy && this.work < 6) {
      this.over = -1;
      if (this.under < 0) this.under = now;
      if (now - this.under > g.upAfterMs && this.tier < this.maxTier) return this._move(now, +1);
    } else {
      this.over = this.under = -1;
    }
    return 0;
  }

  _move(now, d) {
    this.tier += d;
    this.over = this.under = -1;
    this.since = now;
    return d;
  }
}
