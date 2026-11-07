// Canvas 2D fallback for devices without WebGL. Rain is one batched stroke;
// sparks are small rects (no shadowBlur, which is very slow on mobile).

import { KIND } from './particles.js';

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

  draw(ps, dpr, outline) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Rain: one path, one stroke.
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = 'rgb(190,215,255)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < ps.n; i++) {
      if (ps.kind[i] !== KIND.RAIN) continue;
      const vx = ps.vx[i];
      const vy = ps.vy[i];
      const inv = ps.size[i] / Math.hypot(vx, vy);
      ctx.moveTo(ps.x[i], ps.y[i]);
      ctx.lineTo(ps.x[i] - vx * inv, ps.y[i] - vy * inv);
    }
    ctx.stroke();

    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < ps.n; i++) {
      const k = ps.kind[i];
      if (k === KIND.RAIN) continue;
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
      const s = k === KIND.SPLASH ? 2 : ps.size[i] * 0.3;
      ctx.fillRect(ps.x[i] - s / 2, ps.y[i] - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (outline && outline.present) {
      ctx.strokeStyle = 'rgba(120,255,140,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(outline.cx, outline.cy, outline.a, outline.b, Math.atan2(outline.sin, outline.cos), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
