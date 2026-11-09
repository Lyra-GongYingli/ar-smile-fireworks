// WebGL point-sprite renderer. Every particle and sprite goes into one buffer
// upload and one draw call per frame, however many there are. After a firework
// a second, full-screen pass adds the burst's light to the scene.

import { KIND, HIDDEN } from './particles.js';
import { SHAPE } from './sprites.js';

const VS = `
attribute vec2 a_pos;
attribute float a_size;
attribute float a_shape;
attribute float a_angle;
attribute float a_param;
attribute vec4 a_color;
uniform vec2 u_res;
uniform float u_dpr;
varying vec4 v_color;
varying float v_shape;
varying vec2 v_dir;
varying float v_half;
varying float v_param;
void main() {
  vec2 clip = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = a_size;
  v_color = a_color;
  v_shape = a_shape;
  v_dir = vec2(cos(a_angle), sin(a_angle));
  v_half = a_size * 0.5 / u_dpr; // sprite half-size in CSS px
  v_param = a_param;
}`;

// Shapes: see SHAPE in sprites.js.
const FS = `
precision mediump float;
varying vec4 v_color;
varying float v_shape;
varying vec2 v_dir;
varying float v_half;
varying float v_param;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  vec3 col = v_color.rgb;
  float a;
  if (v_shape < 0.5) {
    float d2 = dot(p, p);
    a = exp(-d2 * 5.0) + 0.6 * exp(-d2 * 40.0); // soft glow + hot core
  } else if (v_shape < 1.5) {
    // streak: v_param CSS px wide, fading from a bright head to a clear tail
    vec2 q = p * v_half;
    float along = dot(q, v_dir);
    float across = abs(dot(q, vec2(-v_dir.y, v_dir.x)));
    float w = v_param * 0.5;
    float t = along / v_half * 0.5 + 0.5;
    a = (1.0 - smoothstep(w, w + 0.8, across)) * smoothstep(0.0, 0.8, t) * (1.0 - smoothstep(0.9, 1.0, t));
  } else if (v_shape < 2.5) {
    // comet: hot head at the centre, tail behind it
    vec2 q = p * v_half;
    float along = dot(q, v_dir);
    float across = dot(q, vec2(-v_dir.y, v_dir.x));
    float r2 = along * along + across * across;
    float head = exp(-r2 / 3.0) + 0.45 * exp(-r2 / 18.0);
    float t = clamp(1.0 + along / v_half, 0.0, 1.0) * step(along, 0.0);
    float tail = t * t * exp(-across * across / 1.6) * 0.7;
    // round window: a slow star has a small sprite, and its halo would show the square edge
    a = min(head + tail, 1.4) * (1.0 - smoothstep(0.7, 1.0, length(p)));
  } else if (v_shape < 3.5) {
    // puff: soft disc, darker underneath
    float d = length(p);
    a = 1.0 - smoothstep(0.7, 0.98, d);
    col *= 1.0 - v_param * smoothstep(-0.4, 1.0, p.y);
  } else if (v_shape < 4.5) {
    // drop: faint body, brighter rim, sharp highlight
    float d = length(p);
    float body = 1.0 - smoothstep(0.42, 0.6, d);
    float rim = smoothstep(0.2, 0.55, d) * body;
    vec2 h = p - vec2(-0.18, -0.2);
    float hl = exp(-dot(h, h) * 90.0);
    a = body * 0.35 + rim * 0.45 + hl;
    col = mix(col, vec3(1.0), clamp(hl, 0.0, 1.0));
  } else if (v_shape < 5.5) {
    // star: four-point glint
    vec2 r = vec2(dot(p, v_dir), dot(p, vec2(-v_dir.y, v_dir.x)));
    float core = exp(-dot(r, r) * 28.0);
    float rays = exp(-abs(r.x) * 3.5 - r.y * r.y * 220.0) + exp(-abs(r.y) * 3.5 - r.x * r.x * 220.0);
    a = min(core + rays, 1.3) * (1.0 - smoothstep(0.75, 1.0, length(p)));
  } else {
    // ring lying along v_dir, squashed by v_param: seen almost edge-on
    vec2 r = vec2(dot(p, v_dir), dot(p, vec2(-v_dir.y, v_dir.x)) / v_param);
    float d = length(r);
    a = exp(-(d - 0.72) * (d - 0.72) * 90.0);
  }
  a *= v_color.a;
  gl_FragColor = vec4(col * a, a); // premultiplied
}`;

