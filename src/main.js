import { CONFIG } from './config.js';
import { T, LANG } from './i18n.js';
import { EXPR, EXPR_NAME, ExpressionMachine, resolveBlendshapeIndices, scoresByIndex } from './expression.js';
import { HeadTracker, coverTransform, headFromLandmarks, makeCollider } from './face.js';
import { ParticleSystem } from './particles.js';
import { Effects } from './effects.js';
import { GLRenderer } from './renderer-gl.js';
import { Canvas2DRenderer } from './renderer-2d.js';
import { Hud } from './hud.js';
import { DemoInput } from './demo.js';
import { Governor } from './governor.js';
import { Calibration, PHASES, PHASE_LABEL } from './calibrate.js';
import { FaceTracker, preloadAssets } from './tracker.js';
import { CameraError, inAppBrowser, openCamera, openTestSource, stopStream } from './camera.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

const stage = $('#stage');
const video = $('#cam');
const canvas = $('#fx');
const chip = $('#status');

// ---------------------------------------------------------------- state
const CAP = CONFIG.tiers[CONFIG.tiers.length - 1].maxParticles;
const ps = new ParticleSystem(CAP);
const effects = new Effects(ps, CONFIG);
const expr = new ExpressionMachine(CONFIG.expr);
const head = new HeadTracker(CONFIG.head);
const collider = makeCollider();
const rawHead = { cx: 0, cy: 0, a: 0, b: 0, theta: 0, yaw: 0 };
const demo = new DemoInput($('#demo-head'));
const hud = new Hud($('#hud'), CONFIG);
const renderer = (params.get('renderer') !== '2d' && GLRenderer.create(canvas, CAP)) || Canvas2DRenderer.create(canvas);

let mode = 'intro'; // intro | camera | demo | error
let tracker = null;
let trackerPromise = null;
let stream = null;
let tierIx = pickInitialTier();
let tier = CONFIG.tiers[tierIx];
let W = 1;
let H = 1;
let dpr = 1;
let xform = null;
let bsIdx = null;
const bsScores = new Float32Array(64); // slot 63 stays 0: stand-in for a missing blendshape
const sig = { smileRaw: 0, jawRaw: 0, funnel: 0, pucker: 0 };
let lastDetectAt = 0;
let noFaceMs = 0;
let yaw = 0;
let rafId = 0;
let last = 0;
const demoPrev = { x: 0, y: 0, ok: false };
const timings = {};
let loadText = '';
let chipText = '';
let chipCheck = 0;
const calib = params.get('calibrate') === '1' ? new Calibration(LANG) : null;
let calibFaceSince = -1;
let calibKey = '';
// Every mutable module variable is declared above this line. Code below runs
// during module evaluation (URL switches, the capability error path), so a `let`
// declared further down would still be in its temporal dead zone when called.
// That crash shipped twice (demo autostart, then the no-WebGL path).

const stats = { ps, effects, expr, hud, renderer, get tracker() { return tracker; }, get tier() { return tier; }, get dpr() { return dpr; }, get yaw() { return yaw; } };
// Read-only handles for the stats overlay and automated tests.
window.__app = { stats, snapshot: hud.snapshot, timings, CONFIG, ps, expr, effects, demo, collider, get mode() { return mode; } };

applyTier(tierIx);
const gov = new Governor(CONFIG.governor, tierIx, maxTier());

// ---------------------------------------------------------------- loading
document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
for (const el of document.querySelectorAll('[data-t]')) el.textContent = T[el.dataset.t];
if (inAppBrowser()) $('#inapp').hidden = false;

const testSrc = sameOriginParam('src');
// Check what the face tracker needs before downloading ~18 MB it could not use.
const capErr = checkCapabilities();
if (capErr) {
  setProgress(0, T.err[capErr]);
  $('#btn-start').disabled = true;
} else {
  trackerPromise = loadTracker();
}

