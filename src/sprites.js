// Shapes the renderers know, and a small list of extra sprites that are not
// particles (cloud puffs, rocket heads). Effects refills the list every frame;
// the renderer draws it after the particles, in the same draw call.

export const SHAPE = Object.freeze({
  GLOW: 0, // soft glow + hot core
  STREAK: 1, // thin tapered line along the velocity (rain); param = width in CSS px
  COMET: 2, // hot head with a tail behind it (sparks, embers)
  PUFF: 3, // soft disc lit from above (cloud); param = how dark the underside is
  DROP: 4, // water bead with a highlight
  STAR: 5, // four-point glint
  RING: 6, // ring lying flat along `angle`; param = squash
});

export class Sprites {
  constructor(capacity) {
    this.cap = capacity;
    this.n = 0;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.shape = new Uint8Array(capacity);
    this.angle = new Float32Array(capacity);
    this.param = new Float32Array(capacity);
    this.r = new Uint8Array(capacity);
    this.g = new Uint8Array(capacity);
    this.b = new Uint8Array(capacity);
    this.a = new Float32Array(capacity);
  }

  clear() {
    this.n = 0;
  }

  push(shape, x, y, size, angle, param, r, g, b, a) {
    if (this.n >= this.cap || a <= 0.003 || size <= 0) return;
    const i = this.n++;
    this.shape[i] = shape;
    this.x[i] = x;
    this.y[i] = y;
    this.size[i] = size;
    this.angle[i] = angle;
    this.param[i] = param;
    this.r[i] = r;
    this.g[i] = g;
    this.b[i] = b;
    this.a[i] = a;
  }
}
