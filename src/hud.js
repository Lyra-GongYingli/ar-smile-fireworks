// Stats overlay. Collects numbers every frame, touches the DOM 4x per second.

import { EXPR_NAME } from './expression.js';
import { quantile } from './calibrate.js';

const MAX_SAMPLES = 3600; // one per second: an hour of camera time

export class Hud {
  constructor(root, cfg) {
    this.root = root;
    this.cfg = cfg;
    this.visible = false;
    this.frames = 0;
    this.workSum = 0;
    this.workMax = 0;
    this.intervalSum = 0;
    this.lastFlush = 0;
    this.lastRuns = 0;
    this.lastHits = 0;
    this.lastBursts = 0;
    this.snapshot = {};
    this.samples = []; // per-second camera-mode samples for the copyable report
    this.lastSampleAt = 0;
    this.startedAt = 0;
    this.lines = {};
    for (const el of root.querySelectorAll('[data-k]')) this.lines[el.dataset.k] = el;
    this.bars = {
      smile: root.querySelector('[data-bar=smile]'),
      jaw: root.querySelector('[data-bar=jaw]'),
    };
    this.marks = {
      smile: root.querySelector('[data-mark=smile]'),
      jaw: root.querySelector('[data-mark=jaw]'),
    };
    if (this.marks.smile) this.marks.smile.style.left = `${cfg.expr.smileOn * 100}%`;
    if (this.marks.jaw) this.marks.jaw.style.left = `${cfg.expr.laughJawOn * 100}%`;
  }

  setVisible(v) {
    this.visible = v;
    this.root.hidden = !v;
  }

  /** Called once per rendered frame. */
  frame(nowMs, intervalMs, workMs, s) {
    this.frames++;
    this.workSum += workMs;
    this.intervalSum += intervalMs;
    if (workMs > this.workMax) this.workMax = workMs;
    const span = nowMs - this.lastFlush;
    if (span < 250) return;

    const fps = (this.frames * 1000) / span;
    const detHz = ((s.tracker ? s.tracker.runs : 0) - this.lastRuns) * (1000 / span);
    const hitsPerSec = (s.ps.hits - this.lastHits) * (1000 / span);
    const snap = this.snapshot;
    snap.fps = fps;
    snap.frameMs = this.intervalSum / this.frames;
    snap.workMs = this.workSum / this.frames;
    snap.workMaxMs = this.workMax;
    snap.inferMs = s.tracker ? s.tracker.inferMs : 0;
    snap.detectHz = detHz;
    snap.delegate = s.tracker ? s.tracker.delegate : 'demo';
    snap.particles = s.ps.n;
    snap.limit = s.ps.limit;
    snap.tier = s.tier.name;
    snap.hitsPerSec = hitsPerSec;
    snap.bursts = s.effects.bursts;
    snap.state = EXPR_NAME[s.expr.state];
    snap.smile = s.expr.smile;
    snap.jaw = s.expr.jaw;
    snap.yaw = s.yaw;
    snap.renderer = s.renderer.kind;
    snap.dpr = s.dpr;
    snap.idle = s.tracker ? s.tracker.idle : false;

    if (s.mode === 'camera' && s.tracker && nowMs - this.lastSampleAt >= 1000) {
      if (!this.startedAt) this.startedAt = nowMs;
      this.lastSampleAt = nowMs;
      if (this.samples.length < MAX_SAMPLES) {
        this.samples.push({
          t: (nowMs - this.startedAt) / 1000,
          fps,
          work: snap.workMs,
          infer: snap.inferMs,
          det: detHz,
          tier: snap.tier,
          face: s.facePresent,
          idle: snap.idle,
        });
      }
    }

    this.lastRuns = s.tracker ? s.tracker.runs : 0;
    this.lastHits = s.ps.hits;
    this.frames = 0;
    this.workSum = 0;
    this.workMax = 0;
    this.intervalSum = 0;
    this.lastFlush = nowMs;
    if (this.visible) this.paint(snap);
  }

  paint(s) {
    const L = this.lines;
    set(L.fps, `${s.fps.toFixed(0)} fps · ${s.frameMs.toFixed(1)} ms/frame · JS ${s.workMs.toFixed(1)} ms (max ${s.workMaxMs.toFixed(1)})`);
    set(L.infer, `infer ${s.inferMs.toFixed(1)} ms · ${s.delegate} · ${s.detectHz.toFixed(0)}/s${s.idle ? ' · idle' : ''}`);
    set(L.particles, `particles ${s.particles}/${s.limit} · tier ${s.tier} · ${s.renderer} @${s.dpr.toFixed(2)}x`);
    set(L.hits, `head contacts ${s.hitsPerSec.toFixed(0)}/s · bursts ${s.bursts}`);
    set(L.state, `expr ${s.state} · yaw ${s.yaw.toFixed(2)}`);
    if (this.bars.smile) this.bars.smile.style.width = `${(s.smile * 100).toFixed(0)}%`;
    if (this.bars.jaw) this.bars.jaw.style.width = `${(s.jaw * 100).toFixed(0)}%`;
  }
}

/**
 * One line a tester can paste back from a phone: medians and tails over the
 * seconds a face was tracked, tier changes over time, and what the device is.
 */
export function perfReport(samples, snap, view) {
  const face = samples.filter((x) => x.face && !x.idle);
  const q = (k, p) => quantile(face.map((x) => x[k]), p);
  const f0 = (v) => (Number.isNaN(v) ? '-' : v.toFixed(0));
  const f1 = (v) => (Number.isNaN(v) ? '-' : v.toFixed(1));
  let tiers = samples.length ? samples[0].tier : snap.tier;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].tier !== samples[i - 1].tier) tiers += `→${samples[i].tier}@${Math.round(samples[i].t)}s`;
  }
  const ua = navigator.userAgent;
  const os = (ua.match(/\(([^)]+)\)/) || [, ''])[1];
  const browser = (ua.match(/(EdgA?|EdgiOS|CriOS|Chrome|FxiOS|Firefox|Version)\/[\d.]+/g) || []).pop() || '';
  return [
    `AR perf v1`,
    `${samples.length}s, face ${face.length}s`, // one sample per second
    `fps p50 ${f0(q('fps', 0.5))} p10 ${f0(q('fps', 0.1))}`,
    `JS p50 ${f1(q('work', 0.5))} p90 ${f1(q('work', 0.9))} ms`,
    `infer p50 ${f1(q('infer', 0.5))} p90 ${f1(q('infer', 0.9))} ms ${snap.delegate}`,
    `detect p50 ${f0(q('det', 0.5))}/s`,
    `tier ${tiers}`,
    `${snap.renderer}@${snap.dpr.toFixed(2)}x ${view}`,
    `${os} ${browser}`,
  ].join(' | ');
}

function set(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}