function checkCapabilities() {
  const caps = window.__caps || { wasm: true, simd: true, gl: true }; // set by the inline check in index.html
  if (!caps.wasm) return 'nowasm';
  if (!caps.simd) return 'nosimd';
  if (!caps.gl) return 'nogl';
  return null;
}

function loadTracker() {
  const p = (async () => {
    const t0 = performance.now();
    const assets = params.get('noblob') === '1' ? null : await preloadAssets((f) => setProgress(f, T.loading(f)));
    timings.downloadMs = performance.now() - t0;
    setProgress(1, T.preparing);
    const t = new FaceTracker(CONFIG.detect);
    await t.init(assets, params.get('cpu') === '1');
    timings.initMs = t.initMs;
    timings.warmUpMs = t.warmUpMs;
    timings.readyMs = performance.now() - t0;
    tracker = t;
    setProgress(1, T.ready);
    return t;
  })();
  p.catch((e) => {
    console.error(e);
    trackerPromise = null; // next tap on "start" retries the download
    setProgress(0, T.err.model);
  });
  return p;
}

function setProgress(f, text) {
  loadText = text;
  $('#bar').style.transform = `scaleX(${f})`;
  $('#load-text').textContent = text;
}

// ---------------------------------------------------------------- modes
$('#btn-start').addEventListener('click', startCamera);
$('#btn-demo').addEventListener('click', startDemo);
$('#btn-retry').addEventListener('click', startCamera);
$('#btn-err-demo').addEventListener('click', startDemo);
$('#btn-hud').addEventListener('click', () => hud.setVisible(!hud.visible));
$('#btn-calib-again').addEventListener('click', () => {
  calib.reset();
  calibFaceSince = -1;
  calibKey = '';
  $('#calib-result').hidden = true;
  $('#calib-actions').hidden = true;
});
$('#btn-calib-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(window.__calib));
    $('#btn-calib-copy').textContent = T.calibCopied;
  } catch {
    $('#btn-calib-copy').textContent = T.calibCopyFailed;
  }
});
// Handlers are attached: the buttons may work now (they ship disabled in the HTML).
$('#btn-demo').disabled = false;
$('#btn-start').disabled = !!capErr;

async function startCamera() {
  stopDemo();
  showPanel(null);
  setChip(T.opening);
  // Ask for the camera inside the tap handler (before any await) and load the
  // model at the same time; neither waits for the other.
  const camP = testSrc ? openTestSource(video, testSrc).then(() => null) : openCamera(video, CONFIG.camera);
  const trkP = trackerPromise || (trackerPromise = loadTracker());
  try {
    stopStream(stream);
    stream = await camP;
  } catch (e) {
    return showError(e instanceof CameraError ? e.code : 'failed', e);
  }
  if (stream) {
    const track = stream.getVideoTracks()[0];
    if (track) track.addEventListener('ended', () => mode === 'camera' && showError('lost'));
  }
  document.body.dataset.mode = 'camera';
  mode = 'camera';
  updateXform();
  startLoop();
  if (calib) {
    hud.setVisible(true);
    $('#calib').hidden = false;
  }
  try {
    await trkP;
  } catch (e) {
    return showError('model', e);
  }
  tracker.attachVideo(video);
}

function startDemo() {
  showPanel(null);
  stopStream(stream);
  stream = null;
  video.srcObject = null;
  document.body.dataset.mode = 'demo';
  mode = 'demo';
  expr.reset();
  demoPrev.ok = false;
  setChip(T.demoTag);
  startLoop();
}

function stopDemo() {
  demo.override = null;
  demo.pointer = null;
}

function showError(code, err) {
  if (err) console.warn(code, err);
  mode = 'error';
  document.body.dataset.mode = 'error';
  $('#err-text').textContent = T.err[code] || T.err.failed;
  $('#btn-retry').hidden = code === 'insecure' || code === 'unsupported';
  showPanel('#error');
  setChip('');
}

