// Guided calibration (?calibrate=1): walks one person through a few expressions
// and records the blendshape signals of every detection. Numbers only: no
// frame or image is kept. Used to check and tune the thresholds on real faces.

import { EXPR_NAME } from './expression.js';

export const PHASES = [
  { key: 'neutral', zh: '放松，保持自然表情', en: 'Relax, keep a neutral face', ms: 4000, expect: 'none' },
  { key: 'smile', zh: '微笑，嘴巴闭着', en: 'Smile with your mouth closed', ms: 4000, expect: 'smile' },
  { key: 'talk', zh: '正常说几句话，不要笑', en: 'Talk normally, without smiling', ms: 5000, expect: 'none' },
  { key: 'smileTalk', zh: '一边笑一边说话', en: 'Talk while smiling', ms: 5000, expect: 'smile' },
  { key: 'laugh', zh: '大笑，张嘴笑出声', en: 'Laugh out loud, mouth open', ms: 5000, expect: 'laugh' },
  { key: 'yawn', zh: '张大嘴，像打哈欠', en: 'Open wide, like a yawn', ms: 3000, expect: 'none' },
];
export const PHASE_LABEL = {
  neutral: ['自然', 'Neutral'],
  smile: ['微笑', 'Smile'],
  talk: ['说话', 'Talk'],
  smileTalk: ['边笑边说', 'Smile + talk'],
  laugh: ['大笑', 'Laugh'],
  yawn: ['哈欠', 'Yawn'],
};
const GAP_MS = 2000; // time to read the next instruction; not recorded

const r3 = (v) => Math.round(v * 1000) / 1000;

export function quantile(values, q) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export class Calibration {
  constructor(lang) {
    this.lang = lang;
    this.reset();
  }

  reset() {
    this.state = 'idle'; // idle | running | done
    this.ix = -1;
    this.phaseStart = 0;
    this.frames = [];
  }

  begin(now) {
    this.state = 'running';
    this.ix = 0;
    this.phaseStart = now + GAP_MS;
    this.frames = [];
  }

  /** Advance the script; returns what the UI should show. */
  tick(now) {
    if (this.state !== 'running') return null;
    let p = PHASES[this.ix];
    if (now - this.phaseStart >= p.ms) {
      this.ix++;
      if (this.ix >= PHASES.length) {
        this.state = 'done';
        return { done: true };
      }
      this.phaseStart = now + GAP_MS;
      p = PHASES[this.ix];
    }
    const elapsed = now - this.phaseStart;
    return {
      done: false,
      step: this.ix + 1,
      total: PHASES.length,
      text: this.lang === 'zh' ? p.zh : p.en,
      recording: elapsed >= 0,
      progress: elapsed < 0 ? 0 : Math.min(1, elapsed / p.ms),
      countdown: elapsed < 0 ? Math.ceil(-elapsed / 1000) : 0,
    };
  }

  /** One detection. `sig` is null when no face was found. */
  record(now, sig, yaw, expr) {
    if (this.state !== 'running' || now < this.phaseStart) return;
    const p = PHASES[this.ix];
    if (!p || now - this.phaseStart >= p.ms) return;
    this.frames.push(
      sig
        ? {
            ph: p.key,
            t: Math.round(now - this.phaseStart),
            face: 1,
            smileRaw: r3(sig.smileRaw),
            jawRaw: r3(sig.jawRaw),
            funnel: r3(sig.funnel),
            pucker: r3(sig.pucker),
            yaw: r3(yaw),
            smile: r3(expr.smile),
            jaw: r3(expr.jaw),
            state: EXPR_NAME[expr.state],
          }
        : { ph: p.key, t: Math.round(now - this.phaseStart), face: 0 },
    );
  }

  /** Per phase: p10 / p50 / p90 of each signal and how often each state was on. */
  summary() {
    return PHASES.map((p) => {
      const all = this.frames.filter((f) => f.ph === p.key);
      const fs = all.filter((f) => f.face);
      const q3 = (k) => [0.1, 0.5, 0.9].map((x) => r3(quantile(fs.map((f) => f[k]), x)));
      const share = (s) => (fs.length ? r3(fs.filter((f) => f.state === s).length / fs.length) : 0);
      return {
        phase: p.key,
        expect: p.expect,
        frames: all.length,
        noFace: all.length - fs.length,
        smileRaw: q3('smileRaw'),
        jawRaw: q3('jawRaw'),
        smile: q3('smile'),
        jaw: q3('jaw'),
        funnelP90: r3(quantile(fs.map((f) => f.funnel), 0.9)),
        puckerP90: r3(quantile(fs.map((f) => f.pucker), 0.9)),
        yawAbsP90: r3(quantile(fs.map((f) => Math.abs(f.yaw)), 0.9)),
        states: { none: share('none'), smile: share('smile'), laugh: share('laugh') },
        hit: share(p.expect),
      };
    });
  }
}
