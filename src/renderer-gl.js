// WebGL point-sprite renderer: every particle in one buffer upload and one
// draw call per frame, however many particles there are.

import { KIND } from './particles.js';

const VS = `
attribute vec2 a_pos;
attribute float a_size;
attribute float a_shape;
attribute float a_angle;
attribute vec4 a_color;
uniform vec2 u_res;
uniform float u_dpr;
varying vec4 v_color;
varying float v_shape;
varying vec2 v_dir;
varying float v_half;
void main() {
  vec2 clip = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = a_size;
  v_color = a_color;
  v_shape = a_shape;
  v_dir = vec2(cos(a_angle), sin(a_angle));
  v_half = a_size * 0.5 / u_dpr; // sprite half-size in CSS px
}`;

// Shapes: 0 round glow, 1 rain streak, 2 comet (hot head + tail behind it).
const FS = `
precision mediump float;
varying vec4 v_color;
varying float v_shape;
varying vec2 v_dir;
varying float v_half;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float a;
  if (v_shape < 0.5) {
    float d2 = dot(p, p);
    a = exp(-d2 * 5.0) + 0.6 * exp(-d2 * 40.0); // soft glow + hot core
  } else if (v_shape < 1.5) {
    float along = dot(p, v_dir);
    float across = dot(p, vec2(-v_dir.y, v_dir.x));
    a = (1.0 - smoothstep(0.08, 0.22, abs(across))) * (1.0 - smoothstep(0.55, 1.0, abs(along)));
  } else {
    vec2 q = p * v_half; // CSS px, head at the centre
    float along = dot(q, v_dir);
    float across = dot(q, vec2(-v_dir.y, v_dir.x));
    float r2 = along * along + across * across;
    float head = exp(-r2 / 3.0) + 0.45 * exp(-r2 / 18.0);
    float t = clamp(1.0 + along / v_half, 0.0, 1.0) * step(along, 0.0);
    float tail = t * t * exp(-across * across / 1.6) * 0.7;
    a = min(head + tail, 1.4);
  }
  a *= v_color.a;
  gl_FragColor = vec4(v_color.rgb * a, a); // premultiplied
}`;

const FLOATS = 5; // x, y, size, shape, angle
const STRIDE = FLOATS * 4 + 4; // + rgba bytes

export class GLRenderer {
  static create(canvas, capacity) {
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    });
    if (!gl) return null;
    try {
      return new GLRenderer(canvas, gl, capacity);
    } catch (e) {
      console.warn('WebGL renderer failed, falling back', e);
      return null;
    }
  }

  constructor(canvas, gl, capacity) {
    this.kind = 'webgl';
    this.canvas = canvas;
    this.gl = gl;
    this.capacity = capacity + 64; // + debug outline points
    this.buf = new ArrayBuffer(this.capacity * STRIDE);
    this.f32 = new Float32Array(this.buf);
    this.u8 = new Uint8Array(this.buf);
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.init();
      this.lost = false;
    });
    this.init();
  }

  init() {
    const gl = this.gl;
    const prog = link(gl, VS, FS);
    this.prog = prog;
    gl.useProgram(prog);
    this.uRes = gl.getUniformLocation(prog, 'u_res');
    this.uDpr = gl.getUniformLocation(prog, 'u_dpr');
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.buf.byteLength, gl.DYNAMIC_DRAW);
    const attr = (name, size, type, norm, offset) => {
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, norm, STRIDE, offset);
    };
    attr('a_pos', 2, gl.FLOAT, false, 0);
    attr('a_size', 1, gl.FLOAT, false, 8);
    attr('a_shape', 1, gl.FLOAT, false, 12);
    attr('a_angle', 1, gl.FLOAT, false, 16);
    attr('a_color', 4, gl.UNSIGNED_BYTE, true, 20);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    this.maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64;
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /**
   * @param {ParticleSystem} ps
   * @param {number} dpr device pixels per CSS px
   * @param {object|null} outline head collider to outline (debug), or null
   */
  draw(ps, dpr, outline) {
    if (this.lost) return;
    const gl = this.gl;
    const f = this.f32;
    const u = this.u8;
    const maxP = this.maxPoint;
    let n = 0;
    for (let i = 0; i < ps.n; i++, n++) {
      const o = n * (STRIDE / 4);
      const k = ps.kind[i];
      const life = 1 - ps.age[i] / ps.ttl[i];
      let a = ps.alpha[i];
      let shape = 0;
      let angle = 0;
      let size = ps.size[i];
      if (k === KIND.RAIN) {
        shape = 1;
        angle = Math.atan2(ps.vy[i], ps.vx[i]);
      } else if (k === KIND.SPARK) {
        // Tail length follows speed, so trails shrink as drag slows the spark.
        const vx = ps.vx[i];
        const vy = ps.vy[i];
        const sp = Math.sqrt(vx * vx + vy * vy);
        shape = 2;
        angle = Math.atan2(vy, vx);
        size = Math.min(ps.size[i] + sp * 0.09, 56);
        a *= life * Math.sqrt(life);
      } else if (k === KIND.GLITTER) {
        a *= life * (0.55 + 0.45 * Math.sin(ps.seed[i] + ps.age[i] * 38));
      } else if (k === KIND.FLASH) {
        a *= life * life;
      } else {
        a *= life;
      }
      f[o] = ps.x[i] * dpr;
      f[o + 1] = ps.y[i] * dpr;
      f[o + 2] = Math.min(size * dpr, maxP);
      f[o + 3] = shape;
      f[o + 4] = angle;
      const b = o * 4 + FLOATS * 4;
      u[b] = ps.r[i];
      u[b + 1] = ps.g[i];
      u[b + 2] = ps.b[i];
      u[b + 3] = a >= 1 ? 255 : a <= 0 ? 0 : (a * 255) | 0;
    }
    if (outline && outline.present) n = this.outline(outline, dpr, n);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (n === 0) return;
    gl.useProgram(this.prog);
    gl.uniform2f(this.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uDpr, dpr);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.u8.subarray(0, n * STRIDE));
    gl.drawArrays(gl.POINTS, 0, n);
  }

  outline(h, dpr, n) {
    const f = this.f32;
    const u = this.u8;
    for (let s = 0; s < 48 && n < this.capacity; s++, n++) {
      const t = (s / 48) * Math.PI * 2;
      const lx = Math.cos(t) * h.a;
      const ly = Math.sin(t) * h.b;
      const o = n * (STRIDE / 4);
      f[o] = (h.cx + lx * h.cos - ly * h.sin) * dpr;
      f[o + 1] = (h.cy + lx * h.sin + ly * h.cos) * dpr;
      f[o + 2] = 10 * dpr;
      f[o + 3] = 0;
      f[o + 4] = 0;
      const b = o * 4 + FLOATS * 4;
      u[b] = 90;
      u[b + 1] = 255;
      u[b + 2] = 120;
      u[b + 3] = 255;
    }
    return n;
  }
}

function link(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