function showPanel(sel) {
  for (const p of document.querySelectorAll('.panel')) p.hidden = true;
  if (sel) $(sel).hidden = false;
}

// ---------------------------------------------------------------- layout
function pickInitialTier() {
  const forced = params.get('tier');
  if (forced !== null) return Math.max(0, Math.min(CONFIG.tiers.length - 1, Number(forced) | 0));
  const mem = navigator.deviceMemory || 8;
  const cores = navigator.hardwareConcurrency || 8;
  const touch = matchMedia('(pointer: coarse)').matches;
  if (mem <= 2 || cores <= 2) return 0;
  if (touch || cores <= 4) return 1;
  return 2;
}

function applyTier(ix) {
  tierIx = ix;
  tier = CONFIG.tiers[ix];
  ps.limit = tier.maxParticles;
  effects.setTier(tier);
  resize();
}

function resize() {
  const r = stage.getBoundingClientRect();
  W = Math.max(1, r.width);
  H = Math.max(1, r.height);
  dpr = Math.min(window.devicePixelRatio || 1, tier.dprCap);
  renderer.resize(Math.round(W * dpr), Math.round(H * dpr));
  updateXform();
}

function updateXform() {
  if (video.videoWidth > 0) xform = coverTransform(video.videoWidth, video.videoHeight, W, H);
}

window.addEventListener('resize', resize);
video.addEventListener('resize', updateXform); // camera rotated or renegotiated

// ---------------------------------------------------------------- per frame
function startLoop() {
  if (rafId) return;
  last = performance.now();
  rafId = requestAnimationFrame(loop);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  } else if (mode === 'camera' || mode === 'demo') {
    startLoop();
  }
});

function loop(now) {
  rafId = requestAnimationFrame(loop);
  const intervalMs = now - last;
  last = now;
  const dt = Math.min(intervalMs, 100) / 1000;
  const t0 = performance.now();

  if (mode === 'camera') {
    if (tracker) {
      const res = tracker.poll(now);
      if (res) onDetection(res, now);
      if (tracker.failed) onTrackerFailure();
    }
    head.sample(now, collider);
    if (calib) calibFrame(now);
  } else if (mode === 'demo') {
    demoFrame(dt, now);
  } else {
    collider.present = false;
  }

  const laughing = expr.state === EXPR.LAUGH;
  effects.update(dt, now, expr.rainLevel(), expr.laughLevel(), laughing, collider, W, H);
  const steps = dt > 1 / 55 ? 2 : 1;
  for (let s = 0; s < steps; s++) ps.step(dt / steps, collider, W, H, CONFIG.physics);
  renderer.draw(ps, dpr, hud.visible ? collider : null);

  const workMs = performance.now() - t0;
  governor(now, intervalMs, workMs);
  hud.frame(now, intervalMs, workMs, stats);
  updateChip(now);
}

function onDetection(res, now) {
  const dtMs = lastDetectAt ? Math.min(now - lastDetectAt, 250) : 33;
  lastDetectAt = now;
  const face = res.faceLandmarks && res.faceLandmarks[0];
  if (!face) {
    head.lost(now);
    noFaceMs += dtMs;
    expr.update(dtMs, null, 0);
    if (calib) calib.record(now, null, 0, expr);
    return;
  }
  noFaceMs = 0;
  if (!xform) updateXform();
  if (!xform) return;
  headFromLandmarks(face, xform, true, CONFIG.head, rawHead);
  head.update(rawHead, now);
  yaw = rawHead.yaw;

  const bs = res.faceBlendshapes && res.faceBlendshapes[0];
  if (!bs) return;
  if (!bsIdx) {
    const r = resolveBlendshapeIndices(bs.categories);
    if (r.missing.length) console.error('Model is missing blendshapes:', r.missing);
    bsIdx = r.idx;
    for (const name of r.missing) bsIdx[name] = 63;
  }
  scoresByIndex(bs.categories, bsScores);
  sig.smileRaw = (bsScores[bsIdx.mouthSmileLeft] + bsScores[bsIdx.mouthSmileRight]) * 0.5;
  sig.jawRaw = bsScores[bsIdx.jawOpen];
  sig.funnel = bsScores[bsIdx.mouthFunnel];
  sig.pucker = bsScores[bsIdx.mouthPucker];
  onExpr(expr.update(dtMs, sig, yaw), now);
  if (calib) calib.record(now, sig, yaw, expr);
}