// Light wash: a full-screen triangle, brightest around the latest burst.
const LVS = `
attribute vec2 a_xy;
void main() { gl_Position = vec4(a_xy, 0.0, 1.0); }`;
const LFS = `
precision mediump float;
uniform vec2 u_center; // device px, GL window coordinates (y up)
uniform float u_radius;
uniform vec3 u_color;
uniform float u_i;
void main() {
  float d = distance(gl_FragCoord.xy, u_center) / u_radius;
  float f = u_i * (0.3 + 0.7 * exp(-d * d * 2.5));
  gl_FragColor = vec4(u_color * f, f);
}`;

const FLOATS = 6; // x, y, size, shape, angle, param
const STRIDE = FLOATS * 4 + 4; // + rgba bytes
const W4 = STRIDE / 4;
const ATTRS = ['a_pos', 'a_size', 'a_shape', 'a_angle', 'a_param', 'a_color'];

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
    this.capacity = capacity + 128; // + sprites and debug outline points
    this.buf = new ArrayBuffer(this.capacity * STRIDE);
    this.f32 = new Float32Array(this.buf);
    this.u8 = new Uint8Array(this.buf);
    this.lost = false;
    this.drawCalls = 0;
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
    this.prog = link(gl, VS, FS, ATTRS);
    this.uRes = gl.getUniformLocation(this.prog, 'u_res');
    this.uDpr = gl.getUniformLocation(this.prog, 'u_dpr');
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.buf.byteLength, gl.DYNAMIC_DRAW);

    this.lprog = link(gl, LVS, LFS, ['a_xy']);
    this.uCenter = gl.getUniformLocation(this.lprog, 'u_center');
    this.uRadius = gl.getUniformLocation(this.lprog, 'u_radius');
    this.uColor = gl.getUniformLocation(this.lprog, 'u_color');
    this.uI = gl.getUniformLocation(this.lprog, 'u_i');
    this.lvbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lvbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

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
   * @param {Effects} fx sprites (cloud, rockets) and scene light
   * @param {number} dpr device pixels per CSS px
   * @param {object|null} outline head collider to outline (debug), or null
   */
  draw(ps, fx, dpr, outline) {
    if (this.lost) return;
    const gl = this.gl;
    let n = 0;
    for (let i = 0; i < ps.n; i++) {
      if (ps.flags[i] & HIDDEN) continue; // behind the head
      const k = ps.kind[i];
      const life = 1 - ps.age[i] / ps.ttl[i];
      let a = ps.alpha[i];
      let shape = SHAPE.GLOW;
      let angle = 0;
      let param = 0;
      let size = ps.size[i];
      let g = ps.g[i];
      let b = ps.b[i];
      if (k === KIND.RAIN || k === KIND.RAIN_FAR) {
        shape = SHAPE.STREAK;
        angle = Math.atan2(ps.vy[i], ps.vx[i]);
        param = ps.aux[i];
      } else if (k === KIND.SPARK || k === KIND.EMBER) {
        // Tail length follows speed, so trails shrink as drag slows the star.
        const vx = ps.vx[i];
        const vy = ps.vy[i];
        const sp = Math.sqrt(vx * vx + vy * vy);
        shape = SHAPE.COMET;
        angle = Math.atan2(vy, vx);
        if (k === KIND.SPARK) {
          size = Math.min(size + sp * ps.aux[i], 64);
          a *= life * Math.sqrt(life);
        } else {
          // Willow: even a slow ember keeps a long drooping tail; it cools from gold to deep orange and flickers.
          size = Math.min(size + 14 + sp * ps.aux[i], 64);
          g = (g * (0.55 + 0.45 * life)) | 0;
          b = (b * life) | 0;
          a *= Math.min(1, life * 3) * (0.82 + 0.18 * Math.sin(ps.seed[i] + ps.age[i] * 31));
        }
      } else if (k === KIND.GLITTER) {
        a *= life * (0.55 + 0.45 * Math.sin(ps.seed[i] + ps.age[i] * 38));
      } else if (k === KIND.FLASH || k === KIND.TRAIL) {
        a *= life * life;
      } else if (k === KIND.BEAD) {
        const vx = ps.vx[i];
        const vy = ps.vy[i];
        const sp = Math.sqrt(vx * vx + vy * vy);
        if (sp > 260) {
          // falling off the head: a drip
          shape = SHAPE.STREAK;
          angle = Math.atan2(vy, vx);
          param = 1.5;
          size = Math.min(8 + sp * 0.02, 26);
        } else {
          shape = SHAPE.DROP;
          size *= 2.2;
        }
        a *= Math.min(1, life * 4);
      } else if (k === KIND.GLINT) {
        shape = SHAPE.STAR;
        angle = ps.seed[i];
        size *= 0.6 + 0.4 * life;
        a *= life;
      } else if (k === KIND.RING) {
        shape = SHAPE.RING;
        angle = ps.aux[i];
        param = 0.32;
        size *= 0.35 + 0.9 * (1 - life);
        a *= life;
      } else {
        a *= life; // SPLASH
      }
      n = this.put(n, ps.x[i], ps.y[i], size, shape, angle, param, ps.r[i], g, b, a, dpr);
    }
    const sp = fx.sprites;
    for (let i = 0; i < sp.n; i++) {
      n = this.put(n, sp.x[i], sp.y[i], sp.size[i], sp.shape[i], sp.angle[i], sp.param[i], sp.r[i], sp.g[i], sp.b[i], sp.a[i], dpr);
    }
    if (outline && outline.present) n = this.outline(outline, dpr, n);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawCalls = 0;
    if (fx.light.i > 0) this.drawLight(fx.light, dpr);
    if (n === 0) return;
    gl.useProgram(this.prog);
    gl.uniform2f(this.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uDpr, dpr);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    let off = 0;
    for (let k = 0; k < ATTRS.length; k++) {
      gl.enableVertexAttribArray(k);
      if (k === 5) gl.vertexAttribPointer(k, 4, gl.UNSIGNED_BYTE, true, STRIDE, FLOATS * 4);
      else gl.vertexAttribPointer(k, k === 0 ? 2 : 1, gl.FLOAT, false, STRIDE, off);
      off += k === 0 ? 8 : 4;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.u8.subarray(0, n * STRIDE));
    gl.drawArrays(gl.POINTS, 0, n);
    this.drawCalls++;
  }

  put(n, x, y, size, shape, angle, param, r, g, b, a, dpr) {
    if (n >= this.capacity) return n;
    const f = this.f32;
    const u = this.u8;
    const o = n * W4;
    f[o] = x * dpr;
    f[o + 1] = y * dpr;
    f[o + 2] = Math.min(size * dpr, this.maxPoint);
    f[o + 3] = shape;
    f[o + 4] = angle;
    f[o + 5] = param;
    const c = o * 4 + FLOATS * 4;
    u[c] = r;
    u[c + 1] = g;
    u[c + 2] = b;
    u[c + 3] = a >= 1 ? 255 : a <= 0 ? 0 : (a * 255) | 0;
    return n + 1;
  }

  drawLight(L, dpr) {
    const gl = this.gl;
    gl.useProgram(this.lprog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lvbo);
    for (let k = 1; k < ATTRS.length; k++) gl.disableVertexAttribArray(k);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.uCenter, L.x * dpr, this.canvas.height - L.y * dpr);
    gl.uniform1f(this.uRadius, Math.max(this.canvas.width, this.canvas.height) * 0.7);
    gl.uniform3f(this.uColor, L.r / 255, L.g / 255, L.b / 255);
    gl.uniform1f(this.uI, L.i);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.drawCalls++;
  }

  outline(h, dpr, n) {
    for (let s = 0; s < 48; s++) {
      const t = (s / 48) * Math.PI * 2;
      const lx = Math.cos(t) * h.a;
      const ly = Math.sin(t) * h.b;
      n = this.put(n, h.cx + lx * h.cos - ly * h.sin, h.cy + lx * h.sin + ly * h.cos, 10, SHAPE.GLOW, 0, 0, 90, 255, 120, 1, dpr);
    }
    return n;
  }
}

function link(gl, vs, fs, attrs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  attrs.forEach((name, k) => gl.bindAttribLocation(p, k, name)); // fixed slots: both programs share 0
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
