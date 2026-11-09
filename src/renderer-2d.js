// Canvas 2D fallback for devices without WebGL (demo mode only: the face
// tracker itself needs WebGL). Rain is two batched strokes; everything else is
// small rects and arcs (no shadowBlur, which is very slow on mobile).

import { KIND, HIDDEN } from './particles.js';
import { SHAPE } from './sprites.js';

export class Canvas2DRenderer {
  static create(canvas) {
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    return ctx ? new Canvas2DRenderer(canvas, ctx) : null;
  }

  constructor(canvas, ctx) {
    this.kind = 'canvas2d';
    this.canvas = canvas;
    this.ctx = ctx;
    this.colorCache = new Map();
    this.drawCalls = 0;
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  color(r, g, b) {
    const key = (r << 16) | (g << 8) | b;
    let s = this.colorCache.get(key);
    if (!s) {
      s = `rgb(${r},${g},${b})`;
      this.colorCache.set(key, s);
    }
    return s;
  }

  rain(ps, kind, alpha, width) {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = 'rgb(195,220,255)';
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i < ps.n; i++) {
      if (ps.kind[i] !== kind || ps.flags[i] & HIDDEN) continue;
      const vx = ps.vx[i];
      const vy = ps.vy[i];
      const inv = ps.size[i] / Math.hypot(vx, vy);
      ctx.moveTo(ps.x[i], ps.y[i]);
      ctx.lineTo(ps.x[i] - vx * inv, ps.y[i] - vy * inv);
    }
    ctx.stroke();
  }

  draw(ps, fx, dpr, outline) {
    const ctx = this.ctx;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (fx.dim > 0) {
      ctx.globalAlpha = fx.dim * 0.75; // the GL pass dims the top more; one flat wash is enough here
      ctx.fillStyle = 'rgb(0,0,0)';
      ctx.fillRect(0, 0, w, h);
    }
    const L = fx.light;
    if (L.i > 0) {
      ctx.globalAlpha = L.i * 0.8;
      ctx.fillStyle = this.color(L.r | 0, L.g | 0, L.b | 0);
      ctx.fillRect(0, 0, w, h);
    }

    ctx.globalCompositeOperation = 'source-over';
    this.rain(ps, KIND.RAIN_FAR, 0.28, 0.8);
    this.rain(ps, KIND.RAIN, 0.6, 1.4);

    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < ps.n; i++) {
      const k = ps.kind[i];
      if (k === KIND.RAIN || k === KIND.RAIN_FAR) continue;
      const life = 1 - ps.age[i] / ps.ttl[i];
      ctx.globalAlpha = Math.max(0, Math.min(1, ps.alpha[i] * life));
      ctx.fillStyle = this.color(ps.r[i], ps.g[i], ps.b[i]);
      if (k === KIND.FLASH) {
        ctx.globalAlpha *= 0.4;
        ctx.beginPath();
        ctx.arc(ps.x[i], ps.y[i], ps.size[i] * 0.3, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      const s = k === KIND.SPLASH || k === KIND.TRAIL ? 2 : k === KIND.RING ? 0 : ps.size[i] * 0.3;
      if (s > 0) ctx.fillRect(ps.x[i] - s / 2, ps.y[i] - s / 2, s, s);
    }

    ctx.globalCompositeOperation = 'source-over';
    const sp = fx.sprites;
    for (let i = 0; i < sp.n; i++) {
      ctx.globalAlpha = Math.min(1, sp.a[i]);
      ctx.fillStyle = this.color(sp.r[i], sp.g[i], sp.b[i]);
      ctx.beginPath();
      ctx.arc(sp.x[i], sp.y[i], sp.size[i] * (sp.shape[i] === SHAPE.PUFF ? 0.4 : 0.25), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (outline && outline.present) {
      ctx.strokeStyle = 'rgba(120,255,140,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(outline.cx, outline.cy, outline.a, outline.b, Math.atan2(outline.sin, outline.cos), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