function onExpr(ev, now) {
  if (ev === 'laugh') effects.onLaugh(now);
}

function onTrackerFailure() {
  // A GPU delegate can die at runtime (context loss). Rebuild on CPU once.
  const failed = tracker;
  const err = failed.failed;
  console.warn('inference failed, rebuilding on CPU', err);
  failed.failed = null;
  if (failed.delegate === 'CPU') return showError('infer', err);
  tracker = null;
  failed.close();
  const t = new FaceTracker(CONFIG.detect);
  t.init(null, true)
    .then(() => {
      tracker = t;
      t.attachVideo(video);
    })
    .catch((e) => showError('model', e));
}

function demoFrame(dt, now) {
  demo.update(dt, W, H);
  const h = demo.head;
  collider.present = true;
  collider.cx = h.cx;
  collider.cy = h.cy;
  collider.a = h.a;
  collider.b = h.b;
  collider.cos = Math.cos(h.theta);
  collider.sin = Math.sin(h.theta);
  collider.r2 = Math.max(h.a, h.b) ** 2;
  if (demoPrev.ok && dt > 0) {
    collider.vx += ((h.cx - demoPrev.x) / dt - collider.vx) * 0.3;
    collider.vy += ((h.cy - demoPrev.y) / dt - collider.vy) * 0.3;
  } else {
    collider.vx = collider.vy = 0;
  }
  demoPrev.x = h.cx;
  demoPrev.y = h.cy;
  demoPrev.ok = true;
  yaw = 0;
  onExpr(expr.update(dt * 1000, demo.sig, 0), now);
  demo.render(EXPR_NAME[expr.state]);
}

// ---------------------------------------------------------------- calibration
function calibFrame(now) {
  if (calib.state === 'idle') {
    // Start once a face has been seen steadily for a second.
    if (tracker && head.present) {
      if (calibFaceSince < 0) calibFaceSince = now;
      if (now - calibFaceSince > 1000) calib.begin(now);
    } else calibFaceSince = -1;
    return calibShow('wait', T.calibWait, '', 0);
  }
  if (calib.state !== 'running') return;
  const ui = calib.tick(now);
  if (ui.done) return calibResults();
  const step = `${ui.step}/${ui.total}`;
  const note = ui.recording ? '' : T.calibGetReady(ui.countdown);
  calibShow(`${ui.step}-${ui.recording}-${ui.countdown}`, ui.text, `${step}${note ? ' · ' + note : ''}`, ui.progress);
}

function calibShow(key, text, meta, progress) {
  $('#calib-bar').style.transform = `scaleX(${progress})`;
  if (key === calibKey) return;
  calibKey = key;
  $('#calib-text').textContent = text;
  $('#calib-meta').textContent = meta;
}

