// No-camera demo: a drawn head that drifts (or follows your finger) and fake
// blendshape signals. It feeds the same expression machine and physics as the
// camera path, so reviewers without a webcam see the real behaviour.

const SCRIPT = [
  [2.5, 'none'],
  [4.5, 'smile'],
  [4.0, 'laugh'],
  [2.0, 'none'],
];
const SCRIPT_LEN = SCRIPT.reduce((s, [d]) => s + d, 0);

const TARGETS = {
  none: [0.04, 0.03],
  smile: [0.74, 0.07],
  laugh: [0.82, 0.52],
};

export class DemoInput {
  constructor(el) {
    this.el = el;
    this.t = 0;
    this.override = null; // 'smile' | 'laugh' while a button is held
    this.pointer = null;
    this.smile = 0.04;
    this.jaw = 0.03;
    this.head = { cx: 0, cy: 0, a: 1, b: 1, theta: 0, yaw: 0 };
    this.sig = { smileRaw: 0, jawRaw: 0, funnel: 0.02, pucker: 0.03 };
    this.phase = 'none';
  }

  scripted() {
    let t = this.t % SCRIPT_LEN;
    for (const [d, p] of SCRIPT) {
      if (t < d) return p;
      t -= d;
    }
    return 'none';
  }

  update(dt, W, H) {
    this.t += dt;
    const t = this.t;
    const h = this.head;
    const a = Math.min(W, H) * 0.14;
    h.a = a;
    h.b = a * 1.32;
    if (this.pointer) {
      h.cx += (this.pointer.x - h.cx) * (1 - Math.exp(-dt / 0.06));
      h.cy += (this.pointer.y - h.cy) * (1 - Math.exp(-dt / 0.06));
    } else {
      h.cx = W * 0.5 + W * 0.2 * Math.sin(t * 0.6);
      h.cy = H * 0.58 + H * 0.04 * Math.sin(t * 1.1);
    }
    h.theta = 0.12 * Math.sin(t * 0.8);

    this.phase = this.override || this.scripted();
    const [ts, tj] = TARGETS[this.phase];
    const k = 1 - Math.exp(-dt / 0.08);
    this.smile += (ts + (Math.random() - 0.5) * 0.04 - this.smile) * k;
    const pulse = this.phase === 'laugh' ? 0.14 * Math.sin(t * 24) : 0; // "ha-ha-ha"
    this.jaw += (tj + pulse + (Math.random() - 0.5) * 0.03 - this.jaw) * k;
    this.sig.smileRaw = this.smile;
    this.sig.jawRaw = Math.max(0, this.jaw);
    return this;
  }

  render(state) {
    const el = this.el;
    if (!el) return;
    const h = this.head;
    el.style.transform = `translate(${h.cx - h.a}px, ${h.cy - h.b}px) rotate(${h.theta}rad)`;
    el.style.width = `${h.a * 2}px`;
    el.style.height = `${h.b * 2}px`;
    if (el.dataset.state !== state) el.dataset.state = state;
  }
}