function calibResults() {
  const summary = calib.summary();
  const zh = LANG === 'zh';
  window.__calib = { at: new Date().toISOString(), thresholds: { ...CONFIG.expr }, summary, frames: calib.frames };
  const fmt = (a) => (Number.isNaN(a[1]) ? '—' : `${a[1].toFixed(2)} (${a[0].toFixed(2)}–${a[2].toFixed(2)})`);
  const rows = summary.map((s) => [
    PHASE_LABEL[s.phase][zh ? 0 : 1],
    fmt(s.smile),
    fmt(s.jaw),
    `${Math.round(s.states.none * 100)} / ${Math.round(s.states.smile * 100)} / ${Math.round(s.states.laugh * 100)}`,
    `${Math.round(s.hit * 100)}%`,
  ]);
  const table = document.createElement('table');
  const headRow = zh ? ['动作', '嘴角 中位(10–90%)', '张嘴 中位(10–90%)', '无/微笑/大笑 %', '判对'] : ['Phase', 'Smile p50 (p10–p90)', 'Jaw p50 (p10–p90)', 'None/Smile/Laugh %', 'Correct'];
  for (const cells of [headRow, ...rows]) {
    const tr = document.createElement('tr');
    for (const c of cells) {
      const td = document.createElement(cells === headRow ? 'th' : 'td');
      td.textContent = c;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  const box = $('#calib-result');
  box.replaceChildren(table);
  box.hidden = false;
  $('#calib-actions').hidden = false;
  calibShow('done', T.calibDone, `${PHASES.length}/${PHASES.length}`, 1);
}

// ---------------------------------------------------------------- governor
function governor(now, intervalMs, workMs) {
  const d = gov.update(now, intervalMs, workMs);
  if (d) applyTier(gov.tier);
}

function maxTier() {
  const forced = params.get('tier');
  return forced !== null ? Number(forced) | 0 : CONFIG.tiers.length - 1;
}

// ---------------------------------------------------------------- status chip
function updateChip(now) {
  if (now - chipCheck < 200) return;
  chipCheck = now;
  if (mode === 'demo') return setChip(`${T.demoTag} · ${stateText()}`);
  if (mode !== 'camera') return;
  if (!tracker) return setChip(loadText || T.preparing); // camera is up, model still downloading
  if (noFaceMs > 800 || (!head.present && tracker.runs > 30)) return setChip(T.noFace);
  if (!expr.reliable) return setChip(T.sideFace);
  setChip(stateText());
}

function stateText() {
  return expr.state === EXPR.LAUGH ? T.laughing : expr.state === EXPR.SMILE ? T.smiling : T.idleHint;
}

function setChip(text) {
  if (text === chipText) return;
  chipText = text;
  chip.textContent = text;
  chip.hidden = !text;
}

// ---------------------------------------------------------------- demo input
stage.addEventListener('pointerdown', (e) => {
  if (mode !== 'demo') return;
  demo.pointer = { x: e.clientX, y: e.clientY };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (demo.pointer) {
    demo.pointer.x = e.clientX;
    demo.pointer.y = e.clientY;
  }
});
for (const ev of ['pointerup', 'pointercancel']) stage.addEventListener(ev, () => (demo.pointer = null));

for (const btn of document.querySelectorAll('[data-hold]')) {
  const on = (e) => {
    e.preventDefault();
    demo.override = btn.dataset.hold;
  };
  const off = () => (demo.override = null);
  btn.addEventListener('pointerdown', on);
  btn.addEventListener('pointerup', off);
  btn.addEventListener('pointerleave', off);
  btn.addEventListener('pointercancel', off);
}
window.addEventListener('keydown', (e) => {
  if (mode !== 'demo' || e.repeat) return;
  if (e.key === 's') demo.override = 'smile';
  if (e.key === 'l') demo.override = 'laugh';
});
window.addEventListener('keyup', (e) => {
  if (e.key === 's' || e.key === 'l') demo.override = null;
});

// URL switches run last, after every module-level `let` above is initialised.
if (params.get('hud') === '1') hud.setVisible(true);
if (params.get('demo') === '1') startDemo();
else if (testSrc && params.get('autostart') === '1') startCamera();

function sameOriginParam(name) {
  const v = params.get(name);
  if (!v) return null;
  try {
    const u = new URL(v, location.href);
    return u.origin === location.origin ? u.href : null;
  } catch {
    return null;
  }
}
